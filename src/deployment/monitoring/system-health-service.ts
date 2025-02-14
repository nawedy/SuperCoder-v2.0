import { MonitoringService } from '../../monitoring/monitoring-service';
import { EventBusService } from '../../events/event-bus-service';
import { createClient as createRedisClient } from 'redis';
import os from 'os';

interface HealthCheck {
    id: string;
    name: string;
    type: 'api' | 'database' | 'cache' | 'compute' | 'storage';
    endpoint?: string;
    interval: number;
    timeout: number;
    thresholds: {
        warning: number;
        critical: number;
    };
    lastCheck?: {
        status: 'healthy' | 'degraded' | 'unhealthy';
        latency: number;
        error?: string;
        timestamp: Date;
    };
}

interface SystemStatus {
    status: 'healthy' | 'degraded' | 'unhealthy';
    checks: Record<string, HealthCheck['lastCheck']>;
    resources: {
        cpu: {
            usage: number;
            temperature: number;
        };
        memory: {
            used: number;
            total: number;
            swap: number;
        };
        disk: {
            used: number;
            total: number;
            iops: number;
        };
        network: {
            bytesIn: number;
            bytesOut: number;
            connections: number;
        };
    };
    timestamp: Date;
}

export class SystemHealthService {
    private redis: ReturnType<typeof createRedisClient>;
    private healthChecks: Map<string, HealthCheck>;
    private status: SystemStatus;
    private checkIntervals: Map<string, NodeJS.Timeout>;
    private readonly DEFAULT_CHECK_INTERVAL = 60000; // 1 minute
    private readonly DEFAULT_CHECK_TIMEOUT = 5000; // 5 seconds

    constructor(
        private monitor: MonitoringService,
        private eventBus: EventBusService,
        private config: {
            redisUrl: string;
        }
    ) {
        this.redis = createRedisClient({ url: config.redisUrl });
        this.healthChecks = new Map();
        this.checkIntervals = new Map();
        this.status = this.getInitialStatus();
        this.initialize();
    }

    private async initialize(): Promise<void> {
        await this.redis.connect();
        await this.loadHealthChecks();
        this.startHealthChecks();
        this.startResourceMonitoring();
    }

    async getSystemStatus(): Promise<SystemStatus> {
        return this.status;
    }

    async addHealthCheck(check: Omit<HealthCheck, 'id'>): Promise<string> {
        const checkId = uuidv4();
        const newCheck: HealthCheck = {
            ...check,
            id: checkId,
            interval: check.interval || this.DEFAULT_CHECK_INTERVAL,
            timeout: check.timeout || this.DEFAULT_CHECK_TIMEOUT
        };

        this.healthChecks.set(checkId, newCheck);
        await this.saveHealthChecks();
        this.startCheck(newCheck);

        return checkId;
    }

    async removeHealthCheck(checkId: string): Promise<void> {
        const interval = this.checkIntervals.get(checkId);
        if (interval) {
            clearInterval(interval);
            this.checkIntervals.delete(checkId);
        }

        this.healthChecks.delete(checkId);
        await this.saveHealthChecks();
    }

    private async loadHealthChecks(): Promise<void> {
        const saved = await this.redis.get('health_checks');
        if (saved) {
            const checks = JSON.parse(saved);
            checks.forEach((check: HealthCheck) => {
                this.healthChecks.set(check.id, check);
            });
        }
    }

    private async saveHealthChecks(): Promise<void> {
        await this.redis.set(
            'health_checks',
            JSON.stringify(Array.from(this.healthChecks.values()))
        );
    }

    private startHealthChecks(): void {
        for (const check of this.healthChecks.values()) {
            this.startCheck(check);
        }
    }

    private startCheck(check: HealthCheck): void {
        const interval = setInterval(async () => {
            try {
                const result = await this.performHealthCheck(check);
                await this.updateCheckStatus(check.id, result);
            } catch (error) {
                await this.handleError('health_check_error', error, check.id);
            }
        }, check.interval);

        this.checkIntervals.set(check.id, interval);
    }

    private async performHealthCheck(check: HealthCheck): Promise<HealthCheck['lastCheck']> {
        const startTime = Date.now();

        try {
            switch (check.type) {
                case 'api':
                    await this.checkAPI(check.endpoint!);
                    break;
                case 'database':
                    await this.checkDatabase();
                    break;
                case 'cache':
                    await this.checkCache();
                    break;
                case 'compute':
                    await this.checkCompute();
                    break;
                case 'storage':
                    await this.checkStorage();
                    break;
            }

            const latency = Date.now() - startTime;
            const status = this.determineStatus(latency, check.thresholds);

            return {
                status,
                latency,
                timestamp: new Date()
            };

        } catch (error) {
            return {
                status: 'unhealthy',
                latency: Date.now() - startTime,
                error: error.message,
                timestamp: new Date()
            };
        }
    }

    private async checkAPI(endpoint: string): Promise<void> {
        const response = await fetch(endpoint, {
            timeout: this.DEFAULT_CHECK_TIMEOUT
        });

        if (!response.ok) {
            throw new Error(`API check failed: ${response.status}`);
        }
    }

    private async checkDatabase(): Promise<void> {
        // Implement database health check
    }

    private async checkCache(): Promise<void> {
        await this.redis.ping();
    }

    private async checkCompute(): Promise<void> {
        const load = os.loadavg()[0];
        if (load > 0.8) {
            throw new Error(`High CPU load: ${load}`);
        }
    }

    private async checkStorage(): Promise<void> {
        // Implement storage health check
    }

    private startResourceMonitoring(): void {
        setInterval(async () => {
            try {
                const resources = await this.collectResourceMetrics();
                this.status.resources = resources;
                this.status.timestamp = new Date();

                await this.monitor.recordMetric({
                    name: 'system_resources',
                    value: 1,
                    labels: {
                        cpu_usage: resources.cpu.usage.toString(),
                        memory_used: resources.memory.used.toString()
                    }
                });

            } catch (error) {
                await this.handleError('resource_monitoring_error', error);
            }
        }, 5000); // Every 5 seconds
    }

    private async collectResourceMetrics(): Promise<SystemStatus['resources']> {
        return {
            cpu: {
                usage: this.getCPUUsage(),
                temperature: await this.getCPUTemperature()
            },
            memory: {
                used: os.totalmem() - os.freemem(),
                total: os.totalmem(),
                swap: 0 // Implement swap memory monitoring
            },
            disk: await this.getDiskMetrics(),
            network: await this.getNetworkMetrics()
        };
    }

    private getCPUUsage(): number {
        const cpus = os.cpus();
        const usage = cpus.reduce((acc, cpu) => {
            const total = Object.values(cpu.times).reduce((a, b) => a + b);
            const idle = cpu.times.idle;
            return acc + ((total - idle) / total);
        }, 0);

        return usage / cpus.length;
    }

    private async getCPUTemperature(): Promise<number> {
        // Implement CPU temperature monitoring
        return 0;
    }

    private async getDiskMetrics(): Promise<SystemStatus['resources']['disk']> {
        // Implement disk metrics collection
        return {
            used: 0,
            total: 0,
            iops: 0
        };
    }

    private async getNetworkMetrics(): Promise<SystemStatus['resources']['network']> {
        // Implement network metrics collection
        return {
            bytesIn: 0,
            bytesOut: 0,
            connections: 0
        };
    }

    private determineStatus(
        latency: number,
        thresholds: HealthCheck['thresholds']
    ): HealthCheck['lastCheck']['status'] {
        if (latency > thresholds.critical) return 'unhealthy';
        if (latency > thresholds.warning) return 'degraded';
        return 'healthy';
    }

    private async updateCheckStatus(
        checkId: string,
        result: HealthCheck['lastCheck']
    ): Promise<void> {
        const check = this.healthChecks.get(checkId);
        if (!check) return;

        check.lastCheck = result;
        this.status.checks[checkId] = result;

        // Update overall system status
        this.updateSystemStatus();

        // Emit status update event
        await this.eventBus.publish('system.health.updated', {
            type: 'health.updated',
            source: 'system-health',
            data: {
                checkId,
                status: result
            }
        });

        // Record metrics
        await this.monitor.recordMetric({
            name: 'health_check',
            value: result.latency,
            labels: {
                check_id: checkId,
                check_type: check.type,
                status: result.status
            }
        });
    }

    private updateSystemStatus(): void {
        const checkStatuses = Object.values(this.status.checks);
        
        if (checkStatuses.some(s => s.status === 'unhealthy')) {
            this.status.status = 'unhealthy';
        } else if (checkStatuses.some(s => s.status === 'degraded')) {
            this.status.status = 'degraded';
        } else {
            this.status.status = 'healthy';
        }
    }

    private getInitialStatus(): SystemStatus {
        return {
            status: 'healthy',
            checks: {},
            resources: {
                cpu: { usage: 0, temperature: 0 },
                memory: { used: 0, total: 0, swap: 0 },
                disk: { used: 0, total: 0, iops: 0 },
                network: { bytesIn: 0, bytesOut: 0, connections: 0 }
            },
            timestamp: new Date()
        };
    }

    private async handleError(type: string, error: Error, checkId?: string): Promise<void> {
        await this.monitor.recordMetric({
            name: `system_health_${type}`,
            value: 1,
            labels: {
                error: error.message,
                check_id: checkId || 'unknown'
            }
        });

        await this.eventBus.publish('system.health.error', {
            type: 'health.error',
            source: 'system-health',
            data: {
                error: error.message,
                type,
                checkId,
                timestamp: new Date()
            }
        });
    }

    async close(): Promise<void> {
        for (const interval of this.checkIntervals.values()) {
            clearInterval(interval);
        }
        await this.redis.quit();
    }
}

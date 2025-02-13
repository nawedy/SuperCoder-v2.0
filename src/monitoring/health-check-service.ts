import { MonitoringService } from './monitoring-service';
import { EventBusService } from '../events/event-bus-service';
import { AuditTrailService } from '../audit/audit-trail-service';
import { Redis } from 'ioredis';

interface HealthCheck {
    id: string;
    name: string;
    type: 'liveness' | 'readiness' | 'dependency';
    endpoint?: string;
    interval: number; // milliseconds
    timeout: number; // milliseconds
    threshold: number; // failures before alert
    check: () => Promise<boolean>;
}

interface HealthStatus {
    id: string;
    timestamp: Date;
    status: 'healthy' | 'degraded' | 'unhealthy';
    checks: {
        name: string;
        status: 'pass' | 'fail';
        latency: number;
        message?: string;
        lastSuccess?: Date;
        consecutiveFailures: number;
    }[];
    metrics: {
        uptime: number;
        totalChecks: number;
        failedChecks: number;
    };
}

export class HealthCheckService {
    private monitor: MonitoringService;
    private eventBus: EventBusService;
    private audit: AuditTrailService;
    private redis: Redis;
    private checks: Map<string, HealthCheck>;
    private statuses: Map<string, HealthStatus>;
    private checkIntervals: Map<string, NodeJS.Timeout>;

    constructor(
        monitor: MonitoringService,
        eventBus: EventBusService,
        audit: AuditTrailService,
        redisUrl: string
    ) {
        this.monitor = monitor;
        this.eventBus = eventBus;
        this.audit = audit;
        this.redis = new Redis(redisUrl);
        this.checks = new Map();
        this.statuses = new Map();
        this.checkIntervals = new Map();

        this.initialize();
    }

    private async initialize(): Promise<void> {
        await this.registerDefaultChecks();
        this.startHealthChecks();
    }

    async registerCheck(check: HealthCheck): Promise<void> {
        try {
            // Validate check configuration
            this.validateCheck(check);

            // Store check
            this.checks.set(check.id, check);

            // Initialize status
            this.statuses.set(check.id, {
                id: check.id,
                timestamp: new Date(),
                status: 'healthy',
                checks: [{
                    name: check.name,
                    status: 'pass',
                    latency: 0,
                    consecutiveFailures: 0
                }],
                metrics: {
                    uptime: 100,
                    totalChecks: 0,
                    failedChecks: 0
                }
            });

            // Start check interval
            this.startCheck(check);

            await this.audit.logEvent({
                eventType: 'system.config',
                actor: {
                    id: 'system',
                    type: 'service',
                    metadata: {}
                },
                resource: {
                    type: 'health-check',
                    id: check.id,
                    action: 'register'
                },
                context: {
                    location: 'health-check',
                    ipAddress: 'internal',
                    userAgent: 'system'
                },
                status: 'success',
                details: { check }
            });

        } catch (error) {
            await this.handleError('check_registration_error', error);
            throw error;
        }
    }

    async getSystemHealth(): Promise<HealthStatus[]> {
        return Array.from(this.statuses.values());
    }

    async getCheckStatus(checkId: string): Promise<HealthStatus | null> {
        return this.statuses.get(checkId) || null;
    }

    private async registerDefaultChecks(): Promise<void> {
        // Register memory check
        await this.registerCheck({
            id: 'memory',
            name: 'Memory Usage Check',
            type: 'liveness',
            interval: 30000, // 30 seconds
            timeout: 5000,   // 5 seconds
            threshold: 3,
            check: async () => {
                const usage = process.memoryUsage();
                return (usage.heapUsed / usage.heapTotal) < 0.9; // 90% threshold
            }
        });

        // Register Redis connection check
        await this.registerCheck({
            id: 'redis',
            name: 'Redis Connection Check',
            type: 'dependency',
            interval: 60000, // 1 minute
            timeout: 5000,   // 5 seconds
            threshold: 2,
            check: async () => {
                try {
                    await this.redis.ping();
                    return true;
                } catch {
                    return false;
                }
            }
        });

        // Add more default checks as needed
    }

    private startHealthChecks(): void {
        // Clear any existing intervals
        for (const interval of this.checkIntervals.values()) {
            clearInterval(interval);
        }
        this.checkIntervals.clear();

        // Start new check intervals
        for (const check of this.checks.values()) {
            this.startCheck(check);
        }
    }

    private startCheck(check: HealthCheck): void {
        const interval = setInterval(async () => {
            try {
                await this.executeCheck(check);
            } catch (error) {
                await this.handleError('check_execution_error', error);
            }
        }, check.interval);

        this.checkIntervals.set(check.id, interval);
    }

    private async executeCheck(check: HealthCheck): Promise<void> {
        const startTime = Date.now();
        const status = this.statuses.get(check.id)!;
        const checkStatus = status.checks[0];

        try {
            // Execute check with timeout
            const result = await Promise.race([
                check.check(),
                new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Check timeout')), check.timeout)
                )
            ]);

            // Update status
            checkStatus.status = result ? 'pass' : 'fail';
            checkStatus.latency = Date.now() - startTime;
            checkStatus.lastSuccess = result ? new Date() : checkStatus.lastSuccess;
            checkStatus.consecutiveFailures = result ? 0 : checkStatus.consecutiveFailures + 1;

            // Update metrics
            status.metrics.totalChecks++;
            if (!result) {
                status.metrics.failedChecks++;
            }
            status.metrics.uptime = (
                (status.metrics.totalChecks - status.metrics.failedChecks) /
                status.metrics.totalChecks
            ) * 100;

            // Update overall status
            status.status = this.calculateOverallStatus(status);
            status.timestamp = new Date();

            // Check threshold
            if (checkStatus.consecutiveFailures >= check.threshold) {
                await this.handleCheckFailure(check, status);
            }

            // Record metrics
            await this.monitor.recordMetric({
                name: 'health_check',
                value: checkStatus.latency,
                labels: {
                    check_id: check.id,
                    status: checkStatus.status,
                    type: check.type
                }
            });

        } catch (error) {
            checkStatus.status = 'fail';
            checkStatus.latency = Date.now() - startTime;
            checkStatus.consecutiveFailures++;
            checkStatus.message = error.message;

            await this.handleError('check_execution_error', error);
        }
    }

    private calculateOverallStatus(status: HealthStatus): HealthStatus['status'] {
        const failedChecks = status.checks.filter(c => c.status === 'fail').length;
        const totalChecks = status.checks.length;

        if (failedChecks === 0) return 'healthy';
        if (failedChecks === totalChecks) return 'unhealthy';
        return 'degraded';
    }

    private async handleCheckFailure(check: HealthCheck, status: HealthStatus): Promise<void> {
        // Emit event
        await this.eventBus.publish('health.alert', {
            type: 'health.check.failed',
            source: 'health-check-service',
            data: {
                checkId: check.id,
                name: check.name,
                type: check.type,
                failures: status.checks[0].consecutiveFailures,
                lastSuccess: status.checks[0].lastSuccess
            },
            metadata: {
                severity: check.type === 'liveness' ? 'critical' : 'high',
                timestamp: new Date(),
                environment: process.env.NODE_ENV || 'development'
            }
        });

        // Audit log
        await this.audit.logEvent({
            eventType: 'system.config',
            actor: {
                id: 'system',
                type: 'service',
                metadata: {}
            },
            resource: {
                type: 'health-check',
                id: check.id,
                action: 'alert'
            },
            context: {
                location: 'health-check',
                ipAddress: 'internal',
                userAgent: 'system'
            },
            status: 'failure',
            details: { status }
        });
    }

    private validateCheck(check: HealthCheck): void {
        if (!check.id || !check.name || !check.type) {
            throw new Error('Invalid check configuration: missing required fields');
        }

        if (check.interval < 1000) {
            throw new Error('Check interval must be at least 1 second');
        }

        if (check.timeout >= check.interval) {
            throw new Error('Check timeout must be less than interval');
        }

        if (check.threshold < 1) {
            throw new Error('Check threshold must be at least 1');
        }
    }

    private async handleError(type: string, error: Error): Promise<void> {
        await this.monitor.recordMetric({
            name: type,
            value: 1,
            labels: { error: error.message }
        });
    }

    // Cleanup method for proper service shutdown
    async shutdown(): Promise<void> {
        // Clear all intervals
        for (const interval of this.checkIntervals.values()) {
            clearInterval(interval);
        }
        this.checkIntervals.clear();

        // Close Redis connection
        await this.redis.quit();
    }
}

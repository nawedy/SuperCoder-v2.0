import { MonitoringService } from '../monitoring/monitoring-service';
import { EventBusService } from '../events/event-bus-service';
import { RealTimeMetricsService } from '../monitoring/real-time-metrics-service';
import { SecurityTestingService } from '../testing/security-testing-service';
import { BigQuery } from '@google-cloud/bigquery';
import { createClient as createRedisClient } from 'redis';
import { v4 as uuidv4 } from 'uuid';

interface SystemHealth {
    status: 'healthy' | 'degraded' | 'critical';
    timestamp: Date;
    metrics: {
        system: {
            cpu: {
                usage: number;
                temperature: number;
                processes: number;
            };
            memory: {
                used: number;
                available: number;
                swapUsage: number;
            };
            disk: {
                usage: number;
                iops: number;
                latency: number;
            };
            network: {
                throughput: number;
                latency: number;
                errorRate: number;
            };
        };
        services: Record<string, {
            status: 'up' | 'down' | 'degraded';
            latency: number;
            errorRate: number;
            lastCheck: Date;
        }>;
        security: {
            threatLevel: 'low' | 'medium' | 'high';
            activeThreats: number;
            lastScan: Date;
        };
        application: {
            activeUsers: number;
            requestRate: number;
            errorRate: number;
            avgResponseTime: number;
        };
    };
    alerts: Array<{
        id: string;
        severity: 'critical' | 'warning' | 'info';
        message: string;
        timestamp: Date;
        acknowledged: boolean;
    }>;
}

interface HealthCheck {
    id: string;
    name: string;
    type: 'http' | 'tcp' | 'custom';
    target: string;
    interval: number;
    timeout: number;
    successThreshold: number;
    failureThreshold: number;
}

export class SystemHealthDashboardService {
    private redis: ReturnType<typeof createRedisClient>;
    private bigquery: BigQuery;
    private healthChecks: Map<string, HealthCheck>;
    private checkIntervals: Map<string, NodeJS.Timeout>;
    private currentHealth: SystemHealth;
    private readonly UPDATE_INTERVAL = 10000; // 10 seconds
    private readonly HISTORY_RETENTION = 86400; // 24 hours

    constructor(
        private monitor: MonitoringService,
        private metrics: RealTimeMetricsService,
        private security: SecurityTestingService,
        private eventBus: EventBusService,
        private config: {
            projectId: string;
            redisUrl: string;
            services: string[];
        }
    ) {
        this.redis = createRedisClient({ url: config.redisUrl });
        this.bigquery = new BigQuery({ projectId: config.projectId });
        this.healthChecks = new Map();
        this.checkIntervals = new Map();
        this.currentHealth = this.getInitialHealth();
        this.initialize();
    }

    private async initialize(): Promise<void> {
        await this.redis.connect();
        await this.loadHealthChecks();
        this.startHealthMonitoring();
        this.setupEventListeners();
    }

    async getCurrentHealth(): Promise<SystemHealth> {
        return this.currentHealth;
    }

    async getHistoricalHealth(
        timeframe: '1h' | '24h' | '7d'
    ): Promise<SystemHealth[]> {
        const query = `
            SELECT *
            FROM \`${this.config.projectId}.monitoring.system_health\`
            WHERE timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL ${timeframe})
            ORDER BY timestamp DESC
        `;

        const [rows] = await this.bigquery.query({ query });
        return rows.map(this.deserializeHealth);
    }

    async addHealthCheck(check: Omit<HealthCheck, 'id'>): Promise<string> {
        const checkId = uuidv4();
        const healthCheck: HealthCheck = {
            ...check,
            id: checkId
        };

        this.healthChecks.set(checkId, healthCheck);
        await this.startCheck(healthCheck);
        await this.saveHealthChecks();

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
        // Load predefined health checks
        const defaultChecks: HealthCheck[] = this.config.services.map(service => ({
            id: uuidv4(),
            name: `${service}-health`,
            type: 'http',
            target: `${service}/health`,
            interval: 30000,
            timeout: 5000,
            successThreshold: 1,
            failureThreshold: 3
        }));

        for (const check of defaultChecks) {
            this.healthChecks.set(check.id, check);
            await this.startCheck(check);
        }
    }

    private startHealthMonitoring(): void {
        setInterval(async () => {
            try {
                const health = await this.collectHealthMetrics();
                this.currentHealth = health;

                // Store health state
                await this.storeHealthState(health);

                // Emit health update event
                await this.eventBus.publish('system.health.updated', {
                    type: 'health.updated',
                    source: 'health-dashboard',
                    data: health
                });

                // Check for critical conditions
                await this.checkCriticalConditions(health);

            } catch (error) {
                await this.handleError('health_monitoring_error', error);
            }
        }, this.UPDATE_INTERVAL);
    }

    private async collectHealthMetrics(): Promise<SystemHealth> {
        const [
            systemMetrics,
            serviceMetrics,
            securityMetrics,
            applicationMetrics
        ] = await Promise.all([
            this.collectSystemMetrics(),
            this.collectServiceMetrics(),
            this.collectSecurityMetrics(),
            this.collectApplicationMetrics()
        ]);

        const health: SystemHealth = {
            status: this.determineOverallStatus(systemMetrics, serviceMetrics),
            timestamp: new Date(),
            metrics: {
                system: systemMetrics,
                services: serviceMetrics,
                security: securityMetrics,
                application: applicationMetrics
            },
            alerts: await this.getActiveAlerts()
        };

        return health;
    }

    private async startCheck(check: HealthCheck): Promise<void> {
        let failures = 0;
        let successes = 0;

        const interval = setInterval(async () => {
            try {
                const result = await this.executeHealthCheck(check);
                
                if (result) {
                    successes++;
                    failures = 0;
                    if (successes >= check.successThreshold) {
                        await this.updateServiceStatus(check.name, 'up');
                    }
                } else {
                    failures++;
                    successes = 0;
                    if (failures >= check.failureThreshold) {
                        await this.updateServiceStatus(check.name, 'down');
                    }
                }

            } catch (error) {
                await this.handleError('health_check_error', error);
            }
        }, check.interval);

        this.checkIntervals.set(check.id, interval);
    }

    private async executeHealthCheck(check: HealthCheck): Promise<boolean> {
        try {
            switch (check.type) {
                case 'http':
                    return await this.performHttpCheck(check.target);
                case 'tcp':
                    return await this.performTcpCheck(check.target);
                case 'custom':
                    return await this.performCustomCheck(check.target);
                default:
                    throw new Error(`Unknown check type: ${check.type}`);
            }
        } catch (error) {
            return false;
        }
    }

    private determineOverallStatus(
        systemMetrics: SystemHealth['metrics']['system'],
        serviceMetrics: SystemHealth['metrics']['services']
    ): SystemHealth['status'] {
        const criticalConditions = [
            systemMetrics.cpu.usage > 90,
            systemMetrics.memory.used / (systemMetrics.memory.used + systemMetrics.memory.available) > 0.95,
            Object.values(serviceMetrics).some(s => s.status === 'down')
        ];

        if (criticalConditions.some(Boolean)) {
            return 'critical';
        }

        const warningConditions = [
            systemMetrics.cpu.usage > 75,
            systemMetrics.memory.used / (systemMetrics.memory.used + systemMetrics.memory.available) > 0.85,
            Object.values(serviceMetrics).some(s => s.status === 'degraded')
        ];

        if (warningConditions.some(Boolean)) {
            return 'degraded';
        }

        return 'healthy';
    }

    private async checkCriticalConditions(health: SystemHealth): Promise<void> {
        if (health.status === 'critical') {
            await this.eventBus.publish('system.health.critical', {
                type: 'health.critical',
                source: 'health-dashboard',
                data: {
                    status: health.status,
                    metrics: health.metrics,
                    timestamp: health.timestamp
                }
            });
        }
    }

    private async storeHealthState(health: SystemHealth): Promise<void> {
        // Store in Redis for real-time access
        await this.redis.setEx(
            'current_health',
            300, // 5 minutes
            JSON.stringify(health)
        );

        // Store in BigQuery for historical analysis
        await this.bigquery
            .dataset('monitoring')
            .table('system_health')
            .insert([this.serializeHealth(health)]);
    }

    private serializeHealth(health: SystemHealth): Record<string, any> {
        return {
            timestamp: health.timestamp,
            status: health.status,
            metrics: JSON.stringify(health.metrics),
            alerts: JSON.stringify(health.alerts)
        };
    }

    private deserializeHealth(row: any): SystemHealth {
        return {
            status: row.status,
            timestamp: new Date(row.timestamp),
            metrics: JSON.parse(row.metrics),
            alerts: JSON.parse(row.alerts)
        };
    }

    private setupEventListeners(): void {
        this.eventBus.subscribe({
            id: 'health-dashboard-monitor',
            topic: 'system.alert',
            handler: async (event) => {
                if (event.data.type === 'new_alert') {
                    await this.handleNewAlert(event.data);
                }
            }
        });
    }

    private async handleError(
        type: string,
        error: Error
    ): Promise<void> {
        await this.monitor.recordMetric({
            name: `health_dashboard_${type}`,
            value: 1,
            labels: { error: error.message }
        });

        await this.eventBus.publish('system.health.error', {
            type: 'health.error',
            source: 'health-dashboard',
            data: {
                error: error.message,
                type,
                timestamp: new Date()
            }
        });
    }

    async close(): Promise<void> {
        // Clear all check intervals
        for (const interval of this.checkIntervals.values()) {
            clearInterval(interval);
        }
        await this.redis.quit();
    }
}

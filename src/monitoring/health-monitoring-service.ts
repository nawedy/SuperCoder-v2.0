import { MonitoringService } from './monitoring-service';
import { AuditTrailService } from '../audit/audit-trail-service';
import { PubSub } from '@google-cloud/pubsub';

interface HealthCheck {
    id: string;
    component: string;
    type: 'liveness' | 'readiness' | 'startup';
    status: 'healthy' | 'degraded' | 'unhealthy';
    details: {
        latency: number;
        errorRate: number;
        resourceUsage: {
            cpu: number;
            memory: number;
            disk: number;
        };
    };
    lastChecked: Date;
    nextCheck: Date;
}

interface HealthAlert {
    id: string;
    severity: 'critical' | 'high' | 'medium' | 'low';
    component: string;
    message: string;
    timestamp: Date;
    status: 'active' | 'resolved';
    metadata: Record<string, any>;
}

export class HealthMonitoringService {
    private monitor: MonitoringService;
    private audit: AuditTrailService;
    private pubsub: PubSub;
    private healthChecks: Map<string, HealthCheck>;
    private alerts: Map<string, HealthAlert>;
    private readonly CHECK_INTERVAL = 60000; // 1 minute

    constructor(
        monitor: MonitoringService,
        audit: AuditTrailService,
        projectId: string
    ) {
        this.monitor = monitor;
        this.audit = audit;
        this.pubsub = new PubSub({ projectId });
        this.healthChecks = new Map();
        this.alerts = new Map();

        this.initialize();
    }

    private async initialize(): Promise<void> {
        this.registerHealthChecks();
        this.startMonitoring();
    }

    private registerHealthChecks(): void {
        // Register default health checks
        this.registerCheck('api-gateway', 'readiness', async () => {
            // Implement API gateway health check
            return this.checkApiGateway();
        });

        this.registerCheck('model-serving', 'liveness', async () => {
            // Implement model serving health check
            return this.checkModelServing();
        });

        this.registerCheck('database', 'readiness', async () => {
            // Implement database health check
            return this.checkDatabase();
        });
    }

    private async startMonitoring(): Promise<void> {
        setInterval(async () => {
            await this.runHealthChecks();
        }, this.CHECK_INTERVAL);
    }

    async getSystemHealth(): Promise<{
        status: 'healthy' | 'degraded' | 'unhealthy';
        checks: HealthCheck[];
        alerts: HealthAlert[];
    }> {
        try {
            const checks = Array.from(this.healthChecks.values());
            const activeAlerts = Array.from(this.alerts.values())
                .filter(alert => alert.status === 'active');

            const status = this.calculateOverallStatus(checks);

            await this.monitor.recordMetric({
                name: 'system_health',
                value: status === 'healthy' ? 1 : 0,
                labels: {
                    status,
                    active_alerts: activeAlerts.length.toString()
                }
            });

            return {
                status,
                checks,
                alerts: activeAlerts
            };
        } catch (error) {
            await this.handleError('health_check_error', error);
            throw error;
        }
    }

    async registerCheck(
        component: string,
        type: HealthCheck['type'],
        checkFn: () => Promise<Partial<HealthCheck['details']>>
    ): Promise<void> {
        const checkId = `${component}-${type}`;
        
        this.healthChecks.set(checkId, {
            id: checkId,
            component,
            type,
            status: 'healthy',
            details: {
                latency: 0,
                errorRate: 0,
                resourceUsage: {
                    cpu: 0,
                    memory: 0,
                    disk: 0
                }
            },
            lastChecked: new Date(),
            nextCheck: new Date(Date.now() + this.CHECK_INTERVAL)
        });

        // Register the check function
        this.checkFunctions.set(checkId, checkFn);
    }

    private async runHealthChecks(): Promise<void> {
        for (const [checkId, check] of this.healthChecks.entries()) {
            try {
                const checkFn = this.checkFunctions.get(checkId);
                if (!checkFn) continue;

                const startTime = Date.now();
                const details = await checkFn();

                // Update check status
                check.details = {
                    ...check.details,
                    ...details
                };
                check.lastChecked = new Date();
                check.nextCheck = new Date(Date.now() + this.CHECK_INTERVAL);

                // Determine health status
                check.status = this.determineHealthStatus(check.details);

                // Create alert if unhealthy
                if (check.status !== 'healthy') {
                    await this.createAlert(check);
                }

                await this.monitor.recordMetric({
                    name: 'health_check',
                    value: Date.now() - startTime,
                    labels: {
                        component: check.component,
                        type: check.type,
                        status: check.status
                    }
                });

            } catch (error) {
                await this.handleError('health_check_error', error);
            }
        }
    }

    private determineHealthStatus(details: HealthCheck['details']): HealthCheck['status'] {
        if (details.errorRate > 0.1 || details.resourceUsage.cpu > 90) {
            return 'unhealthy';
        }
        if (details.errorRate > 0.05 || details.resourceUsage.cpu > 75) {
            return 'degraded';
        }
        return 'healthy';
    }

    private async createAlert(check: HealthCheck): Promise<void> {
        const alertId = `alert-${Date.now()}`;
        const alert: HealthAlert = {
            id: alertId,
            severity: this.determineSeverity(check),
            component: check.component,
            message: `Component ${check.component} is ${check.status}`,
            timestamp: new Date(),
            status: 'active',
            metadata: {
                checkId: check.id,
                details: check.details
            }
        };

        this.alerts.set(alertId, alert);

        // Publish alert
        await this.publishAlert(alert);

        await this.audit.logEvent({
            eventType: 'system.config',
            actor: {
                id: 'health-monitor',
                type: 'service',
                metadata: {}
            },
            resource: {
                type: 'health-check',
                id: check.id,
                action: 'alert'
            },
            context: {
                location: 'health-monitoring',
                ipAddress: 'internal',
                userAgent: 'system'
            },
            status: 'success',
            details: alert
        });
    }

    private determineSeverity(check: HealthCheck): HealthAlert['severity'] {
        if (check.status === 'unhealthy') return 'critical';
        if (check.status === 'degraded') return 'high';
        return 'low';
    }

    private async publishAlert(alert: HealthAlert): Promise<void> {
        const topic = this.pubsub.topic('health-alerts');
        await topic.publish(Buffer.from(JSON.stringify(alert)));
    }

    private calculateOverallStatus(checks: HealthCheck[]): 'healthy' | 'degraded' | 'unhealthy' {
        const unhealthy = checks.some(check => check.status === 'unhealthy');
        if (unhealthy) return 'unhealthy';

        const degraded = checks.some(check => check.status === 'degraded');
        if (degraded) return 'degraded';

        return 'healthy';
    }

    private async handleError(type: string, error: Error): Promise<void> {
        await this.monitor.recordMetric({
            name: type,
            value: 1,
            labels: { error: error.message }
        });
    }

    // Health check implementations
    private async checkApiGateway(): Promise<Partial<HealthCheck['details']>> {
        // Implementation for API gateway health check
        return {
            latency: 50,
            errorRate: 0.01,
            resourceUsage: {
                cpu: 45,
                memory: 60,
                disk: 30
            }
        };
    }

    private async checkModelServing(): Promise<Partial<HealthCheck['details']>> {
        // Implementation for model serving health check
        return {
            latency: 100,
            errorRate: 0.02,
            resourceUsage: {
                cpu: 70,
                memory: 80,
                disk: 50
            }
        };
    }

    private async checkDatabase(): Promise<Partial<HealthCheck['details']>> {
        // Implementation for database health check
        return {
            latency: 20,
            errorRate: 0,
            resourceUsage: {
                cpu: 30,
                memory: 40,
                disk: 60
            }
        };
    }
}

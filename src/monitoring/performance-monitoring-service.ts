import { MonitoringService } from './monitoring-service';
import { MetricsCollector } from './metrics-collector';
import { AuditTrailService } from '../audit/audit-trail-service';
import { CloudMonitoring } from '@google-cloud/monitoring';

interface PerformanceMetrics {
    timestamp: Date;
    system: {
        cpu: {
            usage: number;
            temperature: number;
            throttling: boolean;
        };
        memory: {
            used: number;
            available: number;
            swapUsage: number;
        };
        gpu: {
            usage: number;
            temperature: number;
            memoryUsed: number;
        }[];
        network: {
            bytesIn: number;
            bytesOut: number;
            latency: number;
            errorRate: number;
        };
        disk: {
            read: number;
            write: number;
            utilization: number;
        };
    };
    application: {
        requests: {
            total: number;
            successful: number;
            failed: number;
            latency: {
                p50: number;
                p90: number;
                p99: number;
            };
        };
        model: {
            inferenceTime: number;
            throughput: number;
            errorRate: number;
            memoryUsage: number;
        };
    };
}

interface Alert {
    id: string;
    severity: 'critical' | 'high' | 'medium' | 'low';
    type: 'system' | 'application' | 'model';
    message: string;
    timestamp: Date;
    metrics: Partial<PerformanceMetrics>;
    status: 'active' | 'acknowledged' | 'resolved';
}

interface AlertRule {
    id: string;
    name: string;
    condition: (metrics: PerformanceMetrics) => boolean;
    severity: Alert['severity'];
    type: Alert['type'];
    message: string;
}

export class PerformanceMonitoringService {
    private monitor: MonitoringService;
    private metricsCollector: MetricsCollector;
    private audit: AuditTrailService;
    private cloudMonitoring: CloudMonitoring;
    private alertRules: Map<string, AlertRule>;
    private activeAlerts: Map<string, Alert>;
    private readonly COLLECTION_INTERVAL = 10000; // 10 seconds
    private readonly ALERT_CHECK_INTERVAL = 5000; // 5 seconds

    constructor(
        monitor: MonitoringService,
        metricsCollector: MetricsCollector,
        audit: AuditTrailService,
        projectId: string
    ) {
        this.monitor = monitor;
        this.metricsCollector = metricsCollector;
        this.audit = audit;
        this.cloudMonitoring = new CloudMonitoring({ projectId });
        this.alertRules = this.initializeAlertRules();
        this.activeAlerts = new Map();

        this.startMonitoring();
    }

    private initializeAlertRules(): Map<string, AlertRule> {
        const rules = new Map<string, AlertRule>();

        // CPU Usage Alert
        rules.set('cpu-high', {
            id: 'cpu-high',
            name: 'High CPU Usage',
            condition: (metrics) => metrics.system.cpu.usage > 0.9,
            severity: 'high',
            type: 'system',
            message: 'CPU usage exceeds 90%'
        });

        // Memory Alert
        rules.set('memory-high', {
            id: 'memory-high',
            name: 'High Memory Usage',
            condition: (metrics) => 
                metrics.system.memory.available / 
                (metrics.system.memory.used + metrics.system.memory.available) < 0.1,
            severity: 'critical',
            type: 'system',
            message: 'Available memory below 10%'
        });

        // Model Performance Alert
        rules.set('model-latency', {
            id: 'model-latency',
            name: 'High Model Latency',
            condition: (metrics) => metrics.application.model.inferenceTime > 1000,
            severity: 'high',
            type: 'model',
            message: 'Model inference time exceeds 1 second'
        });

        return rules;
    }

    private startMonitoring(): void {
        // Start metrics collection
        setInterval(async () => {
            try {
                await this.collectMetrics();
            } catch (error) {
                await this.handleError('metrics_collection_error', error);
            }
        }, this.COLLECTION_INTERVAL);

        // Start alert checking
        setInterval(async () => {
            try {
                await this.checkAlerts();
            } catch (error) {
                await this.handleError('alert_check_error', error);
            }
        }, this.ALERT_CHECK_INTERVAL);
    }

    async getMetrics(): Promise<PerformanceMetrics> {
        try {
            return await this.metricsCollector.collectMetrics();
        } catch (error) {
            await this.handleError('metrics_retrieval_error', error);
            throw error;
        }
    }

    async getActiveAlerts(): Promise<Alert[]> {
        return Array.from(this.activeAlerts.values());
    }

    async acknowledgeAlert(alertId: string): Promise<void> {
        const alert = this.activeAlerts.get(alertId);
        if (!alert) {
            throw new Error(`Alert not found: ${alertId}`);
        }

        alert.status = 'acknowledged';
        await this.audit.logEvent({
            eventType: 'system.config',
            actor: {
                id: 'system',
                type: 'service',
                metadata: {}
            },
            resource: {
                type: 'alert',
                id: alertId,
                action: 'acknowledge'
            },
            context: {
                location: 'performance-monitoring',
                ipAddress: 'internal',
                userAgent: 'system'
            },
            status: 'success',
            details: { alert }
        });
    }

    private async collectMetrics(): Promise<void> {
        const metrics = await this.getMetrics();
        
        // Store metrics in Cloud Monitoring
        await this.storeMetrics(metrics);

        // Record system metrics
        await this.monitor.recordMetric({
            name: 'system_metrics',
            value: metrics.system.cpu.usage,
            labels: {
                cpu_temp: metrics.system.cpu.temperature.toString(),
                memory_used: metrics.system.memory.used.toString()
            }
        });

        // Record application metrics
        await this.monitor.recordMetric({
            name: 'application_metrics',
            value: metrics.application.requests.latency.p99,
            labels: {
                success_rate: (
                    metrics.application.requests.successful /
                    metrics.application.requests.total
                ).toString()
            }
        });
    }

    private async storeMetrics(metrics: PerformanceMetrics): Promise<void> {
        // Implementation for storing metrics in Cloud Monitoring
    }

    private async checkAlerts(): Promise<void> {
        const metrics = await this.getMetrics();

        for (const rule of this.alertRules.values()) {
            const isTriggered = rule.condition(metrics);
            const alertId = `${rule.id}-${Date.now()}`;

            if (isTriggered && !this.hasActiveAlert(rule.id)) {
                const alert: Alert = {
                    id: alertId,
                    severity: rule.severity,
                    type: rule.type,
                    message: rule.message,
                    timestamp: new Date(),
                    metrics,
                    status: 'active'
                };

                this.activeAlerts.set(alertId, alert);
                await this.handleAlert(alert);
            }
        }
    }

    private hasActiveAlert(ruleId: string): boolean {
        return Array.from(this.activeAlerts.values()).some(
            alert => alert.id.startsWith(ruleId) && alert.status === 'active'
        );
    }

    private async handleAlert(alert: Alert): Promise<void> {
        await this.audit.logEvent({
            eventType: 'system.config',
            actor: {
                id: 'system',
                type: 'service',
                metadata: {}
            },
            resource: {
                type: 'alert',
                id: alert.id,
                action: 'create'
            },
            context: {
                location: 'performance-monitoring',
                ipAddress: 'internal',
                userAgent: 'system'
            },
            status: 'success',
            details: { alert }
        });

        await this.monitor.recordMetric({
            name: 'alert_triggered',
            value: 1,
            labels: {
                severity: alert.severity,
                type: alert.type
            }
        });
    }

    private async handleError(type: string, error: Error): Promise<void> {
        await this.monitor.recordMetric({
            name: type,
            value: 1,
            labels: { error: error.message }
        });
    }
}

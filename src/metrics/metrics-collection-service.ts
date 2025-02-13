import { CloudMonitoring } from '@google-cloud/monitoring';
import { AuditTrailService } from '../audit/audit-trail-service';
import { EventBusService } from '../events/event-bus-service';

interface MetricDefinition {
    name: string;
    description: string;
    type: 'gauge' | 'counter' | 'histogram';
    unit: string;
    labels: string[];
}

interface MetricValue {
    name: string;
    value: number;
    labels: Record<string, string>;
    timestamp?: Date;
}

interface MetricAlert {
    id: string;
    metricName: string;
    condition: {
        threshold: number;
        operator: '>' | '<' | '>=' | '<=' | '=';
        duration: number; // in seconds
    };
    severity: 'critical' | 'warning' | 'info';
    notificationChannels: string[];
}

export class MetricsCollectionService {
    private monitoring: CloudMonitoring;
    private audit: AuditTrailService;
    private eventBus: EventBusService;
    private metrics: Map<string, MetricDefinition>;
    private alerts: Map<string, MetricAlert>;
    private readonly projectPath: string;

    constructor(
        audit: AuditTrailService,
        eventBus: EventBusService,
        projectId: string
    ) {
        this.monitoring = new CloudMonitoring();
        this.audit = audit;
        this.eventBus = eventBus;
        this.metrics = new Map();
        this.alerts = new Map();
        this.projectPath = this.monitoring.projectPath(projectId);

        this.initialize();
    }

    private async initialize(): Promise<void> {
        await this.registerDefaultMetrics();
        await this.setupMetricAlerts();
    }

    async recordMetric(metric: MetricValue): Promise<void> {
        try {
            const definition = this.metrics.get(metric.name);
            if (!definition) {
                throw new Error(`Metric not registered: ${metric.name}`);
            }

            // Validate labels
            this.validateLabels(definition, metric.labels);

            // Create time series
            const timeSeries = {
                metric: {
                    type: `custom.googleapis.com/${metric.name}`,
                    labels: metric.labels
                },
                resource: {
                    type: 'global',
                    labels: {
                        project_id: this.projectPath.split('/')[1]
                    }
                },
                points: [
                    {
                        interval: {
                            endTime: {
                                seconds: Math.floor((metric.timestamp || new Date()).getTime() / 1000)
                            }
                        },
                        value: {
                            doubleValue: metric.value
                        }
                    }
                ]
            };

            // Write time series
            await this.monitoring.createTimeSeries({
                name: this.projectPath,
                timeSeries: [timeSeries]
            });

            // Check alerts
            await this.checkAlerts(metric);

            // Emit metric event
            await this.eventBus.publish('metrics.collected', {
                type: 'metric.recorded',
                source: 'metrics-service',
                data: metric,
                metadata: {
                    version: '1.0',
                    environment: process.env.NODE_ENV || 'development'
                }
            });

        } catch (error) {
            await this.handleError('metric_recording_error', error);
            throw error;
        }
    }

    async registerMetric(definition: MetricDefinition): Promise<void> {
        try {
            if (this.metrics.has(definition.name)) {
                throw new Error(`Metric already registered: ${definition.name}`);
            }

            // Create metric descriptor
            await this.monitoring.createMetricDescriptor({
                name: this.projectPath,
                metricDescriptor: {
                    name: definition.name,
                    displayName: definition.name,
                    description: definition.description,
                    type: `custom.googleapis.com/${definition.name}`,
                    metricKind: this.getMetricKind(definition.type),
                    valueType: 'DOUBLE',
                    unit: definition.unit,
                    labels: definition.labels.map(label => ({
                        key: label,
                        valueType: 'STRING',
                        description: `Label: ${label}`
                    }))
                }
            });

            this.metrics.set(definition.name, definition);

            await this.audit.logEvent({
                eventType: 'system.config',
                actor: {
                    id: 'system',
                    type: 'service',
                    metadata: {}
                },
                resource: {
                    type: 'metric',
                    id: definition.name,
                    action: 'register'
                },
                context: {
                    location: 'metrics-service',
                    ipAddress: 'internal',
                    userAgent: 'system'
                },
                status: 'success',
                details: { definition }
            });

        } catch (error) {
            await this.handleError('metric_registration_error', error);
            throw error;
        }
    }

    async createAlert(alert: MetricAlert): Promise<void> {
        try {
            if (!this.metrics.has(alert.metricName)) {
                throw new Error(`Metric not found: ${alert.metricName}`);
            }

            // Create alert policy
            const [policy] = await this.monitoring.createAlertPolicy({
                name: this.projectPath,
                alertPolicy: {
                    displayName: `Alert for ${alert.metricName}`,
                    documentation: {
                        content: `Alert for metric ${alert.metricName}`,
                        mimeType: 'text/markdown'
                    },
                    conditions: [{
                        displayName: `${alert.metricName} threshold`,
                        conditionThreshold: {
                            filter: `metric.type="custom.googleapis.com/${alert.metricName}"`,
                            comparison: this.getComparisonType(alert.condition.operator),
                            threshold: alert.condition.threshold,
                            duration: {
                                seconds: alert.condition.duration
                            },
                            trigger: {
                                count: 1
                            }
                        }
                    }],
                    combiner: 'OR',
                    notificationChannels: alert.notificationChannels
                }
            });

            this.alerts.set(alert.id, alert);

        } catch (error) {
            await this.handleError('alert_creation_error', error);
            throw error;
        }
    }

    private async registerDefaultMetrics(): Promise<void> {
        const defaultMetrics: MetricDefinition[] = [
            {
                name: 'model_inference_latency',
                description: 'Model inference latency in milliseconds',
                type: 'histogram',
                unit: 'ms',
                labels: ['model_id', 'version']
            },
            {
                name: 'api_request_count',
                description: 'API request count',
                type: 'counter',
                unit: '1',
                labels: ['endpoint', 'method', 'status']
            },
            {
                name: 'system_memory_usage',
                description: 'System memory usage',
                type: 'gauge',
                unit: 'By',
                labels: ['type']
            }
        ];

        for (const metric of defaultMetrics) {
            await this.registerMetric(metric);
        }
    }

    private async setupMetricAlerts(): Promise<void> {
        const defaultAlerts: MetricAlert[] = [
            {
                id: 'high-latency',
                metricName: 'model_inference_latency',
                condition: {
                    threshold: 1000,
                    operator: '>',
                    duration: 300
                },
                severity: 'warning',
                notificationChannels: []
            },
            {
                id: 'high-error-rate',
                metricName: 'api_request_count',
                condition: {
                    threshold: 0.1,
                    operator: '>',
                    duration: 300
                },
                severity: 'critical',
                notificationChannels: []
            }
        ];

        for (const alert of defaultAlerts) {
            await this.createAlert(alert);
        }
    }

    private async checkAlerts(metric: MetricValue): Promise<void> {
        const relevantAlerts = Array.from(this.alerts.values())
            .filter(alert => alert.metricName === metric.name);

        for (const alert of relevantAlerts) {
            const isTriggered = this.evaluateAlertCondition(alert, metric);
            if (isTriggered) {
                await this.triggerAlert(alert, metric);
            }
        }
    }

    private evaluateAlertCondition(alert: MetricAlert, metric: MetricValue): boolean {
        switch (alert.condition.operator) {
            case '>': return metric.value > alert.condition.threshold;
            case '<': return metric.value < alert.condition.threshold;
            case '>=': return metric.value >= alert.condition.threshold;
            case '<=': return metric.value <= alert.condition.threshold;
            case '=': return metric.value === alert.condition.threshold;
            default: return false;
        }
    }

    private async triggerAlert(alert: MetricAlert, metric: MetricValue): Promise<void> {
        await this.eventBus.publish('metrics.alert', {
            type: 'metric.alert',
            source: 'metrics-service',
            data: {
                alert,
                metric,
                timestamp: new Date()
            },
            metadata: {
                version: '1.0',
                environment: process.env.NODE_ENV || 'development'
            }
        });
    }

    private validateLabels(definition: MetricDefinition, labels: Record<string, string>): void {
        const providedLabels = Object.keys(labels);
        const requiredLabels = definition.labels;

        const missingLabels = requiredLabels.filter(label => !providedLabels.includes(label));
        if (missingLabels.length > 0) {
            throw new Error(`Missing required labels: ${missingLabels.join(', ')}`);
        }
    }

    private getMetricKind(type: MetricDefinition['type']): string {
        switch (type) {
            case 'gauge': return 'GAUGE';
            case 'counter': return 'CUMULATIVE';
            case 'histogram': return 'DISTRIBUTION';
            default: return 'GAUGE';
        }
    }

    private getComparisonType(operator: MetricAlert['condition']['operator']): string {
        switch (operator) {
            case '>': return 'COMPARISON_GT';
            case '<': return 'COMPARISON_LT';
            case '>=': return 'COMPARISON_GE';
            case '<=': return 'COMPARISON_LE';
            case '=': return 'COMPARISON_EQ';
            default: return 'COMPARISON_GT';
        }
    }

    private async handleError(type: string, error: Error): Promise<void> {
        await this.recordMetric({
            name: 'metrics_error',
            value: 1,
            labels: {
                error_type: type,
                error_message: error.message
            }
        });
    }
}

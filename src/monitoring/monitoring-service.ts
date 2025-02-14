import { EventBusService } from '../events/event-bus-service';
import { Monitoring } from '@google-cloud/monitoring';
import { ErrorReporting } from '@google-cloud/error-reporting';
import { Logging } from '@google-cloud/logging';
import { v4 as uuidv4 } from 'uuid';

interface Metric {
    name: string;
    value: number;
    labels?: Record<string, string>;
    timestamp?: Date;
}

interface Alert {
    id: string;
    name: string;
    condition: {
        metric: string;
        threshold: number;
        operator: 'gt' | 'lt' | 'eq' | 'gte' | 'lte';
        duration: number; // seconds
    };
    severity: 'critical' | 'high' | 'medium' | 'low';
    notificationChannels: string[];
    enabled: boolean;
    metadata: {
        created: Date;
        updated: Date;
        lastTriggered?: Date;
    };
}

interface AlertInstance {
    id: string;
    alertId: string;
    status: 'firing' | 'resolved';
    value: number;
    metadata: {
        startTime: Date;
        endTime?: Date;
        notifiedChannels: string[];
    };
}

export class MonitoringService {
    private monitoring: Monitoring;
    private errorReporting: ErrorReporting;
    private logging: Logging;
    private eventBus: EventBusService;
    private alerts: Map<string, Alert>;
    private activeAlerts: Map<string, AlertInstance>;
    private readonly ALERT_CHECK_INTERVAL = 60000; // 1 minute
    private readonly METRIC_PREFIX = 'custom.googleapis.com/supercoder';

    constructor(
        eventBus: EventBusService,
        config: {
            projectId: string;
        }
    ) {
        this.monitoring = new Monitoring({ projectId: config.projectId });
        this.errorReporting = new ErrorReporting({ projectId: config.projectId });
        this.logging = new Logging({ projectId: config.projectId });
        this.eventBus = eventBus;
        this.alerts = new Map();
        this.activeAlerts = new Map();

        this.initialize();
    }

    private async initialize(): Promise<void> {
        await this.setupInfrastructure();
        await this.loadAlerts();
        this.startAlertMonitoring();
        this.setupEventListeners();
    }

    async recordMetric(metric: Metric): Promise<void> {
        try {
            const timeSeriesData = {
                metric: {
                    type: `${this.METRIC_PREFIX}/${metric.name}`,
                    labels: metric.labels || {}
                },
                resource: {
                    type: 'global',
                    labels: {
                        project_id: process.env.PROJECT_ID!
                    }
                },
                points: [{
                    interval: {
                        endTime: {
                            seconds: Math.floor((metric.timestamp || new Date()).getTime() / 1000),
                            nanos: 0
                        }
                    },
                    value: {
                        doubleValue: metric.value
                    }
                }]
            };

            await this.monitoring.createTimeSeries({
                name: `projects/${process.env.PROJECT_ID}`,
                timeSeries: [timeSeriesData]
            });

            // Check alerts for this metric
            await this.checkAlertsForMetric(metric);

        } catch (error) {
            await this.handleError('metric_recording_error', error);
        }
    }

    async createAlert(alert: Omit<Alert, 'id' | 'metadata'>): Promise<string> {
        try {
            const alertId = uuidv4();
            const newAlert: Alert = {
                ...alert,
                id: alertId,
                metadata: {
                    created: new Date(),
                    updated: new Date()
                }
            };

            // Validate alert configuration
            await this.validateAlertConfig(newAlert);

            // Store alert
            await this.storeAlert(newAlert);
            this.alerts.set(alertId, newAlert);

            // Create cloud monitoring alert policy
            await this.createCloudAlertPolicy(newAlert);

            return alertId;

        } catch (error) {
            await this.handleError('alert_creation_error', error);
            throw error;
        }
    }

    async reportError(
        error: Error,
        context?: Record<string, any>
    ): Promise<void> {
        try {
            // Report to Error Reporting
            this.errorReporting.report(error, {
                ...context,
                time: new Date().toISOString()
            });

            // Log error
            const log = this.logging.log('errors');
            const metadata = {
                resource: {
                    type: 'global',
                    labels: {
                        project_id: process.env.PROJECT_ID!
                    }
                },
                severity: 'ERROR'
            };

            await log.write(log.entry(metadata, {
                error: error.message,
                stack: error.stack,
                context
            }));

            // Record error metric
            await this.recordMetric({
                name: 'errors',
                value: 1,
                labels: {
                    type: error.name,
                    message: error.message
                }
            });

            // Publish error event
            await this.eventBus.publish('monitoring.error', {
                type: 'error',
                source: 'monitoring',
                data: {
                    error: error.message,
                    stack: error.stack,
                    context,
                    timestamp: new Date()
                },
                metadata: {
                    severity: 'high',
                    environment: process.env.NODE_ENV || 'development'
                }
            });

        } catch (reportError) {
            console.error('Failed to report error:', reportError);
        }
    }

    private async checkAlertsForMetric(metric: Metric): Promise<void> {
        for (const alert of this.alerts.values()) {
            if (alert.enabled && alert.condition.metric === metric.name) {
                const isTriggered = this.evaluateAlertCondition(alert, metric.value);
                
                if (isTriggered) {
                    await this.triggerAlert(alert, metric.value);
                } else {
                    await this.resolveAlert(alert);
                }
            }
        }
    }

    private evaluateAlertCondition(alert: Alert, value: number): boolean {
        const { threshold, operator } = alert.condition;

        switch (operator) {
            case 'gt':
                return value > threshold;
            case 'lt':
                return value < threshold;
            case 'eq':
                return value === threshold;
            case 'gte':
                return value >= threshold;
            case 'lte':
                return value <= threshold;
            default:
                return false;
        }
    }

    private async triggerAlert(alert: Alert, value: number): Promise<void> {
        const existingInstance = Array.from(this.activeAlerts.values())
            .find(a => a.alertId === alert.id);

        if (!existingInstance) {
            const instance: AlertInstance = {
                id: uuidv4(),
                alertId: alert.id,
                status: 'firing',
                value,
                metadata: {
                    startTime: new Date(),
                    notifiedChannels: []
                }
            };

            this.activeAlerts.set(instance.id, instance);
            await this.notifyAlertChannels(alert, instance);

            // Update alert metadata
            alert.metadata.lastTriggered = new Date();
            await this.updateAlert(alert);
        }
    }

    private async resolveAlert(alert: Alert): Promise<void> {
        const instance = Array.from(this.activeAlerts.values())
            .find(a => a.alertId === alert.id);

        if (instance && instance.status === 'firing') {
            instance.status = 'resolved';
            instance.metadata.endTime = new Date();

            await this.notifyAlertResolution(alert, instance);
            this.activeAlerts.delete(instance.id);
        }
    }

    private async notifyAlertChannels(alert: Alert, instance: AlertInstance): Promise<void> {
        for (const channel of alert.notificationChannels) {
            try {
                await this.sendNotification(channel, {
                    type: 'alert_triggered',
                    alert: {
                        name: alert.name,
                        severity: alert.severity,
                        value: instance.value,
                        threshold: alert.condition.threshold,
                        timestamp: instance.metadata.startTime
                    }
                });

                instance.metadata.notifiedChannels.push(channel);

            } catch (error) {
                await this.handleError('notification_error', error);
            }
        }
    }

    private async notifyAlertResolution(alert: Alert, instance: AlertInstance): Promise<void> {
        for (const channel of alert.notificationChannels) {
            try {
                await this.sendNotification(channel, {
                    type: 'alert_resolved',
                    alert: {
                        name: alert.name,
                        severity: alert.severity,
                        duration: instance.metadata.endTime!.getTime() - 
                                instance.metadata.startTime.getTime(),
                        timestamp: instance.metadata.endTime
                    }
                });

            } catch (error) {
                await this.handleError('notification_error', error);
            }
        }
    }

    private async sendNotification(channel: string, message: any): Promise<void> {
        // Implement notification sending logic based on channel type
        // This could integrate with various notification services
    }

    private async validateAlertConfig(alert: Alert): Promise<void> {
        if (!alert.name || !alert.condition || !alert.notificationChannels.length) {
            throw new Error('Invalid alert configuration');
        }

        if (!['gt', 'lt', 'eq', 'gte', 'lte'].includes(alert.condition.operator)) {
            throw new Error('Invalid alert condition operator');
        }

        if (alert.condition.duration < 0) {
            throw new Error('Invalid alert condition duration');
        }
    }

    private async createCloudAlertPolicy(alert: Alert): Promise<void> {
        const policy = {
            displayName: alert.name,
            conditions: [{
                displayName: `${alert.name} condition`,
                conditionThreshold: {
                    filter: `metric.type="${this.METRIC_PREFIX}/${alert.condition.metric}"`,
                    comparison: this.translateOperator(alert.condition.operator),
                    threshold: alert.condition.threshold,
                    duration: {
                        seconds: alert.condition.duration
                    },
                    trigger: {
                        count: 1
                    }
                }
            }],
            alertStrategy: {
                notificationRate: {
                    period: {
                        seconds: 300 // 5 minutes
                    }
                }
            },
            notificationChannels: alert.notificationChannels
        };

        await this.monitoring.createAlertPolicy({
            name: `projects/${process.env.PROJECT_ID}`,
            alertPolicy: policy
        });
    }

    private translateOperator(operator: Alert['condition']['operator']): string {
        const mapping: Record<string, string> = {
            'gt': 'GREATER_THAN',
            'lt': 'LESS_THAN',
            'eq': 'EQUAL_TO',
            'gte': 'GREATER_THAN_OR_EQUAL_TO',
            'lte': 'LESS_THAN_OR_EQUAL_TO'
        };
        return mapping[operator];
    }

    private async setupInfrastructure(): Promise<void> {
        // Set up custom metrics descriptor
        await this.monitoring.createMetricDescriptor({
            name: `projects/${process.env.PROJECT_ID}/metricDescriptors/${this.METRIC_PREFIX}`,
            metricDescriptor: {
                displayName: 'SuperCoder Custom Metrics',
                description: 'Custom metrics for SuperCoder platform',
                type: this.METRIC_PREFIX,
                metricKind: 'GAUGE',
                valueType: 'DOUBLE',
                labels: [{
                    key: 'component',
                    valueType: 'STRING',
                    description: 'Component generating the metric'
                }]
            }
        });
    }

    private async loadAlerts(): Promise<void> {
        const [policies] = await this.monitoring.listAlertPolicies({
            name: `projects/${process.env.PROJECT_ID}`
        });

        for (const policy of policies) {
            const alert = this.convertPolicyToAlert(policy);
            this.alerts.set(alert.id, alert);
        }
    }

    private convertPolicyToAlert(policy: any): Alert {
        return {
            id: policy.name.split('/').pop()!,
            name: policy.displayName,
            condition: this.extractConditionFromPolicy(policy),
            severity: this.determineSeverityFromPolicy(policy),
            notificationChannels: policy.notificationChannels || [],
            enabled: policy.enabled,
            metadata: {
                created: new Date(policy.creationRecord.mutateTime),
                updated: new Date(policy.mutationRecord.mutateTime)
            }
        };
    }

    private extractConditionFromPolicy(policy: any): Alert['condition'] {
        const condition = policy.conditions[0];
        return {
            metric: condition.conditionThreshold.filter.split('"')[1].split('/').pop(),
            threshold: condition.conditionThreshold.threshold,
            operator: this.reverseTranslateOperator(condition.conditionThreshold.comparison),
            duration: parseInt(condition.conditionThreshold.duration.seconds)
        };
    }

    private reverseTranslateOperator(cloudOperator: string): Alert['condition']['operator'] {
        const mapping: Record<string, Alert['condition']['operator']> = {
            'GREATER_THAN': 'gt',
            'LESS_THAN': 'lt',
            'EQUAL_TO': 'eq',
            'GREATER_THAN_OR_EQUAL_TO': 'gte',
            'LESS_THAN_OR_EQUAL_TO': 'lte'
        };
        return mapping[cloudOperator];
    }

    private determineSeverityFromPolicy(policy: any): Alert['severity'] {
        if (policy.userLabels?.severity) {
            return policy.userLabels.severity;
        }
        return 'medium';
    }

    private async storeAlert(alert: Alert): Promise<void> {
        // Store in Cloud Monitoring
        await this.createCloudAlertPolicy(alert);
    }

    private async updateAlert(alert: Alert): Promise<void> {
        this.alerts.set(alert.id, alert);
        await this.updateCloudAlertPolicy(alert);
    }

    private async updateCloudAlertPolicy(alert: Alert): Promise<void> {
        // Update Cloud Monitoring alert policy
    }

    private startAlertMonitoring(): void {
        setInterval(async () => {
            try {
                await this.checkActiveAlerts();
            } catch (error) {
                await this.handleError('alert_monitoring_error', error);
            }
        }, this.ALERT_CHECK_INTERVAL);
    }

    private async checkActiveAlerts(): Promise<void> {
        for (const instance of this.activeAlerts.values()) {
            const alert = this.alerts.get(instance.alertId);
            if (alert) {
                // Re-evaluate alert condition
                const metric = await this.getLatestMetricValue(alert.condition.metric);
                if (metric && !this.evaluateAlertCondition(alert, metric)) {
                    await this.resolveAlert(alert);
                }
            }
        }
    }

    private async getLatestMetricValue(metricName: string): Promise<number | null> {
        try {
            const [timeSeries] = await this.monitoring.listTimeSeries({
                name: `projects/${process.env.PROJECT_ID}`,
                filter: `metric.type="${this.METRIC_PREFIX}/${metricName}"`,
                interval: {
                    startTime: {
                        seconds: Math.floor(Date.now() / 1000) - 300 // Last 5 minutes
                    },
                    endTime: {
                        seconds: Math.floor(Date.now() / 1000)
                    }
                },
                orderBy: 'timestamp desc',
                pageSize: 1
            });

            if (timeSeries && timeSeries[0]?.points[0]?.value?.doubleValue) {
                return timeSeries[0].points[0].value.doubleValue;
            }

            return null;

        } catch (error) {
            await this.handleError('metric_fetch_error', error);
            return null;
        }
    }

    private setupEventListeners(): void {
        this.eventBus.subscribe({
            id: 'monitoring-service',
            topic: 'system.metrics',
            handler: async (event) => {
                if (event.data.type === 'metric') {
                    await this.recordMetric(event.data.metric);
                }
            }
        });
    }

    private async handleError(type: string, error: Error): Promise<void> {
        console.error(`Monitoring error (${type}):`, error);
        
        await this.reportError(error, {
            component: 'monitoring',
            type
        });
    }
}

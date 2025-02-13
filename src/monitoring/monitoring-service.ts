import { Monitoring } from '@google-cloud/monitoring';
import { ErrorReporting } from '@google-cloud/error-reporting';
import { PubSub } from '@google-cloud/pubsub';
import { BigQuery } from '@google-cloud/bigquery';
import { Alert } from '@google-cloud/monitoring/build/protos/protos';
import { v4 as uuidv4 } from 'uuid';

interface MetricData {
    name: string;
    value: number;
    labels: Record<string, string>;
    timestamp?: Date;
}

interface AlertConfig {
    name: string;
    metric: string;
    condition: {
        type: 'threshold' | 'absence' | 'rate';
        value: number;
        duration: number; // seconds
    };
    severity: 'critical' | 'error' | 'warning' | 'info';
    labels?: Record<string, string>;
    notification: {
        channels: ('email' | 'slack' | 'pagerduty')[];
        message: string;
    };
}

interface SystemHealth {
    status: 'healthy' | 'degraded' | 'critical';
    components: {
        [key: string]: {
            status: 'up' | 'down' | 'degraded';
            lastCheck: Date;
            metrics: Record<string, number>;
        };
    };
    metrics: {
        cpu: number;
        memory: number;
        latency: number;
        errorRate: number;
    };
    lastUpdated: Date;
}

export class MonitoringService {
    private monitoring: Monitoring;
    private errorReporting: ErrorReporting;
    private pubsub: PubSub;
    private bigquery: BigQuery;
    private alertConfigs: Map<string, AlertConfig>;
    private readonly projectId: string;
    private readonly metricPrefix: string;
    private readonly HEALTH_CHECK_INTERVAL = 60000; // 1 minute
    private readonly METRIC_BATCH_SIZE = 100;
    private readonly METRIC_FLUSH_INTERVAL = 10000; // 10 seconds

    private metricBuffer: MetricData[] = [];
    private flushTimeout: NodeJS.Timeout | null = null;

    constructor(config: {
        projectId: string;
        metricPrefix?: string;
    }) {
        this.projectId = config.projectId;
        this.metricPrefix = config.metricPrefix || 'custom';
        this.monitoring = new Monitoring({ projectId: this.projectId });
        this.errorReporting = new ErrorReporting({ projectId: this.projectId });
        this.pubsub = new PubSub({ projectId: this.projectId });
        this.bigquery = new BigQuery({ projectId: this.projectId });
        this.alertConfigs = new Map();

        this.initialize();
    }

    private async initialize(): Promise<void> {
        await this.setupInfrastructure();
        await this.loadAlertConfigs();
        this.startHealthChecks();
        this.setupMetricFlushing();
    }

    async recordMetric(data: MetricData): Promise<void> {
        try {
            // Add timestamp if not provided
            const metric = {
                ...data,
                timestamp: data.timestamp || new Date()
            };

            // Add to buffer
            this.metricBuffer.push(metric);

            // Flush if buffer is full
            if (this.metricBuffer.length >= this.METRIC_BATCH_SIZE) {
                await this.flushMetrics();
            }

            // Schedule flush if not already scheduled
            if (!this.flushTimeout) {
                this.flushTimeout = setTimeout(
                    () => this.flushMetrics(),
                    this.METRIC_FLUSH_INTERVAL
                );
            }

            // Check for alerts
            await this.checkAlerts(metric);

        } catch (error) {
            this.handleError('metric_recording_error', error);
        }
    }

    async createAlert(config: AlertConfig): Promise<void> {
        try {
            // Validate alert configuration
            this.validateAlertConfig(config);

            // Create alert policy
            const [policy] = await this.monitoring.createAlertPolicy({
                displayName: config.name,
                conditions: [{
                    displayName: `${config.name}_condition`,
                    conditionThreshold: {
                        filter: `metric.type="${this.metricPrefix}/${config.metric}"`,
                        comparison: Alert.ComparisonType.COMPARISON_GT,
                        thresholdValue: config.condition.value,
                        duration: { seconds: config.condition.duration },
                        trigger: { count: 1 }
                    }
                }],
                combiner: Alert.ConditionCombinerType.AND,
                notificationChannels: await this.getNotificationChannels(config.notification.channels)
            });

            // Store alert config
            this.alertConfigs.set(config.name, config);

            // Store in BigQuery for persistence
            await this.storeAlertConfig(config);

        } catch (error) {
            this.handleError('alert_creation_error', error);
            throw error;
        }
    }

    async getSystemHealth(): Promise<SystemHealth> {
        try {
            const components = await this.checkComponentHealth();
            const metrics = await this.collectSystemMetrics();

            const health: SystemHealth = {
                status: this.determineOverallHealth(components, metrics),
                components,
                metrics,
                lastUpdated: new Date()
            };

            // Store health status
            await this.storeHealthStatus(health);

            return health;

        } catch (error) {
            this.handleError('health_check_error', error);
            throw error;
        }
    }

    private async flushMetrics(): Promise<void> {
        if (this.metricBuffer.length === 0) return;

        try {
            const metrics = this.metricBuffer;
            this.metricBuffer = [];

            if (this.flushTimeout) {
                clearTimeout(this.flushTimeout);
                this.flushTimeout = null;
            }

            // Write to Cloud Monitoring
            await this.writeToCloudMonitoring(metrics);

            // Store in BigQuery for long-term analysis
            await this.storeMetrics(metrics);

        } catch (error) {
            this.handleError('metric_flush_error', error);
            // Restore metrics to buffer on error
            this.metricBuffer = [...metrics, ...this.metricBuffer];
        }
    }

    private async writeToCloudMonitoring(metrics: MetricData[]): Promise<void> {
        const timeSeries = metrics.map(metric => ({
            metric: {
                type: `${this.metricPrefix}/${metric.name}`,
                labels: metric.labels
            },
            resource: {
                type: 'global',
                labels: {
                    project_id: this.projectId
                }
            },
            points: [{
                interval: {
                    endTime: {
                        seconds: Math.floor(metric.timestamp!.getTime() / 1000),
                        nanos: (metric.timestamp!.getTime() % 1000) * 1e6
                    }
                },
                value: {
                    doubleValue: metric.value
                }
            }]
        }));

        await this.monitoring.createTimeSeries({
            name: `projects/${this.projectId}`,
            timeSeries
        });
    }

    private async checkAlerts(metric: MetricData): Promise<void> {
        for (const [name, config] of this.alertConfigs.entries()) {
            if (config.metric === metric.name) {
                const triggered = this.evaluateAlertCondition(config, metric);
                if (triggered) {
                    await this.triggerAlert(config, metric);
                }
            }
        }
    }

    private evaluateAlertCondition(
        config: AlertConfig,
        metric: MetricData
    ): boolean {
        switch (config.condition.type) {
            case 'threshold':
                return metric.value > config.condition.value;
            case 'absence':
                return metric.value === 0;
            case 'rate':
                // Implement rate-based alerting
                return false;
            default:
                return false;
        }
    }

    private async triggerAlert(
        config: AlertConfig,
        metric: MetricData
    ): Promise<void> {
        const alertId = uuidv4();
        const alert = {
            id: alertId,
            name: config.name,
            severity: config.severity,
            metric: metric.name,
            value: metric.value,
            timestamp: new Date(),
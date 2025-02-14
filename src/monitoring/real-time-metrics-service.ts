import { MonitoringService } from './monitoring-service';
import { EventBusService } from '../events/event-bus-service';
import { CloudMonitoring } from '@google-cloud/monitoring';
import { BigQuery } from '@google-cloud/bigquery';
import { createClient as createRedisClient } from 'redis';
import { v4 as uuidv4 } from 'uuid';

interface MetricDefinition {
    name: string;
    description: string;
    type: 'counter' | 'gauge' | 'histogram';
    unit: string;
    labels: string[];
    thresholds?: {
        warning?: number;
        critical?: number;
    };
}

interface MetricValue {
    name: string;
    value: number;
    timestamp: Date;
    labels: Record<string, string>;
}

interface MetricAlert {
    id: string;
    metricName: string;
    threshold: number;
    value: number;
    level: 'warning' | 'critical';
    labels: Record<string, string>;
    timestamp: Date;
}

interface TimeSeriesData {
    metric: string;
    points: Array<{
        value: number;
        timestamp: Date;
        labels: Record<string, string>;
    }>;
}

export class RealTimeMetricsService {
    private cloudMonitoring: CloudMonitoring;
    private bigquery: BigQuery;
    private redis: ReturnType<typeof createRedisClient>;
    private metrics: Map<string, MetricDefinition>;
    private alerts: Map<string, MetricAlert>;
    private readonly ALERT_TTL = 3600; // 1 hour
    private readonly METRIC_TTL = 86400; // 24 hours

    constructor(
        private monitor: MonitoringService,
        private eventBus: EventBusService,
        private config: {
            projectId: string;
            location: string;
            redisUrl: string;
        }
    ) {
        this.cloudMonitoring = new CloudMonitoring({
            projectId: config.projectId
        });
        this.bigquery = new BigQuery({ projectId: config.projectId });
        this.redis = createRedisClient({ url: config.redisUrl });
        this.metrics = new Map();
        this.alerts = new Map();
        this.initialize();
    }

    private async initialize(): Promise<void> {
        await this.redis.connect();
        await this.setupMetricDefinitions();
        await this.setupEventListeners();
        this.startPeriodicTasks();
    }

    async recordMetric(metric: MetricValue): Promise<void> {
        try {
            const definition = this.metrics.get(metric.name);
            if (!definition) {
                throw new Error(`Metric ${metric.name} not defined`);
            }

            // Validate labels
            this.validateLabels(metric.labels, definition.labels);

            // Store metric
            await this.storeMetric(metric);

            // Check thresholds
            if (definition.thresholds) {
                await this.checkThresholds(metric, definition.thresholds);
            }

            // Emit real-time update
            await this.emitMetricUpdate(metric);

        } catch (error) {
            await this.handleError('metric_recording_error', error);
        }
    }

    async getMetricTimeSeries(
        metricName: string,
        timeframe: '5m' | '1h' | '24h',
        resolution: '1s' | '1m' | '5m'
    ): Promise<TimeSeriesData> {
        try {
            const query = this.buildTimeSeriesQuery(metricName, timeframe, resolution);
            const [rows] = await this.bigquery.query({ query });

            return {
                metric: metricName,
                points: rows.map(row => ({
                    value: row.value,
                    timestamp: new Date(row.timestamp),
                    labels: JSON.parse(row.labels)
                }))
            };

        } catch (error) {
            await this.handleError('time_series_error', error);
            throw error;
        }
    }

    async getActiveAlerts(): Promise<MetricAlert[]> {
        return Array.from(this.alerts.values());
    }

    async acknowledgeAlert(alertId: string): Promise<void> {
        const alert = this.alerts.get(alertId);
        if (alert) {
            this.alerts.delete(alertId);
            await this.redis.del(`alert:${alertId}`);
        }
    }

    private async storeMetric(metric: MetricValue): Promise<void> {
        // Store in Redis for real-time access
        const key = `metric:${metric.name}:${Date.now()}`;
        await this.redis.setEx(
            key,
            this.METRIC_TTL,
            JSON.stringify(metric)
        );

        // Store in BigQuery for historical analysis
        await this.bigquery
            .dataset('monitoring')
            .table('metrics')
            .insert([{
                name: metric.name,
                value: metric.value,
                timestamp: metric.timestamp,
                labels: JSON.stringify(metric.labels)
            }]);

        // Send to Cloud Monitoring
        await this.sendToCloudMonitoring(metric);
    }

    private async sendToCloudMonitoring(metric: MetricValue): Promise<void> {
        const metricType = `custom.googleapis.com/${metric.name}`;
        
        const request = {
            name: this.cloudMonitoring.projectPath(this.config.projectId),
            timeSeries: [{
                metric: {
                    type: metricType,
                    labels: metric.labels
                },
                resource: {
                    type: 'global',
                    labels: {
                        project_id: this.config.projectId
                    }
                },
                points: [{
                    interval: {
                        endTime: {
                            seconds: Math.floor(metric.timestamp.getTime() / 1000),
                            nanos: (metric.timestamp.getTime() % 1000) * 1e6
                        }
                    },
                    value: {
                        doubleValue: metric.value
                    }
                }]
            }]
        };

        await this.cloudMonitoring.createTimeSeries(request);
    }

    private async checkThresholds(
        metric: MetricValue,
        thresholds: NonNullable<MetricDefinition['thresholds']>
    ): Promise<void> {
        if (thresholds.critical && metric.value >= thresholds.critical) {
            await this.createAlert(metric, 'critical', thresholds.critical);
        } else if (thresholds.warning && metric.value >= thresholds.warning) {
            await this.createAlert(metric, 'warning', thresholds.warning);
        }
    }

    private async createAlert(
        metric: MetricValue,
        level: MetricAlert['level'],
        threshold: number
    ): Promise<void> {
        const alert: MetricAlert = {
            id: uuidv4(),
            metricName: metric.name,
            threshold,
            value: metric.value,
            level,
            labels: metric.labels,
            timestamp: new Date()
        };

        // Store alert
        this.alerts.set(alert.id, alert);
        await this.redis.setEx(
            `alert:${alert.id}`,
            this.ALERT_TTL,
            JSON.stringify(alert)
        );

        // Emit alert event
        await this.eventBus.publish('metrics.alert', {
            type: 'metrics.alert',
            source: 'real-time-metrics',
            data: alert
        });
    }

    private async emitMetricUpdate(metric: MetricValue): Promise<void> {
        await this.eventBus.publish('metrics.update', {
            type: 'metrics.update',
            source: 'real-time-metrics',
            data: metric
        });
    }

    private buildTimeSeriesQuery(
        metricName: string,
        timeframe: string,
        resolution: string
    ): string {
        const interval = this.getQueryInterval(resolution);
        const range = this.getQueryRange(timeframe);

        return `
            SELECT
                TIMESTAMP_TRUNC(timestamp, ${interval}) as timestamp,
                AVG(value) as value,
                labels
            FROM monitoring.metrics
            WHERE
                name = @metricName
                AND timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), ${range})
            GROUP BY timestamp, labels
            ORDER BY timestamp ASC
        `;
    }

    private getQueryInterval(resolution: string): string {
        switch (resolution) {
            case '1s': return 'SECOND';
            case '1m': return 'MINUTE';
            case '5m': return 'MINUTE_5';
            default: return 'MINUTE';
        }
    }

    private getQueryRange(timeframe: string): string {
        switch (timeframe) {
            case '5m': return 'INTERVAL 5 MINUTE';
            case '1h': return 'INTERVAL 1 HOUR';
            case '24h': return 'INTERVAL 24 HOUR';
            default: return 'INTERVAL 1 HOUR';
        }
    }

    private validateLabels(
        labels: Record<string, string>,
        requiredLabels: string[]
    ): void {
        for (const label of requiredLabels) {
            if (!labels[label]) {
                throw new Error(`Missing required label: ${label}`);
            }
        }
    }

    private async setupMetricDefinitions(): Promise<void> {
        // Load metric definitions from configuration or database
        const definitions: MetricDefinition[] = [
            {
                name: 'request_latency',
                description: 'API request latency in milliseconds',
                type: 'histogram',
                unit: 'ms',
                labels: ['endpoint', 'method'],
                thresholds: {
                    warning: 1000,
                    critical: 2000
                }
            },
            {
                name: 'error_rate',
                description: 'Error rate percentage',
                type: 'gauge',
                unit: 'percent',
                labels: ['service'],
                thresholds: {
                    warning: 5,
                    critical: 10
                }
            }
            // Add more metric definitions
        ];

        for (const def of definitions) {
            this.metrics.set(def.name, def);
        }
    }

    private setupEventListeners(): void {
        this.eventBus.subscribe({
            id: 'metrics-monitor',
            topic: 'system.health',
            handler: async (event) => {
                if (event.data.type === 'health_check') {
                    await this.recordMetric({
                        name: 'system_health',
                        value: event.data.status === 'healthy' ? 1 : 0,
                        timestamp: new Date(),
                        labels: {
                            service: event.data.service
                        }
                    });
                }
            }
        });
    }

    private startPeriodicTasks(): void {
        // Clean up old alerts
        setInterval(async () => {
            const now = Date.now();
            for (const [id, alert] of this.alerts) {
                if (now - alert.timestamp.getTime() > this.ALERT_TTL * 1000) {
                    this.alerts.delete(id);
                }
            }
        }, 300000); // Every 5 minutes
    }

    private async handleError(type: string, error: Error): Promise<void> {
        await this.monitor.recordMetric({
            name: `metrics_service_${type}`,
            value: 1,
            labels: { error: error.message }
        });

        await this.eventBus.publish('metrics.error', {
            type: 'metrics.error',
            source: 'real-time-metrics',
            data: {
                error: error.message,
                type,
                timestamp: new Date()
            }
        });
    }

    async close(): Promise<void> {
        await this.redis.quit();
    }
}

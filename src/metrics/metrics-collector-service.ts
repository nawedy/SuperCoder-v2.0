import { CloudMonitoring } from '@google-cloud/monitoring';
import { BigQuery } from '@google-cloud/bigquery';
import { Redis } from 'ioredis';
import { AuditTrailService } from '../audit/audit-trail-service';
import { EventBusService } from '../events/event-bus-service';

interface MetricPoint {
    name: string;
    value: number;
    timestamp: Date;
    labels: Record<string, string>;
    type: 'gauge' | 'counter' | 'histogram';
}

interface MetricBatch {
    id: string;
    metrics: MetricPoint[];
    timestamp: Date;
    metadata: {
        source: string;
        environment: string;
        version: string;
    };
}

interface MetricAlert {
    id: string;
    metricName: string;
    condition: {
        operator: '>' | '<' | '=' | '>=' | '<=';
        threshold: number;
        duration: number; // seconds
    };
    severity: 'critical' | 'warning' | 'info';
    status: 'active' | 'resolved';
    lastTriggered?: Date;
    notificationChannels: string[];
}

export class MetricsCollectorService {
    private cloudMonitoring: CloudMonitoring;
    private bigquery: BigQuery;
    private redis: Redis;
    private audit: AuditTrailService;
    private eventBus: EventBusService;
    private metricBuffer: Map<string, MetricPoint[]>;
    private alerts: Map<string, MetricAlert>;
    private readonly BUFFER_FLUSH_INTERVAL = 10000; // 10 seconds
    private readonly BUFFER_SIZE_LIMIT = 1000;
    private readonly METRIC_TTL = 86400; // 1 day in seconds

    constructor(
        audit: AuditTrailService,
        eventBus: EventBusService,
        projectId: string,
        redisUrl: string
    ) {
        this.cloudMonitoring = new CloudMonitoring();
        this.bigquery = new BigQuery({ projectId });
        this.redis = new Redis(redisUrl);
        this.audit = audit;
        this.eventBus = eventBus;
        this.metricBuffer = new Map();
        this.alerts = new Map();

        this.initialize();
    }

    private async initialize(): Promise<void> {
        await this.ensureInfrastructure();
        this.startBufferFlush();
        this.startAlertChecking();
    }

    async recordMetric(point: Omit<MetricPoint, 'timestamp'>): Promise<void> {
        try {
            const metric: MetricPoint = {
                ...point,
                timestamp: new Date()
            };

            // Add to buffer
            const buffer = this.metricBuffer.get(metric.name) || [];
            buffer.push(metric);
            this.metricBuffer.set(metric.name, buffer);

            // Store in Redis for real-time access
            await this.storeMetricInRedis(metric);

            // Check if buffer needs to be flushed
            if (buffer.length >= this.BUFFER_SIZE_LIMIT) {
                await this.flushMetricBuffer(metric.name);
            }

            // Check alerts
            await this.checkAlerts(metric);

        } catch (error) {
            await this.handleError('metric_recording_error', error);
            throw error;
        }
    }

    async getMetrics(
        name: string,
        timeRange: { start: Date; end: Date },
        labels?: Record<string, string>
    ): Promise<MetricPoint[]> {
        try {
            // Try Redis first for recent metrics
            const recentMetrics = await this.getRecentMetrics(name, labels);

            // Query BigQuery for historical metrics
            const historicalMetrics = await this.queryHistoricalMetrics(
                name,
                timeRange,
                labels
            );

            return [...recentMetrics, ...historicalMetrics];

        } catch (error) {
            await this.handleError('metric_retrieval_error', error);
            throw error;
        }
    }

    async createAlert(alert: Omit<MetricAlert, 'id' | 'status'>): Promise<string> {
        try {
            const alertId = this.generateAlertId();
            const newAlert: MetricAlert = {
                ...alert,
                id: alertId,
                status: 'active'
            };

            // Store alert
            this.alerts.set(alertId, newAlert);

            // Create Cloud Monitoring alert policy
            await this.createCloudMonitoringAlert(newAlert);

            await this.audit.logEvent({
                eventType: 'system.config',
                actor: {
                    id: 'system',
                    type: 'service',
                    metadata: {}
                },
                resource: {
                    type: 'metric-alert',
                    id: alertId,
                    action: 'create'
                },
                context: {
                    location: 'metrics-collector',
                    ipAddress: 'internal',
                    userAgent: 'system'
                },
                status: 'success',
                details: { alert: newAlert }
            });

            return alertId;

        } catch (error) {
            await this.handleError('alert_creation_error', error);
            throw error;
        }
    }

    private async ensureInfrastructure(): Promise<void> {
        try {
            // Ensure BigQuery dataset exists
            const dataset = this.bigquery.dataset('metrics');
            const [datasetExists] = await dataset.exists();
            if (!datasetExists) {
                await dataset.create();
                await this.createMetricsTable(dataset);
            }
        } catch (error) {
            console.error('Failed to initialize metrics infrastructure:', error);
            throw error;
        }
    }

    private async createMetricsTable(dataset: any): Promise<void> {
        const schema = {
            fields: [
                { name: 'name', type: 'STRING' },
                { name: 'value', type: 'FLOAT' },
                { name: 'timestamp', type: 'TIMESTAMP' },
                { name: 'labels', type: 'JSON' },
                { name: 'type', type: 'STRING' }
            ]
        };

        await dataset.createTable('timeseries', { schema });
    }

    private async storeMetricInRedis(metric: MetricPoint): Promise<void> {
        const key = this.buildRedisKey(metric);
        await this.redis.zadd(
            key,
            metric.timestamp.getTime(),
            JSON.stringify(metric)
        );
        await this.redis.expire(key, this.METRIC_TTL);
    }

    private async getRecentMetrics(
        name: string,
        labels?: Record<string, string>
    ): Promise<MetricPoint[]> {
        const key = this.buildRedisKey({ name, labels } as MetricPoint);
        const data = await this.redis.zrange(key, 0, -1);
        return data.map(item => JSON.parse(item));
    }

    private async queryHistoricalMetrics(
        name: string,
        timeRange: { start: Date; end: Date },
        labels?: Record<string, string>
    ): Promise<MetricPoint[]> {
        const query = `
            SELECT *
            FROM \`metrics.timeseries\`
            WHERE name = @name
            AND timestamp BETWEEN @start AND @end
            ${labels ? 'AND JSON_EXTRACT(labels, "$") = @labels' : ''}
            ORDER BY timestamp DESC
        `;

        const [rows] = await this.bigquery.query({
            query,
            params: {
                name,
                start: timeRange.start,
                end: timeRange.end,
                labels: labels ? JSON.stringify(labels) : undefined
            }
        });

        return rows.map(row => ({
            ...row,
            labels: JSON.parse(row.labels)
        }));
    }

    private async flushMetricBuffer(metricName?: string): Promise<void> {
        const metricsToFlush = metricName 
            ? [[metricName, this.metricBuffer.get(metricName)]]
            : Array.from(this.metricBuffer.entries());

        for (const [name, metrics] of metricsToFlush) {
            if (!metrics?.length) continue;

            const batch: MetricBatch = {
                id: this.generateBatchId(),
                metrics,
                timestamp: new Date(),
                metadata: {
                    source: 'metrics-collector',
                    environment: process.env.NODE_ENV || 'development',
                    version: '1.0.0'
                }
            };

            try {
                // Write to BigQuery
                await this.bigquery
                    .dataset('metrics')
                    .table('timeseries')
                    .insert(metrics.map(m => ({
                        ...m,
                        timestamp: m.timestamp.toISOString(),
                        labels: JSON.stringify(m.labels)
                    })));

                // Write to Cloud Monitoring
                await this.writeToCloudMonitoring(batch);

                // Clear buffer
                this.metricBuffer.set(name, []);

            } catch (error) {
                await this.handleError('metric_flush_error', error);
            }
        }
    }

    private async writeToCloudMonitoring(batch: MetricBatch): Promise<void> {
        const timeSeries = batch.metrics.map(metric => ({
            metric: {
                type: `custom.googleapis.com/${metric.name}`,
                labels: metric.labels
            },
            points: [{
                interval: {
                    endTime: {
                        seconds: Math.floor(metric.timestamp.getTime() / 1000)
                    }
                },
                value: {
                    doubleValue: metric.value
                }
            }]
        }));

        await this.cloudMonitoring.createTimeSeries({
            name: this.cloudMonitoring.projectPath,
            timeSeries
        });
    }

    private async createCloudMonitoringAlert(alert: MetricAlert): Promise<void> {
        // Implementation for creating Cloud Monitoring alert policy
    }

    private startBufferFlush(): void {
        setInterval(async () => {
            try {
                await this.flushMetricBuffer();
            } catch (error) {
                await this.handleError('buffer_flush_error', error);
            }
        }, this.BUFFER_FLUSH_INTERVAL);
    }

    private startAlertChecking(): void {
        setInterval(async () => {
            try {
                await this.checkAllAlerts();
            } catch (error) {
                await this.handleError('alert_check_error', error);
            }
        }, 5000); // Every 5 seconds
    }

    private async checkAllAlerts(): Promise<void> {
        for (const alert of this.alerts.values()) {
            try {
                const metrics = await this.getMetrics(
                    alert.metricName,
                    {
                        start: new Date(Date.now() - alert.condition.duration * 1000),
                        end: new Date()
                    }
                );

                const shouldTrigger = this.evaluateAlert(alert, metrics);
                if (shouldTrigger && alert.status !== 'active') {
                    await this.triggerAlert(alert, metrics);
                } else if (!shouldTrigger && alert.status === 'active') {
                    await this.resolveAlert(alert);
                }
            } catch (error) {
                await this.handleError('alert_evaluation_error', error);
            }
        }
    }

    private async checkAlerts(metric: MetricPoint): Promise<void> {
        const relevantAlerts = Array.from(this.alerts.values())
            .filter(alert => alert.metricName === metric.name);

        for (const alert of relevantAlerts) {
            const metrics = await this.getMetrics(
                alert.metricName,
                {
                    start: new Date(Date.now() - alert.condition.duration * 1000),
                    end: new Date()
                }
            );

            if (this.evaluateAlert(alert, metrics)) {
                await this.triggerAlert(alert, metrics);
            }
        }
    }

    private evaluateAlert(
        alert: MetricAlert,
        metrics: MetricPoint[]
    ): boolean {
        if (!metrics.length) return false;

        const average = metrics.reduce((sum, m) => sum + m.value, 0) / metrics.length;

        switch (alert.condition.operator) {
            case '>': return average > alert.condition.threshold;
            case '<': return average < alert.condition.threshold;
            case '=': return average === alert.condition.threshold;
            case '>=': return average >= alert.condition.threshold;
            case '<=': return average <= alert.condition.threshold;
            default: return false;
        }
    }

    private async triggerAlert(
        alert: MetricAlert,
        metrics: MetricPoint[]
    ): Promise<void> {
        alert.status = 'active';
        alert.lastTriggered = new Date();

        await this.eventBus.publish('metrics.alert', {
            type: 'metric.alert.triggered',
            source: 'metrics-collector',
            data: {
                alert,
                metrics,
                timestamp: new Date()
            },
            metadata: {
                severity: alert.severity,
                environment: process.env.NODE_ENV || 'development'
            }
        });
    }

    private async resolveAlert(alert: MetricAlert): Promise<void> {
        alert.status = 'resolved';

        await this.eventBus.publish('metrics.alert', {
            type: 'metric.alert.resolved',
            source: 'metrics-collector',
            data: {
                alert,
                timestamp: new Date()
            },
            metadata: {
                severity: alert.severity,
                environment: process.env.NODE_ENV || 'development'
            }
        });
    }

    private buildRedisKey(metric: Partial<MetricPoint>): string {
        const labelString = metric.labels 
            ? Object.entries(metric.labels).sort().join(':')
            : '';
        return `metric:${metric.name}:${labelString}`;
    }

    private generateBatchId(): string {
        return `batch-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }

    private generateAlertId(): string {
        return `alert-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }

    private async handleError(type: string, error: Error): Promise<void> {
        await this.recordMetric({
            name: type,
            value: 1,
            type: 'counter',
            labels: { error: error.message }
        });
    }

    // Cleanup method for proper service shutdown
    async shutdown(): Promise<void> {
        // Flush remaining metrics
        await this.flushMetricBuffer();

        // Close Redis connection
        await this.redis.quit();
    }
}

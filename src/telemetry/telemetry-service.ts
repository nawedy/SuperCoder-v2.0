import { MonitoringService } from '../monitoring/monitoring-service';
import { BigQuery } from '@google-cloud/bigquery';
import { PubSub } from '@google-cloud/pubsub';
import * as os from 'os';
import { EventEmitter } from 'events';

interface TelemetryData {
    id: string;
    timestamp: Date;
    type: 'system' | 'application' | 'model' | 'user';
    metrics: Record<string, number>;
    dimensions: Record<string, string>;
    metadata: {
        hostname: string;
        environment: string;
        version: string;
    };
}

interface TelemetryConfig {
    collectionInterval: number;
    batchSize: number;
    flushInterval: number;
    samplingRate: number;
}

export class TelemetryService extends EventEmitter {
    private monitor: MonitoringService;
    private bigquery: BigQuery;
    private pubsub: PubSub;
    private buffer: TelemetryData[];
    private config: TelemetryConfig;
    private isCollecting: boolean;
    private flushTimer?: NodeJS.Timer;

    constructor(
        monitor: MonitoringService,
        projectId: string,
        config?: Partial<TelemetryConfig>
    ) {
        super();
        this.monitor = monitor;
        this.bigquery = new BigQuery({ projectId });
        this.pubsub = new PubSub({ projectId });
        this.buffer = [];
        this.config = {
            collectionInterval: config?.collectionInterval || 10000, // 10 seconds
            batchSize: config?.batchSize || 100,
            flushInterval: config?.flushInterval || 30000, // 30 seconds
            samplingRate: config?.samplingRate || 1.0 // 100%
        };
        this.isCollecting = false;

        this.initialize();
    }

    private async initialize(): Promise<void> {
        await this.setupInfrastructure();
        this.startCollection();
        this.setupFlushTimer();
    }

    async recordTelemetry(
        type: TelemetryData['type'],
        metrics: Record<string, number>,
        dimensions: Record<string, string> = {}
    ): Promise<void> {
        try {
            // Apply sampling
            if (Math.random() > this.config.samplingRate) {
                return;
            }

            const data: TelemetryData = {
                id: this.generateTelemetryId(),
                timestamp: new Date(),
                type,
                metrics,
                dimensions,
                metadata: {
                    hostname: os.hostname(),
                    environment: process.env.NODE_ENV || 'development',
                    version: process.env.APP_VERSION || '0.0.0'
                }
            };

            this.buffer.push(data);

            // Check if buffer should be flushed
            if (this.buffer.length >= this.config.batchSize) {
                await this.flush();
            }

            this.emit('telemetry', data);

        } catch (error) {
            await this.handleError('telemetry_record_error', error);
        }
    }

    async flush(): Promise<void> {
        if (this.buffer.length === 0) return;

        try {
            const batch = [...this.buffer];
            this.buffer = [];

            // Store in BigQuery
            await this.storeToBigQuery(batch);

            // Publish to PubSub for real-time processing
            await this.publishToPubSub(batch);

            await this.monitor.recordMetric({
                name: 'telemetry_flush',
                value: batch.length,
                labels: {
                    type: 'batch',
                    size: batch.length.toString()
                }
            });

        } catch (error) {
            await this.handleError('telemetry_flush_error', error);
            // Restore failed items to buffer
            this.buffer = [...this.buffer, ...this.buffer];
        }
    }

    startCollection(): void {
        if (this.isCollecting) return;

        this.isCollecting = true;
        this.collectSystemMetrics();
    }

    stopCollection(): void {
        this.isCollecting = false;
        if (this.flushTimer) {
            clearInterval(this.flushTimer);
        }
    }

    private async setupInfrastructure(): Promise<void> {
        try {
            // Create BigQuery dataset and table
            const dataset = this.bigquery.dataset('telemetry');
            const [datasetExists] = await dataset.exists();
            if (!datasetExists) {
                await dataset.create();
            }

            const table = dataset.table('metrics');
            const [tableExists] = await table.exists();
            if (!tableExists) {
                await this.createTelemetryTable(table);
            }

            // Create PubSub topic
            const [topics] = await this.pubsub.getTopics();
            const topicExists = topics.some(t => t.name.endsWith('telemetry'));
            if (!topicExists) {
                await this.pubsub.createTopic('telemetry');
            }

        } catch (error) {
            await this.handleError('infrastructure_setup_error', error);
            throw error;
        }
    }

    private async createTelemetryTable(table: any): Promise<void> {
        const schema = {
            fields: [
                { name: 'id', type: 'STRING' },
                { name: 'timestamp', type: 'TIMESTAMP' },
                { name: 'type', type: 'STRING' },
                { name: 'metrics', type: 'RECORD', mode: 'REPEATED', fields: [
                    { name: 'name', type: 'STRING' },
                    { name: 'value', type: 'FLOAT' }
                ]},
                { name: 'dimensions', type: 'RECORD', mode: 'REPEATED', fields: [
                    { name: 'name', type: 'STRING' },
                    { name: 'value', type: 'STRING' }
                ]},
                { name: 'metadata', type: 'RECORD', fields: [
                    { name: 'hostname', type: 'STRING' },
                    { name: 'environment', type: 'STRING' },
                    { name: 'version', type: 'STRING' }
                ]}
            ]
        };

        await table.create({ schema });
    }

    private async collectSystemMetrics(): Promise<void> {
        while (this.isCollecting) {
            try {
                const metrics = {
                    cpu_usage: os.loadavg()[0],
                    memory_used: os.totalmem() - os.freemem(),
                    memory_total: os.totalmem(),
                    uptime: os.uptime()
                };

                await this.recordTelemetry('system', metrics);

            } catch (error) {
                await this.handleError('metrics_collection_error', error);
            }

            await new Promise(resolve => 
                setTimeout(resolve, this.config.collectionInterval)
            );
        }
    }

    private setupFlushTimer(): void {
        this.flushTimer = setInterval(
            () => this.flush(),
            this.config.flushInterval
        );
    }

    private async storeToBigQuery(batch: TelemetryData[]): Promise<void> {
        const rows = batch.map(data => ({
            ...data,
            timestamp: data.timestamp.toISOString(),
            metrics: Object.entries(data.metrics).map(([name, value]) => ({
                name,
                value
            })),
            dimensions: Object.entries(data.dimensions).map(([name, value]) => ({
                name,
                value
            }))
        }));

        await this.bigquery
            .dataset('telemetry')
            .table('metrics')
            .insert(rows);
    }

    private async publishToPubSub(batch: TelemetryData[]): Promise<void> {
        const topic = this.pubsub.topic('telemetry');
        await Promise.all(
            batch.map(data =>
                topic.publish(Buffer.from(JSON.stringify(data)))
            )
        );
    }

    private generateTelemetryId(): string {
        return `tel-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }

    private async handleError(type: string, error: Error): Promise<void> {
        await this.monitor.recordMetric({
            name: type,
            value: 1,
            labels: { error: error.message }
        });
    }
}

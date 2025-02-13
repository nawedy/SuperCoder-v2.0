import { MonitoringService } from '../monitoring/monitoring-service';
import { AuditTrailService } from '../audit/audit-trail-service';
import { CloudStorage } from '@google-cloud/storage';
import { BigQuery } from '@google-cloud/bigquery';
import { Kafka, Producer, Consumer } from 'kafkajs';
import { v4 as uuidv4 } from 'uuid';

interface Event {
    id: string;
    type: string;
    aggregateId: string;
    aggregateType: string;
    version: number;
    data: any;
    metadata: {
        timestamp: Date;
        actor: string;
        correlationId?: string;
        causationId?: string;
        environment: string;
        tags: string[];
    };
}

interface EventStore {
    append(events: Event[]): Promise<void>;
    read(aggregateId: string, fromVersion?: number): Promise<Event[]>;
    readAll(fromTimestamp?: Date): Promise<Event[]>;
    getLastVersion(aggregateId: string): Promise<number>;
}

interface Snapshot<T> {
    aggregateId: string;
    version: number;
    state: T;
    timestamp: Date;
}

interface EventHandlerConfig {
    handlerId: string;
    eventTypes: string[];
    handler: (event: Event) => Promise<void>;
    options?: {
        retries?: number;
        batchSize?: number;
        parallelProcessing?: boolean;
    };
}

export class EventSourcingService {
    private monitor: MonitoringService;
    private audit: AuditTrailService;
    private storage: CloudStorage;
    private bigquery: BigQuery;
    private kafka: Kafka;
    private producer: Producer;
    private consumer: Consumer;
    private eventHandlers: Map<string, EventHandlerConfig>;
    private snapshotFrequency: number;
    private readonly SNAPSHOT_BUCKET: string;
    private readonly EVENT_TOPIC: string;
    private readonly EVENT_TABLE: string;

    constructor(
        monitor: MonitoringService,
        audit: AuditTrailService,
        config: {
            projectId: string;
            kafkaBrokers: string[];
            snapshotFrequency?: number;
        }
    ) {
        this.monitor = monitor;
        this.audit = audit;
        this.storage = new CloudStorage({ projectId: config.projectId });
        this.bigquery = new BigQuery({ projectId: config.projectId });
        this.kafka = new Kafka({ brokers: config.kafkaBrokers });
        this.producer = this.kafka.producer();
        this.consumer = this.kafka.consumer({ groupId: 'event-sourcing-group' });
        this.eventHandlers = new Map();
        this.snapshotFrequency = config.snapshotFrequency || 100;
        this.SNAPSHOT_BUCKET = `${config.projectId}-event-snapshots`;
        this.EVENT_TOPIC = 'event-stream';
        this.EVENT_TABLE = 'events';

        this.initialize();
    }

    private async initialize(): Promise<void> {
        try {
            await this.ensureInfrastructure();
            await this.setupKafka();
            await this.startEventProcessing();
        } catch (error) {
            await this.handleError('initialization_error', error);
            throw error;
        }
    }

    async publishEvent<T>(
        type: string,
        aggregateId: string,
        aggregateType: string,
        data: T,
        metadata: Partial<Event['metadata']> = {}
    ): Promise<string> {
        try {
            const lastVersion = await this.getLastEventVersion(aggregateId);
            
            const event: Event = {
                id: uuidv4(),
                type,
                aggregateId,
                aggregateType,
                version: lastVersion + 1,
                data,
                metadata: {
                    timestamp: new Date(),
                    actor: metadata.actor || 'system',
                    correlationId: metadata.correlationId || uuidv4(),
                    causationId: metadata.causationId,
                    environment: process.env.NODE_ENV || 'development',
                    tags: metadata.tags || []
                }
            };

            // Store event
            await this.storeEvent(event);

            // Publish to Kafka
            await this.producer.send({
                topic: this.EVENT_TOPIC,
                messages: [{
                    key: aggregateId,
                    value: JSON.stringify(event),
                    headers: {
                        eventType: type,
                        version: event.version.toString()
                    }
                }]
            });

            // Check if snapshot needed
            if (event.version % this.snapshotFrequency === 0) {
                await this.createSnapshot(aggregateId);
            }

            await this.monitor.recordMetric({
                name: 'event_published',
                value: 1,
                labels: {
                    type,
                    aggregate_type: aggregateType
                }
            });

            return event.id;

        } catch (error) {
            await this.handleError('event_publish_error', error);
            throw error;
        }
    }

    async registerEventHandler(config: EventHandlerConfig): Promise<void> {
        try {
            this.eventHandlers.set(config.handlerId, {
                ...config,
                options: {
                    retries: config.options?.retries || 3,
                    batchSize: config.options?.batchSize || 100,
                    parallelProcessing: config.options?.parallelProcessing || false
                }
            });

            await this.audit.logEvent({
                eventType: 'system.config',
                actor: {
                    id: 'system',
                    type: 'service',
                    metadata: {}
                },
                resource: {
                    type: 'event-handler',
                    id: config.handlerId,
                    action: 'register'
                },
                context: {
                    location: 'event-sourcing',
                    ipAddress: 'internal',
                    userAgent: 'system'
                },
                status: 'success',
                details: {
                    eventTypes: config.eventTypes,
                    options: config.options
                }
            });

        } catch (error) {
            await this.handleError('handler_registration_error', error);
            throw error;
        }
    }

    async getEventStream(
        aggregateId: string,
        fromVersion?: number
    ): Promise<Event[]> {
        try {
            const query = `
                SELECT *
                FROM \`events.${this.EVENT_TABLE}\`
                WHERE aggregateId = @aggregateId
                ${fromVersion ? 'AND version > @fromVersion' : ''}
                ORDER BY version ASC
            `;

            const [rows] = await this.bigquery.query({
                query,
                params: { aggregateId, fromVersion }
            });

            return rows.map(this.deserializeEvent);

        } catch (error) {
            await this.handleError('event_stream_error', error);
            throw error;
        }
    }

    async getSnapshot<T>(aggregateId: string): Promise<Snapshot<T> | null> {
        try {
            const file = this.storage
                .bucket(this.SNAPSHOT_BUCKET)
                .file(`${aggregateId}/latest.json`);

            const [exists] = await file.exists();
            if (!exists) {
                return null;
            }

            const [data] = await file.download();
            return JSON.parse(data.toString());

        } catch (error) {
            await this.handleError('snapshot_retrieval_error', error);
            return null;
        }
    }

    private async storeEvent(event: Event): Promise<void> {
        // Store in BigQuery
        await this.bigquery
            .dataset('events')
            .table(this.EVENT_TABLE)
            .insert([this.serializeEvent(event)]);
    }

    private async createSnapshot<T>(
        aggregateId: string,
        state?: T
    ): Promise<void> {
        try {
            const events = await this.getEventStream(aggregateId);
            const lastEvent = events[events.length - 1];

            const snapshot: Snapshot<T> = {
                aggregateId,
                version: lastEvent.version,
                state: state || this.rebuildState(events),
                timestamp: new Date()
            };

            await this.storage
                .bucket(this.SNAPSHOT_BUCKET)
                .file(`${aggregateId}/latest.json`)
                .save(JSON.stringify(snapshot));

        } catch (error) {
            await this.handleError('snapshot_creation_error', error);
            throw error;
        }
    }

    private async setupKafka(): Promise<void> {
        await this.producer.connect();
        await this.consumer.connect();
        await this.consumer.subscribe({ topic: this.EVENT_TOPIC });
    }

    private async startEventProcessing(): Promise<void> {
        await this.consumer.run({
            eachBatch: async ({ batch, resolveOffset, heartbeat }) => {
                for (const message of batch.messages) {
                    try {
                        const event: Event = JSON.parse(message.value!.toString());
                        
                        // Process event with registered handlers
                        await this.processEventWithHandlers(event);
                        
                        await resolveOffset(message.offset);
                        await heartbeat();

                    } catch (error) {
                        await this.handleError('event_processing_error', error);
                    }
                }
            }
        });
    }

    private async processEventWithHandlers(event: Event): Promise<void> {
        const relevantHandlers = Array.from(this.eventHandlers.values())
            .filter(h => h.eventTypes.includes(event.type));

        for (const handler of relevantHandlers) {
            try {
                if (handler.options?.parallelProcessing) {
                    // Process in background
                    setImmediate(() => this.executeHandler(handler, event));
                } else {
                    // Process synchronously
                    await this.executeHandler(handler, event);
                }
            } catch (error) {
                await this.handleError('handler_execution_error', error);
            }
        }
    }

    private async executeHandler(
        handler: EventHandlerConfig,
        event: Event
    ): Promise<void> {
        let attempts = 0;
        while (attempts < (handler.options?.retries || 3)) {
            try {
                await handler.handler(event);
                break;
            } catch (error) {
                attempts++;
                if (attempts === handler.options?.retries) {
                    throw error;
                }
                await new Promise(resolve => 
                    setTimeout(resolve, 1000 * Math.pow(2, attempts))
                );
            }
        }
    }

    private async ensureInfrastructure(): Promise<void> {
        try {
            // Ensure snapshot bucket exists
            const [bucketExists] = await this.storage
                .bucket(this.SNAPSHOT_BUCKET)
                .exists();

            if (!bucketExists) {
                await this.storage.createBucket(this.SNAPSHOT_BUCKET);
            }

            // Ensure BigQuery dataset and table exist
            const dataset = this.bigquery.dataset('events');
            const [datasetExists] = await dataset.exists();
            
            if (!datasetExists) {
                await dataset.create();
                await this.createEventsTable(dataset);
            }

        } catch (error) {
            console.error('Failed to initialize event sourcing infrastructure:', error);
            throw error;
        }
    }

    private async createEventsTable(dataset: any): Promise<void> {
        const schema = {
            fields: [
                { name: 'id', type: 'STRING' },
                { name: 'type', type: 'STRING' },
                { name: 'aggregateId', type: 'STRING' },
                { name: 'aggregateType', type: 'STRING' },
                { name: 'version', type: 'INTEGER' },
                { name: 'data', type: 'JSON' },
                { name: 'metadata', type: 'JSON' }
            ]
        };

        await dataset.createTable(this.EVENT_TABLE, { schema });
    }

    private async getLastEventVersion(aggregateId: string): Promise<number> {
        const query = `
            SELECT MAX(version) as lastVersion
            FROM \`events.${this.EVENT_TABLE}\`
            WHERE aggregateId = @aggregateId
        `;

        const [rows] = await this.bigquery.query({
            query,
            params: { aggregateId }
        });

        return (rows[0]?.lastVersion || 0) as number;
    }

    private serializeEvent(event: Event): any {
        return {
            ...event,
            data: JSON.stringify(event.data),
            metadata: JSON.stringify(event.metadata)
        };
    }

    private deserializeEvent(row: any): Event {
        return {
            ...row,
            data: JSON.parse(row.data),
            metadata: JSON.parse(row.metadata)
        };
    }

    private rebuildState<T>(events: Event[]): T {
        // This would be implemented based on specific aggregate requirements
        return events.reduce((state, event) => {
            // Apply event to state
            return state;
        }, {} as T);
    }

    private async handleError(type: string, error: Error): Promise<void> {
        await this.monitor.recordMetric({
            name: type,
            value: 1,
            labels: { error: error.message }
        });
    }

    async shutdown(): Promise<void> {
        await this.producer.disconnect();
        await this.consumer.disconnect();
    }
}

import { MonitoringService } from '../monitoring/monitoring-service';
import { SecurityConfig } from '../config/security-config';
import { BigQuery } from '@google-cloud/bigquery';
import { PubSub } from '@google-cloud/pubsub';

interface AuditEvent {
    id: string;
    timestamp: Date;
    eventType: AuditEventType;
    actor: {
        id: string;
        type: 'user' | 'system' | 'service';
        metadata: Record<string, any>;
    };
    resource: {
        type: string;
        id: string;
        action: string;
    };
    context: {
        location: string;
        ipAddress: string;
        userAgent: string;
    };
    status: 'success' | 'failure';
    details: Record<string, any>;
}

type AuditEventType = 
    | 'model.train'
    | 'model.deploy'
    | 'model.access'
    | 'data.access'
    | 'data.modify'
    | 'security.alert'
    | 'user.login'
    | 'user.logout'
    | 'system.config';

export class AuditTrailService {
    private monitor: MonitoringService;
    private securityConfig: SecurityConfig;
    private bigquery: BigQuery;
    private pubsub: PubSub;
    private readonly datasetId: string;
    private readonly tableId: string;
    private readonly topicName: string;

    constructor(
        monitor: MonitoringService,
        securityConfig: SecurityConfig,
        projectId: string
    ) {
        this.monitor = monitor;
        this.securityConfig = securityConfig;
        this.bigquery = new BigQuery({ projectId });
        this.pubsub = new PubSub({ projectId });
        this.datasetId = 'audit_logs';
        this.tableId = 'events';
        this.topicName = 'audit-events';

        this.initialize();
    }

    private async initialize(): Promise<void> {
        await this.ensureInfrastructure();
    }

    async logEvent(event: Omit<AuditEvent, 'id' | 'timestamp'>): Promise<string> {
        try {
            const id = this.generateEventId();
            const fullEvent: AuditEvent = {
                ...event,
                id,
                timestamp: new Date()
            };
            await this.storeToBigQuery(fullEvent);
            await this.publishToPubSub(fullEvent);
            return id;
        } catch (error) {
            // Handle logging error (could also rethrow after recording metric)
            throw new Error(`Audit log failed: ${error.message}`);
        }
    }

    async queryEvents(
        filters: Partial<AuditEvent>,
        timeRange: { start: Date; end: Date }
    ): Promise<AuditEvent[]> {
        try {
            const query = this.buildQuery(filters, timeRange);
            // Execute query via BigQuery API (pseudo-code)
            const [rows] = await this.bigquery.query({ query });
            return rows as AuditEvent[];
        } catch (error) {
            throw new Error(`Query failed: ${error.message}`);
        }
    }

    async getEventById(eventId: string): Promise<AuditEvent | null> {
        try {
            const query = `SELECT * FROM \`${this.datasetId}.${this.tableId}\` WHERE id = '${eventId}' LIMIT 1`;
            const [rows] = await this.bigquery.query({ query });
            return rows.length ? (rows[0] as AuditEvent) : null;
        } catch (error) {
            throw new Error(`Get event failed: ${error.message}`);
        }
    }

    private async ensureInfrastructure(): Promise<void> {
        try {
            // Ensure BigQuery dataset exists
            const dataset = this.bigquery.dataset(this.datasetId);
            const [datasetExists] = await dataset.exists();
            if (!datasetExists) {
                await dataset.create();
            }

            // Ensure table exists
            const table = dataset.table(this.tableId);
            const [tableExists] = await table.exists();
            if (!tableExists) {
                await this.createAuditTable(table);
            }

            // Ensure PubSub topic exists
            const [topics] = await this.pubsub.getTopics();
            const topicExists = topics.some(t => t.name.endsWith(this.topicName));
            if (!topicExists) {
                await this.pubsub.createTopic(this.topicName);
            }
        } catch (error) {
            console.error('Failed to initialize audit infrastructure:', error);
            throw new Error(`Infrastructure setup failed: ${error.message}`);
        }
    }

    private async createAuditTable(table: any): Promise<void> {
        const schema = {
            fields: [
                { name: 'id', type: 'STRING' },
                { name: 'timestamp', type: 'TIMESTAMP' },
                { name: 'eventType', type: 'STRING' },
                { name: 'actor', type: 'RECORD', fields: [
                    { name: 'id', type: 'STRING' },
                    { name: 'type', type: 'STRING' },
                    { name: 'metadata', type: 'JSON' }
                ]},
                { name: 'resource', type: 'RECORD', fields: [
                    { name: 'type', type: 'STRING' },
                    { name: 'id', type: 'STRING' },
                    { name: 'action', type: 'STRING' }
                ]},
                { name: 'context', type: 'RECORD', fields: [
                    { name: 'location', type: 'STRING' },
                    { name: 'ipAddress', type: 'STRING' },
                    { name: 'userAgent', type: 'STRING' }
                ]},
                { name: 'status', type: 'STRING' },
                { name: 'details', type: 'JSON' }
            ]
        };

        await table.create({ schema });
    }

    private async storeToBigQuery(event: AuditEvent): Promise<void> {
        try {
            const formatted = this.formatEventForBigQuery(event);
            await this.bigquery
                .dataset(this.datasetId)
                .table(this.tableId)
                .insert([formatted]);
        } catch (error) {
            throw new Error(`BigQuery insert failed: ${error.message}`);
        }
    }

    private async publishToPubSub(event: AuditEvent): Promise<void> {
        try {
            const message = Buffer.from(JSON.stringify(event));
            await this.pubsub.topic(this.topicName).publish(message);
        } catch (error) {
            throw new Error(`PubSub publish failed: ${error.message}`);
        }
    }

    private formatEventForBigQuery(event: AuditEvent): Record<string, any> {
        // Convert event to BigQuery row format
        return {
            id: event.id,
            timestamp: event.timestamp.toISOString(),
            eventType: event.eventType,
            actor: JSON.stringify(event.actor),
            resource: JSON.stringify(event.resource),
            context: JSON.stringify(event.context),
            status: event.status,
            details: JSON.stringify(event.details)
        };
    }

    private buildQuery(
        filters: Partial<AuditEvent>,
        timeRange: { start: Date; end: Date }
    ): string {
        let baseQuery = `SELECT * FROM \`${this.datasetId}.${this.tableId}\` WHERE timestamp BETWEEN '${timeRange.start.toISOString()}' AND '${timeRange.end.toISOString()}'`;
        for (const key in filters) {
            const value = (filters as any)[key];
            if (value) {
                baseQuery += ` AND ${key} = '${value}'`;
            }
        }
        return baseQuery;
    }

    private generateEventId(): string {
        return `audit_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    }
}

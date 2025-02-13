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
            const auditEvent: AuditEvent = {
                ...event,
                id: this.generateEventId(),
                timestamp: new Date()
            };

            // Store in BigQuery
            await this.storeToBigQuery(auditEvent);

            // Publish to PubSub for real-time processing
            await this.publishToPubSub(auditEvent);

            // Record metric
            await this.monitor.recordMetric({
                name: 'audit_event',
                value: 1,
                labels: {
                    event_type: event.eventType,
                    status: event.status
                }
            });

            return auditEvent.id;
        } catch (error) {
            await this.monitor.recordMetric({
                name: 'audit_error',
                value: 1,
                labels: { error: error.message }
            });
            throw error;
        }
    }

    async queryEvents(
        filters: Partial<AuditEvent>,
        timeRange: { start: Date; end: Date }
    ): Promise<AuditEvent[]> {
        try {
            const query = this.buildQuery(filters, timeRange);
            const [rows] = await this.bigquery
                .dataset(this.datasetId)
                .table(this.tableId)
                .query(query);

            return rows as AuditEvent[];
        } catch (error) {
            await this.monitor.recordMetric({
                name: 'audit_query_error',
                value: 1,
                labels: { error: error.message }
            });
            throw error;
        }
    }

    async getEventById(eventId: string): Promise<AuditEvent | null> {
        try {
            const query = `
                SELECT *
                FROM \`${this.datasetId}.${this.tableId}\`
                WHERE id = @eventId
            `;

            const options = {
                query,
                params: { eventId }
            };

            const [rows] = await this.bigquery.query(options);
            return rows[0] || null;
        } catch (error) {
            await this.monitor.recordMetric({
                name: 'audit_retrieval_error',
                value: 1,
                labels: { error: error.message }
            });
            throw error;
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
            throw error;
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
        const row = this.formatEventForBigQuery(event);
        await this.bigquery
            .dataset(this.datasetId)
            .table(this.tableId)
            .insert([row]);
    }

    private async publishToPubSub(event: AuditEvent): Promise<void> {
        const topic = this.pubsub.topic(this.topicName);
        const data = Buffer.from(JSON.stringify(event));
        await topic.publish(data);
    }

    private formatEventForBigQuery(event: AuditEvent): Record<string, any> {
        return {
            ...event,
            timestamp: event.timestamp.toISOString(),
            actor: {
                ...event.actor,
                metadata: JSON.stringify(event.actor.metadata)
            },
            details: JSON.stringify(event.details)
        };
    }

    private buildQuery(
        filters: Partial<AuditEvent>,
        timeRange: { start: Date; end: Date }
    ): string {
        const conditions = [`timestamp BETWEEN @start AND @end`];

        if (filters.eventType) {
            conditions.push(`eventType = @eventType`);
        }
        if (filters.status) {
            conditions.push(`status = @status`);
        }
        if (filters.actor?.id) {
            conditions.push(`actor.id = @actorId`);
        }

        return `
            SELECT *
            FROM \`${this.datasetId}.${this.tableId}\`
            WHERE ${conditions.join(' AND ')}
            ORDER BY timestamp DESC
        `;
    }

    private generateEventId(): string {
        return `evt-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }
}

import { MonitoringService } from '../monitoring/monitoring-service';
import { SecurityConfig } from '../config/security-config';
import { Logging } from '@google-cloud/logging';
import { BigQuery } from '@google-cloud/bigquery';

interface LogEntry {
    id: string;
    timestamp: Date;
    level: 'debug' | 'info' | 'warn' | 'error' | 'critical';
    component: string;
    message: string;
    context: {
        requestId?: string;
        userId?: string;
        resourceId?: string;
        trace?: string;
    };
    metadata: Record<string, any>;
    tags: string[];
}

interface LogQuery {
    startTime?: Date;
    endTime?: Date;
    level?: LogEntry['level'];
    component?: string;
    requestId?: string;
    userId?: string;
    tags?: string[];
}

export class AdvancedLoggingService {
    private monitor: MonitoringService;
    private securityConfig: SecurityConfig;
    private logging: Logging;
    private bigquery: BigQuery;
    private readonly logName: string;
    private readonly datasetId: string;
    private readonly tableId: string;

    constructor(
        monitor: MonitoringService,
        securityConfig: SecurityConfig,
        projectId: string
    ) {
        this.monitor = monitor;
        this.securityConfig = securityConfig;
        this.logging = new Logging({ projectId });
        this.bigquery = new BigQuery({ projectId });
        this.logName = 'supercoder-logs';
        this.datasetId = 'application_logs';
        this.tableId = 'logs';

        this.initialize();
    }

    private async initialize(): Promise<void> {
        await this.setupLogging();
        await this.setupBigQuery();
    }

    async log(
        level: LogEntry['level'],
        message: string,
        component: string,
        context: Partial<LogEntry['context']> = {},
        metadata: Record<string, any> = {},
        tags: string[] = []
    ): Promise<string> {
        try {
            const entry: LogEntry = {
                id: this.generateLogId(),
                timestamp: new Date(),
                level,
                component,
                message,
                context,
                metadata,
                tags
            };

            // Write to Cloud Logging
            await this.writeToCloudLogging(entry);

            // Store in BigQuery for analytics
            await this.writeToBigQuery(entry);

            // Record metric
            await this.monitor.recordMetric({
                name: 'log_entry',
                value: 1,
                labels: {
                    level,
                    component
                }
            });

            return entry.id;
        } catch (error) {
            await this.monitor.recordMetric({
                name: 'logging_error',
                value: 1,
                labels: { error: error.message }
            });
            throw error;
        }
    }

    async query(params: LogQuery): Promise<LogEntry[]> {
        try {
            const query = this.buildQuery(params);
            const [rows] = await this.bigquery
                .dataset(this.datasetId)
                .table(this.tableId)
                .query(query);

            return this.formatQueryResults(rows);
        } catch (error) {
            await this.monitor.recordMetric({
                name: 'log_query_error',
                value: 1,
                labels: { error: error.message }
            });
            throw error;
        }
    }

    async exportLogs(
        params: LogQuery,
        format: 'json' | 'csv'
    ): Promise<string> {
        try {
            const query = this.buildQuery(params);
            const destination = `gs://${this.securityConfig.storage.bucketName}/exports/${Date.now()}.${format}`;

            const [job] = await this.bigquery.createQueryJob({
                query,
                destination: this.bigquery
                    .dataset(this.datasetId)
                    .table(`export_${Date.now()}`),
                writeDisposition: 'WRITE_TRUNCATE'
            });

            await job.getQueryResults();

            return destination;
        } catch (error) {
            await this.monitor.recordMetric({
                name: 'log_export_error',
                value: 1,
                labels: { error: error.message }
            });
            throw error;
        }
    }

    private async setupLogging(): Promise<void> {
        const log = this.logging.log(this.logName);
        const [exists] = await log.exists();
        if (!exists) {
            await log.create();
        }
    }

    private async setupBigQuery(): Promise<void> {
        const dataset = this.bigquery.dataset(this.datasetId);
        const [exists] = await dataset.exists();
        if (!exists) {
            await dataset.create();
            await this.createLogsTable();
        }
    }

    private async createLogsTable(): Promise<void> {
        const schema = {
            fields: [
                { name: 'id', type: 'STRING' },
                { name: 'timestamp', type: 'TIMESTAMP' },
                { name: 'level', type: 'STRING' },
                { name: 'component', type: 'STRING' },
                { name: 'message', type: 'STRING' },
                { name: 'context', type: 'RECORD', fields: [
                    { name: 'requestId', type: 'STRING' },
                    { name: 'userId', type: 'STRING' },
                    { name: 'resourceId', type: 'STRING' },
                    { name: 'trace', type: 'STRING' }
                ]},
                { name: 'metadata', type: 'JSON' },
                { name: 'tags', type: 'STRING', mode: 'REPEATED' }
            ]
        };

        const table = this.bigquery
            .dataset(this.datasetId)
            .table(this.tableId);

        await table.create({ schema });
    }

    private async writeToCloudLogging(entry: LogEntry): Promise<void> {
        const log = this.logging.log(this.logName);
        const metadata = {
            severity: entry.level.toUpperCase(),
            resource: {
                type: 'global',
                labels: {
                    component: entry.component
                }
            }
        };

        await log.write(this.formatLogEntry(entry), metadata);
    }

    private async writeToBigQuery(entry: LogEntry): Promise<void> {
        const row = this.formatEntryForBigQuery(entry);
        await this.bigquery
            .dataset(this.datasetId)
            .table(this.tableId)
            .insert([row]);
    }

    private buildQuery(params: LogQuery): string {
        const conditions = [];

        if (params.startTime) {
            conditions.push(`timestamp >= TIMESTAMP('${params.startTime.toISOString()}')`);
        }
        if (params.endTime) {
            conditions.push(`timestamp <= TIMESTAMP('${params.endTime.toISOString()}')`);
        }
        if (params.level) {
            conditions.push(`level = '${params.level}'`);
        }
        if (params.component) {
            conditions.push(`component = '${params.component}'`);
        }
        if (params.requestId) {
            conditions.push(`context.requestId = '${params.requestId}'`);
        }
        if (params.userId) {
            conditions.push(`context.userId = '${params.userId}'`);
        }
        if (params.tags && params.tags.length > 0) {
            const tagConditions = params.tags
                .map(tag => `'${tag}' IN UNNEST(tags)`)
                .join(' AND ');
            conditions.push(`(${tagConditions})`);
        }

        const whereClause = conditions.length > 0
            ? `WHERE ${conditions.join(' AND ')}`
            : '';

        return `
            SELECT *
            FROM \`${this.datasetId}.${this.tableId}\`
            ${whereClause}
            ORDER BY timestamp DESC
        `;
    }

    private formatLogEntry(entry: LogEntry): any {
        return {
            ...entry,
            metadata: JSON.stringify(entry.metadata)
        };
    }

    private formatEntryForBigQuery(entry: LogEntry): any {
        return {
            ...entry,
            timestamp: entry.timestamp.toISOString(),
            metadata: JSON.stringify(entry.metadata)
        };
    }

    private formatQueryResults(rows: any[]): LogEntry[] {
        return rows.map(row => ({
            ...row,
            timestamp: new Date(row.timestamp),
            metadata: JSON.parse(row.metadata)
        }));
    }

    private generateLogId(): string {
        return `log-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }
}

import { MonitoringService } from '../monitoring/monitoring-service';
import { EventBusService } from '../events/event-bus-service';
import { SecurityConfig } from '../config/security-config';
import { Logging } from '@google-cloud/logging';
import { BigQuery } from '@google-cloud/bigquery';
import { format } from 'winston';
import * as Transport from 'winston-transport';

interface LogEntry {
    id: string;
    timestamp: Date;
    level: 'debug' | 'info' | 'warn' | 'error' | 'critical';
    message: string;
    context: {
        service: string;
        method: string;
        requestId?: string;
        userId?: string;
    };
    metadata: Record<string, any>;
    stackTrace?: string;
}

interface LogConfig {
    minLevel: LogEntry['level'];
    retention: number; // days
    sampling: {
        enabled: boolean;
        rate: number; // 0-1
    };
    structured: boolean;
    destinations: ('cloudLogging' | 'bigQuery' | 'local')[];
}

export class LoggingService extends Transport {
    private monitor: MonitoringService;
    private eventBus: EventBusService;
    private security: SecurityConfig;
    private cloudLogging: Logging;
    private bigquery: BigQuery;
    private config: LogConfig;
    private buffer: LogEntry[];
    private readonly FLUSH_INTERVAL = 5000; // 5 seconds
    private readonly BUFFER_SIZE = 100;

    constructor(
        monitor: MonitoringService,
        eventBus: EventBusService,
        security: SecurityConfig,
        projectId: string,
        config: Partial<LogConfig> = {}
    ) {
        super();
        this.monitor = monitor;
        this.eventBus = eventBus;
        this.security = security;
        this.cloudLogging = new Logging({ projectId });
        this.bigquery = new BigQuery({ projectId });
        this.buffer = [];
        this.config = this.initializeConfig(config);

        this.startBufferFlush();
    }

    async log(
        level: LogEntry['level'],
        message: string,
        context: LogEntry['context'],
        metadata: Record<string, any> = {}
    ): Promise<void> {
        try {
            // Check log level
            if (!this.shouldLog(level)) {
                return;
            }

            // Check sampling
            if (this.config.sampling.enabled && 
                Math.random() > this.config.sampling.rate) {
                return;
            }

            // Create log entry
            const entry: LogEntry = {
                id: this.generateLogId(),
                timestamp: new Date(),
                level,
                message,
                context,
                metadata: this.sanitizeMetadata(metadata),
                stackTrace: metadata.error?.stack
            };

            // Add to buffer
            this.buffer.push(entry);

            // Flush if buffer is full
            if (this.buffer.length >= this.BUFFER_SIZE) {
                await this.flushBuffer();
            }

            // Emit critical events immediately
            if (level === 'critical') {
                await this.emitCriticalEvent(entry);
            }

            // Record metric
            await this.monitor.recordMetric({
                name: 'log_entry',
                value: 1,
                labels: {
                    level,
                    service: context.service
                }
            });

        } catch (error) {
            await this.handleError('logging_error', error);
        }
    }

    async query(
        filters: Partial<LogEntry>,
        timeRange: { start: Date; end: Date },
        options: {
            limit?: number;
            order?: 'asc' | 'desc';
        } = {}
    ): Promise<LogEntry[]> {
        try {
            const query = this.buildQuery(filters, timeRange, options);
            const [rows] = await this.bigquery.query(query);
            return rows.map(this.deserializeLogEntry);
        } catch (error) {
            await this.handleError('log_query_error', error);
            throw error;
        }
    }

    private initializeConfig(config: Partial<LogConfig>): LogConfig {
        return {
            minLevel: config.minLevel || 'info',
            retention: config.retention || 30,
            sampling: {
                enabled: config.sampling?.enabled ?? false,
                rate: config.sampling?.rate ?? 1
            },
            structured: config.structured ?? true,
            destinations: config.destinations || ['cloudLogging', 'bigQuery']
        };
    }

    private shouldLog(level: LogEntry['level']): boolean {
        const levels = ['debug', 'info', 'warn', 'error', 'critical'];
        const minLevelIndex = levels.indexOf(this.config.minLevel);
        const currentLevelIndex = levels.indexOf(level);
        return currentLevelIndex >= minLevelIndex;
    }

    private sanitizeMetadata(metadata: Record<string, any>): Record<string, any> {
        const sanitized = { ...metadata };

        // Remove sensitive data
        const sensitiveKeys = ['password', 'token', 'secret', 'key'];
        for (const key of Object.keys(sanitized)) {
            if (sensitiveKeys.some(sk => key.toLowerCase().includes(sk))) {
                sanitized[key] = '[REDACTED]';
            }
        }

        return sanitized;
    }

    private async flushBuffer(): Promise<void> {
        if (this.buffer.length === 0) return;

        const entries = [...this.buffer];
        this.buffer = [];

        try {
            await Promise.all([
                this.writeToCloudLogging(entries),
                this.writeToBigQuery(entries)
            ]);
        } catch (error) {
            await this.handleError('log_flush_error', error);
            // Re-add failed entries to buffer
            this.buffer.unshift(...entries);
        }
    }

    private async writeToCloudLogging(entries: LogEntry[]): Promise<void> {
        if (!this.config.destinations.includes('cloudLogging')) return;

        const log = this.cloudLogging.log('app-logs');
        await log.write(entries.map(entry => ({
            severity: this.getCloudLoggingSeverity(entry.level),
            timestamp: entry.timestamp,
            labels: {
                service: entry.context.service,
                method: entry.context.method
            },
            jsonPayload: {
                message: entry.message,
                context: entry.context,
                metadata: entry.metadata,
                stackTrace: entry.stackTrace
            }
        })));
    }

    private async writeToBigQuery(entries: LogEntry[]): Promise<void> {
        if (!this.config.destinations.includes('bigQuery')) return;

        const dataset = this.bigquery.dataset('logs');
        const table = dataset.table('app_logs');

        await table.insert(entries.map(entry => ({
            log_id: entry.id,
            timestamp: entry.timestamp.toISOString(),
            level: entry.level,
            message: entry.message,
            context: JSON.stringify(entry.context),
            metadata: JSON.stringify(entry.metadata),
            stack_trace: entry.stackTrace
        })));
    }

    private async emitCriticalEvent(entry: LogEntry): Promise<void> {
        await this.eventBus.publish('logging.critical', {
            type: 'log.critical',
            source: 'logging-service',
            data: entry,
            metadata: {
                version: '1.0',
                environment: process.env.NODE_ENV || 'development'
            }
        });
    }

    private getCloudLoggingSeverity(level: LogEntry['level']): string {
        switch (level) {
            case 'debug': return 'DEBUG';
            case 'info': return 'INFO';
            case 'warn': return 'WARNING';
            case 'error': return 'ERROR';
            case 'critical': return 'CRITICAL';
            default: return 'DEFAULT';
        }
    }

    private buildQuery(
        filters: Partial<LogEntry>,
        timeRange: { start: Date; end: Date },
        options: { limit?: number; order?: 'asc' | 'desc' }
    ): string {
        const conditions = [
            `timestamp BETWEEN '${timeRange.start.toISOString()}' AND '${timeRange.end.toISOString()}'`
        ];

        if (filters.level) {
            conditions.push(`level = '${filters.level}'`);
        }
        if (filters.context?.service) {
            conditions.push(`JSON_EXTRACT(context, '$.service') = '${filters.context.service}'`);
        }

        return `
            SELECT *
            FROM \`logs.app_logs\`
            WHERE ${conditions.join(' AND ')}
            ORDER BY timestamp ${options.order || 'desc'}
            ${options.limit ? `LIMIT ${options.limit}` : ''}
        `;
    }

    private deserializeLogEntry(row: any): LogEntry {
        return {
            id: row.log_id,
            timestamp: new Date(row.timestamp),
            level: row.level,
            message: row.message,
            context: JSON.parse(row.context),
            metadata: JSON.parse(row.metadata),
            stackTrace: row.stack_trace
        };
    }

    private startBufferFlush(): void {
        setInterval(async () => {
            try {
                await this.flushBuffer();
            } catch (error) {
                await this.handleError('buffer_flush_error', error);
            }
        }, this.FLUSH_INTERVAL);
    }

    private generateLogId(): string {
        return `log-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }

    private async handleError(type: string, error: Error): Promise<void> {
        await this.monitor.recordMetric({
            name: type,
            value: 1,
            labels: { error: error.message }
        });
    }
}

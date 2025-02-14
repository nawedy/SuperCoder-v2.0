import { MonitoringService } from './monitoring-service';
import { EventBusService } from '../events/event-bus-service';
import { BigQuery } from '@google-cloud/bigquery';
import { createClient as createRedisClient } from 'redis';
import os from 'os';

interface PerformanceMetrics {
    timestamp: Date;
    system: {
        cpu: {
            usage: number;
            load: number[];
            temperature: number;
        };
        memory: {
            used: number;
            total: number;
            swap: number;
            pressure: number;
        };
        io: {
            disk: {
                read: number;
                write: number;
                latency: number;
            };
            network: {
                rx: number;
                tx: number;
                connections: number;
                latency: number;
            };
        };
    };
    application: {
        requests: {
            total: number;
            active: number;
            queued: number;
            latency: {
                p50: number;
                p90: number;
                p99: number;
            };
        };
        errors: {
            count: number;
            rate: number;
        };
        cache: {
            hits: number;
            misses: number;
            size: number;
        };
        database: {
            connections: number;
            queryTime: number;
            poolSize: number;
        };
    };
}

interface PerformanceAlert {
    id: string;
    type: string;
    metric: string;
    threshold: number;
    value: number;
    timestamp: Date;
}

export class PerformanceMonitoringService {
    private redis: ReturnType<typeof createRedisClient>;
    private bigquery: BigQuery;
    private metrics: PerformanceMetrics;
    private readonly METRICS_INTERVAL = 10000; // 10 seconds
    private readonly STORAGE_INTERVAL = 60000; // 1 minute

    constructor(
        private monitor: MonitoringService,
        private eventBus: EventBusService,
        private config: {
            redisUrl: string;
            projectId: string;
            thresholds: {
                cpu: number;
                memory: number;
                latency: number;
                errorRate: number;
            };
        }
    ) {
        this.redis = createRedisClient({ url: config.redisUrl });
        this.bigquery = new BigQuery({ projectId: config.projectId });
        this.metrics = this.getInitialMetrics();
        this.initialize();
    }

    private async initialize(): Promise<void> {
        await this.redis.connect();
        this.startMetricsCollection();
        this.startMetricsStorage();
        this.setupEventListeners();
    }

    async getLatestMetrics(): Promise<PerformanceMetrics> {
        return this.metrics;
    }

    async getHistoricalMetrics(
        timeframe: '1h' | '24h' | '7d',
        resolution: '1m' | '5m' | '1h'
    ): Promise<PerformanceMetrics[]> {
        const query = this.buildHistoricalQuery(timeframe, resolution);
        const [rows] = await this.bigquery.query({ query });
        return rows.map(this.deserializeMetrics);
    }

    private startMetricsCollection(): void {
        setInterval(async () => {
            try {
                const metrics = await this.collectMetrics();
                this.metrics = metrics;

                // Check thresholds
                await this.checkThresholds(metrics);

                // Cache metrics
                await this.cacheMetrics(metrics);

                // Emit metrics event
                await this.eventBus.publish('performance.metrics.updated', {
                    type: 'metrics.updated',
                    source: 'performance-monitoring',
                    data: metrics
                });

            } catch (error) {
                await this.handleError('metrics_collection_error', error);
            }
        }, this.METRICS_INTERVAL);
    }

    private startMetricsStorage(): void {
        setInterval(async () => {
            try {
                await this.storeMetrics(this.metrics);
            } catch (error) {
                await this.handleError('metrics_storage_error', error);
            }
        }, this.STORAGE_INTERVAL);
    }

    private async collectMetrics(): Promise<PerformanceMetrics> {
        const [
            systemMetrics,
            applicationMetrics
        ] = await Promise.all([
            this.collectSystemMetrics(),
            this.collectApplicationMetrics()
        ]);

        return {
            timestamp: new Date(),
            system: systemMetrics,
            application: applicationMetrics
        };
    }

    private async collectSystemMetrics(): Promise<PerformanceMetrics['system']> {
        return {
            cpu: await this.collectCPUMetrics(),
            memory: await this.collectMemoryMetrics(),
            io: await this.collectIOMetrics()
        };
    }

    private async collectApplicationMetrics(): Promise<PerformanceMetrics['application']> {
        return {
            requests: await this.collectRequestMetrics(),
            errors: await this.collectErrorMetrics(),
            cache: await this.collectCacheMetrics(),
            database: await this.collectDatabaseMetrics()
        };
    }

    private async collectCPUMetrics(): Promise<PerformanceMetrics['system']['cpu']> {
        const cpus = os.cpus();
        const load = os.loadavg();

        const usage = cpus.reduce((acc, cpu) => {
            const total = Object.values(cpu.times).reduce((a, b) => a + b);
            const idle = cpu.times.idle;
            return acc + ((total - idle) / total);
        }, 0) / cpus.length;

        return {
            usage,
            load,
            temperature: await this.getCPUTemperature()
        };
    }

    private async collectMemoryMetrics(): Promise<PerformanceMetrics['system']['memory']> {
        const total = os.totalmem();
        const free = os.freemem();
        const used = total - free;

        return {
            used,
            total,
            swap: await this.getSwapUsage(),
            pressure: await this.getMemoryPressure()
        };
    }

    private async collectIOMetrics(): Promise<PerformanceMetrics['system']['io']> {
        return {
            disk: await this.getDiskMetrics(),
            network: await this.getNetworkMetrics()
        };
    }

    private async collectRequestMetrics(): Promise<PerformanceMetrics['application']['requests']> {
        const metrics = await this.monitor.getMetrics({
            name: 'http_request',
            timeframe: '1m'
        });

        const latencies = metrics.map(m => m.value).sort((a, b) => a - b);
        const len = latencies.length;

        return {
            total: len,
            active: await this.getActiveRequests(),
            queued: await this.getQueuedRequests(),
            latency: {
                p50: latencies[Math.floor(len * 0.5)] || 0,
                p90: latencies[Math.floor(len * 0.9)] || 0,
                p99: latencies[Math.floor(len * 0.99)] || 0
            }
        };
    }

    private async checkThresholds(metrics: PerformanceMetrics): Promise<void> {
        const checks = [
            {
                type: 'cpu_usage',
                value: metrics.system.cpu.usage,
                threshold: this.config.thresholds.cpu
            },
            {
                type: 'memory_usage',
                value: metrics.system.memory.used / metrics.system.memory.total,
                threshold: this.config.thresholds.memory
            },
            {
                type: 'request_latency',
                value: metrics.application.requests.latency.p99,
                threshold: this.config.thresholds.latency
            },
            {
                type: 'error_rate',
                value: metrics.application.errors.rate,
                threshold: this.config.thresholds.errorRate
            }
        ];

        for (const check of checks) {
            if (check.value > check.threshold) {
                await this.emitAlert({
                    id: uuidv4(),
                    type: 'threshold_breach',
                    metric: check.type,
                    threshold: check.threshold,
                    value: check.value,
                    timestamp: new Date()
                });
            }
        }
    }

    private async emitAlert(alert: PerformanceAlert): Promise<void> {
        await this.eventBus.publish('performance.alert', {
            type: 'performance.alert',
            source: 'performance-monitoring',
            data: alert
        });
    }

    private async cacheMetrics(metrics: PerformanceMetrics): Promise<void> {
        await this.redis.setEx(
            'performance_metrics',
            300, // 5 minutes
            JSON.stringify(metrics)
        );
    }

    private async storeMetrics(metrics: PerformanceMetrics): Promise<void> {
        await this.bigquery
            .dataset('monitoring')
            .table('performance_metrics')
            .insert([this.serializeMetrics(metrics)]);
    }

    private serializeMetrics(metrics: PerformanceMetrics): Record<string, any> {
        return {
            timestamp: metrics.timestamp.toISOString(),
            metrics: JSON.stringify(metrics)
        };
    }

    private deserializeMetrics(row: any): PerformanceMetrics {
        const metrics = JSON.parse(row.metrics);
        return {
            ...metrics,
            timestamp: new Date(row.timestamp)
        };
    }

    private buildHistoricalQuery(
        timeframe: string,
        resolution: string
    ): string {
        const interval = this.getQueryInterval(resolution);
        const range = this.getQueryRange(timeframe);

        return `
            SELECT
                TIMESTAMP_TRUNC(timestamp, ${interval}) as timestamp,
                ANY_VALUE(metrics) as metrics
            FROM monitoring.performance_metrics
            WHERE timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), ${range})
            GROUP BY 1
            ORDER BY 1 ASC
        `;
    }

    private getQueryInterval(resolution: string): string {
        switch (resolution) {
            case '1m': return 'MINUTE';
            case '5m': return 'MINUTE_5';
            case '1h': return 'HOUR';
            default: return 'MINUTE_5';
        }
    }

    private getQueryRange(timeframe: string): string {
        switch (timeframe) {
            case '1h': return 'INTERVAL 1 HOUR';
            case '24h': return 'INTERVAL 24 HOUR';
            case '7d': return 'INTERVAL 7 DAY';
            default: return 'INTERVAL 24 HOUR';
        }
    }

    private getInitialMetrics(): PerformanceMetrics {
        return {
            timestamp: new Date(),
            system: {
                cpu: { usage: 0, load: [0, 0, 0], temperature: 0 },
                memory: { used: 0, total: 0, swap: 0, pressure: 0 },
                io: {
                    disk: { read: 0, write: 0, latency: 0 },
                    network: { rx: 0, tx: 0, connections: 0, latency: 0 }
                }
            },
            application: {
                requests: {
                    total: 0,
                    active: 0,
                    queued: 0,
                    latency: { p50: 0, p90: 0, p99: 0 }
                },
                errors: { count: 0, rate: 0 },
                cache: { hits: 0, misses: 0, size: 0 },
                database: { connections: 0, queryTime: 0, poolSize: 0 }
            }
        };
    }

    private async handleError(type: string, error: Error): Promise<void> {
        await this.monitor.recordMetric({
            name: `performance_${type}`,
            value: 1,
            labels: { error: error.message }
        });

        await this.eventBus.publish('performance.error', {
            type: 'performance.error',
            source: 'performance-monitoring',
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

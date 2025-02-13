import { MonitoringService } from '../monitoring/monitoring-service';
import { AuditTrailService } from '../audit/audit-trail-service';
import { EventBusService } from '../events/event-bus-service';
import { Pool, PoolClient, PoolConfig } from 'pg';
import { Redis } from 'ioredis';

interface ConnectionPoolConfig {
    main: PoolConfig;
    replica?: PoolConfig;
    maxConnections: number;
    minConnections: number;
    idleTimeout: number;
    connectionTimeout: number;
    retryAttempts: number;
    healthCheck: {
        enabled: boolean;
        interval: number;
        timeout: number;
    };
}

interface PoolStats {
    active: number;
    idle: number;
    waiting: number;
    error: number;
    latency: number;
}

export class ConnectionPoolService {
    private monitor: MonitoringService;
    private audit: AuditTrailService;
    private eventBus: EventBusService;
    private mainPool: Pool;
    private replicaPool?: Pool;
    private redis: Redis;
    private stats: Map<string, PoolStats>;
    private healthCheckIntervals: NodeJS.Timeout[];
    private readonly config: ConnectionPoolConfig;

    constructor(
        monitor: MonitoringService,
        audit: AuditTrailService,
        eventBus: EventBusService,
        config: ConnectionPoolConfig,
        redisUrl: string
    ) {
        this.monitor = monitor;
        this.audit = audit;
        this.eventBus = eventBus;
        this.config = config;
        this.redis = new Redis(redisUrl);
        this.stats = new Map();
        this.healthCheckIntervals = [];

        this.initialize();
    }

    private async initialize(): Promise<void> {
        try {
            // Initialize main pool
            this.mainPool = new Pool({
                ...this.config.main,
                max: this.config.maxConnections,
                min: this.config.minConnections,
                idleTimeoutMillis: this.config.idleTimeout,
                connectionTimeoutMillis: this.config.connectionTimeout
            });

            // Initialize replica pool if configured
            if (this.config.replica) {
                this.replicaPool = new Pool({
                    ...this.config.replica,
                    max: this.config.maxConnections,
                    min: this.config.minConnections,
                    idleTimeoutMillis: this.config.idleTimeout,
                    connectionTimeoutMillis: this.config.connectionTimeout
                });
            }

            // Set up event handlers
            this.setupEventHandlers(this.mainPool, 'main');
            if (this.replicaPool) {
                this.setupEventHandlers(this.replicaPool, 'replica');
            }

            // Start health checks
            if (this.config.healthCheck.enabled) {
                this.startHealthChecks();
            }

            // Initialize stats
            this.initializeStats();

            await this.audit.logEvent({
                eventType: 'system.config',
                actor: {
                    id: 'system',
                    type: 'service',
                    metadata: {}
                },
                resource: {
                    type: 'connection-pool',
                    id: 'initialize',
                    action: 'create'
                },
                context: {
                    location: 'connection-pool',
                    ipAddress: 'internal',
                    userAgent: 'system'
                },
                status: 'success',
                details: { config: this.sanitizeConfig(this.config) }
            });

        } catch (error) {
            await this.handleError('pool_initialization_error', error);
            throw error;
        }
    }

    async getConnection(readOnly: boolean = false): Promise<PoolClient> {
        const startTime = Date.now();
        try {
            // Get appropriate pool
            const pool = this.getPool(readOnly);
            
            // Get connection with retry logic
            const client = await this.getConnectionWithRetry(pool);

            // Update stats
            this.updateStats(readOnly ? 'replica' : 'main', {
                active: pool.totalCount,
                idle: pool.idleCount,
                waiting: pool.waitingCount,
                error: 0,
                latency: Date.now() - startTime
            });

            return client;

        } catch (error) {
            await this.handleError('connection_acquisition_error', error);
            throw error;
        }
    }

    private async getConnectionWithRetry(pool: Pool): Promise<PoolClient> {
        let attempts = 0;
        while (attempts < this.config.retryAttempts) {
            try {
                return await pool.connect();
            } catch (error) {
                attempts++;
                if (attempts === this.config.retryAttempts) {
                    throw error;
                }
                await new Promise(resolve => setTimeout(resolve, 1000 * attempts));
            }
        }
        throw new Error('Failed to acquire connection after retries');
    }

    private getPool(readOnly: boolean): Pool {
        if (readOnly && this.replicaPool) {
            return this.replicaPool;
        }
        return this.mainPool;
    }

    private setupEventHandlers(pool: Pool, name: string): void {
        pool.on('connect', () => {
            this.monitor.recordMetric({
                name: 'pool_connection',
                value: 1,
                labels: { pool: name, event: 'connect' }
            });
        });

        pool.on('error', async (error) => {
            await this.handleError(`pool_${name}_error`, error);
        });

        pool.on('remove', async () => {
            await this.monitor.recordMetric({
                name: 'pool_connection',
                value: -1,
                labels: { pool: name, event: 'remove' }
            });
        });
    }

    private startHealthChecks(): void {
        const checkHealth = async (pool: Pool, name: string) => {
            try {
                const client = await pool.connect();
                const startTime = Date.now();
                
                await client.query('SELECT 1');
                const latency = Date.now() - startTime;
                
                client.release();

                await this.monitor.recordMetric({
                    name: 'pool_health_check',
                    value: latency,
                    labels: { pool: name, status: 'success' }
                });

            } catch (error) {
                await this.handleError('pool_health_check_error', error);
            }
        };

        // Set up health check intervals
        this.healthCheckIntervals.push(
            setInterval(
                () => checkHealth(this.mainPool, 'main'),
                this.config.healthCheck.interval
            )
        );

        if (this.replicaPool) {
            this.healthCheckIntervals.push(
                setInterval(
                    () => checkHealth(this.replicaPool!, 'replica'),
                    this.config.healthCheck.interval
                )
            );
        }
    }

    private initializeStats(): void {
        this.stats.set('main', {
            active: 0,
            idle: 0,
            waiting: 0,
            error: 0,
            latency: 0
        });

        if (this.replicaPool) {
            this.stats.set('replica', {
                active: 0,
                idle: 0,
                waiting: 0,
                error: 0,
                latency: 0
            });
        }
    }

    private updateStats(pool: string, stats: PoolStats): void {
        this.stats.set(pool, stats);

        // Record metrics
        Object.entries(stats).forEach(([key, value]) => {
            this.monitor.recordMetric({
                name: `pool_${key}`,
                value,
                labels: { pool }
            });
        });
    }

    private sanitizeConfig(config: ConnectionPoolConfig): any {
        const sanitized = { ...config };
        delete sanitized.main.password;
        if (sanitized.replica) {
            delete sanitized.replica.password;
        }
        return sanitized;
    }

    private async handleError(type: string, error: Error): Promise<void> {
        await this.monitor.recordMetric({
            name: type,
            value: 1,
            labels: { error: error.message }
        });

        await this.eventBus.publish('database.error', {
            type: 'database.connection.error',
            source: 'connection-pool',
            data: {
                error: error.message,
                timestamp: new Date()
            },
            metadata: {
                severity: 'high',
                environment: process.env.NODE_ENV || 'development'
            }
        });
    }

    async shutdown(): Promise<void> {
        // Clear health check intervals
        this.healthCheckIntervals.forEach(clearInterval);

        // Drain pools
        await this.mainPool.end();
        if (this.replicaPool) {
            await this.replicaPool.end();
        }

        // Close Redis connection
        await this.redis.quit();

        await this.audit.logEvent({
            eventType: 'system.config',
            actor: {
                id: 'system',
                type: 'service',
                metadata: {}
            },
            resource: {
                type: 'connection-pool',
                id: 'shutdown',
                action: 'shutdown'
            },
            context: {
                location: 'connection-pool',
                ipAddress: 'internal',
                userAgent: 'system'
            },
            status: 'success',
            details: {}
        });
    }
}

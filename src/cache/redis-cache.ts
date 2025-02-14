import Redis, { Redis as RedisType } from 'ioredis';
import { MonitoringService } from '../monitoring/monitoring-service';
import { EventBusService } from '../events/event-bus-service';
import { v4 as uuidv4 } from 'uuid';

interface RedisCacheConfig {
    enabled: boolean;
    defaultTTL: number;
    maxSize: number;
    redis?: {
        host: string;
        port: number;
        password?: string;
        maxRetriesPerRequest?: number;
        enableReadyCheck?: boolean;
        connectTimeout?: number;
    };
    cluster?: {
        nodes: { host: string; port: number }[];
        options?: {
            scaleReads?: 'master' | 'slave' | 'all';
            maxRedirections?: number;
        };
    };
}

interface CacheStats {
    hits: number;
    misses: number;
    keys: number;
    memoryUsage: number;
    uptime: number;
}

export class RedisCache {
    private client: RedisType;
    private fallbackCache: Map<string, { value: any; expires: number }>;
    private monitor?: MonitoringService;
    private eventBus?: EventBusService;
    private readonly instanceId: string;
    private stats: CacheStats;
    private readonly STATS_INTERVAL = 60000; // 1 minute

    constructor(
        private config: RedisCacheConfig,
        monitor?: MonitoringService,
        eventBus?: EventBusService
    ) {
        this.instanceId = uuidv4();
        this.monitor = monitor;
        this.eventBus = eventBus;
        this.fallbackCache = new Map();
        this.stats = {
            hits: 0,
            misses: 0,
            keys: 0,
            memoryUsage: 0,
            uptime: 0
        };
    }

    async initialize(): Promise<void> {
        if (!this.config.enabled) return;

        try {
            // Initialize Redis client
            if (this.config.cluster) {
                this.client = new Redis.Cluster(this.config.cluster.nodes, {
                    scaleReads: this.config.cluster.options?.scaleReads || 'master',
                    maxRedirections: this.config.cluster.options?.maxRedirections || 16,
                    retryDelayOnFailover: 100
                });
            } else if (this.config.redis) {
                this.client = new Redis({
                    host: this.config.redis.host,
                    port: this.config.redis.port,
                    password: this.config.redis.password,
                    maxRetriesPerRequest: this.config.redis.maxRetriesPerRequest || 3,
                    enableReadyCheck: this.config.redis.enableReadyCheck ?? true,
                    connectTimeout: this.config.redis.connectTimeout || 10000,
                    retryStrategy: (times) => Math.min(times * 50, 2000)
                });
            } else {
                throw new Error('Redis configuration missing');
            }

            // Setup event handlers
            this.setupEventHandlers();

            // Start stats collection
            this.startStatsCollection();

            await this.recordMetric('cache_initialized', 1);

        } catch (error) {
            await this.handleError('initialization_error', error);
            // Fall back to in-memory cache
            this.client = null as any;
        }
    }

    async get<T>(key: string): Promise<T | null> {
        if (!this.config.enabled) return null;

        try {
            let value: T | null = null;

            if (this.client) {
                const data = await this.client.get(key);
                if (data) {
                    value = JSON.parse(data);
                    this.stats.hits++;
                    await this.recordMetric('cache_hit', 1);
                } else {
                    this.stats.misses++;
                    await this.recordMetric('cache_miss', 1);
                }
            } else {
                // Fallback to in-memory cache
                const cached = this.fallbackCache.get(key);
                if (cached && cached.expires > Date.now()) {
                    value = cached.value;
                    this.stats.hits++;
                    await this.recordMetric('cache_hit', 1);
                } else {
                    this.stats.misses++;
                    await this.recordMetric('cache_miss', 1);
                    if (cached) {
                        this.fallbackCache.delete(key);
                    }
                }
            }

            return value;

        } catch (error) {
            await this.handleError('get_error', error);
            return null;
        }
    }

    async set(key: string, value: any, ttl?: number): Promise<void> {
        if (!this.config.enabled) return;

        try {
            const effectiveTTL = ttl || this.config.defaultTTL;
            const serialized = JSON.stringify(value);

            if (this.client) {
                if (effectiveTTL > 0) {
                    await this.client.set(key, serialized, 'EX', effectiveTTL);
                } else {
                    await this.client.set(key, serialized);
                }
            } else {
                // Fallback to in-memory cache
                this.fallbackCache.set(key, {
                    value,
                    expires: Date.now() + (effectiveTTL * 1000)
                });

                // Enforce max size limit
                if (this.fallbackCache.size > this.config.maxSize) {
                    const oldestKey = Array.from(this.fallbackCache.keys())[0];
                    this.fallbackCache.delete(oldestKey);
                }
            }

            this.stats.keys = await this.getKeyCount();
            await this.recordMetric('cache_set', 1);

        } catch (error) {
            await this.handleError('set_error', error);
        }
    }

    async delete(key: string): Promise<void> {
        if (!this.config.enabled) return;

        try {
            if (this.client) {
                await this.client.del(key);
            } else {
                this.fallbackCache.delete(key);
            }

            this.stats.keys = await this.getKeyCount();
            await this.recordMetric('cache_delete', 1);

        } catch (error) {
            await this.handleError('delete_error', error);
        }
    }

    async clear(): Promise<void> {
        if (!this.config.enabled) return;

        try {
            if (this.client) {
                await this.client.flushall();
            } else {
                this.fallbackCache.clear();
            }

            this.stats.keys = 0;
            await this.recordMetric('cache_clear', 1);

        } catch (error) {
            await this.handleError('clear_error', error);
        }
    }

    async getStats(): Promise<CacheStats> {
        return this.stats;
    }

    private setupEventHandlers(): void {
        if (!this.client) return;

        this.client.on('error', async (error) => {
            await this.handleError('redis_error', error);
        });

        this.client.on('connect', async () => {
            await this.recordMetric('redis_connect', 1);
        });

        this.client.on('ready', async () => {
            await this.recordMetric('redis_ready', 1);
        });

        this.client.on('close', async () => {
            await this.recordMetric('redis_close', 1);
        });

        this.client.on('reconnecting', async () => {
            await this.recordMetric('redis_reconnecting', 1);
        });
    }

    private startStatsCollection(): void {
        setInterval(async () => {
            try {
                if (this.client) {
                    const info = await this.client.info();
                    this.stats.memoryUsage = this.parseMemoryUsage(info);
                    this.stats.uptime = this.parseUptime(info);
                }

                await this.recordMetric('cache_stats', 1, {
                    hits: this.stats.hits,
                    misses: this.stats.misses,
                    keys: this.stats.keys,
                    memory_usage: this.stats.memoryUsage
                });

            } catch (error) {
                await this.handleError('stats_collection_error', error);
            }
        }, this.STATS_INTERVAL);
    }

    private parseMemoryUsage(info: string): number {
        const match = info.match(/used_memory:(\d+)/);
        return match ? parseInt(match[1]) : 0;
    }

    private parseUptime(info: string): number {
        const match = info.match(/uptime_in_seconds:(\d+)/);
        return match ? parseInt(match[1]) : 0;
    }

    private async getKeyCount(): Promise<number> {
        if (this.client) {
            const keys = await this.client.dbsize();
            return keys;
        }
        return this.fallbackCache.size;
    }

    private async recordMetric(
        name: string,
        value: number,
        labels?: Record<string, string>
    ): Promise<void> {
        if (this.monitor) {
            await this.monitor.recordMetric({
                name: `cache_${name}`,
                value,
                labels: {
                    instance_id: this.instanceId,
                    cache_type: this.client ? 'redis' : 'memory',
                    ...labels
                }
            });
        }
    }

    private async handleError(type: string, error: Error): Promise<void> {
        await this.recordMetric(`error_${type}`, 1);

        if (this.eventBus) {
            await this.eventBus.publish('cache.error', {
                type: 'cache.error',
                source: 'redis-cache',
                data: {
                    error: error.message,
                    type,
                    timestamp: new Date()
                }
            });
        }
    }

    async close(): Promise<void> {
        if (this.client) {
            await this.client.quit();
        }
        this.fallbackCache.clear();
    }
}

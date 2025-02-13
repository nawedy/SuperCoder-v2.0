import { MonitoringService } from '../monitoring/monitoring-service';
import { Redis } from 'ioredis';
import { SecurityConfig } from '../config/security-config';

interface CacheConfig {
    ttl: number;
    maxSize: number;
    encryption: boolean;
}

interface CacheStats {
    hits: number;
    misses: number;
    size: number;
    lastCleanup: Date;
}

export class CacheService {
    private monitor: MonitoringService;
    private securityConfig: SecurityConfig;
    private redis: Redis;
    private localCache: Map<string, { value: any; expiry: number }>;
    private stats: CacheStats;

    constructor(
        monitor: MonitoringService,
        securityConfig: SecurityConfig,
        redisUrl: string
    ) {
        this.monitor = monitor;
        this.securityConfig = securityConfig;
        this.redis = new Redis(redisUrl);
        this.localCache = new Map();
        this.stats = {
            hits: 0,
            misses: 0,
            size: 0,
            lastCleanup: new Date()
        };

        this.setupCleanupJob();
    }

    async get<T>(key: string): Promise<T | null> {
        try {
            // Try local cache first
            const localValue = this.getFromLocalCache<T>(key);
            if (localValue) {
                this.stats.hits++;
                return localValue;
            }

            // Try Redis
            const redisValue = await this.getFromRedis<T>(key);
            if (redisValue) {
                this.stats.hits++;
                // Update local cache
                this.setToLocalCache(key, redisValue);
                return redisValue;
            }

            this.stats.misses++;
            return null;

        } catch (error) {
            await this.monitor.recordMetric({
                name: 'cache_error',
                value: 1,
                labels: { operation: 'get', error: error.message }
            });
            throw error;
        }
    }

    async set(key: string, value: any, config?: Partial<CacheConfig>): Promise<void> {
        try {
            const finalConfig = this.getConfig(config);
            
            // Encrypt if needed
            const processedValue = finalConfig.encryption ? 
                await this.encryptValue(value) : value;

            // Set in Redis
            await this.setToRedis(key, processedValue, finalConfig.ttl);
            
            // Set in local cache
            this.setToLocalCache(key, value, finalConfig.ttl);

            await this.monitor.recordMetric({
                name: 'cache_set',
                value: 1,
                labels: { key_prefix: key.split(':')[0] }
            });

        } catch (error) {
            await this.monitor.recordMetric({
                name: 'cache_error',
                value: 1,
                labels: { operation: 'set', error: error.message }
            });
            throw error;
        }
    }

    async invalidate(key: string): Promise<void> {
        try {
            // Remove from both caches
            this.localCache.delete(key);
            await this.redis.del(key);

            await this.monitor.recordMetric({
                name: 'cache_invalidate',
                value: 1,
                labels: { key_prefix: key.split(':')[0] }
            });

        } catch (error) {
            await this.monitor.recordMetric({
                name: 'cache_error',
                value: 1,
                labels: { operation: 'invalidate', error: error.message }
            });
            throw error;
        }
    }

    private getFromLocalCache<T>(key: string): T | null {
        const entry = this.localCache.get(key);
        if (!entry) return null;

        if (entry.expiry < Date.now()) {
            this.localCache.delete(key);
            return null;
        }

        return entry.value as T;
    }

    private async getFromRedis<T>(key: string): Promise<T | null> {
        const value = await this.redis.get(key);
        if (!value) return null;

        try {
            return JSON.parse(value) as T;
        } catch {
            return null;
        }
    }

    private async setToRedis(key: string, value: any, ttl: number): Promise<void> {
        const serializedValue = JSON.stringify(value);
        await this.redis.set(key, serializedValue, 'EX', ttl);
    }

    private setToLocalCache(key: string, value: any, ttl?: number): void {
        const expiry = Date.now() + (ttl || 300) * 1000; // Default 5 minutes
        this.localCache.set(key, { value, expiry });
        this.stats.size = this.localCache.size;
    }

    private setupCleanupJob(): void {
        setInterval(() => this.cleanup(), 60000); // Run every minute
    }

    private async cleanup(): Promise<void> {
        const now = Date.now();
        let cleaned = 0;

        for (const [key, entry] of this.localCache.entries()) {
            if (entry.expiry < now) {
                this.localCache.delete(key);
                cleaned++;
            }
        }

        this.stats.lastCleanup = new Date();
        this.stats.size = this.localCache.size;

        await this.monitor.recordMetric({
            name: 'cache_cleanup',
            value: cleaned,
            labels: { cache_size: this.stats.size.toString() }
        });
    }

    private getConfig(config?: Partial<CacheConfig>): CacheConfig {
        return {
            ttl: config?.ttl || 300, // 5 minutes
            maxSize: config?.maxSize || 1000,
            encryption: config?.encryption ?? this.securityConfig.encryption.enabled
        };
    }

    private async encryptValue(value: any): Promise<string> {
        // Implement encryption logic using KMS
        return JSON.stringify(value);
    }
}

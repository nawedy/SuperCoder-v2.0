import { MonitoringService } from '../monitoring/monitoring-service';
import { EventBusService } from '../events/event-bus-service';
import { AuditTrailService } from '../audit/audit-trail-service';
import { Redis } from 'ioredis';
import { Memcached } from 'memcached';
import { Etcd3 } from 'etcd3';
import * as zlib from 'zlib';
import { promisify } from 'util';
import { v4 as uuidv4 } from 'uuid';

const gzip = promisify(zlib.gzip);
const ungzip = promisify(zlib.gunzip);

interface CacheConfig {
    backends: {
        primary: CacheBackend;
        secondary?: CacheBackend;
        metadata?: CacheBackend;
    };
    replication: {
        enabled: boolean;
        mode: 'sync' | 'async';
        consistency: 'strong' | 'eventual';
    };
    compression: {
        enabled: boolean;
        threshold: number; // bytes
    };
    ttl: number;
    maxSize: number; // MB
    healthCheck: {
        interval: number;
        timeout: number;
    };
}

type CacheBackend = 'redis' | 'memcached' | 'etcd';

interface CacheEntry<T> {
    key: string;
    value: T;
    metadata: {
        version: number;
        createdAt: Date;
        lastAccessed: Date;
        expiresAt: Date;
        size: number;
        compressed: boolean;
        checksum: string;
    };
}

interface CacheStats {
    operations: {
        reads: number;
        writes: number;
        hits: number;
        misses: number;
    };
    storage: {
        size: number;
        items: number;
        evictions: number;
    };
    replication: {
        lag: number;
        syncErrors: number;
        lastSync: Date;
    };
    health: {
        status: 'healthy' | 'degraded' | 'unhealthy';
        lastCheck: Date;
        errors: string[];
    };
}

export class DistributedCacheService {
    private monitor: MonitoringService;
    private eventBus: EventBusService;
    private audit: AuditTrailService;
    private config: CacheConfig;
    private primaryClient: any;
    private secondaryClient: any;
    private metadataClient: any;
    private stats: CacheStats;
    private healthCheckInterval: NodeJS.Timeout;
    private readonly lockPrefix = 'lock:';
    private readonly statsPrefix = 'stats:';
    private readonly metadataPrefix = 'meta:';

    constructor(
        monitor: MonitoringService,
        eventBus: EventBusService,
        audit: AuditTrailService,
        config: CacheConfig
    ) {
        this.monitor = monitor;
        this.eventBus = eventBus;
        this.audit = audit;
        this.config = config;
        this.stats = this.initializeStats();

        this.initialize();
    }

    private async initialize(): Promise<void> {
        try {
            await this.initializeBackends();
            await this.validateConfig();
            await this.startHealthCheck();
            await this.setupReplication();
            await this.loadStats();

            await this.audit.logEvent({
                eventType: 'system.config',
                actor: {
                    id: 'system',
                    type: 'service',
                    metadata: {}
                },
                resource: {
                    type: 'distributed-cache',
                    id: 'initialize',
                    action: 'create'
                },
                context: {
                    location: 'distributed-cache',
                    ipAddress: 'internal',
                    userAgent: 'system'
                },
                status: 'success',
                details: { config: this.sanitizeConfig(this.config) }
            });

        } catch (error) {
            await this.handleError('initialization_error', error);
            throw error;
        }
    }

    async get<T>(key: string): Promise<T | null> {
        const startTime = Date.now();
        try {
            // Try primary backend
            let entry = await this.getFromBackend<T>(key, this.primaryClient);

            // Try secondary if primary fails
            if (!entry && this.secondaryClient) {
                entry = await this.getFromBackend<T>(key, this.secondaryClient);
                if (entry) {
                    // Restore to primary
                    await this.setToBackend(key, entry, this.primaryClient);
                }
            }

            // Update stats
            this.updateStats(entry ? 'hit' : 'miss', 'read', Date.now() - startTime);

            return entry?.value || null;

        } catch (error) {
            await this.handleError('get_error', error);
            return null;
        }
    }

    async set<T>(
        key: string,
        value: T,
        ttl?: number
    ): Promise<boolean> {
        const startTime = Date.now();
        try {
            // Acquire lock
            const locked = await this.acquireLock(key);
            if (!locked) {
                throw new Error('Failed to acquire lock');
            }

            try {
                const entry = await this.createCacheEntry(key, value);

                // Store in primary backend
                await this.setToBackend(key, entry, this.primaryClient);

                // Handle replication
                if (this.config.replication.enabled && this.secondaryClient) {
                    if (this.config.replication.mode === 'sync') {
                        await this.setToBackend(key, entry, this.secondaryClient);
                    } else {
                        this.replicateAsync(key, entry);
                    }
                }

                // Update stats
                this.updateStats('write', 'write', Date.now() - startTime);

                // Store metadata
                await this.storeMetadata(key, entry.metadata);

                return true;

            } finally {
                // Release lock
                await this.releaseLock(key);
            }

        } catch (error) {
            await this.handleError('set_error', error);
            return false;
        }
    }

    async delete(key: string): Promise<boolean> {
        try {
            const locked = await this.acquireLock(key);
            if (!locked) {
                throw new Error('Failed to acquire lock');
            }

            try {
                // Delete from all backends
                await Promise.all([
                    this.deleteFromBackend(key, this.primaryClient),
                    this.secondaryClient && this.deleteFromBackend(key, this.secondaryClient),
                    this.deleteMetadata(key)
                ]);

                return true;

            } finally {
                await this.releaseLock(key);
            }

        } catch (error) {
            await this.handleError('delete_error', error);
            return false;
        }
    }

    private async getFromBackend<T>(
        key: string,
        client: any
    ): Promise<CacheEntry<T> | null> {
        let value: string | null = null;

        if (client instanceof Redis) {
            value = await client.get(key);
        } else if (client instanceof Memcached) {
            value = await new Promise((resolve, reject) => {
                client.get(key, (err, data) => {
                    if (err) reject(err);
                    resolve(data);
                });
            });
        } else if (client instanceof Etcd3) {
            value = await client.get(key).string();
        }

        if (!value) return null;

        const entry: CacheEntry<T> = JSON.parse(value);
        
        // Check expiration
        if (new Date(entry.metadata.expiresAt) < new Date()) {
            await this.delete(key);
            return null;
        }

        // Decompress if needed
        if (entry.metadata.compressed) {
            const buffer = Buffer.from(entry.value as string, 'base64');
            const decompressed = await ungzip(buffer);
            entry.value = JSON.parse(decompressed.toString());
        }

        // Update access time
        entry.metadata.lastAccessed = new Date();
        await this.storeMetadata(key, entry.metadata);

        return entry;
    }

    private async setToBackend<T>(
        key: string,
        entry: CacheEntry<T>,
        client: any
    ): Promise<void> {
        let value = entry;

        // Compress if needed
        if (this.shouldCompress(entry)) {
            const compressed = await gzip(Buffer.from(JSON.stringify(entry.value)));
            value = {
                ...entry,
                value: compressed.toString('base64'),
                metadata: {
                    ...entry.metadata,
                    compressed: true
                }
            };
        }

        if (client instanceof Redis) {
            await client.set(
                key,
                JSON.stringify(value),
                'EX',
                Math.ceil((new Date(entry.metadata.expiresAt).getTime() - Date.now()) / 1000)
            );
        } else if (client instanceof Memcached) {
            await new Promise((resolve, reject) => {
                client.set(
                    key,
                    JSON.stringify(value),
                    Math.ceil((new Date(entry.metadata.expiresAt).getTime() - Date.now()) / 1000),
                    (err) => err ? reject(err) : resolve(undefined)
                );
            });
        } else if (client instanceof Etcd3) {
            await client.put(key).value(JSON.stringify(value));
        }
    }

    private async deleteFromBackend(
        key: string,
        client: any
    ): Promise<void> {
        if (client instanceof Redis) {
            await client.del(key);
        } else if (client instanceof Memcached) {
            await new Promise((resolve, reject) => {
                client.del(key, (err) => err ? reject(err) : resolve(undefined));
            });
        } else if (client instanceof Etcd3) {
            await client.delete().key(key);
        }
    }

    private async createCacheEntry<T>(
        key: string,
        value: T
    ): Promise<CacheEntry<T>> {
        const serialized = JSON.stringify(value);
        const expiresAt = new Date(Date.now() + (this.config.ttl * 1000));

        return {
            key,
            value,
            metadata: {
                version: Date.now(),
                createdAt: new Date(),
                lastAccessed: new Date(),
                expiresAt,
                size: Buffer.from(serialized).length,
                compressed: false,
                checksum: this.calculateChecksum(serialized)
            }
        };
    }

    private async acquireLock(key: string): Promise<boolean> {
        const lockKey = `${this.lockPrefix}${key}`;
        const lockId = uuidv4();
        const acquired = await this.primaryClient.set(
            lockKey,
            lockId,
            'NX',
            'PX',
            5000 // 5 second lock timeout
        );

        return !!acquired;
    }

    private async releaseLock(key: string): Promise<void> {
        const lockKey = `${this.lockPrefix}${key}`;
        await this.primaryClient.del(lockKey);
    }

    private async storeMetadata(
        key: string,
        metadata: CacheEntry<any>['metadata']
    ): Promise<void> {
        if (!this.metadataClient) return;

        const metaKey = `${this.metadataPrefix}${key}`;
        await this.setToBackend(metaKey, { metadata }, this.metadataClient);
    }

    private async deleteMetadata(key: string): Promise<void> {
        if (!this.metadataClient) return;

        const metaKey = `${this.metadataPrefix}${key}`;
        await this.deleteFromBackend(metaKey, this.metadataClient);
    }

    private shouldCompress(entry: CacheEntry<any>): boolean {
        return this.config.compression.enabled &&
               entry.metadata.size > this.config.compression.threshold &&
               !entry.metadata.compressed;
    }

    private calculateChecksum(data: string): string {
        const crypto = require('crypto');
        return crypto
            .createHash('sha256')
            .update(data)
            .digest('hex');
    }

    private async initializeBackends(): Promise<void> {
        // Initialize primary backend
        this.primaryClient = this.createBackendClient(
            this.config.backends.primary
        );

        // Initialize secondary backend if configured
        if (this.config.backends.secondary) {
            this.secondaryClient = this.createBackendClient(
                this.config.backends.secondary
            );
        }

        // Initialize metadata backend if configured
        if (this.config.backends.metadata) {
            this.metadataClient = this.createBackendClient(
                this.config.backends.metadata
            );
        }
    }

    private createBackendClient(backend: CacheBackend): any {
        switch (backend) {
            case 'redis':
                return new Redis();
            case 'memcached':
                return new Memcached('localhost:11211');
            case 'etcd':
                return new Etcd3();
            default:
                throw new Error(`Unsupported backend: ${backend}`);
        }
    }

    private async validateConfig(): Promise<void> {
        if (!this.config.backends.primary) {
            throw new Error('Primary backend not configured');
        }

        if (this.config.replication.enabled && !this.config.backends.secondary) {
            throw new Error('Secondary backend required for replication');
        }
    }

    private async setupReplication(): Promise<void> {
        if (!this.config.replication.enabled) return;

        this.eventBus.subscribe({
            id: 'cache-replication',
            topic: 'cache.replication',
            handler: async (event) => {
                try {
                    const { key, entry } = event.data;
                    await this.setToBackend(key, entry, this.secondaryClient);
                } catch (error) {
                    await this.handleError('replication_error', error);
                }
            }
        });
    }

    private async replicateAsync(
        key: string,
        entry: CacheEntry<any>
    ): Promise<void> {
        await this.eventBus.publish('cache.replication', {
            type: 'cache.replication',
            source: 'distributed-cache',
            data: { key, entry },
            metadata: {
                timestamp: new Date(),
                environment: process.env.NODE_ENV || 'development'
            }
        });
    }

    private startHealthCheck(): void {
        this.healthCheckInterval = setInterval(
            async () => {
                try {
                    await this.checkHealth();
                } catch (error) {
                    await this.handleError('health_check_error', error);
                }
            },
            this.config.healthCheck.interval
        );
    }

    private async checkHealth(): Promise<void> {
        const startTime = Date.now();
        const errors: string[] = [];

        try {
            // Check primary backend
            if (!await this.pingBackend(this.primaryClient)) {
                errors.push('Primary backend unreachable');
            }

            // Check secondary backend
            if (this.secondaryClient && !await this.pingBackend(this.secondaryClient)) {
                errors.push('Secondary backend unreachable');
            }

            // Check metadata backend
            if (this.metadataClient && !await this.pingBackend(this.metadataClient)) {
                errors.push('Metadata backend unreachable');
            }

            // Update health status
            this.stats.health = {
                status: errors.length === 0 ? 'healthy' : 
                    errors.length === 1 ? 'degraded' : 'unhealthy',
                lastCheck: new Date(),
                errors
            };

            // Record metrics
            await this.monitor.recordMetric({
                name: 'cache_health_check',
                value: Date.now() - startTime,
                labels: {
                    status: this.stats.health.status,
                    errors: errors.length.toString()
                }
            });

        } catch (error) {
            await this.handleError('health_check_error', error);
        }
    }

    private async pingBackend(client: any): Promise<boolean> {
        try {
            if (client instanceof Redis) {
                await client.ping();
            } else if (client instanceof Memcached) {
                await new Promise((resolve, reject) => {
                    client.stats((err, data) => {
                        err ? reject(err) : resolve(data);
                    });
                });
            } else if (client instanceof Etcd3) {
                await client.maintenance.status();
            }
            return true;
        } catch {
            return false;
        }
    }

    private initializeStats(): CacheStats {
        return {
            operations: {
                reads: 0,
                writes: 0,
                hits: 0,
                misses: 0
            },
            storage: {
                size: 0,
                items: 0,
                evictions: 0
            },
            replication: {
                lag: 0,
                syncErrors: 0,
                lastSync: new Date()
            },
            health: {
                status: 'healthy',
                lastCheck: new Date(),
                errors: []
            }
        };
    }

    private async loadStats(): Promise<void> {
        const stats = await this.getFromBackend<CacheStats>(
            this.statsPrefix,
            this.primaryClient
        );
        if (stats) {
            this.stats = stats.value;
        }
    }

    private updateStats(
        operation: 'hit' | 'miss' | 'write',
        type: 'read' | 'write',
        latency: number
    ): void {
        const stats = this.stats.operations;
        
        if (type === 'read') {
            stats.reads++;
            if (operation === 'hit') {
                stats.hits++;
            } else {
                stats.misses++;
            }
        } else {
            stats.writes++;
        }

        // Record metrics
        this.monitor.recordMetric({
            name: 'cache_operation',
            value: latency,
            labels: {
                operation,
                type
            }
        });
    }

    private sanitizeConfig(config: CacheConfig): any {
        // Remove sensitive information before logging
        const sanitized = { ...config };
        delete sanitized.backends;
        return sanitized;
    }

    private async handleError(type: string, error: Error): Promise<void> {
        await this.monitor.recordMetric({
            name: type,
            value: 1,
            labels: { error: error.message }
        });

        await this.eventBus.publish('cache.error', {
            type: 'cache.error',
            source: 'distributed-cache',
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
        clearInterval(this.healthCheckInterval);

        // Close all connections
        if (this.primaryClient?.disconnect) {
            await this.primaryClient.disconnect();
        }
        if (this.secondaryClient?.disconnect) {
            await this.secondaryClient.disconnect();
        }
        if (this.metadataClient?.disconnect) {
            await this.metadataClient.disconnect();
        }
    }
}

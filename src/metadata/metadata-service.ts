import { MonitoringService } from '../monitoring/monitoring-service';
import { CacheService } from '../cache/cache-service';
import { Firestore } from '@google-cloud/firestore';
import { AuditTrailService } from '../audit/audit-trail-service';

interface MetadataEntry {
    id: string;
    type: 'model' | 'dataset' | 'job' | 'user' | 'system';
    key: string;
    value: any;
    schema?: Record<string, any>;
    version: number;
    tags: string[];
    metadata: {
        createdAt: Date;
        updatedAt: Date;
        createdBy: string;
        updatedBy: string;
    };
}

interface MetadataQuery {
    type?: string;
    tags?: string[];
    timeRange?: {
        start: Date;
        end: Date;
    };
    version?: number;
}

export class MetadataService {
    private monitor: MonitoringService;
    private cache: CacheService;
    private firestore: Firestore;
    private auditService: AuditTrailService;
    private readonly COLLECTION = 'metadata';

    constructor(
        monitor: MonitoringService,
        cache: CacheService,
        auditService: AuditTrailService
    ) {
        this.monitor = monitor;
        this.cache = cache;
        this.firestore = new Firestore();
        this.auditService = auditService;
    }

    async setMetadata(entry: Omit<MetadataEntry, 'id' | 'version' | 'metadata'>): Promise<MetadataEntry> {
        try {
            // Validate entry
            await this.validateEntry(entry);

            // Check if entry exists
            const existingEntry = await this.getMetadataByKey(entry.type, entry.key);
            const version = existingEntry ? existingEntry.version + 1 : 1;

            const newEntry: MetadataEntry = {
                ...entry,
                id: existingEntry?.id || this.generateMetadataId(),
                version,
                metadata: {
                    createdAt: existingEntry?.metadata.createdAt || new Date(),
                    updatedAt: new Date(),
                    createdBy: existingEntry?.metadata.createdBy || 'system',
                    updatedBy: 'system'
                }
            };

            // Store in Firestore
            await this.firestore
                .collection(this.COLLECTION)
                .doc(newEntry.id)
                .set(this.serializeEntry(newEntry));

            // Update cache
            await this.cache.set(
                this.buildCacheKey(entry.type, entry.key),
                newEntry,
                { ttl: 3600 } // 1 hour cache
            );

            // Audit trail
            await this.auditService.logEvent({
                eventType: 'data.modify',
                actor: {
                    id: 'system',
                    type: 'service',
                    metadata: { entryId: newEntry.id }
                },
                resource: {
                    type: 'metadata',
                    id: newEntry.id,
                    action: existingEntry ? 'update' : 'create'
                },
                context: {
                    location: 'metadata-service',
                    ipAddress: 'internal',
                    userAgent: 'system'
                },
                status: 'success',
                details: { type: entry.type, key: entry.key }
            });

            await this.monitor.recordMetric({
                name: 'metadata_operation',
                value: 1,
                labels: {
                    operation: existingEntry ? 'update' : 'create',
                    type: entry.type
                }
            });

            return newEntry;
        } catch (error) {
            await this.handleError('metadata_set_error', error);
            throw error;
        }
    }

    async getMetadata<T = any>(
        type: string,
        key: string
    ): Promise<T | null> {
        try {
            // Try cache first
            const cacheKey = this.buildCacheKey(type, key);
            const cached = await this.cache.get<T>(cacheKey);
            if (cached) {
                return cached;
            }

            // Get from Firestore
            const entry = await this.getMetadataByKey(type, key);
            if (!entry) {
                return null;
            }

            // Update cache
            await this.cache.set(cacheKey, entry.value, { ttl: 3600 });

            await this.monitor.recordMetric({
                name: 'metadata_access',
                value: 1,
                labels: { type, key }
            });

            return entry.value;
        } catch (error) {
            await this.handleError('metadata_get_error', error);
            throw error;
        }
    }

    async queryMetadata(query: MetadataQuery): Promise<MetadataEntry[]> {
        try {
            let firestoreQuery = this.firestore.collection(this.COLLECTION);

            if (query.type) {
                firestoreQuery = firestoreQuery.where('type', '==', query.type);
            }

            if (query.version) {
                firestoreQuery = firestoreQuery.where('version', '==', query.version);
            }

            if (query.timeRange) {
                firestoreQuery = firestoreQuery
                    .where('metadata.updatedAt', '>=', query.timeRange.start)
                    .where('metadata.updatedAt', '<=', query.timeRange.end);
            }

            const snapshot = await firestoreQuery.get();
            const entries = snapshot.docs.map(doc => this.deserializeEntry(doc.data()));

            // Filter by tags if provided
            const filteredEntries = query.tags
                ? entries.filter(entry => 
                    query.tags!.every(tag => entry.tags.includes(tag)))
                : entries;

            await this.monitor.recordMetric({
                name: 'metadata_query',
                value: filteredEntries.length,
                labels: {
                    type: query.type || 'all',
                    has_tags: query.tags ? 'true' : 'false'
                }
            });

            return filteredEntries;
        } catch (error) {
            await this.handleError('metadata_query_error', error);
            throw error;
        }
    }

    async deleteMetadata(type: string, key: string): Promise<void> {
        try {
            const entry = await this.getMetadataByKey(type, key);
            if (!entry) {
                throw new Error('Metadata entry not found');
            }

            // Remove from Firestore
            await this.firestore
                .collection(this.COLLECTION)
                .doc(entry.id)
                .delete();

            // Remove from cache
            await this.cache.invalidate(this.buildCacheKey(type, key));

            // Audit trail
            await this.auditService.logEvent({
                eventType: 'data.modify',
                actor: {
                    id: 'system',
                    type: 'service',
                    metadata: { entryId: entry.id }
                },
                resource: {
                    type: 'metadata',
                    id: entry.id,
                    action: 'delete'
                },
                context: {
                    location: 'metadata-service',
                    ipAddress: 'internal',
                    userAgent: 'system'
                },
                status: 'success',
                details: { type, key }
            });

            await this.monitor.recordMetric({
                name: 'metadata_delete',
                value: 1,
                labels: { type, key }
            });
        } catch (error) {
            await this.handleError('metadata_delete_error', error);
            throw error;
        }
    }

    private async getMetadataByKey(
        type: string,
        key: string
    ): Promise<MetadataEntry | null> {
        const snapshot = await this.firestore
            .collection(this.COLLECTION)
            .where('type', '==', type)
            .where('key', '==', key)
            .limit(1)
            .get();

        if (snapshot.empty) {
            return null;
        }

        return this.deserializeEntry(snapshot.docs[0].data());
    }

    private async validateEntry(entry: Partial<MetadataEntry>): Promise<void> {
        if (!entry.type || !entry.key || entry.value === undefined) {
            throw new Error('Invalid metadata entry: Missing required fields');
        }

        if (entry.schema) {
            // Implement schema validation
        }
    }

    private buildCacheKey(type: string, key: string): string {
        return `metadata:${type}:${key}`;
    }

    private serializeEntry(entry: MetadataEntry): any {
        return {
            ...entry,
            metadata: {
                ...entry.metadata,
                createdAt: entry.metadata.createdAt.toISOString(),
                updatedAt: entry.metadata.updatedAt.toISOString()
            }
        };
    }

    private deserializeEntry(data: any): MetadataEntry {
        return {
            ...data,
            metadata: {
                ...data.metadata,
                createdAt: new Date(data.metadata.createdAt),
                updatedAt: new Date(data.metadata.updatedAt)
            }
        };
    }

    private generateMetadataId(): string {
        return `meta-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }

    private async handleError(type: string, error: Error): Promise<void> {
        await this.monitor.recordMetric({
            name: type,
            value: 1,
            labels: { error: error.message }
        });
    }
}

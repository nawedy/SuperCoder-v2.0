import { MonitoringService } from '../monitoring/monitoring-service';
import { CacheService } from '../cache/cache-service';
import { AuditTrailService } from '../audit/audit-trail-service';
import { SecretManager } from '@google-cloud/secret-manager';
import { Firestore } from '@google-cloud/firestore';

interface ConfigValue {
    value: any;
    metadata: {
        version: number;
        environment: string;
        lastUpdated: Date;
        updatedBy: string;
    };
}

interface ConfigChangeEvent {
    key: string;
    oldValue: any;
    newValue: any;
    timestamp: Date;
    updatedBy: string;
}

export class ConfigurationService {
    private monitor: MonitoringService;
    private cache: CacheService;
    private audit: AuditTrailService;
    private secretManager: SecretManager;
    private firestore: Firestore;
    private configChangeListeners: Map<string, ((event: ConfigChangeEvent) => Promise<void>)[]>;
    private readonly CACHE_TTL = 300; // 5 minutes

    constructor(
        monitor: MonitoringService,
        cache: CacheService,
        audit: AuditTrailService,
        projectId: string
    ) {
        this.monitor = monitor;
        this.cache = cache;
        this.audit = audit;
        this.secretManager = new SecretManager({ projectId });
        this.firestore = new Firestore();
        this.configChangeListeners = new Map();

        this.initialize();
    }

    private async initialize(): Promise<void> {
        await this.setupConfigWatcher();
    }

    async getConfig<T>(key: string, defaultValue?: T): Promise<T> {
        try {
            // Try cache first
            const cachedValue = await this.cache.get<ConfigValue>(this.buildCacheKey(key));
            if (cachedValue) {
                return cachedValue.value;
            }

            // Check if it's a secret
            if (this.isSecretKey(key)) {
                return await this.getSecret(key);
            }

            // Get from Firestore
            const doc = await this.firestore
                .collection('configurations')
                .doc(key)
                .get();

            if (!doc.exists) {
                if (defaultValue === undefined) {
                    throw new Error(`Configuration not found: ${key}`);
                }
                return defaultValue;
            }

            const config = doc.data() as ConfigValue;

            // Cache the value
            await this.cache.set(
                this.buildCacheKey(key),
                config,
                { ttl: this.CACHE_TTL }
            );

            await this.monitor.recordMetric({
                name: 'config_access',
                value: 1,
                labels: { key }
            });

            return config.value;

        } catch (error) {
            await this.handleError('config_access_error', error);
            throw error;
        }
    }

    async setConfig(
        key: string,
        value: any,
        metadata: { environment: string; updatedBy: string }
    ): Promise<void> {
        try {
            // Validate key and value
            this.validateConfig(key, value);

            const oldConfig = await this.getConfigMetadata(key);
            const newConfig: ConfigValue = {
                value,
                metadata: {
                    version: oldConfig ? oldConfig.metadata.version + 1 : 1,
                    environment: metadata.environment,
                    lastUpdated: new Date(),
                    updatedBy: metadata.updatedBy
                }
            };

            if (this.isSecretKey(key)) {
                await this.setSecret(key, value);
            } else {
                await this.firestore
                    .collection('configurations')
                    .doc(key)
                    .set(newConfig);
            }

            // Invalidate cache
            await this.cache.invalidate(this.buildCacheKey(key));

            // Notify listeners
            await this.notifyConfigChange({
                key,
                oldValue: oldConfig?.value,
                newValue: value,
                timestamp: new Date(),
                updatedBy: metadata.updatedBy
            });

            await this.audit.logEvent({
                eventType: 'system.config',
                actor: {
                    id: metadata.updatedBy,
                    type: 'user',
                    metadata: {}
                },
                resource: {
                    type: 'configuration',
                    id: key,
                    action: 'update'
                },
                context: {
                    location: 'configuration-service',
                    ipAddress: 'internal',
                    userAgent: 'system'
                },
                status: 'success',
                details: {
                    environment: metadata.environment,
                    version: newConfig.metadata.version
                }
            });

        } catch (error) {
            await this.handleError('config_update_error', error);
            throw error;
        }
    }

    async watchConfig(
        key: string,
        callback: (event: ConfigChangeEvent) => Promise<void>
    ): Promise<() => void> {
        let listeners = this.configChangeListeners.get(key);
        if (!listeners) {
            listeners = [];
            this.configChangeListeners.set(key, listeners);
        }
        listeners.push(callback);

        // Return unsubscribe function
        return () => {
            const index = listeners!.indexOf(callback);
            if (index >= 0) {
                listeners!.splice(index, 1);
            }
        };
    }

    private async setupConfigWatcher(): Promise<void> {
        // Watch for configuration changes in Firestore
        this.firestore
            .collection('configurations')
            .onSnapshot(async snapshot => {
                for (const change of snapshot.docChanges()) {
                    if (change.type === 'modified') {
                        const newValue = change.doc.data() as ConfigValue;
                        await this.handleConfigChange(change.doc.id, newValue);
                    }
                }
            });
    }

    private async handleConfigChange(key: string, newConfig: ConfigValue): Promise<void> {
        // Invalidate cache
        await this.cache.invalidate(this.buildCacheKey(key));

        // Notify listeners
        const listeners = this.configChangeListeners.get(key);
        if (listeners) {
            const event: ConfigChangeEvent = {
                key,
                oldValue: null, // Could fetch old value if needed
                newValue: newConfig.value,
                timestamp: new Date(),
                updatedBy: newConfig.metadata.updatedBy
            };

            await Promise.all(listeners.map(listener => listener(event)));
        }
    }

    private async getConfigMetadata(key: string): Promise<ConfigValue | null> {
        const doc = await this.firestore
            .collection('configurations')
            .doc(key)
            .get();

        return doc.exists ? (doc.data() as ConfigValue) : null;
    }

    private async notifyConfigChange(event: ConfigChangeEvent): Promise<void> {
        const listeners = this.configChangeListeners.get(event.key);
        if (listeners) {
            await Promise.all(listeners.map(listener => listener(event)));
        }
    }

    private isSecretKey(key: string): boolean {
        return key.startsWith('secret://');
    }

    private async getSecret(key: string): Promise<string> {
        const secretName = this.getSecretName(key);
        const [version] = await this.secretManager
            .accessSecretVersion({ name: secretName });
        return version.payload?.data?.toString() || '';
    }

    private async setSecret(key: string, value: string): Promise<void> {
        const secretName = this.getSecretName(key);
        await this.secretManager.addSecretVersion({
            parent: secretName,
            payload: {
                data: Buffer.from(value)
            }
        });
    }

    private getSecretName(key: string): string {
        return key.replace('secret://', '');
    }

    private buildCacheKey(key: string): string {
        return `config:${key}`;
    }

    private validateConfig(key: string, value: any): void {
        if (!key) {
            throw new Error('Configuration key cannot be empty');
        }

        if (value === undefined || value === null) {
            throw new Error('Configuration value cannot be null or undefined');
        }
    }

    private async handleError(type: string, error: Error): Promise<void> {
        await this.monitor.recordMetric({
            name: type,
            value: 1,
            labels: { error: error.message }
        });
    }
}

import { MonitoringService } from '../monitoring/monitoring-service';
import { AuditTrailService } from '../audit/audit-trail-service';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { Storage } from '@google-cloud/storage';
import { z } from 'zod';

interface ConfigItem {
    key: string;
    value: any;
    type: 'string' | 'number' | 'boolean' | 'object' | 'array';
    environment: string;
    isSecret: boolean;
    validation?: z.ZodType<any>;
    metadata: {
        description?: string;
        tags: string[];
        createdAt: Date;
        updatedAt: Date;
        version: number;
    };
}

interface ConfigChangeEvent {
    key: string;
    oldValue: any;
    newValue: any;
    environment: string;
    timestamp: Date;
    actor: string;
}

interface ConfigSnapshot {
    id: string;
    timestamp: Date;
    environment: string;
    configs: Map<string, ConfigItem>;
    metadata: {
        version: number;
        description?: string;
    };
}

export class ConfigManagementService {
    private monitor: MonitoringService;
    private audit: AuditTrailService;
    private secretManager: SecretManagerServiceClient;
    private storage: Storage;
    private configs: Map<string, Map<string, ConfigItem>>;
    private snapshots: Map<string, ConfigSnapshot>;
    private readonly MAX_SNAPSHOTS = 10;
    private readonly CONFIG_BUCKET: string;
    private readonly PROJECT_ID: string;

    constructor(
        monitor: MonitoringService,
        audit: AuditTrailService,
        projectId: string
    ) {
        this.monitor = monitor;
        this.audit = audit;
        this.secretManager = new SecretManagerServiceClient();
        this.storage = new Storage({ projectId });
        this.configs = new Map();
        this.snapshots = new Map();
        this.PROJECT_ID = projectId;
        this.CONFIG_BUCKET = `${projectId}-configs`;

        this.initialize();
    }

    private async initialize(): Promise<void> {
        await this.ensureInfrastructure();
        await this.loadConfigs();
        this.startPeriodicSnapshot();
    }

    async getConfig<T>(
        key: string,
        environment: string,
        defaultValue?: T
    ): Promise<T> {
        try {
            const envConfigs = this.configs.get(environment);
            if (!envConfigs) {
                return defaultValue as T;
            }

            const config = envConfigs.get(key);
            if (!config) {
                return defaultValue as T;
            }

            if (config.isSecret) {
                return await this.getSecret(key, environment);
            }

            return config.value as T;

        } catch (error) {
            await this.handleError('config_retrieval_error', error);
            throw error;
        }
    }

    async setConfig(
        key: string,
        value: any,
        environment: string,
        options: {
            isSecret?: boolean;
            validation?: z.ZodType<any>;
            description?: string;
            tags?: string[];
        } = {}
    ): Promise<void> {
        try {
            // Validate input
            if (options.validation) {
                options.validation.parse(value);
            }

            // Get existing config
            const envConfigs = this.configs.get(environment) || new Map();
            const existingConfig = envConfigs.get(key);

            // Create new config item
            const configItem: ConfigItem = {
                key,
                value,
                type: this.getValueType(value),
                environment,
                isSecret: options.isSecret || false,
                validation: options.validation,
                metadata: {
                    description: options.description,
                    tags: options.tags || [],
                    createdAt: existingConfig?.metadata.createdAt || new Date(),
                    updatedAt: new Date(),
                    version: (existingConfig?.metadata.version || 0) + 1
                }
            };

            // Store config
            if (configItem.isSecret) {
                await this.storeSecret(key, value, environment);
            }

            // Update in-memory configs
            envConfigs.set(key, configItem);
            this.configs.set(environment, envConfigs);

            // Store config in Cloud Storage
            await this.persistConfig(configItem);

            // Create change event
            const changeEvent: ConfigChangeEvent = {
                key,
                oldValue: existingConfig?.value,
                newValue: value,
                environment,
                timestamp: new Date(),
                actor: 'system'
            };

            // Audit log
            await this.audit.logEvent({
                eventType: 'system.config',
                actor: {
                    id: 'system',
                    type: 'service',
                    metadata: {}
                },
                resource: {
                    type: 'config',
                    id: key,
                    action: 'update'
                },
                context: {
                    location: 'config-management',
                    ipAddress: 'internal',
                    userAgent: 'system'
                },
                status: 'success',
                details: changeEvent
            });

        } catch (error) {
            await this.handleError('config_update_error', error);
            throw error;
        }
    }

    async createSnapshot(
        environment: string,
        description?: string
    ): Promise<string> {
        try {
            const envConfigs = this.configs.get(environment);
            if (!envConfigs) {
                throw new Error(`No configs found for environment: ${environment}`);
            }

            const snapshot: ConfigSnapshot = {
                id: this.generateSnapshotId(),
                timestamp: new Date(),
                environment,
                configs: new Map(envConfigs),
                metadata: {
                    version: this.getLatestSnapshotVersion(environment) + 1,
                    description
                }
            };

            // Store snapshot
            await this.storeSnapshot(snapshot);

            // Maintain snapshot limit
            await this.cleanupOldSnapshots(environment);

            return snapshot.id;

        } catch (error) {
            await this.handleError('snapshot_creation_error', error);
            throw error;
        }
    }

    async rollbackToSnapshot(snapshotId: string): Promise<void> {
        try {
            const snapshot = this.snapshots.get(snapshotId);
            if (!snapshot) {
                throw new Error(`Snapshot not found: ${snapshotId}`);
            }

            // Backup current state
            await this.createSnapshot(
                snapshot.environment,
                'Auto-backup before rollback'
            );

            // Restore configs from snapshot
            for (const [key, config] of snapshot.configs.entries()) {
                await this.setConfig(
                    key,
                    config.value,
                    config.environment,
                    {
                        isSecret: config.isSecret,
                        validation: config.validation,
                        description: config.metadata.description,
                        tags: config.metadata.tags
                    }
                );
            }

            await this.audit.logEvent({
                eventType: 'system.config',
                actor: {
                    id: 'system',
                    type: 'service',
                    metadata: {}
                },
                resource: {
                    type: 'config',
                    id: 'rollback',
                    action: 'rollback'
                },
                context: {
                    location: 'config-management',
                    ipAddress: 'internal',
                    userAgent: 'system'
                },
                status: 'success',
                details: { snapshotId }
            });

        } catch (error) {
            await this.handleError('rollback_error', error);
            throw error;
        }
    }

    private async ensureInfrastructure(): Promise<void> {
        try {
            // Ensure config bucket exists
            const [bucketExists] = await this.storage
                .bucket(this.CONFIG_BUCKET)
                .exists();

            if (!bucketExists) {
                await this.storage.createBucket(this.CONFIG_BUCKET, {
                    location: 'US',
                    versioning: {
                        enabled: true
                    }
                });
            }
        } catch (error) {
            console.error('Failed to initialize config infrastructure:', error);
            throw error;
        }
    }

    private async loadConfigs(): Promise<void> {
        try {
            const [files] = await this.storage
                .bucket(this.CONFIG_BUCKET)
                .getFiles({ prefix: 'configs/' });

            for (const file of files) {
                const [content] = await file.download();
                const config: ConfigItem = JSON.parse(content.toString());
                
                const envConfigs = this.configs.get(config.environment) || new Map();
                envConfigs.set(config.key, config);
                this.configs.set(config.environment, envConfigs);
            }
        } catch (error) {
            await this.handleError('config_load_error', error);
            throw error;
        }
    }

    private async persistConfig(config: ConfigItem): Promise<void> {
        const filename = `configs/${config.environment}/${config.key}.json`;
        await this.storage
            .bucket(this.CONFIG_BUCKET)
            .file(filename)
            .save(JSON.stringify(config));
    }

    private async storeSnapshot(snapshot: ConfigSnapshot): Promise<void> {
        const filename = `snapshots/${snapshot.environment}/${snapshot.id}.json`;
        await this.storage
            .bucket(this.CONFIG_BUCKET)
            .file(filename)
            .save(JSON.stringify(snapshot));

        this.snapshots.set(snapshot.id, snapshot);
    }

    private async cleanupOldSnapshots(environment: string): Promise<void> {
        const envSnapshots = Array.from(this.snapshots.values())
            .filter(s => s.environment === environment)
            .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

        while (envSnapshots.length > this.MAX_SNAPSHOTS) {
            const oldSnapshot = envSnapshots.pop();
            if (oldSnapshot) {
                await this.deleteSnapshot(oldSnapshot.id);
            }
        }
    }

    private async deleteSnapshot(snapshotId: string): Promise<void> {
        const snapshot = this.snapshots.get(snapshotId);
        if (snapshot) {
            const filename = `snapshots/${snapshot.environment}/${snapshotId}.json`;
            await this.storage
                .bucket(this.CONFIG_BUCKET)
                .file(filename)
                .delete();

            this.snapshots.delete(snapshotId);
        }
    }

    private async storeSecret(
        key: string,
        value: any,
        environment: string
    ): Promise<void> {
        const secretId = this.getSecretId(key, environment);
        const parent = `projects/${this.PROJECT_ID}`;

        try {
            // Create secret if it doesn't exist
            try {
                await this.secretManager.createSecret({
                    parent,
                    secretId,
                    secret: {
                        replication: {
                            automatic: {}
                        }
                    }
                });
            } catch (error) {
                // Secret might already exist
            }

            // Add new version
            await this.secretManager.addSecretVersion({
                parent: `${parent}/secrets/${secretId}`,
                payload: {
                    data: Buffer.from(JSON.stringify(value))
                }
            });
        } catch (error) {
            await this.handleError('secret_store_error', error);
            throw error;
        }
    }

    private async getSecret<T>(key: string, environment: string): Promise<T> {
        const secretId = this.getSecretId(key, environment);
        const name = `projects/${this.PROJECT_ID}/secrets/${secretId}/versions/latest`;

        try {
            const [version] = await this.secretManager.accessSecretVersion({ name });
            return JSON.parse(version.payload.data.toString()) as T;
        } catch (error) {
            await this.handleError('secret_retrieval_error', error);
            throw error;
        }
    }

    private getSecretId(key: string, environment: string): string {
        return `${environment}_${key}`.toLowerCase().replace(/[^a-z0-9-_]/g, '_');
    }

    private getValueType(value: any): ConfigItem['type'] {
        if (Array.isArray(value)) return 'array';
        return typeof value as ConfigItem['type'];
    }

    private getLatestSnapshotVersion(environment: string): number {
        return Math.max(
            ...Array.from(this.snapshots.values())
                .filter(s => s.environment === environment)
                .map(s => s.metadata.version),
            0
        );
    }

    private generateSnapshotId(): string {
        return `snap-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }

    private startPeriodicSnapshot(): void {
        setInterval(async () => {
            try {
                for (const environment of this.configs.keys()) {
                    await this.createSnapshot(
                        environment,
                        'Automatic periodic snapshot'
                    );
                }
            } catch (error) {
                await this.handleError('periodic_snapshot_error', error);
            }
        }, 24 * 60 * 60 * 1000); // Daily snapshots
    }

    private async handleError(type: string, error: Error): Promise<void> {
        await this.monitor.recordMetric({
            name: type,
            value: 1,
            labels: { error: error.message }
        });
    }
}

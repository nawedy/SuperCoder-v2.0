import { MonitoringService } from '../monitoring/monitoring-service';
import { EventBusService } from '../events/event-bus-service';
import { AuditTrailService } from '../audit/audit-trail-service';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { CloudKMS } from '@google-cloud/kms';
import { Storage } from '@google-cloud/storage';
import { v4 as uuidv4 } from 'uuid';

interface ConfigurationOptions {
    environment: 'development' | 'staging' | 'production';
    region: string;
    encryptionEnabled: boolean;
    versionControl: boolean;
    autoReload: boolean;
    validateOnLoad: boolean;
}

interface ConfigurationValue {
    value: any;
    metadata: {
        version: string;
        lastModified: Date;
        modifiedBy: string;
        encrypted: boolean;
        checksum: string;
    };
    validation?: {
        rules: ValidationRule[];
        lastValidated: Date;
        isValid: boolean;
    };
}

interface ValidationRule {
    type: 'required' | 'format' | 'range' | 'custom';
    condition: any;
    errorMessage: string;
}

interface ConfigurationChange {
    key: string;
    oldValue: any;
    newValue: any;
    timestamp: Date;
    actor: string;
    reason?: string;
}

export class ConfigurationManagementService {
    private monitor: MonitoringService;
    private eventBus: EventBusService;
    private audit: AuditTrailService;
    private secretManager: SecretManagerServiceClient;
    private kms: CloudKMS;
    private storage: Storage;
    private configurations: Map<string, ConfigurationValue>;
    private options: ConfigurationOptions;
    private readonly RELOAD_INTERVAL = 300000; // 5 minutes
    private readonly CONFIG_BUCKET: string;

    constructor(
        monitor: MonitoringService,
        eventBus: EventBusService,
        audit: AuditTrailService,
        options: ConfigurationOptions,
        config: {
            projectId: string;
        }
    ) {
        this.monitor = monitor;
        this.eventBus = eventBus;
        this.audit = audit;
        this.options = options;
        this.secretManager = new SecretManagerServiceClient();
        this.kms = new CloudKMS({ projectId: config.projectId });
        this.storage = new Storage({ projectId: config.projectId });
        this.configurations = new Map();
        this.CONFIG_BUCKET = `${config.projectId}-configs-${options.environment}`;

        this.initialize();
    }

    private async initialize(): Promise<void> {
        await this.setupInfrastructure();
        await this.loadConfigurations();
        if (this.options.autoReload) {
            this.startAutoReload();
        }
        this.setupEventListeners();
    }

    async getConfiguration<T>(key: string): Promise<T> {
        try {
            const config = this.configurations.get(key);
            if (!config) {
                throw new Error(`Configuration not found: ${key}`);
            }

            // Decrypt if needed
            const value = config.metadata.encrypted ?
                await this.decryptValue(config.value) :
                config.value;

            await this.monitor.recordMetric({
                name: 'config_access',
                value: 1,
                labels: {
                    key,
                    encrypted: config.metadata.encrypted.toString()
                }
            });

            return value as T;

        } catch (error) {
            await this.handleError('config_retrieval_error', error);
            throw error;
        }
    }

    async setConfiguration(
        key: string,
        value: any,
        options?: {
            encrypted?: boolean;
            validation?: ValidationRule[];
        }
    ): Promise<void> {
        const startTime = Date.now();
        try {
            // Validate value if rules exist
            if (options?.validation) {
                await this.validateValue(value, options.validation);
            }

            // Encrypt if needed
            const processedValue = options?.encrypted ?
                await this.encryptValue(value) :
                value;

            const configValue: ConfigurationValue = {
                value: processedValue,
                metadata: {
                    version: uuidv4(),
                    lastModified: new Date(),
                    modifiedBy: 'system',
                    encrypted: options?.encrypted || false,
                    checksum: this.calculateChecksum(value)
                },
                validation: options?.validation ? {
                    rules: options.validation,
                    lastValidated: new Date(),
                    isValid: true
                } : undefined
            };

            // Store configuration
            await this.storeConfiguration(key, configValue);

            // Record change
            await this.recordConfigurationChange({
                key,
                oldValue: this.configurations.get(key)?.value,
                newValue: value,
                timestamp: new Date(),
                actor: 'system'
            });

            // Update memory cache
            this.configurations.set(key, configValue);

            await this.monitor.recordMetric({
                name: 'config_update',
                value: Date.now() - startTime,
                labels: {
                    key,
                    encrypted: options?.encrypted?.toString() || 'false'
                }
            });

        } catch (error) {
            await this.handleError('config_update_error', error);
            throw error;
        }
    }

    async validateConfiguration(key: string): Promise<boolean> {
        try {
            const config = this.configurations.get(key);
            if (!config || !config.validation) {
                return true;
            }

            const value = config.metadata.encrypted ?
                await this.decryptValue(config.value) :
                config.value;

            await this.validateValue(value, config.validation.rules);
            
            config.validation.lastValidated = new Date();
            config.validation.isValid = true;

            return true;

        } catch (error) {
            await this.handleError('config_validation_error', error);
            return false;
        }
    }

    async reloadConfiguration(key: string): Promise<void> {
        try {
            const config = await this.loadConfigurationFromStore(key);
            if (config) {
                this.configurations.set(key, config);
            }

            await this.monitor.recordMetric({
                name: 'config_reload',
                value: 1,
                labels: { key }
            });

        } catch (error) {
            await this.handleError('config_reload_error', error);
            throw error;
        }
    }

    private async validateValue(
        value: any,
        rules: ValidationRule[]
    ): Promise<void> {
        for (const rule of rules) {
            const isValid = await this.evaluateValidationRule(value, rule);
            if (!isValid) {
                throw new Error(rule.errorMessage);
            }
        }
    }

    private async evaluateValidationRule(
        value: any,
        rule: ValidationRule
    ): Promise<boolean> {
        switch (rule.type) {
            case 'required':
                return value !== undefined && value !== null;
            case 'format':
                return new RegExp(rule.condition).test(value);
            case 'range':
                return value >= rule.condition.min && value <= rule.condition.max;
            case 'custom':
                return await rule.condition(value);
            default:
                return false;
        }
    }

    private async encryptValue(value: any): Promise<string> {
        const version = this.options.environment;
        const keyName = this.kms.cryptoKeyPath(
            process.env.PROJECT_ID!,
            this.options.region,
            'config-encryption',
            'config-key'
        );

        const plaintextBuffer = Buffer.from(JSON.stringify(value));
        const [result] = await this.kms.encrypt({
            name: keyName,
            plaintext: plaintextBuffer
        });

        return result.ciphertext!.toString('base64');
    }

    private async decryptValue(encryptedValue: string): Promise<any> {
        const version = this.options.environment;
        const keyName = this.kms.cryptoKeyPath(
            process.env.PROJECT_ID!,
            this.options.region,
            'config-encryption',
            'config-key'
        );

        const [result] = await this.kms.decrypt({
            name: keyName,
            ciphertext: Buffer.from(encryptedValue, 'base64')
        });

        return JSON.parse(result.plaintext!.toString());
    }

    private calculateChecksum(value: any): string {
        const crypto = require('crypto');
        return crypto
            .createHash('sha256')
            .update(JSON.stringify(value))
            .digest('hex');
    }

    private async storeConfiguration(
        key: string,
        config: ConfigurationValue
    ): Promise<void> {
        // Store in Secret Manager if encrypted
        if (config.metadata.encrypted) {
            await this.storeSecret(key, config);
        }

        // Store in Cloud Storage
        await this.storeConfigFile(key, config);
    }

    private async storeSecret(
        key: string,
        config: ConfigurationValue
    ): Promise<void> {
        const secretId = this.getSecretId(key);
        const parent = `projects/${process.env.PROJECT_ID}`;

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

        await this.secretManager.addSecretVersion({
            parent: `${parent}/secrets/${secretId}`,
            payload: {
                data: Buffer.from(JSON.stringify(config))
            }
        });
    }

    private async storeConfigFile(
        key: string,
        config: ConfigurationValue
    ): Promise<void> {
        const bucket = this.storage.bucket(this.CONFIG_BUCKET);
        const file = bucket.file(`${key}.json`);

        await file.save(JSON.stringify(config), {
            metadata: {
                contentType: 'application/json',
                metadata: {
                    version: config.metadata.version,
                    encrypted: config.metadata.encrypted.toString()
                }
            }
        });
    }

    private async loadConfigurations(): Promise<void> {
        const [files] = await this.storage
            .bucket(this.CONFIG_BUCKET)
            .getFiles();

        for (const file of files) {
            const key = file.name.replace('.json', '');
            const config = await this.loadConfigurationFromStore(key);
            if (config) {
                this.configurations.set(key, config);
            }
        }
    }

    private async loadConfigurationFromStore(
        key: string
    ): Promise<ConfigurationValue | null> {
        try {
            const file = this.storage
                .bucket(this.CONFIG_BUCKET)
                .file(`${key}.json`);

            const [exists] = await file.exists();
            if (!exists) return null;

            const [content] = await file.download();
            const config: ConfigurationValue = JSON.parse(content.toString());

            if (this.options.validateOnLoad && config.validation) {
                await this.validateValue(config.value, config.validation.rules);
            }

            return config;

        } catch (error) {
            await this.handleError('config_load_error', error);
            return null;
        }
    }

    private async recordConfigurationChange(
        change: ConfigurationChange
    ): Promise<void> {
        await this.audit.logEvent({
            eventType: 'system.config',
            actor: {
                id: change.actor,
                type: 'system',
                metadata: {}
            },
            resource: {
                type: 'configuration',
                id: change.key,
                action: 'update'
            },
            context: {
                location: 'configuration-management',
                ipAddress: 'internal',
                userAgent: 'system'
            },
            status: 'success',
            details: {
                oldValue: change.oldValue,
                newValue: change.newValue,
                reason: change.reason
            }
        });
    }

    private startAutoReload(): void {
        setInterval(async () => {
            try {
                for (const key of this.configurations.keys()) {
                    await this.reloadConfiguration(key);
                }
            } catch (error) {
                await this.handleError('auto_reload_error', error);
            }
        }, this.RELOAD_INTERVAL);
    }

    private async setupInfrastructure(): Promise<void> {
        // Create Cloud Storage bucket
        const [exists] = await this.storage
            .bucket(this.CONFIG_BUCKET)
            .exists();

        if (!exists) {
            await this.storage.createBucket(this.CONFIG_BUCKET, {
                location: this.options.region,
                versioning: this.options.versionControl
            });
        }

        // Create KMS keyring and key if encryption is enabled
        if (this.options.encryptionEnabled) {
            await this.setupEncryption();
        }
    }

    private async setupEncryption(): Promise<void> {
        const parent = `projects/${process.env.PROJECT_ID}/locations/${this.options.region}`;
        const keyRingId = 'config-encryption';
        const keyId = 'config-key';

        try {
            await this.kms.createKeyRing({
                parent,
                keyRingId
            });
        } catch (error) {
            // KeyRing might already exist
        }

        try {
            await this.kms.createCryptoKey({
                parent: `${parent}/keyRings/${keyRingId}`,
                cryptoKeyId: keyId,
                cryptoKey: {
                    purpose: 'ENCRYPT_DECRYPT',
                    versionTemplate: {
                        algorithm: 'GOOGLE_SYMMETRIC_ENCRYPTION'
                    }
                }
            });
        } catch (error) {
            // CryptoKey might already exist
        }
    }

    private getSecretId(key: string): string {
        return `config-${key}-${this.options.environment}`;
    }

    private setupEventListeners(): void {
        this.eventBus.subscribe({
            id: 'config-monitor',
            topic: 'system.config',
            handler: async (event) => {
                if (event.data.action === 'reload') {
                    await this.reloadConfiguration(event.data.key);
                }
            }
        });
    }

    private async handleError(type: string, error: Error): Promise<void> {
        await this.monitor.recordMetric({
            name: type,
            value: 1,
            labels: { error: error.message }
        });

        await this.eventBus.publish('config.error', {
            type: 'config.error',
            source: 'configuration-management',
            data: {
                error: error.message,
                timestamp: new Date()
            },
            metadata: {
                severity: 'high',
                environment: this.options.environment
            }
        });
    }
}

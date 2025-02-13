import { MonitoringService } from '../monitoring/monitoring-service';
import { EventBusService } from '../events/event-bus-service';
import { AuditTrailService } from '../audit/audit-trail-service';
import { SecurityConfig } from '../config/security-config';
import { HSMBindingService } from '../security/hsm-binding-service';
import { CloudStorage } from '@google-cloud/storage';
import { BigQuery } from '@google-cloud/bigquery';
import { ModelPerformanceService } from '../monitoring/model-performance-service';
import { v4 as uuidv4 } from 'uuid';

interface ModelMetadata {
    id: string;
    name: string;
    version: string;
    description: string;
    type: ModelType;
    framework: string;
    createdAt: Date;
    updatedAt: Date;
    status: ModelStatus;
    performance: ModelPerformanceMetrics;
    security: SecurityMetadata;
    dependencies: string[];
    artifacts: ArtifactMetadata[];
    config: ModelConfig;
    tags: string[];
}

interface ModelPerformanceMetrics {
    accuracy: number;
    latency: number;
    throughput: number;
    resourceUsage: {
        cpu: number;
        memory: number;
        gpu?: number;
    };
}

interface SecurityMetadata {
    encryptionStatus: boolean;
    keyId?: string;
    hash: string;
    signature?: string;
    vulnerabilities: {
        critical: number;
        high: number;
        medium: number;
        low: number;
    };
}

interface ArtifactMetadata {
    id: string;
    type: 'model' | 'config' | 'checkpoint' | 'metrics';
    path: string;
    size: number;
    hash: string;
    encrypted: boolean;
}

interface ModelConfig {
    hyperparameters: Record<string, any>;
    architecture: Record<string, any>;
    training: {
        epochs: number;
        batchSize: number;
        optimizerConfig: Record<string, any>;
    };
}

type ModelType = 'transformer' | 'lstm' | 'gpt' | 'custom';
type ModelStatus = 'draft' | 'training' | 'validating' | 'deployed' | 'archived' | 'failed';

export class ModelRegistryService {
    private monitor: MonitoringService;
    private eventBus: EventBusService;
    private audit: AuditTrailService;
    private security: SecurityConfig;
    private hsm: HSMBindingService;
    private storage: CloudStorage;
    private bigquery: BigQuery;
    private performance: ModelPerformanceService;
    private models: Map<string, ModelMetadata>;
    private readonly ARTIFACT_BUCKET: string;
    private readonly METRICS_TABLE: string;

    constructor(
        monitor: MonitoringService,
        eventBus: EventBusService,
        audit: AuditTrailService,
        security: SecurityConfig,
        hsm: HSMBindingService,
        performance: ModelPerformanceService,
        config: {
            projectId: string;
            region: string;
        }
    ) {
        this.monitor = monitor;
        this.eventBus = eventBus;
        this.audit = audit;
        this.security = security;
        this.hsm = hsm;
        this.storage = new CloudStorage({ projectId: config.projectId });
        this.bigquery = new BigQuery({ projectId: config.projectId });
        this.performance = performance;
        this.models = new Map();
        this.ARTIFACT_BUCKET = `${config.projectId}-model-artifacts`;
        this.METRICS_TABLE = 'model_metrics';

        this.initialize();
    }

    private async initialize(): Promise<void> {
        await this.setupInfrastructure();
        await this.loadModels();
        this.setupEventListeners();
    }

    async registerModel(
        name: string,
        metadata: Omit<ModelMetadata, 'id' | 'createdAt' | 'updatedAt' | 'status'>
    ): Promise<string> {
        try {
            // Validate metadata
            await this.validateMetadata(metadata);

            const modelId = uuidv4();
            const model: ModelMetadata = {
                ...metadata,
                id: modelId,
                name,
                createdAt: new Date(),
                updatedAt: new Date(),
                status: 'draft'
            };

            // Store model metadata
            await this.storeModelMetadata(model);

            // Process and store artifacts
            await this.processArtifacts(model);

            // Generate security metadata
            model.security = await this.generateSecurityMetadata(model);

            // Update model registry
            this.models.set(modelId, model);

            await this.audit.logEvent({
                eventType: 'model.deploy',
                actor: {
                    id: 'system',
                    type: 'service',
                    metadata: {}
                },
                resource: {
                    type: 'model',
                    id: modelId,
                    action: 'register'
                },
                context: {
                    location: 'model-registry',
                    ipAddress: 'internal',
                    userAgent: 'system'
                },
                status: 'success',
                details: {
                    name,
                    version: metadata.version,
                    type: metadata.type
                }
            });

            return modelId;

        } catch (error) {
            await this.handleError('model_registration_error', error);
            throw error;
        }
    }

    async updateModelStatus(
        modelId: string,
        status: ModelStatus,
        performance?: Partial<ModelPerformanceMetrics>
    ): Promise<void> {
        try {
            const model = await this.getModel(modelId);
            if (!model) {
                throw new Error(`Model not found: ${modelId}`);
            }

            model.status = status;
            model.updatedAt = new Date();

            if (performance) {
                model.performance = {
                    ...model.performance,
                    ...performance
                };

                // Update performance metrics
                await this.performance.recordMetrics(modelId, performance);
            }

            // Update storage
            await this.storeModelMetadata(model);

            await this.eventBus.publish('model.status.updated', {
                type: 'model.status',
                source: 'model-registry',
                data: {
                    modelId,
                    status,
                    performance,
                    timestamp: new Date()
                },
                metadata: {
                    environment: process.env.NODE_ENV || 'development'
                }
            });

        } catch (error) {
            await this.handleError('model_status_update_error', error);
            throw error;
        }
    }

    async getModel(modelId: string): Promise<ModelMetadata | null> {
        try {
            // Check cache first
            if (this.models.has(modelId)) {
                return this.models.get(modelId)!;
            }

            // Query BigQuery
            const [rows] = await this.bigquery.query({
                query: `
                    SELECT *
                    FROM \`models.metadata\`
                    WHERE id = @modelId
                `,
                params: { modelId }
            });

            if (!rows.length) return null;

            const model = this.deserializeModel(rows[0]);
            this.models.set(modelId, model);
            return model;

        } catch (error) {
            await this.handleError('model_retrieval_error', error);
            throw error;
        }
    }

    async listModels(
        filters?: {
            type?: ModelType;
            status?: ModelStatus;
            tags?: string[];
        }
    ): Promise<ModelMetadata[]> {
        try {
            let query = `SELECT * FROM \`models.metadata\``;
            const conditions: string[] = [];
            const params: any = {};

            if (filters?.type) {
                conditions.push('type = @type');
                params.type = filters.type;
            }
            if (filters?.status) {
                conditions.push('status = @status');
                params.status = filters.status;
            }
            if (filters?.tags?.length) {
                conditions.push('EXISTS (SELECT 1 FROM UNNEST(tags) AS tag WHERE tag IN UNNEST(@tags))');
                params.tags = filters.tags;
            }

            if (conditions.length) {
                query += ` WHERE ${conditions.join(' AND ')}`;
            }

            const [rows] = await this.bigquery.query({ query, params });
            return rows.map(this.deserializeModel);

        } catch (error) {
            await this.handleError('model_list_error', error);
            throw error;
        }
    }

    async downloadArtifact(
        modelId: string,
        artifactId: string
    ): Promise<Buffer> {
        try {
            const model = await this.getModel(modelId);
            if (!model) {
                throw new Error(`Model not found: ${modelId}`);
            }

            const artifact = model.artifacts.find(a => a.id === artifactId);
            if (!artifact) {
                throw new Error(`Artifact not found: ${artifactId}`);
            }

            // Download from Cloud Storage
            const file = this.storage
                .bucket(this.ARTIFACT_BUCKET)
                .file(artifact.path);

            const [data] = await file.download();

            // Verify integrity
            const hash = await this.calculateHash(data);
            if (hash !== artifact.hash) {
                throw new Error('Artifact integrity check failed');
            }

            // Decrypt if necessary
            if (artifact.encrypted) {
                return await this.decryptArtifact(data, model.security.keyId!);
            }

            return data;

        } catch (error) {
            await this.handleError('artifact_download_error', error);
            throw error;
        }
    }

    private async validateMetadata(
        metadata: Partial<ModelMetadata>
    ): Promise<void> {
        if (!metadata.version || !metadata.type || !metadata.framework) {
            throw new Error('Missing required metadata fields');
        }

        // Validate version format
        if (!/^\d+\.\d+\.\d+$/.test(metadata.version)) {
            throw new Error('Invalid version format');
        }

        // Validate artifacts
        if (metadata.artifacts) {
            for (const artifact of metadata.artifacts) {
                if (!artifact.type || !artifact.path) {
                    throw new Error('Invalid artifact metadata');
                }
            }
        }

        // Validate config
        if (metadata.config) {
            if (!metadata.config.hyperparameters || !metadata.config.architecture) {
                throw new Error('Invalid model configuration');
            }
        }
    }

    private async processArtifacts(model: ModelMetadata): Promise<void> {
        for (const artifact of model.artifacts) {
            // Generate artifact ID if not present
            if (!artifact.id) {
                artifact.id = uuidv4();
            }

            // Upload to Cloud Storage
            const file = this.storage
                .bucket(this.ARTIFACT_BUCKET)
                .file(artifact.path);

            // Calculate hash before encryption
            const data = await file.download();
            artifact.hash = await this.calculateHash(data[0]);

            // Encrypt if required
            if (this.security.encryption.enabled) {
                const encrypted = await this.encryptArtifact(
                    data[0],
                    model.security.keyId!
                );
                await file.save(encrypted);
                artifact.encrypted = true;
            }
        }
    }

    private async generateSecurityMetadata(
        model: ModelMetadata
    ): Promise<SecurityMetadata> {
        // Generate encryption key if needed
        let keyId;
        if (this.security.encryption.enabled) {
            const key = await this.hsm.generateKey(
                'model',
                { purpose: 'encryption' }
            );
            keyId = key.id;
        }

        // Calculate model hash
        const modelHash = await this.calculateModelHash(model);

        // Sign model metadata if configured
        let signature;
        if (this.security.signing.enabled) {
            const signResult = await this.hsm.sign(
                keyId!,
                Buffer.from(modelHash)
            );
            signature = signResult.signature.toString('base64');
        }

        return {
            encryptionStatus: !!keyId,
            keyId,
            hash: modelHash,
            signature,
            vulnerabilities: {
                critical: 0,
                high: 0,
                medium: 0,
                low: 0
            }
        };
    }

    private async calculateModelHash(model: ModelMetadata): Promise<string> {
        const content = JSON.stringify({
            name: model.name,
            version: model.version,
            type: model.type,
            framework: model.framework,
            config: model.config,
            artifacts: model.artifacts.map(a => ({
                id: a.id,
                type: a.type,
                hash: a.hash
            }))
        });

        return crypto
            .createHash('sha256')
            .update(content)
            .digest('hex');
    }

    private async calculateHash(data: Buffer): Promise<string> {
        return crypto
            .createHash('sha256')
            .update(data)
            .digest('hex');
    }

    private async encryptArtifact(
        data: Buffer,
        keyId: string
    ): Promise<Buffer> {
        const result = await this.hsm.encrypt(keyId, data);
        return result.ciphertext;
    }

    private async decryptArtifact(
        data: Buffer,
        keyId: string
    ): Promise<Buffer> {
        const result = await this.hsm.decrypt(keyId, data);
        return result.plaintext;
    }

    private async storeModelMetadata(model: ModelMetadata): Promise<void> {
        const row = this.serializeModel(model);
        await this.bigquery
            .dataset('models')
            .table('metadata')
            .insert([row]);
    }

    private serializeModel(model: ModelMetadata): Record<string, any> {
        return {
            ...model,
            performance: JSON.stringify(model.performance),
            security: JSON.stringify(model.security),
            config: JSON.stringify(model.config),
            artifacts: JSON.stringify(model.artifacts),
            createdAt: model.createdAt.toISOString(),
            updatedAt: model.updatedAt.toISOString()
        };
    }

    private deserializeModel(row: any): ModelMetadata {
        return {
            ...row,
            performance: JSON.parse(row.performance),
            security: JSON.parse(row.security),
            config: JSON.parse(row.config),
            artifacts: JSON.parse(row.artifacts),
            createdAt: new Date(row.createdAt),
            updatedAt: new Date(row.updatedAt)
        };
    }

    private async setupInfrastructure(): Promise<void> {
        try {
            // Create Cloud Storage bucket
            const [bucketExists] = await this.storage
                .bucket(this.ARTIFACT_BUCKET)
                .exists();
            if (!bucketExists) {
                await this.storage.createBucket(this.ARTIFACT_BUCKET);
            }

            // Create BigQuery dataset and tables
            const dataset = this.bigquery.dataset('models');
            const [datasetExists] = await dataset.exists();
            if (!datasetExists) {
                await dataset.create();
                await this.createModelTables(dataset);
            }

        } catch (error) {
            console.error('Failed to setup model registry infrastructure:', error);
            throw error;
        }
    }

    private async createModelTables(dataset: any): Promise<void> {
        const metadataSchema = {
            fields: [
                { name: 'id', type: 'STRING' },
                { name: 'name', type: 'STRING' },
                { name: 'version', type: 'STRING' },
                { name: 'description', type: 'STRING' },
                { name: 'type', type: 'STRING' },
                { name: 'framework', type: 'STRING' },
                { name: 'createdAt', type: 'TIMESTAMP' },
                { name: 'updatedAt', type: 'TIMESTAMP' },
                { name: 'status', type: 'STRING' },
                { name: 'performance', type: 'JSON' },
                { name: 'security', type: 'JSON' },
                { name: 'dependencies', type: 'STRING', mode: 'REPEATED' },
                { name: 'artifacts', type: 'JSON' },
                { name: 'config', type: 'JSON' },
                { name: 'tags', type: 'STRING', mode: 'REPEATED' }
            ]
        };

        await dataset.createTable('metadata', { schema: metadataSchema });
    }

    private async loadModels(): Promise<void> {
        const [rows] = await this.bigquery.query(`
            SELECT *
            FROM \`models.metadata\`
            WHERE status != 'archived'
        `);

        for (const row of rows) {
            const model = this.deserializeModel(row);
            this.models.set(model.id, model);
        }
    }

    private setupEventListeners(): void {
        this.eventBus.subscribe({
            id: 'model-registry-monitor',
            topic: 'model.performance',
            handler: async (event) => {
                const { modelId, metrics } = event.data;
                await this.updateModelStatus(modelId, 'deployed', metrics);
            }
        });
    }

    private async handleError(type: string, error: Error): Promise<void> {
        await this.monitor.recordMetric({
            name: type,
            value: 1,
            labels: { error: error.message }
        });

        await this.eventBus.publish('model.error', {
            type: 'model.error',
            source: 'model-registry',
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
        this.models.clear();
    }
}

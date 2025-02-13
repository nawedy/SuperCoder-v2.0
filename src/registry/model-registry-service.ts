import { MonitoringService } from '../monitoring/monitoring-service';
import { SecurityScanner } from '../security/security-scanner';
import { EncryptionService } from '../security/encryption-service';
import { AuditTrailService } from '../audit/audit-trail-service';
import { Storage } from '@google-cloud/storage';
import { BigQuery } from '@google-cloud/bigquery';

interface ModelMetadata {
    name: string;
    version: string;
    type: string;
    framework?: string;
    metrics: Record<string, number>;
    artifacts?: {
        path: string;
        type: string;
        size: number;
        hash: string;
    }[];
    dependencies?: {
        name: string;
        version: string;
    }[];
    training?: {
        startTime: Date;
        endTime: Date;
        parameters: Record<string, any>;
        datasetId: string;
    };
    validation?: {
        accuracy: number;
        loss: number;
        metrics: Record<string, number>;
    };
    deployment?: {
        environment: string;
        status: 'active' | 'inactive';
        instances: number;
    };
}

interface ModelVersion {
    modelId: string;
    version: string;
    metadata: ModelMetadata;
    data: Buffer;
    createdAt: Date;
    updatedAt: Date;
    status: 'draft' | 'validated' | 'deployed' | 'archived';
    security: {
        scanned: boolean;
        vulnerabilities: any[];
        score: number;
    };
}

export class ModelRegistryService {
    private monitor: MonitoringService;
    private security: SecurityScanner;
    private encryption: EncryptionService;
    private audit: AuditTrailService;
    private storage: Storage;
    private bigquery: BigQuery;
    private readonly bucketName: string;
    private readonly datasetId: string;

    constructor(
        monitor: MonitoringService,
        security: SecurityScanner,
        encryption: EncryptionService,
        audit: AuditTrailService,
        projectId: string
    ) {
        this.monitor = monitor;
        this.security = security;
        this.encryption = encryption;
        this.audit = audit;
        this.storage = new Storage({ projectId });
        this.bigquery = new BigQuery({ projectId });
        this.bucketName = `${projectId}-model-registry`;
        this.datasetId = 'model_registry';

        this.initialize();
    }

    private async initialize(): Promise<void> {
        await this.ensureInfrastructure();
    }

    async registerModel(
        modelData: Buffer,
        metadata: ModelMetadata
    ): Promise<string> {
        const startTime = Date.now();
        try {
            // Generate model ID
            const modelId = this.generateModelId(metadata.name);

            // Validate metadata
            await this.validateMetadata(metadata);

            // Scan model for security issues
            const securityScan = await this.security.scanModel(modelData);
            if (securityScan.score < 0.7) { // 70% security threshold
                throw new Error('Model failed security scan');
            }

            // Encrypt model data
            const encryptedData = await this.encryption.encrypt(modelData);

            // Create model version
            const version: ModelVersion = {
                modelId,
                version: metadata.version,
                metadata,
                data: encryptedData,
                createdAt: new Date(),
                updatedAt: new Date(),
                status: 'draft',
                security: {
                    scanned: true,
                    vulnerabilities: securityScan.vulnerabilities,
                    score: securityScan.score
                }
            };

            // Store model data
            await this.storeModelData(modelId, version);

            // Store metadata
            await this.storeModelMetadata(version);

            await this.monitor.recordMetric({
                name: 'model_registered',
                value: Date.now() - startTime,
                labels: {
                    model_id: modelId,
                    version: metadata.version,
                    type: metadata.type
                }
            });

            await this.audit.logEvent({
                eventType: 'model.train',
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
                    version: metadata.version,
                    security_score: securityScan.score
                }
            });

            return modelId;

        } catch (error) {
            await this.handleError('model_registration_error', error);
            throw error;
        }
    }

    async getModel(modelId: string, version?: string): Promise<ModelVersion | null> {
        try {
            const query = this.bigquery.dataset(this.datasetId).table('models').query(`
                SELECT *
                FROM models
                WHERE model_id = @modelId
                ${version ? 'AND version = @version' : ''}
                ORDER BY created_at DESC
                LIMIT 1
            `);

            const [rows] = await query.run({
                params: { modelId, version }
            });

            if (!rows.length) {
                return null;
            }

            const modelVersion = this.deserializeModelVersion(rows[0]);
            
            // Get model data from storage
            const data = await this.getModelData(modelId, modelVersion.version);
            
            // Decrypt model data
            modelVersion.data = await this.encryption.decrypt(data);

            await this.monitor.recordMetric({
                name: 'model_retrieved',
                value: 1,
                labels: {
                    model_id: modelId,
                    version: version || 'latest'
                }
            });

            return modelVersion;

        } catch (error) {
            await this.handleError('model_retrieval_error', error);
            throw error;
        }
    }

    async updateModelStatus(
        modelId: string,
        version: string,
        status: ModelVersion['status']
    ): Promise<void> {
        try {
            await this.bigquery
                .dataset(this.datasetId)
                .table('models')
                .query(`
                    UPDATE models
                    SET status = @status,
                        updated_at = CURRENT_TIMESTAMP()
                    WHERE model_id = @modelId
                    AND version = @version
                `).run({
                    params: { modelId, version, status }
                });

            await this.monitor.recordMetric({
                name: 'model_status_updated',
                value: 1,
                labels: {
                    model_id: modelId,
                    version,
                    status
                }
            });

        } catch (error) {
            await this.handleError('model_update_error', error);
            throw error;
        }
    }

    private async ensureInfrastructure(): Promise<void> {
        try {
            // Ensure storage bucket exists
            const [bucketExists] = await this.storage
                .bucket(this.bucketName)
                .exists();
            
            if (!bucketExists) {
                await this.storage.createBucket(this.bucketName, {
                    location: 'US',
                    storageClass: 'STANDARD'
                });
            }

            // Ensure BigQuery dataset and table exist
            const dataset = this.bigquery.dataset(this.datasetId);
            const [datasetExists] = await dataset.exists();
            
            if (!datasetExists) {
                await dataset.create();
                await this.createModelTable(dataset);
            }
        } catch (error) {
            console.error('Failed to initialize registry infrastructure:', error);
            throw error;
        }
    }

    private async createModelTable(dataset: any): Promise<void> {
        const schema = {
            fields: [
                { name: 'model_id', type: 'STRING' },
                { name: 'version', type: 'STRING' },
                { name: 'metadata', type: 'JSON' },
                { name: 'status', type: 'STRING' },
                { name: 'security', type: 'JSON' },
                { name: 'created_at', type: 'TIMESTAMP' },
                { name: 'updated_at', type: 'TIMESTAMP' }
            ]
        };

        await dataset.createTable('models', { schema });
    }

    private async storeModelData(
        modelId: string,
        version: ModelVersion
    ): Promise<void> {
        const filename = `${modelId}/${version.version}/model.bin`;
        await this.storage
            .bucket(this.bucketName)
            .file(filename)
            .save(version.data);
    }

    private async getModelData(
        modelId: string,
        version: string
    ): Promise<Buffer> {
        const filename = `${modelId}/${version}/model.bin`;
        const [data] = await this.storage
            .bucket(this.bucketName)
            .file(filename)
            .download();
        
        return data;
    }

    private async storeModelMetadata(version: ModelVersion): Promise<void> {
        await this.bigquery
            .dataset(this.datasetId)
            .table('models')
            .insert([{
                model_id: version.modelId,
                version: version.version,
                metadata: JSON.stringify(version.metadata),
                status: version.status,
                security: JSON.stringify(version.security),
                created_at: version.createdAt,
                updated_at: version.updatedAt
            }]);
    }

    private deserializeModelVersion(row: any): ModelVersion {
        return {
            modelId: row.model_id,
            version: row.version,
            metadata: JSON.parse(row.metadata),
            data: Buffer.from([]), // Will be loaded separately
            createdAt: new Date(row.created_at),
            updatedAt: new Date(row.updated_at),
            status: row.status,
            security: JSON.parse(row.security)
        };
    }

    private async validateMetadata(metadata: ModelMetadata): Promise<void> {
        if (!metadata.name || !metadata.version || !metadata.type) {
            throw new Error('Missing required metadata fields');
        }

        if (metadata.version && !this.isValidVersion(metadata.version)) {
            throw new Error('Invalid version format');
        }
    }

    private isValidVersion(version: string): boolean {
        return /^\d+\.\d+\.\d+$/.test(version);
    }

    private generateModelId(name: string): string {
        const sanitizedName = name.toLowerCase().replace(/[^a-z0-9]/g, '-');
        return `${sanitizedName}-${Date.now()}`;
    }

    private async handleError(type: string, error: Error): Promise<void> {
        await this.monitor.recordMetric({
            name: type,
            value: 1,
            labels: { error: error.message }
        });
    }
}

import { Storage } from '@google-cloud/storage';
import { KMS } from '@google-cloud/kms';
import { SecurityConfig } from '../config/security-config';
import { MonitoringService } from '../monitoring/monitoring-service';

interface ModelMetadata {
    id: string;
    version: string;
    createdAt: Date;
    checksums: {
        sha256: string;
        md5: string;
    };
    securityScanStatus: 'pending' | 'passed' | 'failed';
    deploymentStatus: 'draft' | 'deployed' | 'archived';
}

export class ModelRegistry {
    private storage: Storage;
    private kms: KMS;
    private monitor: MonitoringService;
    private bucketName: string;
    private securityConfig: SecurityConfig;

    constructor(
        bucketName: string, 
        securityConfig: SecurityConfig,
        monitor: MonitoringService
    ) {
        this.storage = new Storage();
        this.kms = new KMS();
        this.monitor = monitor;
        this.bucketName = bucketName;
        this.securityConfig = securityConfig;
    }

    async registerModel(
        modelId: string,
        modelBuffer: Buffer,
        metadata: Partial<ModelMetadata>
    ): Promise<ModelMetadata> {
        try {
            // Generate checksums
            const sha256 = await this.generateChecksum(modelBuffer, 'sha256');
            const md5 = await this.generateChecksum(modelBuffer, 'md5');

            const modelMetadata: ModelMetadata = {
                id: modelId,
                version: this.generateVersion(),
                createdAt: new Date(),
                checksums: { sha256, md5 },
                securityScanStatus: 'pending',
                deploymentStatus: 'draft',
                ...metadata
            };

            // Encrypt model before storage
            const encryptedModel = await this.encryptModel(modelBuffer);
            
            // Store model
            await this.storage.bucket(this.bucketName).file(`models/${modelId}`).save(encryptedModel);
            
            // Store metadata
            await this.storage.bucket(this.bucketName)
                .file(`metadata/${modelId}.json`)
                .save(JSON.stringify(modelMetadata));

            // Record metric
            await this.monitor.recordMetric({
                name: 'model_registration',
                value: 1,
                labels: { model_id: modelId }
            });

            return modelMetadata;
        } catch (error) {
            console.error('Model registration failed:', error);
            await this.monitor.recordMetric({
                name: 'model_registration_error',
                value: 1,
                labels: { model_id: modelId, error: error.message }
            });
            throw error;
        }
    }

    private async encryptModel(modelBuffer: Buffer): Promise<Buffer> {
        try {
            const keyName = this.kms.cryptoKeyPath(
                process.env.GCP_PROJECT_ID!,
                'global',
                this.securityConfig.encryption.kmsKeyRing,
                'model-encryption-key'
            );

            const [result] = await this.kms.encrypt({
                name: keyName,
                plaintext: modelBuffer
            });

            return Buffer.from(result.ciphertext);
        } catch (error) {
            console.error('Model encryption failed:', error);
            throw error;
        }
    }

    private async generateChecksum(buffer: Buffer, algorithm: 'sha256' | 'md5'): Promise<string> {
        const crypto = require('crypto');
        return crypto.createHash(algorithm).update(buffer).digest('hex');
    }

    private generateVersion(): string {
        return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }
}

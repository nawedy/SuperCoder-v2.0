import { MonitoringService } from '../monitoring/monitoring-service';
import { EventBusService } from '../events/event-bus-service';
import { HSMBindingService } from './hsm-binding-service';
import { Redis } from 'ioredis';
import { BigQuery } from '@google-cloud/bigquery';
import { v4 as uuidv4 } from 'uuid';
import * as crypto from 'crypto';

interface TokenizationConfig {
    tokenType: 'reversible' | 'irreversible';
    format: TokenFormat;
    preserveLength: boolean;
    preserveCharacterSet: boolean;
    expirationTime?: number; // seconds
    keyRotation?: {
        enabled: boolean;
        interval: number; // days
    };
}

interface TokenFormat {
    type: 'numeric' | 'alphanumeric' | 'pattern';
    pattern?: string;
    minLength?: number;
    maxLength?: number;
    prefix?: string;
    suffix?: string;
}

interface TokenEntry {
    token: string;
    value: string;
    metadata: {
        createdAt: Date;
        expiresAt?: Date;
        keyVersion: string;
        format: TokenFormat;
        usageCount: number;
        lastUsed: Date;
    };
}

interface TokenValidationResult {
    valid: boolean;
    error?: string;
    metadata?: {
        expiresAt?: Date;
        usageCount: number;
    };
}

export class TokenizationService {
    private monitor: MonitoringService;
    private eventBus: EventBusService;
    private hsm: HSMBindingService;
    private redis: Redis;
    private bigquery: BigQuery;
    private tokenStore: Map<string, TokenEntry>;
    private currentKeyVersion: string;
    private readonly KEY_PREFIX = 'token:';
    private readonly TOKEN_CLEANUP_INTERVAL = 3600000; // 1 hour
    private readonly MAX_RETRIES = 3;

    constructor(
        monitor: MonitoringService,
        eventBus: EventBusService,
        hsm: HSMBindingService,
        config: {
            redisUrl: string;
            projectId: string;
        }
    ) {
        this.monitor = monitor;
        this.eventBus = eventBus;
        this.hsm = hsm;
        this.redis = new Redis(config.redisUrl);
        this.bigquery = new BigQuery({ projectId: config.projectId });
        this.tokenStore = new Map();
        this.currentKeyVersion = uuidv4();

        this.initialize();
    }

    private async initialize(): Promise<void> {
        await this.setupInfrastructure();
        await this.initializeEncryptionKey();
        this.startCleanupTask();
        this.setupEventListeners();
    }

    async tokenize(
        value: string,
        config: TokenizationConfig
    ): Promise<string> {
        const startTime = Date.now();
        try {
            // Validate input
            this.validateInput(value, config);

            // Generate token
            let token: string;
            let retries = 0;
            do {
                token = await this.generateToken(value, config);
                retries++;
            } while (
                this.tokenStore.has(token) && 
                retries < this.MAX_RETRIES
            );

            if (retries >= this.MAX_RETRIES) {
                throw new Error('Failed to generate unique token');
            }

            // Store token mapping
            const entry: TokenEntry = {
                token,
                value: config.tokenType === 'reversible' ? 
                    await this.encrypt(value) : 
                    await this.hash(value),
                metadata: {
                    createdAt: new Date(),
                    expiresAt: config.expirationTime ? 
                        new Date(Date.now() + config.expirationTime * 1000) : 
                        undefined,
                    keyVersion: this.currentKeyVersion,
                    format: config.format,
                    usageCount: 0,
                    lastUsed: new Date()
                }
            };

            await this.storeToken(entry);

            // Record metrics
            await this.monitor.recordMetric({
                name: 'tokenization_operation',
                value: Date.now() - startTime,
                labels: {
                    type: config.tokenType,
                    format: config.format.type
                }
            });

            return token;

        } catch (error) {
            await this.handleError('tokenization_error', error);
            throw error;
        }
    }

    async detokenize(token: string): Promise<string | null> {
        const startTime = Date.now();
        try {
            // Validate token
            const validation = await this.validateToken(token);
            if (!validation.valid) {
                throw new Error(validation.error || 'Invalid token');
            }

            // Get token entry
            const entry = await this.getTokenEntry(token);
            if (!entry) {
                return null;
            }

            // Update usage stats
            entry.metadata.usageCount++;
            entry.metadata.lastUsed = new Date();
            await this.storeToken(entry);

            // Decrypt/verify value
            const value = await this.decrypt(entry.value);

            // Record metrics
            await this.monitor.recordMetric({
                name: 'detokenization_operation',
                value: Date.now() - startTime,
                labels: {
                    format: entry.metadata.format.type
                }
            });

            return value;

        } catch (error) {
            await this.handleError('detokenization_error', error);
            throw error;
        }
    }

    async validateToken(token: string): Promise<TokenValidationResult> {
        try {
            const entry = await this.getTokenEntry(token);
            if (!entry) {
                return { valid: false, error: 'Token not found' };
            }

            // Check expiration
            if (entry.metadata.expiresAt && entry.metadata.expiresAt < new Date()) {
                return { valid: false, error: 'Token expired' };
            }

            return {
                valid: true,
                metadata: {
                    expiresAt: entry.metadata.expiresAt,
                    usageCount: entry.metadata.usageCount
                }
            };

        } catch (error) {
            await this.handleError('token_validation_error', error);
            return { valid: false, error: 'Validation error' };
        }
    }

    private validateInput(value: string, config: TokenizationConfig): void {
        if (!value) {
            throw new Error('Value cannot be empty');
        }

        if (config.format.minLength && value.length < config.format.minLength) {
            throw new Error(`Value length below minimum (${config.format.minLength})`);
        }

        if (config.format.maxLength && value.length > config.format.maxLength) {
            throw new Error(`Value length exceeds maximum (${config.format.maxLength})`);
        }

        if (config.format.pattern) {
            const regex = new RegExp(config.format.pattern);
            if (!regex.test(value)) {
                throw new Error('Value does not match required pattern');
            }
        }
    }

    private async generateToken(
        value: string,
        config: TokenizationConfig
    ): Promise<string> {
        let token: string;

        if (config.format.type === 'pattern') {
            token = this.generatePatternToken(config.format);
        } else if (config.format.type === 'numeric') {
            token = this.generateNumericToken(value.length);
        } else {
            token = this.generateAlphanumericToken(value.length);
        }

        if (config.preserveLength && token.length !== value.length) {
            token = token.padEnd(value.length, '0').slice(0, value.length);
        }

        if (config.format.prefix) {
            token = config.format.prefix + token;
        }

        if (config.format.suffix) {
            token = token + config.format.suffix;
        }

        return token;
    }

    private generatePatternToken(format: TokenFormat): string {
        if (!format.pattern) {
            throw new Error('Pattern not specified');
        }

        return format.pattern.replace(/[#]/g, () => 
            Math.floor(Math.random() * 10).toString()
        ).replace(/[A-Z]/g, () => 
            String.fromCharCode(65 + Math.floor(Math.random() * 26))
        ).replace(/[a-z]/g, () => 
            String.fromCharCode(97 + Math.floor(Math.random() * 26))
        );
    }

    private generateNumericToken(length: number): string {
        return Array.from(
            { length }, 
            () => Math.floor(Math.random() * 10)
        ).join('');
    }

    private generateAlphanumericToken(length: number): string {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        return Array.from(
            { length },
            () => chars.charAt(Math.floor(Math.random() * chars.length))
        ).join('');
    }

    private async encrypt(value: string): Promise<string> {
        const key = await this.hsm.generateKey(
            'tokenization',
            { purpose: 'encryption' }
        );

        const encrypted = await this.hsm.encrypt(
            key.id,
            Buffer.from(value)
        );

        return encrypted.ciphertext.toString('base64');
    }

    private async decrypt(value: string): Promise<string> {
        const key = await this.hsm.generateKey(
            'tokenization',
            { purpose: 'decryption' }
        );

        const decrypted = await this.hsm.decrypt(
            key.id,
            Buffer.from(value, 'base64')
        );

        return decrypted.plaintext.toString();
    }

    private async hash(value: string): Promise<string> {
        const salt = crypto.randomBytes(16);
        const hash = crypto.pbkdf2Sync(
            value,
            salt,
            100000,
            64,
            'sha512'
        );
        
        return `${salt.toString('hex')}:${hash.toString('hex')}`;
    }

    private async storeToken(entry: TokenEntry): Promise<void> {
        // Store in memory
        this.tokenStore.set(entry.token, entry);

        // Store in Redis
        await this.redis.set(
            this.KEY_PREFIX + entry.token,
            JSON.stringify(entry),
            'EX',
            entry.metadata.expiresAt ? 
                Math.ceil((entry.metadata.expiresAt.getTime() - Date.now()) / 1000) :
                0
        );

        // Store in BigQuery for analytics
        await this.storeToBigQuery(entry);
    }

    private async getTokenEntry(token: string): Promise<TokenEntry | null> {
        // Check memory cache
        if (this.tokenStore.has(token)) {
            return this.tokenStore.get(token)!;
        }

        // Check Redis
        const data = await this.redis.get(this.KEY_PREFIX + token);
        if (data) {
            const entry = JSON.parse(data);
            this.tokenStore.set(token, entry);
            return entry;
        }

        return null;
    }

    private async storeToBigQuery(entry: TokenEntry): Promise<void> {
        const row = {
            token: entry.token,
            created_at: entry.metadata.createdAt.toISOString(),
            expires_at: entry.metadata.expiresAt?.toISOString(),
            key_version: entry.metadata.keyVersion,
            format_type: entry.metadata.format.type,
            usage_count: entry.metadata.usageCount,
            last_used: entry.metadata.lastUsed.toISOString()
        };

        await this.bigquery
            .dataset('tokenization')
            .table('token_analytics')
            .insert([row]);
    }

    private async initializeEncryptionKey(): Promise<void> {
        const key = await this.hsm.generateKey(
            'tokenization',
            {
                purpose: 'master',
                rotation: true
            }
        );
        this.currentKeyVersion = key.id;
    }

    private startCleanupTask(): void {
        setInterval(async () => {
            try {
                await this.cleanup();
            } catch (error) {
                await this.handleError('cleanup_error', error);
            }
        }, this.TOKEN_CLEANUP_INTERVAL);
    }

    private async cleanup(): Promise<void> {
        const now = new Date();
        let cleaned = 0;

        for (const [token, entry] of this.tokenStore.entries()) {
            if (entry.metadata.expiresAt && entry.metadata.expiresAt < now) {
                this.tokenStore.delete(token);
                await this.redis.del(this.KEY_PREFIX + token);
                cleaned++;
            }
        }

        await this.monitor.recordMetric({
            name: 'token_cleanup',
            value: cleaned,
            labels: {
                cache_size: this.tokenStore.size.toString()
            }
        });
    }

    private async setupInfrastructure(): Promise<void> {
        // Create BigQuery dataset and table
        const dataset = this.bigquery.dataset('tokenization');
        const [exists] = await dataset.exists();
        
        if (!exists) {
            await dataset.create();
            await this.createAnalyticsTable(dataset);
        }
    }

    private async createAnalyticsTable(dataset: any): Promise<void> {
        const schema = {
            fields: [
                { name: 'token', type: 'STRING' },
                { name: 'created_at', type: 'TIMESTAMP' },
                { name: 'expires_at', type: 'TIMESTAMP' },
                { name: 'key_version', type: 'STRING' },
                { name: 'format_type', type: 'STRING' },
                { name: 'usage_count', type: 'INTEGER' },
                { name: 'last_used', type: 'TIMESTAMP' }
            ]
        };

        await dataset.createTable('token_analytics', { schema });
    }

    private setupEventListeners(): void {
        this.eventBus.subscribe({
            id: 'tokenization-monitor',
            topic: 'hsm.key.rotated',
            handler: async (event) => {
                if (event.data.purpose === 'tokenization') {
                    this.currentKeyVersion = event.data.keyId;
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

        await this.eventBus.publish('tokenization.error', {
            type: 'tokenization.error',
            source: 'tokenization-service',
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
        // Clear caches
        this.tokenStore.clear();
        await this.redis.quit();
    }
}

import { MonitoringService } from '../monitoring/monitoring-service';
import { z } from 'zod';
import { SecurityConfig } from '../config/security-config';

interface ValidationResult {
    valid: boolean;
    errors: ValidationError[];
    metadata: {
        timestamp: Date;
        schemaVersion: string;
        executionTime: number;
    };
}

interface ValidationError {
    path: string[];
    message: string;
    code: string;
    input: any;
}

interface ValidationSchema {
    id: string;
    version: string;
    schema: z.ZodType<any>;
    metadata: {
        description: string;
        createdAt: Date;
        updatedAt: Date;
    };
}

export class ValidationService {
    private monitor: MonitoringService;
    private securityConfig: SecurityConfig;
    private schemas: Map<string, ValidationSchema>;
    private readonly DEFAULT_MAX_SIZE = 1024 * 1024; // 1MB

    constructor(
        monitor: MonitoringService,
        securityConfig: SecurityConfig
    ) {
        this.monitor = monitor;
        this.securityConfig = securityConfig;
        this.schemas = this.initializeSchemas();
    }

    async validate(
        data: any,
        schemaId: string,
        options: { maxSize?: number } = {}
    ): Promise<ValidationResult> {
        const startTime = Date.now();
        try {
            // Get schema
            const schema = this.schemas.get(schemaId);
            if (!schema) {
                throw new Error(`Schema not found: ${schemaId}`);
            }

            // Validate data size
            await this.validateDataSize(data, options.maxSize);

            // Perform validation
            const result = await schema.schema.safeParseAsync(data);

            const validationResult: ValidationResult = {
                valid: result.success,
                errors: result.success ? [] : this.formatZodErrors(result.error),
                metadata: {
                    timestamp: new Date(),
                    schemaVersion: schema.version,
                    executionTime: Date.now() - startTime
                }
            };

            await this.monitor.recordMetric({
                name: 'validation_execution',
                value: validationResult.metadata.executionTime,
                labels: {
                    schema_id: schemaId,
                    valid: validationResult.valid.toString()
                }
            });

            return validationResult;

        } catch (error) {
            await this.handleError('validation_error', error);
            throw error;
        }
    }

    async registerSchema(
        id: string,
        schema: z.ZodType<any>,
        description: string
    ): Promise<ValidationSchema> {
        try {
            if (this.schemas.has(id)) {
                throw new Error(`Schema already exists: ${id}`);
            }

            const validationSchema: ValidationSchema = {
                id,
                version: '1.0.0',
                schema,
                metadata: {
                    description,
                    createdAt: new Date(),
                    updatedAt: new Date()
                }
            };

            this.schemas.set(id, validationSchema);

            await this.monitor.recordMetric({
                name: 'schema_registered',
                value: 1,
                labels: { schema_id: id }
            });

            return validationSchema;
        } catch (error) {
            await this.handleError('schema_registration_error', error);
            throw error;
        }
    }

    async updateSchema(
        id: string,
        schema: z.ZodType<any>,
        description?: string
    ): Promise<ValidationSchema> {
        try {
            const existing = this.schemas.get(id);
            if (!existing) {
                throw new Error(`Schema not found: ${id}`);
            }

            const [major, minor, patch] = existing.version.split('.').map(Number);
            const newVersion = `${major}.${minor}.${patch + 1}`;

            const updatedSchema: ValidationSchema = {
                ...existing,
                version: newVersion,
                schema,
                metadata: {
                    ...existing.metadata,
                    description: description || existing.metadata.description,
                    updatedAt: new Date()
                }
            };

            this.schemas.set(id, updatedSchema);

            await this.monitor.recordMetric({
                name: 'schema_updated',
                value: 1,
                labels: {
                    schema_id: id,
                    version: newVersion
                }
            });

            return updatedSchema;
        } catch (error) {
            await this.handleError('schema_update_error', error);
            throw error;
        }
    }

    private initializeSchemas(): Map<string, ValidationSchema> {
        const schemas = new Map<string, ValidationSchema>();

        // Register default schemas
        this.registerDefaultSchemas(schemas);

        return schemas;
    }

    private registerDefaultSchemas(schemas: Map<string, ValidationSchema>): void {
        // User schema
        schemas.set('user', {
            id: 'user',
            version: '1.0.0',
            schema: z.object({
                id: z.string().uuid(),
                name: z.string().min(2).max(100),
                email: z.string().email(),
                role: z.enum(['admin', 'user', 'guest'])
            }),
            metadata: {
                description: 'User validation schema',
                createdAt: new Date(),
                updatedAt: new Date()
            }
        });

        // Model schema
        schemas.set('model', {
            id: 'model',
            version: '1.0.0',
            schema: z.object({
                id: z.string(),
                name: z.string().min(1),
                version: z.string(),
                type: z.enum(['classification', 'generation', 'other']),
                metadata: z.record(z.any())
            }),
            metadata: {
                description: 'Model validation schema',
                createdAt: new Date(),
                updatedAt: new Date()
            }
        });
    }

    private formatZodErrors(error: z.ZodError): ValidationError[] {
        return error.errors.map(err => ({
            path: err.path,
            message: err.message,
            code: err.code,
            input: err.input
        }));
    }

    private async validateDataSize(data: any, maxSize?: number): Promise<void> {
        const size = Buffer.from(JSON.stringify(data)).length;
        const limit = maxSize || this.DEFAULT_MAX_SIZE;

        if (size > limit) {
            throw new Error(`Data size exceeds limit: ${size} > ${limit} bytes`);
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

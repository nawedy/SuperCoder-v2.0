import { MonitoringService } from '../monitoring/monitoring-service';
import { ErrorHandlingService } from '../error/error-handling-service';
import { z } from 'zod';

interface ValidationContext {
    source: string;
    type: 'model-input' | 'api-request' | 'training-data';
    metadata: Record<string, any>;
}

interface ValidationResult {
    valid: boolean;
    errors: ValidationError[];
    metadata: {
        executionTime: number;
        timestamp: Date;
        validationId: string;
    };
}

interface ValidationError {
    field: string;
    message: string;
    code: string;
    severity: 'error' | 'warning';
}

export class DataValidationService {
    private monitor: MonitoringService;
    private errorHandler: ErrorHandlingService;
    private schemas: Map<string, z.ZodType<any>>;

    constructor(
        monitor: MonitoringService,
        errorHandler: ErrorHandlingService
    ) {
        this.monitor = monitor;
        this.errorHandler = errorHandler;
        this.schemas = this.initializeSchemas();
    }

    async validateData(
        data: any,
        schemaKey: string,
        context: ValidationContext
    ): Promise<ValidationResult> {
        const startTime = Date.now();
        const validationId = `val-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

        try {
            const schema = this.schemas.get(schemaKey);
            if (!schema) {
                throw new Error(`Schema not found: ${schemaKey}`);
            }

            const result = await schema.safeParseAsync(data);
            const errors = this.processValidationResults(result);

            const validationResult: ValidationResult = {
                valid: errors.length === 0,
                errors,
                metadata: {
                    executionTime: Date.now() - startTime,
                    timestamp: new Date(),
                    validationId
                }
            };

            await this.recordValidationMetrics(validationResult, context);
            return validationResult;

        } catch (error) {
            await this.errorHandler.handleError(error, {
                component: 'DataValidation',
                severity: 'high',
                metadata: { schemaKey, context }
            });
            throw error;
        }
    }

    private initializeSchemas(): Map<string, z.ZodType<any>> {
        const schemas = new Map<string, z.ZodType<any>>();

        // Model Input Schema
        schemas.set('model-input', z.object({
            code: z.string().min(1),
            language: z.string(),
            context: z.string().optional(),
            settings: z.object({
                temperature: z.number().min(0).max(1),
                maxTokens: z.number().positive()
            })
        }));

        // Training Data Schema
        schemas.set('training-data', z.object({
            inputs: z.array(z.string()).min(1),
            labels: z.array(z.string()).min(1),
            metadata: z.record(z.string(), z.any())
        }));

        // API Request Schema
        schemas.set('api-request', z.object({
            method: z.enum(['GET', 'POST', 'PUT', 'DELETE']),
            path: z.string().startsWith('/'),
            headers: z.record(z.string(), z.string()),
            body: z.any().optional()
        }));

        return schemas;
    }

    private processValidationResults(result: z.SafeParseReturnType<any, any>): ValidationError[] {
        if (result.success) return [];

        return result.error.issues.map(issue => ({
            field: issue.path.join('.'),
            message: issue.message,
            code: issue.code,
            severity: 'error'
        }));
    }

    private async recordValidationMetrics(
        result: ValidationResult,
        context: ValidationContext
    ): Promise<void> {
        await this.monitor.recordMetric({
            name: 'data_validation',
            value: result.valid ? 1 : 0,
            labels: {
                validation_id: result.metadata.validationId,
                source: context.source,
                type: context.type,
                execution_time: result.metadata.executionTime.toString()
            }
        });

        if (result.errors.length > 0) {
            await this.monitor.recordMetric({
                name: 'validation_errors',
                value: result.errors.length,
                labels: {
                    validation_id: result.metadata.validationId,
                    source: context.source
                }
            });
        }
    }

    async addCustomSchema(key: string, schema: z.ZodType<any>): Promise<void> {
        if (this.schemas.has(key)) {
            throw new Error(`Schema already exists: ${key}`);
        }
        this.schemas.set(key, schema);
    }
}

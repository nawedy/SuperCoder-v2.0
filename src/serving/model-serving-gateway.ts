import { MonitoringService } from '../monitoring/monitoring-service';
import { RateLimitingService } from '../security/rate-limiting-service';
import { AuthorizationService } from '../auth/authorization-service';
import { ModelRegistryService } from '../registry/model-registry-service';
import { AuditTrailService } from '../audit/audit-trail-service';

interface ModelRequest {
    modelId: string;
    input: any;
    parameters?: Record<string, any>;
    timeout?: number;
    priority?: 'high' | 'medium' | 'low';
}

interface ModelResponse {
    id: string;
    output: any;
    metadata: {
        modelId: string;
        version: string;
        latency: number;
        timestamp: Date;
    };
}

export class ModelServingGateway {
    private monitor: MonitoringService;
    private rateLimiter: RateLimitingService;
    private authorizer: AuthorizationService;
    private registry: ModelRegistryService;
    private audit: AuditTrailService;
    private readonly DEFAULT_TIMEOUT = 30000; // 30 seconds

    constructor(
        monitor: MonitoringService,
        rateLimiter: RateLimitingService,
        authorizer: AuthorizationService,
        registry: ModelRegistryService,
        audit: AuditTrailService
    ) {
        this.monitor = monitor;
        this.rateLimiter = rateLimiter;
        this.authorizer = authorizer;
        this.registry = registry;
        this.audit = audit;
    }

    async processRequest(
        request: ModelRequest,
        context: { userId: string; roles: string[] }
    ): Promise<ModelResponse> {
        const startTime = Date.now();
        try {
            // Rate limiting check
            const rateLimitInfo = await this.rateLimiter.checkLimit(
                'model_inference',
                request.modelId,
                context.userId
            );

            if (rateLimitInfo.remaining <= 0) {
                throw new Error(`Rate limit exceeded. Retry after ${rateLimitInfo.retryAfter} seconds`);
            }

            // Authorization check
            const authResult = await this.authorizer.authorize(
                {
                    userId: context.userId,
                    roles: context.roles,
                    permissions: [],
                    attributes: { modelId: request.modelId }
                },
                'model',
                'inference'
            );

            if (!authResult.authorized) {
                throw new Error(`Unauthorized: ${authResult.reason}`);
            }

            // Get model from registry
            const model = await this.registry.getModel(request.modelId);
            if (!model) {
                throw new Error(`Model not found: ${request.modelId}`);
            }

            // Process inference request with timeout
            const timeout = request.timeout || this.DEFAULT_TIMEOUT;
            const result = await Promise.race([
                this.performInference(model.data, request.input, request.parameters),
                new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Inference timeout')), timeout)
                )
            ]);

            const response: ModelResponse = {
                id: `inf-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                output: result,
                metadata: {
                    modelId: request.modelId,
                    version: model.metadata.version,
                    latency: Date.now() - startTime,
                    timestamp: new Date()
                }
            };

            // Audit trail
            await this.audit.logEvent({
                eventType: 'model.access',
                actor: {
                    id: context.userId,
                    type: 'user',
                    metadata: { roles: context.roles }
                },
                resource: {
                    type: 'model',
                    id: request.modelId,
                    action: 'inference'
                },
                context: {
                    location: 'model-serving',
                    ipAddress: 'internal',
                    userAgent: 'system'
                },
                status: 'success',
                details: {
                    latency: response.metadata.latency,
                    priority: request.priority
                }
            });

            // Record metrics
            await this.monitor.recordMetric({
                name: 'model_inference',
                value: response.metadata.latency,
                labels: {
                    model_id: request.modelId,
                    user_id: context.userId,
                    priority: request.priority || 'medium'
                }
            });

            return response;

        } catch (error) {
            await this.handleError('inference_error', error, {
                modelId: request.modelId,
                userId: context.userId
            });
            throw error;
        }
    }

    private async performInference(
        modelData: Buffer,
        input: any,
        parameters?: Record<string, any>
    ): Promise<any> {
        try {
            // Load model (implementation depends on your ML framework)
            const model = await this.loadModel(modelData);

            // Preprocess input
            const processedInput = await this.preprocessInput(input);

            // Run inference
            const output = await model.predict(processedInput, parameters);

            // Postprocess output
            return await this.postprocessOutput(output);

        } catch (error) {
            throw new Error(`Inference failed: ${error.message}`);
        }
    }

    private async loadModel(modelData: Buffer): Promise<any> {
        // Implementation for loading model
        // This would depend on your ML framework (TensorFlow, PyTorch, etc.)
        return {
            predict: async (input: any) => input // Placeholder
        };
    }

    private async preprocessInput(input: any): Promise<any> {
        // Implementation for input preprocessing
        // This would include data validation, formatting, etc.
        return input;
    }

    private async postprocessOutput(output: any): Promise<any> {
        // Implementation for output postprocessing
        // This would include formatting, validation, etc.
        return output;
    }

    private async handleError(
        type: string,
        error: Error,
        context: Record<string, any>
    ): Promise<void> {
        await this.monitor.recordMetric({
            name: type,
            value: 1,
            labels: {
                error: error.message,
                ...context
            }
        });

        await this.audit.logEvent({
            eventType: 'model.access',
            actor: {
                id: context.userId,
                type: 'user',
                metadata: {}
            },
            resource: {
                type: 'model',
                id: context.modelId,
                action: 'inference'
            },
            context: {
                location: 'model-serving',
                ipAddress: 'internal',
                userAgent: 'system'
            },
            status: 'failure',
            details: { error: error.message }
        });
    }
}

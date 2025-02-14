import { MonitoringService } from '../monitoring/monitoring-service';
import { AuditTrailService } from '../audit/audit-trail-service';
import { ModelServingConfig } from './model-serving-config';
import { VertexAI } from '@google-cloud/vertexai';
import { Cache } from '../cache/cache-service';

interface AIRequest {
    prompt: string;
    context?: any;
    options?: {
        temperature?: number;
        maxTokens?: number;
        stream?: boolean;
    };
}

interface AIResponse {
    id: string;
    completion: string;
    usage: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
    };
    metadata: {
        model: string;
        latency: number;
        cached: boolean;
    };
}

export class GCPAIService {
    private vertex: VertexAI;
    private cache: Cache;
    private requestQueue: Promise<any>[] = [];
    private activeRequests = 0;

    constructor(
        private config: ModelServingConfig,
        private monitor: MonitoringService,
        private audit: AuditTrailService
    ) {
        this.vertex = new VertexAI({
            project: process.env.GCP_PROJECT_ID!,
            location: process.env.GCP_LOCATION || 'us-central1'
        });
        this.cache = new Cache(config.cacheConfig);
        this.setupMonitoring();
    }

    async generateCode(request: AIRequest): Promise<AIResponse> {
        const startTime = Date.now();
        const requestId = `req_${Date.now()}`;

        try {
            // Check cache first
            if (this.config.cacheConfig.enabled) {
                const cached = await this.cache.get(this.getCacheKey(request));
                if (cached) {
                    await this.recordMetrics('cache_hit', startTime);
                    return {
                        ...cached,
                        metadata: { ...cached.metadata, cached: true }
                    };
                }
            }

            // Rate limiting and queue management
            if (this.activeRequests >= this.config.maxConcurrentRequests) {
                await this.waitForAvailableSlot();
            }

            // Execute request
            this.activeRequests++;
            const response = await this.executeRequest(request, requestId);
            this.activeRequests--;

            // Cache successful response
            if (this.config.cacheConfig.enabled) {
                await this.cache.set(
                    this.getCacheKey(request),
                    response,
                    this.config.cacheConfig.ttl
                );
            }

            // Record metrics
            await this.recordMetrics('request_success', startTime, {
                tokens: response.usage.totalTokens
            });

            return response;

        } catch (error) {
            await this.handleError('ai_request_error', error, requestId);
            throw error;
        }
    }

    async streamCode(request: AIRequest): Promise<AsyncGenerator<string, void, unknown>> {
        const startTime = Date.now();
        const requestId = `stream_${Date.now()}`;

        try {
            if (this.activeRequests >= this.config.maxConcurrentRequests) {
                await this.waitForAvailableSlot();
            }

            this.activeRequests++;
            const model = this.vertex.preview.getGenerativeModel({
                model: 'code-bison',
                generation_config: {
                    temperature: request.options?.temperature || 0.7,
                    max_output_tokens: request.options?.maxTokens || 1024
                }
            });

            const stream = await model.generateContentStream(request.prompt);
            
            return this.processStream(stream, startTime, requestId);

        } catch (error) {
            await this.handleError('stream_error', error, requestId);
            throw error;
        }
    }

    private async *processStream(
        stream: any,
        startTime: number,
        requestId: string
    ): AsyncGenerator<string, void, unknown> {
        try {
            let totalTokens = 0;
            for await (const chunk of stream) {
                const content = chunk.candidates[0]?.content || '';
                totalTokens += this.estimateTokens(content);
                yield content;
            }

            await this.recordMetrics('stream_success', startTime, {
                tokens: totalTokens
            });

        } finally {
            this.activeRequests--;
        }
    }

    private async executeRequest(
        request: AIRequest,
        requestId: string
    ): Promise<AIResponse> {
        const model = this.vertex.preview.getGenerativeModel({
            model: 'code-bison'
        });

        const result = await model.generateContent({
            contents: [{ role: 'user', parts: [{ text: request.prompt }] }],
            generation_config: {
                temperature: request.options?.temperature || 0.7,
                max_output_tokens: request.options?.maxTokens || 1024
            }
        });

        const response = result.response;
        const completion = response.candidates[0]?.content || '';
        const tokens = this.estimateTokens(completion);

        return {
            id: requestId,
            completion,
            usage: {
                promptTokens: this.estimateTokens(request.prompt),
                completionTokens: tokens,
                totalTokens: tokens + this.estimateTokens(request.prompt)
            },
            metadata: {
                model: 'code-bison',
                latency: Date.now() - startTime,
                cached: false
            }
        };
    }

    private async waitForAvailableSlot(): Promise<void> {
        return new Promise(resolve => {
            const interval = setInterval(() => {
                if (this.activeRequests < this.config.maxConcurrentRequests) {
                    clearInterval(interval);
                    resolve();
                }
            }, 100);
        });
    }

    private getCacheKey(request: AIRequest): string {
        return `ai_${Buffer.from(request.prompt).toString('base64')}`;
    }

    private estimateTokens(text: string): number {
        // Rough token estimation: ~4 chars per token
        return Math.ceil(text.length / 4);
    }

    private async recordMetrics(
        event: string,
        startTime: number,
        extra?: Record<string, any>
    ): Promise<void> {
        await this.monitor.recordMetric({
            name: `ai_${event}`,
            value: Date.now() - startTime,
            labels: {
                model: 'code-bison',
                ...extra
            }
        });
    }

    private async handleError(
        type: string,
        error: Error,
        requestId: string
    ): Promise<void> {
        this.activeRequests = Math.max(0, this.activeRequests - 1);

        await this.monitor.recordMetric({
            name: type,
            value: 1,
            labels: { error: error.message, request_id: requestId }
        });

        await this.audit.logEvent({
            eventType: 'ai.error',
            actor: {
                id: 'system',
                type: 'service',
                metadata: { request_id: requestId }
            },
            resource: {
                type: 'ai-model',
                id: 'code-bison',
                action: 'generate'
            },
            context: {
                location: 'gcp-ai-service',
                ipAddress: 'internal',
                userAgent: 'system'
            },
            status: 'error',
            details: {
                error: error.message,
                type
            }
        });
    }

    private setupMonitoring(): void {
        setInterval(() => {
            this.monitor.recordMetric({
                name: 'ai_active_requests',
                value: this.activeRequests,
                labels: { model: 'code-bison' }
            });
        }, 5000);
    }
}

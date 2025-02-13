import { MonitoringService } from '../monitoring/monitoring-service';
import { AuditTrailService } from '../audit/audit-trail-service';
import { CacheService } from '../cache/cache-service';
import { EventBusService } from '../events/event-bus-service';
import { v4 as uuidv4 } from 'uuid';
import axios, { AxiosInstance } from 'axios';

interface IntegrationConfig {
    id: string;
    name: string;
    type: 'rest' | 'graphql' | 'grpc' | 'webhook';
    endpoint: string;
    auth: {
        type: 'basic' | 'bearer' | 'oauth2' | 'apiKey';
        credentials: Record<string, string>;
    };
    retry: {
        maxAttempts: number;
        backoffMs: number;
    };
    timeout: number;
    rateLimit: {
        requestsPerSecond: number;
        burstSize: number;
    };
}

interface IntegrationRequest {
    id: string;
    config: IntegrationConfig;
    method: string;
    path: string;
    headers?: Record<string, string>;
    body?: any;
    timestamp: Date;
}

interface IntegrationResponse {
    requestId: string;
    status: number;
    headers: Record<string, string>;
    body: any;
    timing: {
        start: Date;
        end: Date;
        duration: number;
    };
}

export class IntegrationService {
    private monitor: MonitoringService;
    private audit: AuditTrailService;
    private cache: CacheService;
    private eventBus: EventBusService;
    private configs: Map<string, IntegrationConfig>;
    private clients: Map<string, AxiosInstance>;
    private rateLimiters: Map<string, {
        lastReset: Date;
        tokens: number;
    }>;

    constructor(
        monitor: MonitoringService,
        audit: AuditTrailService,
        cache: CacheService,
        eventBus: EventBusService
    ) {
        this.monitor = monitor;
        this.audit = audit;
        this.cache = cache;
        this.eventBus = eventBus;
        this.configs = new Map();
        this.clients = new Map();
        this.rateLimiters = new Map();
    }

    async registerIntegration(config: IntegrationConfig): Promise<void> {
        try {
            // Validate config
            await this.validateConfig(config);

            // Create HTTP client
            const client = this.createClient(config);

            // Store config and client
            this.configs.set(config.id, config);
            this.clients.set(config.id, client);

            // Initialize rate limiter
            this.rateLimiters.set(config.id, {
                lastReset: new Date(),
                tokens: config.rateLimit.burstSize
            });

            await this.audit.logEvent({
                eventType: 'system.config',
                actor: {
                    id: 'system',
                    type: 'service',
                    metadata: {}
                },
                resource: {
                    type: 'integration',
                    id: config.id,
                    action: 'register'
                },
                context: {
                    location: 'integration-service',
                    ipAddress: 'internal',
                    userAgent: 'system'
                },
                status: 'success',
                details: { config }
            });

        } catch (error) {
            await this.handleError('integration_registration_error', error);
            throw error;
        }
    }

    async execute(
        integrationId: string,
        method: string,
        path: string,
        options: {
            headers?: Record<string, string>;
            body?: any;
            cache?: boolean;
        } = {}
    ): Promise<IntegrationResponse> {
        const startTime = Date.now();
        const requestId = uuidv4();

        try {
            // Get config and client
            const config = this.configs.get(integrationId);
            if (!config) {
                throw new Error(`Integration not found: ${integrationId}`);
            }

            // Check rate limit
            await this.checkRateLimit(config);

            // Check cache
            if (options.cache) {
                const cached = await this.checkCache(integrationId, method, path, options);
                if (cached) {
                    return cached;
                }
            }

            // Create request
            const request: IntegrationRequest = {
                id: requestId,
                config,
                method,
                path,
                headers: options.headers,
                body: options.body,
                timestamp: new Date()
            };

            // Execute request with retries
            const response = await this.executeWithRetry(request);

            // Cache response if needed
            if (options.cache) {
                await this.cacheResponse(integrationId, method, path, options, response);
            }

            // Record metrics
            await this.monitor.recordMetric({
                name: 'integration_request',
                value: Date.now() - startTime,
                labels: {
                    integration_id: integrationId,
                    method,
                    status: response.status.toString()
                }
            });

            return response;

        } catch (error) {
            await this.handleError('integration_execution_error', error);
            throw error;
        }
    }

    private async executeWithRetry(request: IntegrationRequest): Promise<IntegrationResponse> {
        const client = this.clients.get(request.config.id)!;
        let attempts = 0;
        let lastError: Error | null = null;

        while (attempts < request.config.retry.maxAttempts) {
            try {
                const startTime = new Date();
                const response = await client.request({
                    method: request.method,
                    url: request.path,
                    headers: request.headers,
                    data: request.body
                });

                const endTime = new Date();

                return {
                    requestId: request.id,
                    status: response.status,
                    headers: response.headers,
                    body: response.data,
                    timing: {
                        start: startTime,
                        end: endTime,
                        duration: endTime.getTime() - startTime.getTime()
                    }
                };

            } catch (error) {
                lastError = error;
                attempts++;

                if (attempts < request.config.retry.maxAttempts) {
                    await new Promise(resolve => 
                        setTimeout(resolve, request.config.retry.backoffMs * attempts)
                    );
                }
            }
        }

        throw lastError || new Error('Request failed after retries');
    }

    private async checkRateLimit(config: IntegrationConfig): Promise<void> {
        const limiter = this.rateLimiters.get(config.id)!;
        const now = new Date();
        const timeDiff = now.getTime() - limiter.lastReset.getTime();

        // Reset tokens if enough time has passed
        if (timeDiff >= 1000) {
            limiter.tokens = config.rateLimit.burstSize;
            limiter.lastReset = now;
        }

        if (limiter.tokens <= 0) {
            throw new Error('Rate limit exceeded');
        }

        limiter.tokens--;
    }

    private createClient(config: IntegrationConfig): AxiosInstance {
        const client = axios.create({
            baseURL: config.endpoint,
            timeout: config.timeout
        });

        // Add auth interceptor
        client.interceptors.request.use(request => {
            switch (config.auth.type) {
                case 'basic':
                    request.auth = {
                        username: config.auth.credentials.username,
                        password: config.auth.credentials.password
                    };
                    break;
                case 'bearer':
                    request.headers['Authorization'] = 
                        `Bearer ${config.auth.credentials.token}`;
                    break;
                case 'apiKey':
                    request.headers[config.auth.credentials.header || 'X-API-Key'] = 
                        config.auth.credentials.key;
                    break;
            }
            return request;
        });

        return client;
    }

    private async validateConfig(config: IntegrationConfig): Promise<void> {
        if (!config.endpoint || !config.auth) {
            throw new Error('Invalid integration configuration');
        }

        // Validate endpoint URL
        try {
            new URL(config.endpoint);
        } catch {
            throw new Error('Invalid endpoint URL');
        }

        // Validate auth configuration
        switch (config.auth.type) {
            case 'basic':
                if (!config.auth.credentials.username || !config.auth.credentials.password) {
                    throw new Error('Missing basic auth credentials');
                }
                break;
            case 'bearer':
                if (!config.auth.credentials.token) {
                    throw new Error('Missing bearer token');
                }
                break;
            case 'apiKey':
                if (!config.auth.credentials.key) {
                    throw new Error('Missing API key');
                }
                break;
            default:
                throw new Error('Invalid auth type');
        }
    }

    private async checkCache(
        integrationId: string,
        method: string,
        path: string,
        options: any
    ): Promise<IntegrationResponse | null> {
        const cacheKey = this.buildCacheKey(integrationId, method, path, options);
        return this.cache.get<IntegrationResponse>(cacheKey);
    }

    private async cacheResponse(
        integrationId: string,
        method: string,
        path: string,
        options: any,
        response: IntegrationResponse
    ): Promise<void> {
        const cacheKey = this.buildCacheKey(integrationId, method, path, options);
        await this.cache.set(cacheKey, response, { ttl: 300 }); // 5 minutes
    }

    private buildCacheKey(
        integrationId: string,
        method: string,
        path: string,
        options: any
    ): string {
        return `integration:${integrationId}:${method}:${path}:${JSON.stringify(options)}`;
    }

    private async handleError(type: string, error: Error): Promise<void> {
        await this.monitor.recordMetric({
            name: type,
            value: 1,
            labels: { error: error.message }
        });
    }
}

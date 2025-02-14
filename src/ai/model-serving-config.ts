export interface ModelServingConfig {
    endpoint: string;
    version: string;
    apiKey: string;
    maxConcurrentRequests: number;
    timeout: number;
    cacheConfig: {
        enabled: boolean;
        ttl: number;
    };
}

export const defaultConfig: ModelServingConfig = {
    endpoint: process.env.AI_ENDPOINT || '',
    version: process.env.AI_MODEL_VERSION || 'v1',
    apiKey: process.env.AI_API_KEY || '',
    maxConcurrentRequests: 100,
    timeout: 30000,
    cacheConfig: {
        enabled: true,
        ttl: 3600
    }
};

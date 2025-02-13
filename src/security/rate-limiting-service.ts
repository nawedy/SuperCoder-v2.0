import { MonitoringService } from '../monitoring/monitoring-service';
import { Redis } from 'ioredis';
import { SecurityConfig } from '../config/security-config';

interface RateLimitConfig {
    window: number;      // Time window in seconds
    maxRequests: number; // Maximum requests per window
    burstLimit?: number; // Maximum burst allowed
}

interface RateLimitInfo {
    remaining: number;
    reset: number;
    limit: number;
    retryAfter?: number;
}

export class RateLimitingService {
    private monitor: MonitoringService;
    private redis: Redis;
    private limits: Map<string, RateLimitConfig>;
    private readonly DEFAULT_PREFIX = 'ratelimit:';

    constructor(
        monitor: MonitoringService,
        redisUrl: string
    ) {
        this.monitor = monitor;
        this.redis = new Redis(redisUrl);
        this.limits = this.initializeLimits();
    }

    private initializeLimits(): Map<string, RateLimitConfig> {
        const limits = new Map<string, RateLimitConfig>();

        // API endpoints
        limits.set('api:default', {
            window: 60,      // 1 minute
            maxRequests: 100 // 100 requests per minute
        });

        // Model inference
        limits.set('model:inference', {
            window: 60,
            maxRequests: 50,
            burstLimit: 60
        });

        // Training requests
        limits.set('model:training', {
            window: 300,    // 5 minutes
            maxRequests: 5  // 5 training requests per 5 minutes
        });

        return limits;
    }

    async checkLimit(
        key: string,
        type: string,
        userId?: string
    ): Promise<RateLimitInfo> {
        try {
            const config = this.limits.get(type) || this.limits.get('api:default')!;
            const limitKey = this.buildLimitKey(key, type, userId);

            const now = Math.floor(Date.now() / 1000);
            const windowStart = now - config.window;

            // Execute rate limiting logic in Redis
            const result = await this.redis.eval(`
                -- Remove old entries
                redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, ARGV[1])
                
                -- Count requests in current window
                local count = redis.call('ZCARD', KEYS[1])
                
                -- Check if limit is exceeded
                if count >= tonumber(ARGV[3]) then
                    return {count, 0}
                end
                
                -- Add new request
                redis.call('ZADD', KEYS[1], ARGV[2], ARGV[2])
                -- Set expiry
                redis.call('EXPIRE', KEYS[1], ARGV[4])
                
                return {count + 1, 1}
            `, 
            1, 
            limitKey, 
            windowStart.toString(), 
            now.toString(), 
            config.maxRequests.toString(),
            config.window.toString()
            ) as [number, number];

            const [count, allowed] = result;
            const remainingRequests = Math.max(0, config.maxRequests - count);
            const resetTime = now + config.window;

            // Record metrics
            await this.monitor.recordMetric({
                name: 'rate_limit_check',
                value: allowed,
                labels: {
                    type,
                    user_id: userId || 'anonymous',
                    remaining: remainingRequests.toString()
                }
            });

            const info: RateLimitInfo = {
                remaining: remainingRequests,
                reset: resetTime,
                limit: config.maxRequests
            };

            if (allowed === 0) {
                info.retryAfter = resetTime - now;
                await this.handleLimitExceeded(type, userId);
            }

            return info;

        } catch (error) {
            await this.handleError('rate_limit_error', error);
            // Fail open with a default response
            return {
                remaining: 1,
                reset: Math.floor(Date.now() / 1000) + 60,
                limit: 100
            };
        }
    }

    async updateLimit(
        type: string,
        config: RateLimitConfig
    ): Promise<void> {
        try {
            // Validate config
            this.validateConfig(config);

            // Update limits map
            this.limits.set(type, config);

            // Record update
            await this.monitor.recordMetric({
                name: 'rate_limit_update',
                value: 1,
                labels: {
                    type,
                    max_requests: config.maxRequests.toString(),
                    window: config.window.toString()
                }
            });
        } catch (error) {
            await this.handleError('rate_limit_update_error', error);
            throw error;
        }
    }

    async resetLimit(
        key: string,
        type: string,
        userId?: string
    ): Promise<void> {
        try {
            const limitKey = this.buildLimitKey(key, type, userId);
            await this.redis.del(limitKey);

            await this.monitor.recordMetric({
                name: 'rate_limit_reset',
                value: 1,
                labels: {
                    type,
                    user_id: userId || 'anonymous'
                }
            });
        } catch (error) {
            await this.handleError('rate_limit_reset_error', error);
            throw error;
        }
    }

    private buildLimitKey(
        key: string,
        type: string,
        userId?: string
    ): string {
        const components = [this.DEFAULT_PREFIX, type, key];
        if (userId) {
            components.push(userId);
        }
        return components.join(':');
    }

    private validateConfig(config: RateLimitConfig): void {
        if (config.window <= 0) {
            throw new Error('Window must be positive');
        }
        if (config.maxRequests <= 0) {
            throw new Error('Max requests must be positive');
        }
        if (config.burstLimit && config.burstLimit < config.maxRequests) {
            throw new Error('Burst limit must be greater than max requests');
        }
    }

    private async handleLimitExceeded(
        type: string,
        userId?: string
    ): Promise<void> {
        await this.monitor.recordMetric({
            name: 'rate_limit_exceeded',
            value: 1,
            labels: {
                type,
                user_id: userId || 'anonymous'
            }
        });

        // Implement additional logic for handling exceeded limits
        // e.g., logging, notifications, or temporary bans
    }

    private async handleError(
        type: string,
        error: Error
    ): Promise<void> {
        await this.monitor.recordMetric({
            name: type,
            value: 1,
            labels: { error: error.message }
        });
    }
}

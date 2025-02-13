import { MonitoringService } from '../monitoring/monitoring-service';
import { EventBusService } from '../events/event-bus-service';
import { Redis } from 'ioredis';
import { v4 as uuidv4 } from 'uuid';

interface RateLimitRule {
    id: string;
    name: string;
    type: 'fixed' | 'sliding' | 'token_bucket';
    resource: string;
    limit: number;
    window: number; // in seconds
    penalty?: {
        blockDuration: number;
        maxViolations: number;
    };
    scope: 'ip' | 'user' | 'api_key' | 'global';
    priority: number;
    conditions?: {
        userType?: string[];
        path?: string[];
        method?: string[];
        headers?: Record<string, string>;
    };
}

interface RateLimitResult {
    allowed: boolean;
    remaining: number;
    resetTime: number;
    retryAfter?: number;
    rule: string;
    usage: {
        current: number;
        limit: number;
        window: number;
    };
}

interface TokenBucket {
    tokens: number;
    lastRefill: number;
    capacity: number;
    refillRate: number;
}

export class RateLimitingService {
    private monitor: MonitoringService;
    private eventBus: EventBusService;
    private redis: Redis;
    private rules: Map<string, RateLimitRule>;
    private readonly REDIS_PREFIX = 'ratelimit:';
    private readonly VIOLATION_PREFIX = 'violation:';
    private readonly BUCKET_PREFIX = 'bucket:';
    private readonly CLEANUP_INTERVAL = 3600000; // 1 hour

    constructor(
        monitor: MonitoringService,
        eventBus: EventBusService,
        redisUrl: string
    ) {
        this.monitor = monitor;
        this.eventBus = eventBus;
        this.redis = new Redis(redisUrl);
        this.rules = new Map();

        this.initialize();
    }

    private async initialize(): Promise<void> {
        await this.loadRules();
        this.startCleanup();
        this.setupEventListeners();
    }

    async checkLimit(
        identifier: string,
        resource: string,
        context: {
            ip?: string;
            userId?: string;
            apiKey?: string;
            path?: string;
            method?: string;
            headers?: Record<string, string>;
        }
    ): Promise<RateLimitResult> {
        const startTime = Date.now();
        try {
            // Get applicable rules
            const rule = await this.getApplicableRule(resource, context);
            if (!rule) {
                return this.createAllowedResult('default');
            }

            // Check if blocked due to violations
            if (await this.isBlocked(identifier, rule)) {
                return this.createBlockedResult(rule);
            }

            // Check rate limit based on rule type
            const result = await this.checkRuleLimit(identifier, rule);

            // Record metrics
            await this.monitor.recordMetric({
                name: 'rate_limit_check',
                value: Date.now() - startTime,
                labels: {
                    resource,
                    rule: rule.name,
                    allowed: result.allowed.toString()
                }
            });

            // Handle violations if needed
            if (!result.allowed) {
                await this.handleViolation(identifier, rule);
            }

            return result;

        } catch (error) {
            await this.handleError('rate_limit_error', error);
            // Default to allowing request in case of errors
            return this.createAllowedResult('error');
        }
    }

    async addRule(rule: Omit<RateLimitRule, 'id'>): Promise<string> {
        try {
            // Validate rule
            this.validateRule(rule);

            const id = uuidv4();
            const newRule: RateLimitRule = {
                ...rule,
                id
            };

            // Store rule
            this.rules.set(id, newRule);
            await this.persistRule(newRule);

            // Publish event
            await this.eventBus.publish('ratelimit.rule.created', {
                type: 'ratelimit.rule.created',
                source: 'rate-limiting-service',
                data: {
                    rule: newRule,
                    timestamp: new Date()
                },
                metadata: {
                    environment: process.env.NODE_ENV || 'development'
                }
            });

            return id;

        } catch (error) {
            await this.handleError('rule_creation_error', error);
            throw error;
        }
    }

    async updateRule(
        id: string,
        updates: Partial<Omit<RateLimitRule, 'id'>>
    ): Promise<void> {
        try {
            const rule = this.rules.get(id);
            if (!rule) {
                throw new Error(`Rule not found: ${id}`);
            }

            // Validate updates
            this.validateRule({ ...rule, ...updates });

            // Update rule
            const updatedRule = {
                ...rule,
                ...updates
            };

            this.rules.set(id, updatedRule);
            await this.persistRule(updatedRule);

        } catch (error) {
            await this.handleError('rule_update_error', error);
            throw error;
        }
    }

    private async checkRuleLimit(
        identifier: string,
        rule: RateLimitRule
    ): Promise<RateLimitResult> {
        const key = this.buildKey(identifier, rule);

        switch (rule.type) {
            case 'fixed':
                return this.checkFixedWindow(key, rule);
            case 'sliding':
                return this.checkSlidingWindow(key, rule);
            case 'token_bucket':
                return this.checkTokenBucket(key, rule);
            default:
                throw new Error(`Unsupported rule type: ${rule.type}`);
        }
    }

    private async checkFixedWindow(
        key: string,
        rule: RateLimitRule
    ): Promise<RateLimitResult> {
        const now = Math.floor(Date.now() / 1000);
        const windowKey = `${key}:${Math.floor(now / rule.window)}`;

        const count = await this.redis.incr(windowKey);
        if (count === 1) {
            await this.redis.expire(windowKey, rule.window);
        }

        const allowed = count <= rule.limit;
        const remaining = Math.max(0, rule.limit - count);
        const resetTime = Math.ceil(now / rule.window) * rule.window;

        return {
            allowed,
            remaining,
            resetTime,
            retryAfter: allowed ? 0 : resetTime - now,
            rule: rule.name,
            usage: {
                current: count,
                limit: rule.limit,
                window: rule.window
            }
        };
    }

    private async checkSlidingWindow(
        key: string,
        rule: RateLimitRule
    ): Promise<RateLimitResult> {
        const now = Date.now();
        const windowStart = now - (rule.window * 1000);

        // Remove old entries
        await this.redis.zremrangebyscore(key, '-inf', windowStart);

        // Add current request
        await this.redis.zadd(key, now, `${now}:${uuidv4()}`);

        // Get current count
        const count = await this.redis.zcard(key);

        // Set expiry
        await this.redis.expire(key, rule.window);

        const allowed = count <= rule.limit;
        const remaining = Math.max(0, rule.limit - count);
        
        return {
            allowed,
            remaining,
            resetTime: Math.floor(now/1000) + rule.window,
            retryAfter: allowed ? 0 : 1,
            rule: rule.name,
            usage: {
                current: count,
                limit: rule.limit,
                window: rule.window
            }
        };
    }

    private async checkTokenBucket(
        key: string,
        rule: RateLimitRule
    ): Promise<RateLimitResult> {
        const now = Date.now();
        let bucket = await this.getBucket(key, rule);

        // Refill tokens
        const timePassed = (now - bucket.lastRefill) / 1000;
        const tokensToAdd = timePassed * bucket.refillRate;
        bucket.tokens = Math.min(bucket.capacity, bucket.tokens + tokensToAdd);
        bucket.lastRefill = now;

        // Check if request can be allowed
        const allowed = bucket.tokens >= 1;
        if (allowed) {
            bucket.tokens -= 1;
        }

        // Save updated bucket
        await this.saveBucket(key, bucket);

        return {
            allowed,
            remaining: Math.floor(bucket.tokens),
            resetTime: Math.floor(now/1000 + ((1 - bucket.tokens) / bucket.refillRate)),
            retryAfter: allowed ? 0 : Math.ceil(1 / bucket.refillRate),
            rule: rule.name,
            usage: {
                current: bucket.capacity - bucket.tokens,
                limit: bucket.capacity,
                window: rule.window
            }
        };
    }

    private async getBucket(
        key: string,
        rule: RateLimitRule
    ): Promise<TokenBucket> {
        const bucketKey = `${this.BUCKET_PREFIX}${key}`;
        const stored = await this.redis.get(bucketKey);

        if (stored) {
            return JSON.parse(stored);
        }

        // Create new bucket
        const bucket: TokenBucket = {
            tokens: rule.limit,
            lastRefill: Date.now(),
            capacity: rule.limit,
            refillRate: rule.limit / rule.window
        };

        await this.saveBucket(key, bucket);
        return bucket;
    }

    private async saveBucket(key: string, bucket: TokenBucket): Promise<void> {
        const bucketKey = `${this.BUCKET_PREFIX}${key}`;
        await this.redis.set(
            bucketKey,
            JSON.stringify(bucket),
            'EX',
            3600 // 1 hour TTL
        );
    }

    private async handleViolation(
        identifier: string,
        rule: RateLimitRule
    ): Promise<void> {
        if (!rule.penalty) return;

        const violationKey = `${this.VIOLATION_PREFIX}${identifier}`;
        const violations = await this.redis.incr(violationKey);

        if (violations === 1) {
            await this.redis.expire(violationKey, rule.penalty.blockDuration);
        }

        if (violations >= rule.penalty.maxViolations) {
            await this.blockIdentifier(identifier, rule.penalty.blockDuration);
            
            await this.eventBus.publish('ratelimit.violation', {
                type: 'ratelimit.violation',
                source: 'rate-limiting-service',
                data: {
                    identifier,
                    rule: rule.name,
                    violations,
                    blockDuration: rule.penalty.blockDuration,
                    timestamp: new Date()
                },
                metadata: {
                    severity: 'high',
                    environment: process.env.NODE_ENV || 'development'
                }
            });
        }
    }

    private async isBlocked(
        identifier: string,
        rule: RateLimitRule
    ): Promise<boolean> {
        if (!rule.penalty) return false;

        const blockKey = `${this.REDIS_PREFIX}blocked:${identifier}`;
        return await this.redis.exists(blockKey) === 1;
    }

    private async blockIdentifier(
        identifier: string,
        duration: number
    ): Promise<void> {
        const blockKey = `${this.REDIS_PREFIX}blocked:${identifier}`;
        await this.redis.set(blockKey, '1', 'EX', duration);
    }

    private buildKey(identifier: string, rule: RateLimitRule): string {
        return `${this.REDIS_PREFIX}${rule.type}:${rule.resource}:${identifier}`;
    }

    private validateRule(rule: Partial<RateLimitRule>): void {
        if (!rule.name || !rule.type || !rule.resource || !rule.limit || !rule.window) {
            throw new Error('Missing required rule fields');
        }

        if (!['fixed', 'sliding', 'token_bucket'].includes(rule.type)) {
            throw new Error(`Invalid rule type: ${rule.type}`);
        }

        if (!['ip', 'user', 'api_key', 'global'].includes(rule.scope)) {
            throw new Error(`Invalid rule scope: ${rule.scope}`);
        }
    }

    private async getApplicableRule(
        resource: string,
        context: Record<string, any>
    ): Promise<RateLimitRule | null> {
        return Array.from(this.rules.values())
            .filter(rule => {
                if (rule.resource !== resource) return false;
                if (!rule.conditions) return true;

                // Check conditions
                if (rule.conditions.userType && context.userType) {
                    if (!rule.conditions.userType.includes(context.userType)) {
                        return false;
                    }
                }

                if (rule.conditions.path && context.path) {
                    if (!rule.conditions.path.some(p => 
                        context.path.startsWith(p)
                    )) {
                        return false;
                    }
                }

                if (rule.conditions.method && context.method) {
                    if (!rule.conditions.method.includes(context.method)) {
                        return false;
                    }
                }

                return true;
            })
            .sort((a, b) => b.priority - a.priority)[0] || null;
    }

    private createAllowedResult(rule: string): RateLimitResult {
        return {
            allowed: true,
            remaining: Infinity,
            resetTime: 0,
            rule,
            usage: {
                current: 0,
                limit: Infinity,
                window: 0
            }
        };
    }

    private createBlockedResult(rule: RateLimitRule): RateLimitResult {
        const now = Math.floor(Date.now() / 1000);
        return {
            allowed: false,
            remaining: 0,
            resetTime: now + (rule.penalty?.blockDuration || 0),
            retryAfter: rule.penalty?.blockDuration || 0,
            rule: rule.name,
            usage: {
                current: rule.limit,
                limit: rule.limit,
                window: rule.window
            }
        };
    }

    private async loadRules(): Promise<void> {
        // Implementation for loading rules from persistent storage
    }

    private async persistRule(rule: RateLimitRule): Promise<void> {
        // Implementation for persisting rules to storage
    }

    private startCleanup(): void {
        setInterval(async () => {
            try {
                await this.cleanup();
            } catch (error) {
                await this.handleError('cleanup_error', error);
            }
        }, this.CLEANUP_INTERVAL);
    }

    private async cleanup(): Promise<void> {
        // Cleanup logic implementation
    }

    private setupEventListeners(): void {
        this.eventBus.subscribe({
            id: 'ratelimit-monitor',
            topic: 'ratelimit.violation',
            handler: async (event) => {
                await this.monitor.recordMetric({
                    name: 'rate_limit_violation',
                    value: 1,
                    labels: {
                        identifier: event.data.identifier,
                        rule: event.data.rule
                    }
                });
            }
        });
    }

    private async handleError(type: string, error: Error): Promise<void> {
        await this.monitor.recordMetric({
            name: type,
            value: 1,
            labels: { error: error.message }
        });
    }

    async shutdown(): Promise<void> {
        this.rules.clear();
        await this.redis.quit();
    }
}

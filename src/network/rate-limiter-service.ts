import { MonitoringService } from '../monitoring/monitoring-service';
import { Redis } from 'ioredis';
import { EventBusService } from '../events/event-bus-service';

interface RateLimitRule {
    id: string;
    resource: string;
    limit: number;
    window: number; // in seconds
    userScoped: boolean;
    burstLimit?: number;
    priority?: number;
    grouping?: string[];
    overrides?: {
        userIds?: string[];
        roles?: string[];
        limit: number;
    }[];
}

interface RateLimitResult {
    allowed: boolean;
    remaining: number;
    resetTime: Date;
    retryAfter?: number;
}

interface RateLimitMetrics {
    total: number;
    allowed: number;
    blocked: number;
    resetTime: Date;
}

export class RateLimiterService {
    private monitor: MonitoringService;
    private eventBus: EventBusService;
    private redis: Redis;
    private rules: Map<string, RateLimitRule>;
    private metrics: Map<string, RateLimitMetrics>;

    constructor(
        monitor: MonitoringService,
        eventBus: EventBusService,
        redisUrl: string
    ) {
        this.monitor = monitor;
        this.eventBus = eventBus;
        this.redis = new Redis(redisUrl);
        this.rules = new Map();
        this.metrics = new Map();

        this.initialize();
    }

    private async initialize(): Promise<void> {
        await this.loadRules();
        this.startMetricsCollection();
    }

    async checkLimit(
        resource: string,
        userId?: string,
        metadata: Record<string, any> = {}
    ): Promise<RateLimitResult> {
        const startTime = Date.now();
        try {
            // Get rule for resource
            const rule = this.rules.get(resource);
            if (!rule) {
                return { allowed: true, remaining: -1, resetTime: new Date() };
            }

            // Build key
            const key = this.buildKey(rule, userId, metadata);

            // Check rate limit using Redis
            const [current, ttl] = await this.checkAndIncrement(key, rule);

            // Calculate result
            const allowed = current <= (rule.burstLimit || rule.limit);
            const resetTime = new Date(Date.now() + ttl * 1000);

            // Update metrics
            await this.updateMetrics(rule.id, allowed);

            // Record latency
            await this.monitor.recordMetric({
                name: 'rate_limit_check',
                value: Date.now() - startTime,
                labels: {
                    resource,
                    allowed: allowed.toString()
                }
            });

            // Emit event if blocked
            if (!allowed) {
                await this.eventBus.publish('ratelimit.exceeded', {
                    type: 'ratelimit.blocked',
                    source: 'rate-limiter',
                    data: {
                        resource,
                        userId,
                        current,
                        limit: rule.limit
                    },
                    metadata: {
                        timestamp: new Date(),
                        environment: process.env.NODE_ENV || 'development'
                    }
                });
            }

            return {
                allowed,
                remaining: Math.max(0, (rule.burstLimit || rule.limit) - current),
                resetTime,
                retryAfter: allowed ? undefined : Math.ceil(ttl)
            };

        } catch (error) {
            await this.handleError('rate_limit_error', error);
            // Fail open in case of errors
            return { allowed: true, remaining: -1, resetTime: new Date() };
        }
    }

    async addRule(rule: RateLimitRule): Promise<void> {
        try {
            // Validate rule
            this.validateRule(rule);

            // Store rule
            this.rules.set(rule.resource, rule);

            // Initialize metrics
            this.metrics.set(rule.id, {
                total: 0,
                allowed: 0,
                blocked: 0,
                resetTime: new Date()
            });

            await this.monitor.recordMetric({
                name: 'rate_limit_rule_added',
                value: 1,
                labels: {
                    resource: rule.resource,
                    limit: rule.limit.toString()
                }
            });

        } catch (error) {
            await this.handleError('rule_creation_error', error);
            throw error;
        }
    }

    async removeRule(resource: string): Promise<void> {
        const rule = this.rules.get(resource);
        if (rule) {
            this.rules.delete(resource);
            this.metrics.delete(rule.id);

            await this.monitor.recordMetric({
                name: 'rate_limit_rule_removed',
                value: 1,
                labels: { resource }
            });
        }
    }

    private async checkAndIncrement(
        key: string,
        rule: RateLimitRule
    ): Promise<[number, number]> {
        const now = Math.floor(Date.now() / 1000);
        const windowStart = now - (now % rule.window);

        const multi = this.redis.multi()
            .zadd(key, now, `${now}-${Math.random()}`)
            .zremrangebyscore(key, '-inf', windowStart)
            .zcard(key)
            .pexpire(key, rule.window * 1000)
            .exec();

        const result = await multi;
        const current = result[2][1] as number;
        const ttl = result[3][1] as number;

        return [current, Math.ceil(ttl / 1000)];
    }

    private buildKey(
        rule: RateLimitRule,
        userId?: string,
        metadata: Record<string, any> = {}
    ): string {
        const parts = ['ratelimit', rule.resource];

        if (rule.userScoped && userId) {
            parts.push(userId);
        }

        if (rule.grouping) {
            for (const group of rule.grouping) {
                if (metadata[group]) {
                    parts.push(`${group}:${metadata[group]}`);
                }
            }
        }

        return parts.join(':');
    }

    private validateRule(rule: RateLimitRule): void {
        if (!rule.id || !rule.resource || rule.limit <= 0 || rule.window <= 0) {
            throw new Error('Invalid rate limit rule configuration');
        }

        if (rule.burstLimit && rule.burstLimit < rule.limit) {
            throw new Error('Burst limit must be greater than or equal to base limit');
        }

        if (rule.overrides) {
            for (const override of rule.overrides) {
                if (override.limit <= 0) {
                    throw new Error('Override limit must be positive');
                }
            }
        }
    }

    private async updateMetrics(ruleId: string, allowed: boolean): Promise<void> {
        const metric = this.metrics.get(ruleId);
        if (metric) {
            metric.total++;
            if (allowed) {
                metric.allowed++;
            } else {
                metric.blocked++;
            }
        }
    }

    private async loadRules(): Promise<void> {
        // Implementation for loading rules from persistent storage
        // This would typically load from a database or configuration service
    }

    private startMetricsCollection(): void {
        setInterval(async () => {
            try {
                for (const [ruleId, metric] of this.metrics.entries()) {
                    const rule = Array.from(this.rules.values())
                        .find(r => r.id === ruleId);

                    if (rule) {
                        await this.monitor.recordMetric({
                            name: 'rate_limit_metrics',
                            value: metric.blocked,
                            labels: {
                                rule_id: ruleId,
                                resource: rule.resource,
                                total: metric.total.toString(),
                                allowed: metric.allowed.toString()
                            }
                        });
                    }

                    // Reset metrics
                    metric.total = 0;
                    metric.allowed = 0;
                    metric.blocked = 0;
                    metric.resetTime = new Date();
                }
            } catch (error) {
                await this.handleError('metrics_collection_error', error);
            }
        }, 60000); // Every minute
    }

    private async handleError(type: string, error: Error): Promise<void> {
        await this.monitor.recordMetric({
            name: type,
            value: 1,
            labels: { error: error.message }
        });
    }

    // Cleanup method for proper service shutdown
    async shutdown(): Promise<void> {
        await this.redis.quit();
    }
}

import { MonitoringService } from '../monitoring/monitoring-service';
import { PermissionsService } from '../security/permissions-service';
import { CacheService } from '../cache/cache-service';
import { AuditTrailService } from '../audit/audit-trail-service';

interface AuthorizationContext {
    userId: string;
    roles: string[];
    permissions: string[];
    attributes: Record<string, any>;
}

interface ResourcePolicy {
    resource: string;
    actions: string[];
    conditions: PolicyCondition[];
}

interface PolicyCondition {
    type: 'role' | 'permission' | 'attribute' | 'time' | 'location';
    value: any;
    operator: 'equals' | 'contains' | 'greaterThan' | 'lessThan' | 'between';
}

interface AuthorizationResult {
    authorized: boolean;
    reason?: string;
    expiresAt?: Date;
    metadata: {
        evaluatedAt: Date;
        policies: string[];
        context: Partial<AuthorizationContext>;
    };
}

export class AuthorizationService {
    private monitor: MonitoringService;
    private permissions: PermissionsService;
    private cache: CacheService;
    private audit: AuditTrailService;
    private policies: Map<string, ResourcePolicy>;

    constructor(
        monitor: MonitoringService,
        permissions: PermissionsService,
        cache: CacheService,
        audit: AuditTrailService
    ) {
        this.monitor = monitor;
        this.permissions = permissions;
        this.cache = cache;
        this.audit = audit;
        this.policies = new Map();

        this.initializePolicies();
    }

    async authorize(
        context: AuthorizationContext,
        resource: string,
        action: string
    ): Promise<AuthorizationResult> {
        const startTime = Date.now();
        try {
            // Check cache first
            const cacheKey = this.buildCacheKey(context.userId, resource, action);
            const cachedResult = await this.cache.get<AuthorizationResult>(cacheKey);
            if (cachedResult && cachedResult.expiresAt && cachedResult.expiresAt > new Date()) {
                return cachedResult;
            }

            // Get resource policy
            const policy = this.policies.get(resource);
            if (!policy) {
                throw new Error(`No policy found for resource: ${resource}`);
            }

            // Evaluate policy
            const result = await this.evaluatePolicy(policy, context, action);

            // Cache result
            if (result.authorized) {
                await this.cache.set(cacheKey, result, {
                    ttl: 300, // 5 minutes
                    encryption: true
                });
            }

            // Audit trail
            await this.audit.logEvent({
                eventType: 'security.alert',
                actor: {
                    id: context.userId,
                    type: 'user',
                    metadata: { roles: context.roles }
                },
                resource: {
                    type: 'authorization',
                    id: resource,
                    action: action
                },
                context: {
                    location: 'authorization-service',
                    ipAddress: 'internal',
                    userAgent: 'system'
                },
                status: result.authorized ? 'success' : 'failure',
                details: { 
                    authorized: result.authorized,
                    reason: result.reason
                }
            });

            // Record metrics
            await this.monitor.recordMetric({
                name: 'authorization_check',
                value: Date.now() - startTime,
                labels: {
                    resource,
                    action,
                    authorized: result.authorized.toString()
                }
            });

            return result;

        } catch (error) {
            await this.handleError('authorization_error', error);
            throw error;
        }
    }

    async addPolicy(resource: string, policy: ResourcePolicy): Promise<void> {
        try {
            // Validate policy
            await this.validatePolicy(policy);

            // Store policy
            this.policies.set(resource, policy);

            // Invalidate relevant cache entries
            await this.invalidatePolicyCache(resource);

            await this.audit.logEvent({
                eventType: 'security.alert',
                actor: {
                    id: 'system',
                    type: 'service',
                    metadata: {}
                },
                resource: {
                    type: 'policy',
                    id: resource,
                    action: 'create'
                },
                context: {
                    location: 'authorization-service',
                    ipAddress: 'internal',
                    userAgent: 'system'
                },
                status: 'success',
                details: { policy }
            });

        } catch (error) {
            await this.handleError('policy_creation_error', error);
            throw error;
        }
    }

    private async evaluatePolicy(
        policy: ResourcePolicy,
        context: AuthorizationContext,
        action: string
    ): Promise<AuthorizationResult> {
        // Check if action is allowed
        if (!policy.actions.includes(action)) {
            return this.createResult(false, 'Action not allowed by policy');
        }

        // Evaluate all conditions
        for (const condition of policy.conditions) {
            if (!await this.evaluateCondition(condition, context)) {
                return this.createResult(false, `Condition failed: ${condition.type}`);
            }
        }

        // Check permissions
        const hasPermission = await this.permissions.checkPermission(
            context.userId,
            policy.resource,
            action
        );

        if (!hasPermission) {
            return this.createResult(false, 'Insufficient permissions');
        }

        return this.createResult(true);
    }

    private async evaluateCondition(
        condition: PolicyCondition,
        context: AuthorizationContext
    ): Promise<boolean> {
        switch (condition.type) {
            case 'role':
                return this.evaluateRoleCondition(condition, context.roles);
            case 'permission':
                return this.evaluatePermissionCondition(condition, context.permissions);
            case 'attribute':
                return this.evaluateAttributeCondition(condition, context.attributes);
            case 'time':
                return this.evaluateTimeCondition(condition);
            case 'location':
                return this.evaluateLocationCondition(condition, context.attributes.location);
            default:
                throw new Error(`Unknown condition type: ${condition.type}`);
        }
    }

    private evaluateRoleCondition(
        condition: PolicyCondition,
        roles: string[]
    ): boolean {
        switch (condition.operator) {
            case 'equals':
                return roles.includes(condition.value);
            case 'contains':
                return condition.value.some((role: string) => roles.includes(role));
            default:
                return false;
        }
    }

    private evaluatePermissionCondition(
        condition: PolicyCondition,
        permissions: string[]
    ): boolean {
        return permissions.includes(condition.value);
    }

    private evaluateAttributeCondition(
        condition: PolicyCondition,
        attributes: Record<string, any>
    ): boolean {
        const value = attributes[condition.value.key];
        switch (condition.operator) {
            case 'equals':
                return value === condition.value.value;
            case 'contains':
                return Array.isArray(value) && value.includes(condition.value.value);
            default:
                return false;
        }
    }

    private evaluateTimeCondition(condition: PolicyCondition): boolean {
        const now = new Date();
        switch (condition.operator) {
            case 'between':
                return now >= new Date(condition.value.start) && 
                       now <= new Date(condition.value.end);
            default:
                return false;
        }
    }

    private evaluateLocationCondition(
        condition: PolicyCondition,
        location?: string
    ): boolean {
        if (!location) return false;
        return condition.value.includes(location);
    }

    private createResult(
        authorized: boolean,
        reason?: string
    ): AuthorizationResult {
        return {
            authorized,
            reason,
            expiresAt: new Date(Date.now() + 300000), // 5 minutes
            metadata: {
                evaluatedAt: new Date(),
                policies: Array.from(this.policies.keys()),
                context: {}
            }
        };
    }

    private async validatePolicy(policy: ResourcePolicy): Promise<void> {
        if (!policy.resource || !policy.actions.length) {
            throw new Error('Invalid policy configuration');
        }

        // Validate conditions
        for (const condition of policy.conditions) {
            if (!this.isValidCondition(condition)) {
                throw new Error(`Invalid condition configuration: ${condition.type}`);
            }
        }
    }

    private isValidCondition(condition: PolicyCondition): boolean {
        const validOperators = {
            role: ['equals', 'contains'],
            permission: ['equals'],
            attribute: ['equals', 'contains'],
            time: ['between'],
            location: ['equals', 'contains']
        };

        return validOperators[condition.type]?.includes(condition.operator) ?? false;
    }

    private buildCacheKey(userId: string, resource: string, action: string): string {
        return `auth:${userId}:${resource}:${action}`;
    }

    private async invalidatePolicyCache(resource: string): Promise<void> {
        // Implementation for cache invalidation
        // This would typically involve pattern matching and bulk deletion
    }

    private async initializePolicies(): Promise<void> {
        // Implementation for loading initial policies
        // This would typically involve loading from a configuration store
    }

    private async handleError(type: string, error: Error): Promise<void> {
        await this.monitor.recordMetric({
            name: type,
            value: 1,
            labels: { error: error.message }
        });
    }
}

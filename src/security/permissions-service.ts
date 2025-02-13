import { MonitoringService } from '../monitoring/monitoring-service';
import { AuditTrailService } from '../audit/audit-trail-service';
import { Firestore } from '@google-cloud/firestore';

interface Permission {
    id: string;
    name: string;
    description: string;
    scope: string;
    actions: string[];
    conditions?: Record<string, any>;
    metadata: {
        createdAt: Date;
        updatedAt: Date;
        createdBy: string;
    };
}

interface Role {
    id: string;
    name: string;
    description: string;
    permissions: string[];
    metadata: {
        createdAt: Date;
        updatedAt: Date;
        createdBy: string;
    };
}

interface AccessPolicy {
    id: string;
    name: string;
    description: string;
    roles: string[];
    subjects: string[];
    resources: string[];
    conditions?: Record<string, any>;
    effect: 'allow' | 'deny';
    priority: number;
    metadata: {
        createdAt: Date;
        updatedAt: Date;
        createdBy: string;
    };
}

export class PermissionsService {
    private monitor: MonitoringService;
    private auditService: AuditTrailService;
    private firestore: Firestore;
    private cache: Map<string, any>;
    private readonly CACHE_TTL = 300; // 5 minutes

    constructor(
        monitor: MonitoringService,
        auditService: AuditTrailService
    ) {
        this.monitor = monitor;
        this.auditService = auditService;
        this.firestore = new Firestore();
        this.cache = new Map();

        this.startCacheCleanup();
    }

    async checkPermission(
        userId: string,
        resource: string,
        action: string
    ): Promise<boolean> {
        try {
            const cacheKey = `perm:${userId}:${resource}:${action}`;
            const cachedResult = this.getFromCache(cacheKey);
            if (cachedResult !== undefined) {
                return cachedResult;
            }

            // Get user roles
            const userRoles = await this.getUserRoles(userId);
            
            // Get applicable policies
            const policies = await this.getApplicablePolicies(userRoles, resource);
            
            // Evaluate policies
            const result = await this.evaluatePolicies(policies, userId, resource, action);
            
            // Cache result
            this.setInCache(cacheKey, result);

            await this.monitor.recordMetric({
                name: 'permission_check',
                value: result ? 1 : 0,
                labels: {
                    user_id: userId,
                    resource,
                    action
                }
            });

            return result;
        } catch (error) {
            await this.handleError('permission_check_error', error);
            return false;
        }
    }

    async createRole(role: Omit<Role, 'id' | 'metadata'>): Promise<Role> {
        try {
            const newRole: Role = {
                ...role,
                id: `role-${Date.now()}`,
                metadata: {
                    createdAt: new Date(),
                    updatedAt: new Date(),
                    createdBy: 'system'
                }
            };

            await this.firestore
                .collection('roles')
                .doc(newRole.id)
                .create(newRole);

            await this.auditService.logEvent({
                eventType: 'security.alert',
                actor: {
                    id: 'system',
                    type: 'service',
                    metadata: {}
                },
                resource: {
                    type: 'role',
                    id: newRole.id,
                    action: 'create'
                },
                context: {
                    location: 'permissions-service',
                    ipAddress: 'internal',
                    userAgent: 'system'
                },
                status: 'success',
                details: { role: newRole }
            });

            return newRole;
        } catch (error) {
            await this.handleError('role_creation_error', error);
            throw error;
        }
    }

    async createPolicy(policy: Omit<AccessPolicy, 'id' | 'metadata'>): Promise<AccessPolicy> {
        try {
            const newPolicy: AccessPolicy = {
                ...policy,
                id: `policy-${Date.now()}`,
                metadata: {
                    createdAt: new Date(),
                    updatedAt: new Date(),
                    createdBy: 'system'
                }
            };

            await this.validatePolicy(newPolicy);
            await this.firestore
                .collection('policies')
                .doc(newPolicy.id)
                .create(newPolicy);

            await this.auditService.logEvent({
                eventType: 'security.alert',
                actor: {
                    id: 'system',
                    type: 'service',
                    metadata: {}
                },
                resource: {
                    type: 'policy',
                    id: newPolicy.id,
                    action: 'create'
                },
                context: {
                    location: 'permissions-service',
                    ipAddress: 'internal',
                    userAgent: 'system'
                },
                status: 'success',
                details: { policy: newPolicy }
            });

            // Invalidate relevant cache entries
            this.invalidatePolicyCache(newPolicy);

            return newPolicy;
        } catch (error) {
            await this.handleError('policy_creation_error', error);
            throw error;
        }
    }

    private async getUserRoles(userId: string): Promise<string[]> {
        const cacheKey = `roles:${userId}`;
        const cachedRoles = this.getFromCache(cacheKey);
        if (cachedRoles) {
            return cachedRoles;
        }

        const snapshot = await this.firestore
            .collection('user_roles')
            .where('userId', '==', userId)
            .get();

        const roles = snapshot.docs.map(doc => doc.data().roleId);
        this.setInCache(cacheKey, roles);
        return roles;
    }

    private async getApplicablePolicies(
        roles: string[],
        resource: string
    ): Promise<AccessPolicy[]> {
        const policies: AccessPolicy[] = [];
        
        for (const role of roles) {
            const snapshot = await this.firestore
                .collection('policies')
                .where('roles', 'array-contains', role)
                .where('resources', 'array-contains', resource)
                .orderBy('priority', 'desc')
                .get();

            policies.push(...snapshot.docs.map(doc => doc.data() as AccessPolicy));
        }

        return policies;
    }

    private async evaluatePolicies(
        policies: AccessPolicy[],
        userId: string,
        resource: string,
        action: string
    ): Promise<boolean> {
        for (const policy of policies) {
            if (await this.evaluatePolicy(policy, userId, resource, action)) {
                return policy.effect === 'allow';
            }
        }
        return false;
    }

    private async evaluatePolicy(
        policy: AccessPolicy,
        userId: string,
        resource: string,
        action: string
    ): Promise<boolean> {
        // Check basic conditions
        if (!policy.subjects.includes(userId) && !policy.subjects.includes('*')) {
            return false;
        }

        if (!policy.resources.includes(resource) && !policy.resources.includes('*')) {
            return false;
        }

        // Evaluate custom conditions if present
        if (policy.conditions) {
            return this.evaluateConditions(policy.conditions, {
                userId,
                resource,
                action,
                timestamp: new Date()
            });
        }

        return true;
    }

    private evaluateConditions(
        conditions: Record<string, any>,
        context: Record<string, any>
    ): boolean {
        // Implement condition evaluation logic
        return true;
    }

    private async validatePolicy(policy: AccessPolicy): Promise<void> {
        if (!policy.name || !policy.effect || policy.priority === undefined) {
            throw new Error('Invalid policy configuration');
        }
    }

    private getFromCache(key: string): any {
        const entry = this.cache.get(key);
        if (!entry) return undefined;

        if (entry.expiry < Date.now()) {
            this.cache.delete(key);
            return undefined;
        }

        return entry.value;
    }

    private setInCache(key: string, value: any): void {
        this.cache.set(key, {
            value,
            expiry: Date.now() + (this.CACHE_TTL * 1000)
        });
    }

    private invalidatePolicyCache(policy: AccessPolicy): void {
        // Implement cache invalidation logic
    }

    private startCacheCleanup(): void {
        setInterval(() => {
            const now = Date.now();
            for (const [key, entry] of this.cache.entries()) {
                if (entry.expiry < now) {
                    this.cache.delete(key);
                }
            }
        }, 60000); // Clean up every minute
    }

    private async handleError(type: string, error: Error): Promise<void> {
        await this.monitor.recordMetric({
            name: type,
            value: 1,
            labels: { error: error.message }
        });
    }
}

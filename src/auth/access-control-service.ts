import { MonitoringService } from '../monitoring/monitoring-service';
import { EventBusService } from '../events/event-bus-service';
import { AuditTrailService } from '../audit/audit-trail-service';
import { SecurityConfig } from '../config/security-config';
import { BigQuery } from '@google-cloud/bigquery';
import { SecretManager } from '@google-cloud/secret-manager';
import { v4 as uuidv4 } from 'uuid';

interface Role {
    id: string;
    name: string;
    description: string;
    permissions: Permission[];
    metadata: {
        created: Date;
        updated: Date;
        createdBy: string;
        system: boolean;
    };
}

interface Permission {
    id: string;
    name: string;
    resource: string;
    actions: string[];
    conditions?: {
        type: string;
        value: any;
    }[];
}

interface AccessPolicy {
    id: string;
    name: string;
    description: string;
    rules: AccessRule[];
    metadata: {
        created: Date;
        updated: Date;
        version: number;
        enabled: boolean;
    };
}

interface AccessRule {
    id: string;
    priority: number;
    effect: 'allow' | 'deny';
    principals: string[];
    resources: string[];
    actions: string[];
    conditions?: {
        type: 'ip' | 'time' | 'mfa' | 'custom';
        value: any;
    }[];
}

interface AccessRequest {
    principal: {
        id: string;
        type: 'user' | 'service';
        roles: string[];
    };
    resource: {
        type: string;
        id: string;
    };
    action: string;
    context: {
        ip?: string;
        timestamp: Date;
        attributes: Record<string, any>;
    };
}

interface AccessDecision {
    allowed: boolean;
    reason: string;
    policy?: string;
    rule?: string;
    metadata: {
        timestamp: Date;
        evaluationTime: number;
    };
}

export class AccessControlService {
    private monitor: MonitoringService;
    private eventBus: EventBusService;
    private audit: AuditTrailService;
    private security: SecurityConfig;
    private bigquery: BigQuery;
    private secretManager: SecretManager;
    private roles: Map<string, Role>;
    private policies: Map<string, AccessPolicy>;
    private cache: Map<string, { decision: AccessDecision; expires: Date }>;
    private readonly CACHE_TTL = 300000; // 5 minutes
    private readonly POLICY_REFRESH_INTERVAL = 60000; // 1 minute

    constructor(
        monitor: MonitoringService,
        eventBus: EventBusService,
        audit: AuditTrailService,
        security: SecurityConfig,
        config: {
            projectId: string;
        }
    ) {
        this.monitor = monitor;
        this.eventBus = eventBus;
        this.audit = audit;
        this.security = security;
        this.bigquery = new BigQuery({ projectId: config.projectId });
        this.secretManager = new SecretManager({ projectId: config.projectId });
        this.roles = new Map();
        this.policies = new Map();
        this.cache = new Map();

        this.initialize();
    }

    private async initialize(): Promise<void> {
        await this.setupInfrastructure();
        await this.loadRolesAndPolicies();
        this.startPolicyRefresh();
        this.setupEventListeners();
    }

    async checkAccess(request: AccessRequest): Promise<AccessDecision> {
        const startTime = Date.now();
        try {
            // Check cache first
            const cacheKey = this.generateCacheKey(request);
            const cached = this.checkCache(cacheKey);
            if (cached) return cached;

            // Evaluate policies
            const decision = await this.evaluateAccess(request);

            // Cache result
            this.cacheDecision(cacheKey, decision);

            // Record metrics
            await this.monitor.recordMetric({
                name: 'access_check',
                value: Date.now() - startTime,
                labels: {
                    allowed: decision.allowed.toString(),
                    resource_type: request.resource.type,
                    principal_type: request.principal.type
                }
            });

            // Audit log
            await this.audit.logEvent({
                eventType: 'access.check',
                actor: {
                    id: request.principal.id,
                    type: request.principal.type,
                    metadata: { roles: request.principal.roles }
                },
                resource: {
                    type: request.resource.type,
                    id: request.resource.id,
                    action: request.action
                },
                context: {
                    location: 'access-control',
                    ipAddress: request.context.ip || 'unknown',
                    userAgent: 'system'
                },
                status: decision.allowed ? 'success' : 'failure',
                details: {
                    reason: decision.reason,
                    policy: decision.policy,
                    rule: decision.rule
                }
            });

            return decision;

        } catch (error) {
            await this.handleError('access_check_error', error);
            throw error;
        }
    }

    async createRole(role: Omit<Role, 'id' | 'metadata'>): Promise<string> {
        try {
            // Generate ID
            const roleId = uuidv4();

            // Create role
            const newRole: Role = {
                ...role,
                id: roleId,
                metadata: {
                    created: new Date(),
                    updated: new Date(),
                    createdBy: 'system',
                    system: false
                }
            };

            // Validate permissions
            await this.validatePermissions(newRole.permissions);

            // Store role
            await this.storeRole(newRole);
            this.roles.set(roleId, newRole);

            // Audit log
            await this.audit.logEvent({
                eventType: 'role.create',
                actor: {
                    id: 'system',
                    type: 'service',
                    metadata: {}
                },
                resource: {
                    type: 'role',
                    id: roleId,
                    action: 'create'
                },
                context: {
                    location: 'access-control',
                    ipAddress: 'internal',
                    userAgent: 'system'
                },
                status: 'success',
                details: {
                    name: role.name,
                    permissions: role.permissions.length
                }
            });

            return roleId;

        } catch (error) {
            await this.handleError('role_creation_error', error);
            throw error;
        }
    }

    async createPolicy(policy: Omit<AccessPolicy, 'id' | 'metadata'>): Promise<string> {
        try {
            // Generate ID
            const policyId = uuidv4();

            // Create policy
            const newPolicy: AccessPolicy = {
                ...policy,
                id: policyId,
                metadata: {
                    created: new Date(),
                    updated: new Date(),
                    version: 1,
                    enabled: true
                }
            };

            // Validate rules
            await this.validatePolicyRules(newPolicy.rules);

            // Store policy
            await this.storePolicy(newPolicy);
            this.policies.set(policyId, newPolicy);

            // Clear cache
            this.clearCache();

            // Audit log
            await this.audit.logEvent({
                eventType: 'policy.create',
                actor: {
                    id: 'system',
                    type: 'service',
                    metadata: {}
                },
                resource: {
                    type: 'policy',
                    id: policyId,
                    action: 'create'
                },
                context: {
                    location: 'access-control',
                    ipAddress: 'internal',
                    userAgent: 'system'
                },
                status: 'success',
                details: {
                    name: policy.name,
                    rules: policy.rules.length
                }
            });

            return policyId;

        } catch (error) {
            await this.handleError('policy_creation_error', error);
            throw error;
        }
    }

    private async evaluateAccess(request: AccessRequest): Promise<AccessDecision> {
        // Get applicable policies
        const applicablePolicies = Array.from(this.policies.values())
            .filter(p => p.metadata.enabled)
            .sort((a, b) => {
                const aMaxPriority = Math.max(...a.rules.map(r => r.priority));
                const bMaxPriority = Math.max(...b.rules.map(r => r.priority));
                return bMaxPriority - aMaxPriority;
            });

        // Evaluate each policy
        for (const policy of applicablePolicies) {
            const decision = await this.evaluatePolicy(policy, request);
            if (decision) {
                return {
                    ...decision,
                    metadata: {
                        timestamp: new Date(),
                        evaluationTime: Date.now()
                    }
                };
            }
        }

        // Default deny if no policy matches
        return {
            allowed: false,
            reason: 'No matching policy found',
            metadata: {
                timestamp: new Date(),
                evaluationTime: Date.now()
            }
        };
    }

    private async evaluatePolicy(
        policy: AccessPolicy,
        request: AccessRequest
    ): Promise<Partial<AccessDecision> | null> {
        // Sort rules by priority
        const sortedRules = [...policy.rules].sort((a, b) => b.priority - a.priority);

        // Evaluate each rule
        for (const rule of sortedRules) {
            if (await this.matchesRule(rule, request)) {
                return {
                    allowed: rule.effect === 'allow',
                    reason: `${rule.effect} by rule ${rule.id}`,
                    policy: policy.id,
                    rule: rule.id
                };
            }
        }

        return null;
    }

    private async matchesRule(rule: AccessRule, request: AccessRequest): Promise<boolean> {
        // Check principals
        if (!this.matchesPrincipals(rule.principals, request.principal)) {
            return false;
        }

        // Check resources
        if (!this.matchesResources(rule.resources, request.resource)) {
            return false;
        }

        // Check actions
        if (!rule.actions.includes(request.action)) {
            return false;
        }

        // Check conditions
        if (rule.conditions) {
            for (const condition of rule.conditions) {
                if (!await this.evaluateCondition(condition, request.context)) {
                    return false;
                }
            }
        }

        return true;
    }

    private matchesPrincipals(rulePrincipals: string[], requestPrincipal: AccessRequest['principal']): boolean {
        return rulePrincipals.some(p => {
            // Check direct match
            if (p === requestPrincipal.id) return true;
            
            // Check role match
            if (p.startsWith('role:')) {
                const roleId = p.substring(5);
                return requestPrincipal.roles.includes(roleId);
            }

            // Check type match
            if (p.startsWith('type:')) {
                const type = p.substring(5);
                return requestPrincipal.type === type;
            }

            return false;
        });
    }

    private matchesResources(ruleResources: string[], requestResource: AccessRequest['resource']): boolean {
        return ruleResources.some(r => {
            // Check exact match
            if (r === `${requestResource.type}:${requestResource.id}`) return true;

            // Check type wildcard
            if (r === `${requestResource.type}:*`) return true;

            // Check global wildcard
            if (r === '*') return true;

            return false;
        });
    }

    private async evaluateCondition(
        condition: AccessRule['conditions'][0],
        context: AccessRequest['context']
    ): Promise<boolean> {
        switch (condition.type) {
            case 'ip':
                return this.evaluateIpCondition(condition.value, context.ip);
            case 'time':
                return this.evaluateTimeCondition(condition.value, context.timestamp);
            case 'mfa':
                return this.evaluateMfaCondition(condition.value, context.attributes);
            case 'custom':
                return this.evaluateCustomCondition(condition.value, context);
            default:
                return false;
        }
    }

    private evaluateIpCondition(allowed: string[], ip?: string): boolean {
        if (!ip) return false;
        return allowed.some(range => this.ipInRange(ip, range));
    }

    private evaluateTimeCondition(
        window: { start: string; end: string },
        timestamp: Date
    ): boolean {
        const time = timestamp.toTimeString().slice(0, 5);
        return time >= window.start && time <= window.end;
    }

    private evaluateMfaCondition(required: boolean, attributes: Record<string, any>): boolean {
        return required === !!attributes.mfaAuthenticated;
    }

    private evaluateCustomCondition(
        condition: any,
        context: AccessRequest['context']
    ): boolean {
        // Implement custom condition evaluation
        return true;
    }

    private ipInRange(ip: string, range: string): boolean {
        // Implement IP range checking
        return true;
    }

    private generateCacheKey(request: AccessRequest): string {
        return `${request.principal.id}:${request.resource.type}:${request.resource.id}:${request.action}`;
    }

    private checkCache(key: string): AccessDecision | null {
        const cached = this.cache.get(key);
        if (cached && cached.expires > new Date()) {
            return cached.decision;
        }
        return null;
    }

    private cacheDecision(key: string, decision: AccessDecision): void {
        this.cache.set(key, {
            decision,
            expires: new Date(Date.now() + this.CACHE_TTL)
        });
    }

    private clearCache(): void {
        this.cache.clear();
    }

    private async validatePermissions(permissions: Permission[]): Promise<void> {
        for (const permission of permissions) {
            if (!permission.resource || !permission.actions.length) {
                throw new Error(`Invalid permission configuration: ${permission.name}`);
            }
        }
    }

    private async validatePolicyRules(rules: AccessRule[]): Promise<void> {
        for (const rule of rules) {
            if (!rule.principals.length || !rule.resources.length || !rule.actions.length) {
                throw new Error(`Invalid rule configuration: ${rule.id}`);
            }
        }
    }

    private async setupInfrastructure(): Promise<void> {
        const dataset = this.bigquery.dataset('access_control');
        const [exists] = await dataset.exists();

        if (!exists) {
            await dataset.create();
            await this.createAccessControlTables(dataset);
        }
    }

    private async createAccessControlTables(dataset: any): Promise<void> {
        const tables = {
            roles: {
                fields: [
                    { name: 'id', type: 'STRING' },
                    { name: 'name', type: 'STRING' },
                    { name: 'description', type: 'STRING' },
                    { name: 'permissions', type: 'JSON' },
                    { name: 'metadata', type: 'JSON' }
                ]
            },
            policies: {
                fields: [
                    { name: 'id', type: 'STRING' },
                    { name: 'name', type: 'STRING' },
                    { name: 'description', type: 'STRING' },
                    { name: 'rules', type: 'JSON' },
                    { name: 'metadata', type: 'JSON' }
                ]
            }
        };

        for (const [name, schema] of Object.entries(tables)) {
            await dataset.createTable(name, { schema });
        }
    }

    private async loadRolesAndPolicies(): Promise<void> {
        // Load roles
        const [roleRows] = await this.bigquery.query(`
            SELECT *
            FROM \`access_control.roles\`
        `);

        for (const row of roleRows) {
            const role = this.deserializeRole(row);
            this.roles.set(role.id, role);
        }

        // Load policies
        const [policyRows] = await this.bigquery.query(`
            SELECT *
            FROM \`access_control.policies\`
            WHERE JSON_EXTRACT(metadata, '$.enabled') = true
        `);

        for (const row of policyRows) {
            const policy = this.deserializePolicy(row);
            this.policies.set(policy.id, policy);
        }
    }

    private startPolicyRefresh(): void {
        setInterval(async () => {
            try {
                await this.loadRolesAndPolicies();
            } catch (error) {
                await this.handleError('policy_refresh_error', error);
            }
        }, this.POLICY_REFRESH_INTERVAL);
    }

    private async storeRole(role: Role): Promise<void> {
        await this.bigquery
            .dataset('access_control')
            .table('roles')
            .insert([this.formatRoleForStorage(role)]);
    }

    private async storePolicy(policy: AccessPolicy): Promise<void> {
        await this.bigquery
            .dataset('access_control')
            .table('policies')
            .insert([this.formatPolicyForStorage(policy)]);
    }

    private formatRoleForStorage(role: Role): Record<string, any> {
        return {
            ...role,
            permissions: JSON.stringify(role.permissions),
            metadata: JSON.stringify(role.metadata)
        };
    }

    private formatPolicyForStorage(policy: AccessPolicy): Record<string, any> {
        return {
            ...policy,
            rules: JSON.stringify(policy.rules),
            metadata: JSON.stringify(policy.metadata)
        };
    }

    private deserializeRole(row: any): Role {
        return {
            ...row,
            permissions: JSON.parse(row.permissions),
            metadata: JSON.parse(row.metadata)
        };
    }

    private deserializePolicy(row: any): AccessPolicy {
        return {
            ...row,
            rules: JSON.parse(row.rules),
            metadata: JSON.parse(row.metadata)
        };
    }

    private setupEventListeners(): void {
        this.eventBus.subscribe({
            id: 'access-control-monitor',
            topic: 'security.alert',
            handler: async (event) => {
                if (event.data.type === 'policy_violation') {
                    await this.handlePolicyViolation(event.data);
                }
            }
        });
    }

    private async handlePolicyViolation(data: any): Promise<void> {
        // Clear cache
        this.clearCache();

        // Reload policies
        await this.loadRolesAndPolicies();
    }

    private async handleError(type: string, error: Error): Promise<void> {
        await this.monitor.recordMetric({
            name: type,
            value: 1,
            labels: { error: error.message }
        });

        await this.eventBus.publish('access.error', {
            type: 'access.error',
            source: 'access-control',
            data: {
                error: error.message,
                timestamp: new Date()
            },
            metadata: {
                severity: 'high',
                environment: process.env.NODE_ENV || 'development'
            }
        });
    }
}

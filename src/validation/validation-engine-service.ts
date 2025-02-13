import { MonitoringService } from '../monitoring/monitoring-service';
import { EventBusService } from '../events/event-bus-service';
import { AuditTrailService } from '../audit/audit-trail-service';
import { BigQuery } from '@google-cloud/bigquery';
import { Cache } from '@google-cloud/cache';
import { v4 as uuidv4 } from 'uuid';

interface ValidationRule {
    id: string;
    name: string;
    type: ValidationRuleType;
    target: {
        dataType: string;
        fields?: string[];
        context?: string[];
    };
    conditions: ValidationCondition[];
    metadata: {
        createdAt: Date;
        updatedAt: Date;
        version: number;
        enabled: boolean;
    };
    errorMessage: string;
    severity: 'error' | 'warning' | 'info';
}

interface ValidationCondition {
    type: 'pattern' | 'range' | 'enum' | 'dependency' | 'custom';
    operator: string;
    value: any;
    options?: Record<string, any>;
}

interface ValidationContext {
    ruleId: string;
    data: any;
    metadata: {
        type: string;
        source: string;
        timestamp: Date;
    };
    options?: {
        stopOnFailure?: boolean;
        ignoreWarnings?: boolean;
        context?: Record<string, any>;
    };
}

interface ValidationResult {
    id: string;
    valid: boolean;
    timestamp: Date;
    context: ValidationContext;
    issues: ValidationIssue[];
    metadata: {
        duration: number;
        rulesEvaluated: number;
        failedRules: number;
    };
}

interface ValidationIssue {
    ruleId: string;
    field: string;
    message: string;
    severity: ValidationRule['severity'];
    details?: Record<string, any>;
}

type ValidationRuleType = 
    | 'syntax'
    | 'semantic'
    | 'business'
    | 'security'
    | 'compliance'
    | 'custom';

export class ValidationEngineService {
    private monitor: MonitoringService;
    private eventBus: EventBusService;
    private audit: AuditTrailService;
    private bigquery: BigQuery;
    private cache: Cache;
    private rules: Map<string, ValidationRule>;
    private readonly CACHE_TTL = 3600; // 1 hour

    constructor(
        monitor: MonitoringService,
        eventBus: EventBusService,
        audit: AuditTrailService,
        config: {
            projectId: string;
        }
    ) {
        this.monitor = monitor;
        this.eventBus = eventBus;
        this.audit = audit;
        this.bigquery = new BigQuery({ projectId: config.projectId });
        this.cache = new Cache();
        this.rules = new Map();

        this.initialize();
    }

    private async initialize(): Promise<void> {
        await this.setupInfrastructure();
        await this.loadValidationRules();
        this.setupEventListeners();
    }

    async validate(context: ValidationContext): Promise<ValidationResult> {
        const startTime = Date.now();
        try {
            // Initialize result
            const result: ValidationResult = {
                id: uuidv4(),
                valid: true,
                timestamp: new Date(),
                context,
                issues: [],
                metadata: {
                    duration: 0,
                    rulesEvaluated: 0,
                    failedRules: 0
                }
            };

            // Get applicable rules
            const rules = this.getApplicableRules(context);

            // Evaluate rules
            for (const rule of rules) {
                result.metadata.rulesEvaluated++;
                
                const ruleValid = await this.evaluateRule(rule, context);
                if (!ruleValid.valid) {
                    result.valid = false;
                    result.metadata.failedRules++;
                    result.issues.push({
                        ruleId: rule.id,
                        field: ruleValid.field || '',
                        message: rule.errorMessage,
                        severity: rule.severity,
                        details: ruleValid.details
                    });

                    if (context.options?.stopOnFailure && rule.severity === 'error') {
                        break;
                    }
                }
            }

            // Update metadata
            result.metadata.duration = Date.now() - startTime;

            // Record metrics
            await this.monitor.recordMetric({
                name: 'validation_performed',
                value: result.metadata.duration,
                labels: {
                    valid: result.valid.toString(),
                    rules_evaluated: result.metadata.rulesEvaluated.toString(),
                    failed_rules: result.metadata.failedRules.toString()
                }
            });

            // Audit log
            await this.audit.logEvent({
                eventType: 'validation.execute',
                actor: {
                    id: 'system',
                    type: 'service',
                    metadata: {}
                },
                resource: {
                    type: 'validation',
                    id: result.id,
                    action: 'validate'
                },
                context: {
                    location: 'validation-engine',
                    ipAddress: 'internal',
                    userAgent: 'system'
                },
                status: result.valid ? 'success' : 'failure',
                details: {
                    data_type: context.metadata.type,
                    issues: result.issues.length,
                    duration: result.metadata.duration
                }
            });

            return result;

        } catch (error) {
            await this.handleError('validation_error', error);
            throw error;
        }
    }

    async addRule(rule: Omit<ValidationRule, 'id' | 'metadata'>): Promise<string> {
        try {
            // Validate rule configuration
            await this.validateRuleConfig(rule);

            // Create rule
            const ruleId = uuidv4();
            const newRule: ValidationRule = {
                ...rule,
                id: ruleId,
                metadata: {
                    createdAt: new Date(),
                    updatedAt: new Date(),
                    version: 1,
                    enabled: true
                }
            };

            // Store rule
            await this.storeRule(newRule);
            this.rules.set(ruleId, newRule);

            // Invalidate cache
            await this.invalidateRuleCache();

            await this.monitor.recordMetric({
                name: 'validation_rule_added',
                value: 1,
                labels: {
                    rule_id: ruleId,
                    type: rule.type
                }
            });

            return ruleId;

        } catch (error) {
            await this.handleError('rule_creation_error', error);
            throw error;
        }
    }

    async updateRule(
        ruleId: string,
        updates: Partial<ValidationRule>
    ): Promise<void> {
        try {
            const rule = this.rules.get(ruleId);
            if (!rule) {
                throw new Error(`Rule not found: ${ruleId}`);
            }

            // Apply updates
            const updatedRule: ValidationRule = {
                ...rule,
                ...updates,
                metadata: {
                    ...rule.metadata,
                    updatedAt: new Date(),
                    version: rule.metadata.version + 1
                }
            };

            // Validate updated rule
            await this.validateRuleConfig(updatedRule);

            // Store updated rule
            await this.storeRule(updatedRule);
            this.rules.set(ruleId, updatedRule);

            // Invalidate cache
            await this.invalidateRuleCache();

            await this.monitor.recordMetric({
                name: 'validation_rule_updated',
                value: 1,
                labels: {
                    rule_id: ruleId,
                    version: updatedRule.metadata.version.toString()
                }
            });

        } catch (error) {
            await this.handleError('rule_update_error', error);
            throw error;
        }
    }

    private async evaluateRule(
        rule: ValidationRule,
        context: ValidationContext
    ): Promise<{ valid: boolean; field?: string; details?: Record<string, any> }> {
        try {
            for (const condition of rule.conditions) {
                const result = await this.evaluateCondition(condition, context.data);
                if (!result.valid) {
                    return result;
                }
            }
            return { valid: true };

        } catch (error) {
            await this.handleError('rule_evaluation_error', error);
            return {
                valid: false,
                details: { error: error.message }
            };
        }
    }

    private async evaluateCondition(
        condition: ValidationCondition,
        data: any
    ): Promise<{ valid: boolean; field?: string; details?: Record<string, any> }> {
        switch (condition.type) {
            case 'pattern':
                return this.evaluatePattern(condition, data);
            case 'range':
                return this.evaluateRange(condition, data);
            case 'enum':
                return this.evaluateEnum(condition, data);
            case 'dependency':
                return this.evaluateDependency(condition, data);
            case 'custom':
                return this.evaluateCustom(condition, data);
            default:
                throw new Error(`Unknown condition type: ${condition.type}`);
        }
    }

    private evaluatePattern(
        condition: ValidationCondition,
        data: any
    ): { valid: boolean; field?: string } {
        const pattern = new RegExp(condition.value);
        return {
            valid: pattern.test(data),
            field: condition.options?.field
        };
    }

    private evaluateRange(
        condition: ValidationCondition,
        data: any
    ): { valid: boolean; field?: string } {
        const value = Number(data);
        const range = condition.value as { min: number; max: number };
        return {
            valid: value >= range.min && value <= range.max,
            field: condition.options?.field
        };
    }

    private evaluateEnum(
        condition: ValidationCondition,
        data: any
    ): { valid: boolean; field?: string } {
        return {
            valid: condition.value.includes(data),
            field: condition.options?.field
        };
    }

    private evaluateDependency(
        condition: ValidationCondition,
        data: any
    ): { valid: boolean; field?: string } {
        const { field, dependsOn, rule } = condition.value;
        const dependentValue = data[dependsOn];
        return {
            valid: rule(data[field], dependentValue),
            field
        };
    }

    private evaluateCustom(
        condition: ValidationCondition,
        data: any
    ): { valid: boolean; field?: string; details?: Record<string, any> } {
        return condition.value(data);
    }

    private getApplicableRules(context: ValidationContext): ValidationRule[] {
        return Array.from(this.rules.values()).filter(rule => 
            rule.metadata.enabled &&
            rule.target.dataType === context.metadata.type &&
            (!rule.target.context || 
             rule.target.context.includes(context.metadata.source))
        );
    }

    private async validateRuleConfig(rule: Partial<ValidationRule>): Promise<void> {
        if (!rule.name || !rule.type || !rule.target || !rule.conditions) {
            throw new Error('Invalid rule configuration');
        }

        // Validate conditions
        for (const condition of rule.conditions) {
            if (!this.isValidCondition(condition)) {
                throw new Error(`Invalid condition configuration: ${condition.type}`);
            }
        }
    }

    private isValidCondition(condition: ValidationCondition): boolean {
        const validOperators = {
            pattern: ['matches', 'notMatches'],
            range: ['between', 'notBetween'],
            enum: ['in', 'notIn'],
            dependency: ['requires', 'conflicts'],
            custom: ['evaluate']
        };

        return validOperators[condition.type]?.includes(condition.operator) ?? false;
    }

    private async storeRule(rule: ValidationRule): Promise<void> {
        await this.bigquery
            .dataset('validation')
            .table('rules')
            .insert([this.formatRuleForStorage(rule)]);
    }

    private formatRuleForStorage(rule: ValidationRule): Record<string, any> {
        return {
            ...rule,
            metadata: {
                ...rule.metadata,
                createdAt: rule.metadata.createdAt.toISOString(),
                updatedAt: rule.metadata.updatedAt.toISOString()
            },
            conditions: JSON.stringify(rule.conditions),
            target: JSON.stringify(rule.target)
        };
    }

    private async invalidateRuleCache(): Promise<void> {
        await this.cache.del('validation_rules');
    }

    private async loadValidationRules(): Promise<void> {
        // Try cache first
        const cached = await this.cache.get('validation_rules');
        if (cached) {
            this.rules = new Map(cached as [string, ValidationRule][]);
            return;
        }

        // Load from BigQuery
        const [rows] = await this.bigquery.query(`
            SELECT *
            FROM \`validation.rules\`
            WHERE metadata.enabled = true
        `);

        for (const row of rows) {
            const rule = this.deserializeRule(row);
            this.rules.set(rule.id, rule);
        }

        // Cache rules
        await this.cache.set('validation_rules', Array.from(this.rules.entries()), {
            ttl: this.CACHE_TTL
        });
    }

    private deserializeRule(row: any): ValidationRule {
        return {
            id: row.id,
            name: row.name,
            type: row.type,
            target: JSON.parse(row.target),
            conditions: JSON.parse(row.conditions),
            metadata: {
                createdAt: new Date(row.metadata.createdAt),
                updatedAt: new Date(row.metadata.updatedAt),
                version: row.metadata.version,
                enabled: row.metadata.enabled
            },
            errorMessage: row.errorMessage,
            severity: row.severity
        };
    }

    private async setupInfrastructure(): Promise<void> {
        const dataset = this.bigquery.dataset('validation');
        const [exists] = await dataset.exists();

        if (!exists) {
            await dataset.create();
            await this.createValidationTables(dataset);
        }
    }

    private async createValidationTables(dataset: any): Promise<void> {
        const schema = {
            fields: [
                { name: 'id', type: 'STRING' },
                { name: 'name', type: 'STRING' },
                { name: 'type', type: 'STRING' },
                { name: 'target', type: 'JSON' },
                { name: 'conditions', type: 'JSON' },
                { name: 'metadata', type: 'RECORD', fields: [
                    { name: 'createdAt', type: 'TIMESTAMP' },
                    { name: 'updatedAt', type: 'TIMESTAMP' },
                    { name: 'version', type: 'INTEGER' },
                    { name: 'enabled', type: 'BOOLEAN' }
                ]},
                { name: 'errorMessage', type: 'STRING' },
                { name: 'severity', type: 'STRING' }
            ]
        };

        await dataset.createTable('rules', { schema });
    }

    private setupEventListeners(): void {
        this.eventBus.subscribe({
            id: 'validation-monitor',
            topic: 'config.updated',
            handler: async (event) => {
                if (event.data.type === 'validation_rules') {
                    await this.loadValidationRules();
                }
            }
        });
    }

    private async handleError(type: string, error: Error): Promise<void> {
        await this.monitor.recordMetric({
            name: type,
            value: 1,
            labels: { error: error.message }
        });

        await this.eventBus.publish('validation.error', {
            type: 'validation.error',
            source: 'validation-engine',
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

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { MonitoringService } from '../monitoring/monitoring-service';
import { EventBusService } from '../events/event-bus-service';
import { AuditTrailService } from '../audit/audit-trail-service';
import { v4 as uuidv4 } from 'uuid';

interface RLSPolicy {
    id: string;
    name: string;
    table: string;
    operation: 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'ALL';
    definition: string;
    enabled: boolean;
    metadata: {
        created: Date;
        updated: Date;
        deploymentId?: string;
    };
}

interface PolicyBackup {
    id: string;
    policyId: string;
    definition: string;
    deploymentId: string;
    timestamp: Date;
}

export class RLSPolicyService {
    private supabase: SupabaseClient;
    private policies: Map<string, RLSPolicy>;
    private backups: Map<string, PolicyBackup[]>;

    constructor(
        private config: {
            supabaseUrl: string;
            supabaseKey: string;
        },
        private monitor: MonitoringService,
        private eventBus: EventBusService,
        private audit: AuditTrailService
    ) {
        this.supabase = createClient(config.supabaseUrl, config.supabaseKey);
        this.policies = new Map();
        this.backups = new Map();
        this.initialize();
    }

    private async initialize(): Promise<void> {
        await this.loadPolicies();
        this.setupEventListeners();
    }

    async deployPolicies(deploymentId: string, policies: Omit<RLSPolicy, 'id' | 'metadata'>[]): Promise<string[]> {
        const startTime = Date.now();
        const deployedPolicyIds: string[] = [];

        try {
            // Backup existing policies
            await this.backupExistingPolicies(deploymentId);

            // Deploy new policies
            for (const policy of policies) {
                const policyId = await this.deployPolicy(deploymentId, policy);
                deployedPolicyIds.push(policyId);
            }

            // Record metrics
            await this.monitor.recordMetric({
                name: 'rls_policies_deployed',
                value: policies.length,
                labels: {
                    deployment_id: deploymentId,
                    duration: (Date.now() - startTime).toString()
                }
            });

            // Audit log
            await this.audit.logEvent({
                eventType: 'rls.policies.deployed',
                actor: {
                    id: 'system',
                    type: 'service',
                    metadata: { deployment_id: deploymentId }
                },
                resource: {
                    type: 'rls_policies',
                    id: deploymentId,
                    action: 'deploy'
                },
                status: 'success',
                details: {
                    policy_count: policies.length,
                    policy_ids: deployedPolicyIds
                }
            });

            return deployedPolicyIds;

        } catch (error) {
            await this.handleError('policy_deployment_error', error, deploymentId);
            throw error;
        }
    }

    async rollbackPolicies(deploymentId: string): Promise<void> {
        const startTime = Date.now();
        
        try {
            const backups = Array.from(this.backups.values())
                .flat()
                .filter(b => b.deploymentId === deploymentId);

            for (const backup of backups) {
                await this.restorePolicy(backup);
            }

            // Record metrics
            await this.monitor.recordMetric({
                name: 'rls_policies_rollback',
                value: backups.length,
                labels: {
                    deployment_id: deploymentId,
                    duration: (Date.now() - startTime).toString()
                }
            });

        } catch (error) {
            await this.handleError('policy_rollback_error', error, deploymentId);
            throw error;
        }
    }

    private async deployPolicy(
        deploymentId: string,
        policy: Omit<RLSPolicy, 'id' | 'metadata'>
    ): Promise<string> {
        const policyId = uuidv4();
        
        try {
            // Create policy in database
            await this.supabase.rpc('create_rls_policy', {
                policy_name: policy.name,
                table_name: policy.table,
                policy_operation: policy.operation,
                policy_definition: policy.definition,
                policy_enabled: policy.enabled
            });

            const newPolicy: RLSPolicy = {
                ...policy,
                id: policyId,
                metadata: {
                    created: new Date(),
                    updated: new Date(),
                    deploymentId
                }
            };

            this.policies.set(policyId, newPolicy);

            return policyId;

        } catch (error) {
            throw new Error(`Failed to deploy policy ${policy.name}: ${error.message}`);
        }
    }

    private async backupExistingPolicies(deploymentId: string): Promise<void> {
        const { data: existingPolicies, error } = await this.supabase
            .from('rls_policies')
            .select('*');

        if (error) throw error;

        for (const policy of existingPolicies) {
            const backup: PolicyBackup = {
                id: uuidv4(),
                policyId: policy.id,
                definition: policy.definition,
                deploymentId,
                timestamp: new Date()
            };

            const policyBackups = this.backups.get(policy.id) || [];
            policyBackups.push(backup);
            this.backups.set(policy.id, policyBackups);

            // Store backup in database
            await this.supabase
                .from('rls_policy_backups')
                .insert([backup]);
        }
    }

    private async restorePolicy(backup: PolicyBackup): Promise<void> {
        try {
            await this.supabase.rpc('restore_rls_policy', {
                policy_id: backup.policyId,
                policy_definition: backup.definition
            });

            const policy = this.policies.get(backup.policyId);
            if (policy) {
                policy.definition = backup.definition;
                policy.metadata.updated = new Date();
                this.policies.set(backup.policyId, policy);
            }

        } catch (error) {
            throw new Error(`Failed to restore policy ${backup.policyId}: ${error.message}`);
        }
    }

    private async loadPolicies(): Promise<void> {
        const { data: policies, error } = await this.supabase
            .from('rls_policies')
            .select('*');

        if (error) throw error;

        for (const policy of policies) {
            this.policies.set(policy.id, {
                ...policy,
                metadata: {
                    created: new Date(policy.created_at),
                    updated: new Date(policy.updated_at),
                    deploymentId: policy.deployment_id
                }
            });
        }
    }

    private setupEventListeners(): void {
        this.eventBus.subscribe({
            id: 'rls-policy-monitor',
            topic: 'deployment.status',
            handler: async (event) => {
                if (event.data.status === 'rolling_back') {
                    await this.handleDeploymentRollback(event.data.deploymentId);
                }
            }
        });
    }

    private async handleDeploymentRollback(deploymentId: string): Promise<void> {
        try {
            await this.rollbackPolicies(deploymentId);
        } catch (error) {
            await this.handleError('rollback_handler_error', error, deploymentId);
        }
    }

    private async handleError(type: string, error: Error, deploymentId?: string): Promise<void> {
        await this.monitor.recordMetric({
            name: `rls_policy_${type}`,
            value: 1,
            labels: {
                error: error.message,
                deployment_id: deploymentId || 'unknown'
            }
        });

        await this.eventBus.publish('rls.policy.error', {
            type: 'rls.policy.error',
            source: 'rls-policy-service',
            data: {
                error: error.message,
                type,
                deploymentId,
                timestamp: new Date()
            }
        });
    }
}

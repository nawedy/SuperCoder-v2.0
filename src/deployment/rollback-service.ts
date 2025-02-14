import { MonitoringService } from '../monitoring/monitoring-service';
import { EventBusService } from '../events/event-bus-service';
import { AuditTrailService } from '../audit/audit-trail-service';
import { DeploymentStatus } from './deployment-pipeline-service';
import { createClient as createVercelClient } from '@vercel/client';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { CloudBuild } from '@google-cloud/storage';

export class RollbackService {
    private vercel: any;
    private supabase: any;
    private cloudBuild: CloudBuild;
    private readonly MAX_ROLLBACK_ATTEMPTS = 3;

    constructor(
        private config: any,
        private monitor: MonitoringService,
        private eventBus: EventBusService,
        private audit: AuditTrailService
    ) {
        this.vercel = createVercelClient({ token: config.vercel.token });
        this.supabase = createSupabaseClient(config.supabase.url, config.supabase.serviceKey);
        this.cloudBuild = new CloudBuild({ credentials: config.gcp.credentials });
    }

    async performRollback(deploymentId: string, status: DeploymentStatus): Promise<boolean> {
        const startTime = Date.now();
        let success = true;

        try {
            // Start rollback process
            await this.eventBus.publish('deployment.rollback.start', {
                type: 'rollback.start',
                source: 'rollback-service',
                data: { deploymentId, status }
            });

            // Perform rollbacks in reverse order
            const rollbackOperations = [];

            if (status.services.gcp?.status === 'completed') {
                rollbackOperations.push(this.rollbackGCP(deploymentId));
            }

            if (status.services.supabase?.status === 'completed') {
                rollbackOperations.push(this.rollbackSupabase(deploymentId));
            }

            if (status.services.vercel?.status === 'completed') {
                rollbackOperations.push(this.rollbackVercel(deploymentId));
            }

            // Execute rollbacks
            const results = await Promise.allSettled(rollbackOperations);
            success = results.every(r => r.status === 'fulfilled');

            // Record metrics
            await this.monitor.recordMetric({
                name: 'deployment_rollback',
                value: Date.now() - startTime,
                labels: {
                    deployment_id: deploymentId,
                    success: success.toString()
                }
            });

            // Audit log
            await this.audit.logEvent({
                eventType: 'deployment.rollback',
                actor: {
                    id: 'system',
                    type: 'service',
                    metadata: { deployment_id: deploymentId }
                },
                resource: {
                    type: 'deployment',
                    id: deploymentId,
                    action: 'rollback'
                },
                status: success ? 'success' : 'failure',
                details: {
                    duration: Date.now() - startTime,
                    services: Object.keys(status.services)
                }
            });

            return success;

        } catch (error) {
            await this.handleError('rollback_error', error, deploymentId);
            return false;
        }
    }

    private async rollbackVercel(deploymentId: string): Promise<void> {
        try {
            // Get deployment history
            const deployments = await this.vercel.listDeployments({
                meta: { deploymentId }
            });

            // Find previous stable deployment
            const previousDeployment = deployments.find(d => 
                d.state === 'READY' && d.meta.deploymentId !== deploymentId
            );

            if (!previousDeployment) {
                throw new Error('No previous stable deployment found');
            }

            // Perform rollback
            await this.vercel.createDeployment({
                name: previousDeployment.name,
                files: previousDeployment.files,
                target: previousDeployment.target,
                project: this.config.vercel.projectId,
                teamId: this.config.vercel.teamId,
                meta: {
                    rolledBackFrom: deploymentId
                }
            });

        } catch (error) {
            throw new Error(`Vercel rollback failed: ${error.message}`);
        }
    }

    private async rollbackSupabase(deploymentId: string): Promise<void> {
        try {
            // Get migration history
            const { data: migrations } = await this.supabase
                .from('migrations')
                .select('*')
                .eq('deployment_id', deploymentId);

            // Reverse migrations
            for (const migration of migrations.reverse()) {
                await this.supabase.migrations.down(migration.id);
            }

            // Restore RLS policies
            await this.restoreRLSPolicies(deploymentId);

            // Remove edge functions
            await this.removeEdgeFunctions(deploymentId);

        } catch (error) {
            throw new Error(`Supabase rollback failed: ${error.message}`);
        }
    }

    private async rollbackGCP(deploymentId: string): Promise<void> {
        try {
            // Get deployment history
            const [builds] = await this.cloudBuild.listBuilds({
                filter: `tags="deployment-${deploymentId}"`
            });

            if (!builds || builds.length === 0) {
                throw new Error('No GCP builds found for deployment');
            }

            // Create rollback build
            const rollbackBuild = await this.cloudBuild.createBuild({
                source: {
                    storageSource: {
                        bucket: 'rollback-artifacts',
                        object: `${deploymentId}-backup.zip`
                    }
                },
                steps: [
                    {
                        name: 'gcr.io/cloud-builders/gcloud',
                        args: [
                            'functions',
                            'deploy',
                            '--version-id',
                            builds[0].id
                        ]
                    }
                ],
                tags: [`rollback-${deploymentId}`]
            });

            // Wait for rollback completion
            await rollbackBuild.promise();

        } catch (error) {
            throw new Error(`GCP rollback failed: ${error.message}`);
        }
    }

    private async restoreRLSPolicies(deploymentId: string): Promise<void> {
        const { data: backups } = await this.supabase
            .from('rls_policy_backups')
            .select('*')
            .eq('deployment_id', deploymentId);

        for (const backup of backups) {
            await this.supabase.rpc('restore_rls_policy', {
                policy_id: backup.policy_id,
                policy_definition: backup.definition
            });
        }
    }

    private async removeEdgeFunctions(deploymentId: string): Promise<void> {
        const { data: functions } = await this.supabase
            .from('edge_functions')
            .select('*')
            .eq('deployment_id', deploymentId);

        for (const func of functions) {
            await this.supabase.functions.delete(func.name);
        }
    }

    private async handleError(type: string, error: Error, deploymentId: string): Promise<void> {
        await this.monitor.recordMetric({
            name: `rollback_${type}`,
            value: 1,
            labels: {
                deployment_id: deploymentId,
                error: error.message
            }
        });

        await this.eventBus.publish('deployment.rollback.error', {
            type: 'rollback.error',
            source: 'rollback-service',
            data: {
                error: error.message,
                deploymentId,
                timestamp: new Date()
            }
        });
    }
}

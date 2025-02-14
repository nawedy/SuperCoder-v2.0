import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { MonitoringService } from '../monitoring/monitoring-service';
import { EventBusService } from '../events/event-bus-service';
import { AuditTrailService } from '../audit/audit-trail-service';
import { Storage } from '@google-cloud/storage';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';

interface EdgeFunction {
    id: string;
    name: string;
    runtime: 'node18' | 'python3.9' | 'go1.x';
    source: {
        entrypoint: string;
        code: string;
        dependencies?: Record<string, string>;
    };
    config: {
        memory?: number;
        timeout?: number;
        env?: Record<string, string>;
    };
    metadata: {
        created: Date;
        updated: Date;
        deploymentId?: string;
        version?: string;
    };
}

interface FunctionVersion {
    id: string;
    functionId: string;
    version: string;
    source: EdgeFunction['source'];
    config: EdgeFunction['config'];
    timestamp: Date;
}

export class EdgeFunctionService {
    private supabase: SupabaseClient;
    private storage: Storage;
    private functions: Map<string, EdgeFunction>;
    private versions: Map<string, FunctionVersion[]>;

    constructor(
        private config: {
            supabaseUrl: string;
            supabaseKey: string;
            gcpProjectId: string;
            bucket: string;
        },
        private monitor: MonitoringService,
        private eventBus: EventBusService,
        private audit: AuditTrailService
    ) {
        this.supabase = createClient(config.supabaseUrl, config.supabaseKey);
        this.storage = new Storage({ projectId: config.gcpProjectId });
        this.functions = new Map();
        this.versions = new Map();
        this.initialize();
    }

    private async initialize(): Promise<void> {
        await this.loadFunctions();
        this.setupEventListeners();
    }

    async deployFunctions(
        deploymentId: string,
        functions: Omit<EdgeFunction, 'id' | 'metadata'>[]
    ): Promise<string[]> {
        const startTime = Date.now();
        const deployedFunctionIds: string[] = [];

        try {
            // Create new versions for existing functions
            await this.backupExistingFunctions(deploymentId);

            // Deploy new functions
            for (const func of functions) {
                const functionId = await this.deployFunction(deploymentId, func);
                deployedFunctionIds.push(functionId);
            }

            // Record metrics
            await this.monitor.recordMetric({
                name: 'edge_functions_deployed',
                value: functions.length,
                labels: {
                    deployment_id: deploymentId,
                    duration: (Date.now() - startTime).toString()
                }
            });

            // Audit log
            await this.audit.logEvent({
                eventType: 'edge.functions.deployed',
                actor: {
                    id: 'system',
                    type: 'service',
                    metadata: { deployment_id: deploymentId }
                },
                resource: {
                    type: 'edge_functions',
                    id: deploymentId,
                    action: 'deploy'
                },
                status: 'success',
                details: {
                    function_count: functions.length,
                    function_ids: deployedFunctionIds
                }
            });

            return deployedFunctionIds;

        } catch (error) {
            await this.handleError('function_deployment_error', error, deploymentId);
            throw error;
        }
    }

    async rollbackFunctions(deploymentId: string): Promise<void> {
        const startTime = Date.now();
        
        try {
            // Find all functions from this deployment
            const functionsToRollback = Array.from(this.functions.values())
                .filter(f => f.metadata.deploymentId === deploymentId);

            for (const func of functionsToRollback) {
                await this.rollbackFunction(func.id, deploymentId);
            }

            // Record metrics
            await this.monitor.recordMetric({
                name: 'edge_functions_rollback',
                value: functionsToRollback.length,
                labels: {
                    deployment_id: deploymentId,
                    duration: (Date.now() - startTime).toString()
                }
            });

        } catch (error) {
            await this.handleError('function_rollback_error', error, deploymentId);
            throw error;
        }
    }

    private async deployFunction(
        deploymentId: string,
        func: Omit<EdgeFunction, 'id' | 'metadata'>
    ): Promise<string> {
        const functionId = uuidv4();
        const version = `v${Date.now()}`;

        try {
            // Store function code in GCS
            const codePath = await this.storeFunctionCode(
                functionId,
                version,
                func.source.code
            );

            // Deploy to Supabase Edge Functions
            await this.supabase.functions.deploy(func.name, {
                entrypoint: func.source.entrypoint,
                source: codePath,
                verify: true,
                ...func.config
            });

            const newFunction: EdgeFunction = {
                ...func,
                id: functionId,
                metadata: {
                    created: new Date(),
                    updated: new Date(),
                    deploymentId,
                    version
                }
            };

            this.functions.set(functionId, newFunction);

            // Store version information
            const functionVersion: FunctionVersion = {
                id: uuidv4(),
                functionId,
                version,
                source: func.source,
                config: func.config,
                timestamp: new Date()
            };

            const versions = this.versions.get(functionId) || [];
            versions.push(functionVersion);
            this.versions.set(functionId, versions);

            return functionId;

        } catch (error) {
            throw new Error(`Failed to deploy function ${func.name}: ${error.message}`);
        }
    }

    private async storeFunctionCode(
        functionId: string,
        version: string,
        code: string
    ): Promise<string> {
        const filename = `${functionId}/${version}/index.js`;
        const bucket = this.storage.bucket(this.config.bucket);
        const file = bucket.file(filename);

        await file.save(code, {
            contentType: 'application/javascript'
        });

        return `gs://${this.config.bucket}/${filename}`;
    }

    private async rollbackFunction(
        functionId: string,
        deploymentId: string
    ): Promise<void> {
        const versions = this.versions.get(functionId) || [];
        const previousVersion = versions
            .filter(v => v.timestamp < new Date())
            .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())[0];

        if (!previousVersion) {
            throw new Error(`No previous version found for function ${functionId}`);
        }

        const func = this.functions.get(functionId);
        if (!func) {
            throw new Error(`Function ${functionId} not found`);
        }

        // Deploy previous version
        await this.supabase.functions.deploy(func.name, {
            entrypoint: previousVersion.source.entrypoint,
            source: await this.storeFunctionCode(
                functionId,
                previousVersion.version,
                previousVersion.source.code
            ),
            verify: true,
            ...previousVersion.config
        });

        // Update function metadata
        func.source = previousVersion.source;
        func.config = previousVersion.config;
        func.metadata.updated = new Date();
        func.metadata.version = previousVersion.version;

        this.functions.set(functionId, func);
    }

    private async backupExistingFunctions(deploymentId: string): Promise<void> {
        const { data: functions, error } = await this.supabase
            .from('edge_functions')
            .select('*');

        if (error) throw error;

        for (const func of functions) {
            const version: FunctionVersion = {
                id: uuidv4(),
                functionId: func.id,
                version: `backup_${deploymentId}`,
                source: func.source,
                config: func.config,
                timestamp: new Date()
            };

            const versions = this.versions.get(func.id) || [];
            versions.push(version);
            this.versions.set(func.id, versions);

            // Store backup in database
            await this.supabase
                .from('function_versions')
                .insert([version]);
        }
    }

    private async loadFunctions(): Promise<void> {
        const { data: functions, error } = await this.supabase
            .from('edge_functions')
            .select('*');

        if (error) throw error;

        for (const func of functions) {
            this.functions.set(func.id, {
                ...func,
                metadata: {
                    created: new Date(func.created_at),
                    updated: new Date(func.updated_at),
                    deploymentId: func.deployment_id,
                    version: func.version
                }
            });
        }
    }

    private setupEventListeners(): void {
        this.eventBus.subscribe({
            id: 'edge-function-monitor',
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
            await this.rollbackFunctions(deploymentId);
        } catch (error) {
            await this.handleError('rollback_handler_error', error, deploymentId);
        }
    }

    private async handleError(type: string, error: Error, deploymentId?: string): Promise<void> {
        await this.monitor.recordMetric({
            name: `edge_function_${type}`,
            value: 1,
            labels: {
                error: error.message,
                deployment_id: deploymentId || 'unknown'
            }
        });

        await this.eventBus.publish('edge.function.error', {
            type: 'edge.function.error',
            source: 'edge-function-service',
            data: {
                error: error.message,
                type,
                deploymentId,
                timestamp: new Date()
            }
        });
    }
}

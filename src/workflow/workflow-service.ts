import { MonitoringService } from '../monitoring/monitoring-service';
import { TaskQueueService } from '../queue/task-queue-service';
import { EventBusService } from '../events/event-bus-service';
import { AuditTrailService } from '../audit/audit-trail-service';
import { Redis } from 'ioredis';
import { v4 as uuidv4 } from 'uuid';

interface WorkflowStep {
    id: string;
    name: string;
    type: 'task' | 'condition' | 'parallel' | 'sequence';
    status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
    action: (context: WorkflowContext) => Promise<any>;
    dependencies?: string[];
    condition?: (context: WorkflowContext) => Promise<boolean>;
    retryConfig?: {
        maxAttempts: number;
        backoffMs: number;
    };
    timeout?: number;
    onFailure?: 'stop' | 'continue' | 'retry';
}

interface WorkflowDefinition {
    id: string;
    name: string;
    version: string;
    steps: WorkflowStep[];
    timeout?: number;
    parallelism?: number;
    errorHandling: {
        onFailure: 'stop' | 'continue' | 'rollback';
        maxRetries?: number;
    };
}

interface WorkflowContext {
    id: string;
    workflowId: string;
    status: 'running' | 'completed' | 'failed' | 'canceled';
    data: Map<string, any>;
    startTime: Date;
    endTime?: Date;
    currentStep?: string;
    errors: Error[];
    metadata: Record<string, any>;
}

interface WorkflowResult {
    id: string;
    status: WorkflowContext['status'];
    steps: {
        id: string;
        status: WorkflowStep['status'];
        duration: number;
        error?: string;
    }[];
    duration: number;
    output: any;
}

export class WorkflowService {
    private monitor: MonitoringService;
    private taskQueue: TaskQueueService;
    private eventBus: EventBusService;
    private audit: AuditTrailService;
    private redis: Redis;
    private workflows: Map<string, WorkflowDefinition>;
    private activeWorkflows: Map<string, WorkflowContext>;
    private readonly WORKFLOW_LOCK_TIMEOUT = 300; // 5 minutes

    constructor(
        monitor: MonitoringService,
        taskQueue: TaskQueueService,
        eventBus: EventBusService,
        audit: AuditTrailService,
        redisUrl: string
    ) {
        this.monitor = monitor;
        this.taskQueue = taskQueue;
        this.eventBus = eventBus;
        this.audit = audit;
        this.redis = new Redis(redisUrl);
        this.workflows = new Map();
        this.activeWorkflows = new Map();

        this.initialize();
    }

    private async initialize(): Promise<void> {
        await this.loadWorkflows();
        this.setupEventListeners();
    }

    async registerWorkflow(workflow: WorkflowDefinition): Promise<void> {
        try {
            // Validate workflow definition
            await this.validateWorkflow(workflow);

            // Store workflow
            this.workflows.set(workflow.id, workflow);

            // Audit log
            await this.audit.logEvent({
                eventType: 'system.config',
                actor: {
                    id: 'system',
                    type: 'service',
                    metadata: {}
                },
                resource: {
                    type: 'workflow',
                    id: workflow.id,
                    action: 'register'
                },
                context: {
                    location: 'workflow-service',
                    ipAddress: 'internal',
                    userAgent: 'system'
                },
                status: 'success',
                details: { workflow: workflow.name }
            });

        } catch (error) {
            await this.handleError('workflow_registration_error', error);
            throw error;
        }
    }

    async startWorkflow(
        workflowId: string,
        initialData: Record<string, any> = {},
        metadata: Record<string, any> = {}
    ): Promise<string> {
        try {
            const workflow = this.workflows.get(workflowId);
            if (!workflow) {
                throw new Error(`Workflow not found: ${workflowId}`);
            }

            // Create workflow context
            const context: WorkflowContext = {
                id: this.generateExecutionId(),
                workflowId,
                status: 'running',
                data: new Map(Object.entries(initialData)),
                startTime: new Date(),
                errors: [],
                metadata
            };

            // Store context
            this.activeWorkflows.set(context.id, context);
            await this.persistContext(context);

            // Start workflow execution
            this.executeWorkflow(workflow, context).catch(error => {
                this.handleWorkflowError(context, error);
            });

            await this.monitor.recordMetric({
                name: 'workflow_started',
                value: 1,
                labels: {
                    workflow_id: workflowId,
                    execution_id: context.id
                }
            });

            return context.id;

        } catch (error) {
            await this.handleError('workflow_start_error', error);
            throw error;
        }
    }

    async getStatus(executionId: string): Promise<WorkflowResult | null> {
        try {
            const context = this.activeWorkflows.get(executionId) ||
                await this.loadContext(executionId);

            if (!context) {
                return null;
            }

            const workflow = this.workflows.get(context.workflowId)!;
            return this.buildWorkflowResult(workflow, context);

        } catch (error) {
            await this.handleError('workflow_status_error', error);
            throw error;
        }
    }

    private async executeWorkflow(
        workflow: WorkflowDefinition,
        context: WorkflowContext
    ): Promise<void> {
        const executionTimeout = setTimeout(
            () => this.handleWorkflowTimeout(context),
            workflow.timeout || 3600000 // 1 hour default
        );

        try {
            // Execute steps based on dependencies
            const executed = new Set<string>();
            const pending = new Set(workflow.steps.map(s => s.id));

            while (pending.size > 0) {
                const executableSteps = Array.from(pending)
                    .filter(stepId => this.canExecuteStep(
                        workflow.steps.find(s => s.id === stepId)!,
                        executed
                    ));

                if (executableSteps.length === 0) {
                    break;
                }

                // Execute steps in parallel within limits
                const chunks = this.chunkArray(
                    executableSteps,
                    workflow.parallelism || 5
                );

                for (const chunk of chunks) {
                    await Promise.all(
                        chunk.map(stepId => this.executeStep(
                            workflow.steps.find(s => s.id === stepId)!,
                            context
                        ))
                    );
                }

                // Update sets
                executableSteps.forEach(stepId => {
                    pending.delete(stepId);
                    executed.add(stepId);
                });
            }

            // Complete workflow
            await this.completeWorkflow(context);

        } catch (error) {
            await this.handleWorkflowError(context, error);
        } finally {
            clearTimeout(executionTimeout);
        }
    }

    private async executeStep(
        step: WorkflowStep,
        context: WorkflowContext
    ): Promise<void> {
        const startTime = Date.now();
        context.currentStep = step.id;

        try {
            // Check condition if present
            if (step.condition && !await step.condition(context)) {
                step.status = 'skipped';
                return;
            }

            // Execute step with retries
            let attempts = 0;
            const maxAttempts = step.retryConfig?.maxAttempts || 1;

            while (attempts < maxAttempts) {
                try {
                    step.status = 'running';
                    await this.executeStepWithTimeout(step, context);
                    step.status = 'completed';
                    break;
                } catch (error) {
                    attempts++;
                    if (attempts === maxAttempts) {
                        throw error;
                    }
                    await new Promise(resolve => 
                        setTimeout(resolve, step.retryConfig?.backoffMs || 1000)
                    );
                }
            }

            await this.monitor.recordMetric({
                name: 'workflow_step_completed',
                value: Date.now() - startTime,
                labels: {
                    workflow_id: context.workflowId,
                    step_id: step.id,
                    status: step.status
                }
            });

        } catch (error) {
            step.status = 'failed';
            context.errors.push(error);

            await this.monitor.recordMetric({
                name: 'workflow_step_failed',
                value: 1,
                labels: {
                    workflow_id: context.workflowId,
                    step_id: step.id,
                    error: error.message
                }
            });

            if (step.onFailure === 'stop') {
                throw error;
            }
        }
    }

    private async executeStepWithTimeout(
        step: WorkflowStep,
        context: WorkflowContext
    ): Promise<void> {
        const timeout = step.timeout || 60000; // 1 minute default

        await Promise.race([
            step.action(context),
            new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Step timeout')), timeout)
            )
        ]);
    }

    private canExecuteStep(step: WorkflowStep, executed: Set<string>): boolean {
        if (!step.dependencies || step.dependencies.length === 0) {
            return true;
        }

        return step.dependencies.every(dep => executed.has(dep));
    }

    private async completeWorkflow(context: WorkflowContext): Promise<void> {
        context.status = context.errors.length > 0 ? 'failed' : 'completed';
        context.endTime = new Date();

        await this.persistContext(context);

        await this.eventBus.publish('workflow.completed', {
            type: 'workflow.execution.completed',
            source: 'workflow-service',
            data: {
                executionId: context.id,
                workflowId: context.workflowId,
                status: context.status,
                duration: context.endTime.getTime() - context.startTime.getTime()
            },
            metadata: {
                timestamp: new Date(),
                environment: process.env.NODE_ENV || 'development'
            }
        });
    }

    private async handleWorkflowError(
        context: WorkflowContext,
        error: Error
    ): Promise<void> {
        context.status = 'failed';
        context.endTime = new Date();
        context.errors.push(error);

        await this.persistContext(context);

        await this.eventBus.publish('workflow.failed', {
            type: 'workflow.execution.failed',
            source: 'workflow-service',
            data: {
                executionId: context.id,
                workflowId: context.workflowId,
                error: error.message
            },
            metadata: {
                severity: 'high',
                timestamp: new Date(),
                environment: process.env.NODE_ENV || 'development'
            }
        });
    }

    private async handleWorkflowTimeout(context: WorkflowContext): Promise<void> {
        await this.handleWorkflowError(
            context,
            new Error('Workflow execution timeout')
        );
    }

    private async validateWorkflow(workflow: WorkflowDefinition): Promise<void> {
        if (!workflow.id || !workflow.name || !workflow.steps.length) {
            throw new Error('Invalid workflow definition');
        }

        // Validate step dependencies
        const stepIds = new Set(workflow.steps.map(s => s.id));
        for (const step of workflow.steps) {
            if (step.dependencies) {
                for (const dep of step.dependencies) {
                    if (!stepIds.has(dep)) {
                        throw new Error(`Invalid dependency: ${dep}`);
                    }
                }
            }
        }

        // Check for cycles
        if (this.hasCycles(workflow.steps)) {
            throw new Error('Workflow contains cyclic dependencies');
        }
    }

    private hasCycles(steps: WorkflowStep[]): boolean {
        const visited = new Set<string>();
        const recursionStack = new Set<string>();

        const hasCycle = (stepId: string): boolean => {
            if (recursionStack.has(stepId)) {
                return true;
            }

            if (visited.has(stepId)) {
                return false;
            }

            visited.add(stepId);
            recursionStack.add(stepId);

            const step = steps.find(s => s.id === stepId);
            if (step?.dependencies) {
                for (const dep of step.dependencies) {
                    if (hasCycle(dep)) {
                        return true;
                    }
                }
            }

            recursionStack.delete(stepId);
            return false;
        };

        return steps.some(step => hasCycle(step.id));
    }

    private buildWorkflowResult(
        workflow: WorkflowDefinition,
        context: WorkflowContext
    ): WorkflowResult {
        return {
            id: context.id,
            status: context.status,
            steps: workflow.steps.map(step => ({
                id: step.id,
                status: step.status,
                duration: 0, // Calculate actual duration
                error: context.errors
                    .find(e => context.currentStep === step.id)
                    ?.message
            })),
            duration: context.endTime ? 
                context.endTime.getTime() - context.startTime.getTime() : 
                Date.now() - context.startTime.getTime(),
            output: Object.fromEntries(context.data)
        };
    }

    private async persistContext(context: WorkflowContext): Promise<void> {
        const key = `workflow:${context.id}`;
        await this.redis.set(
            key,
            JSON.stringify({
                ...context,
                data: Object.fromEntries(context.data)
            })
        );
    }

    private async loadContext(executionId: string): Promise<WorkflowContext | null> {
        const key = `workflow:${executionId}`;
        const data = await this.redis.get(key);
        if (!data) return null;

        const context = JSON.parse(data);
        context.data = new Map(Object.entries(context.data));
        return context;
    }

    private setupEventListeners(): void {
        this.eventBus.subscribe({
            id: 'workflow-monitor',
            topic: 'workflow.failed',
            handler: async (event) => {
                await this.monitor.recordMetric({
                    name: 'workflow_failure',
                    value: 1,
                    labels: {
                        workflow_id: event.data.workflowId,
                        error: event.data.error
                    }
                });
            }
        });
    }

    private chunkArray<T>(array: T[], size: number): T[][] {
        const chunks: T[][] = [];
        for (let i = 0; i < array.length; i += size) {
            chunks.push(array.slice(i, i + size));
        }
        return chunks;
    }

    private generateExecutionId(): string {
        return `wf-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }

    private async handleError(type: string, error: Error): Promise<void> {
        await this.monitor.recordMetric({
            name: type,
            value: 1,
            labels: { error: error.message }
        });
    }
}

import { MonitoringService } from '../monitoring/monitoring-service';
import { AuditTrailService } from '../audit/audit-trail-service';
import { EventBusService } from '../events/event-bus-service';
import { Redis } from 'ioredis';
import { v4 as uuidv4 } from 'uuid';

interface Task {
    id: string;
    type: string;
    priority: 'high' | 'medium' | 'low';
    data: any;
    status: 'pending' | 'processing' | 'completed' | 'failed' | 'retrying';
    attempts: number;
    maxAttempts: number;
    timing: {
        created: Date;
        started?: Date;
        completed?: Date;
        nextRetry?: Date;
    };
    result?: any;
    error?: {
        message: string;
        stack?: string;
        code?: string;
    };
}

interface TaskHandler {
    type: string;
    handler: (data: any) => Promise<any>;
    options: {
        maxAttempts: number;
        timeout: number;
        backoff: {
            type: 'fixed' | 'exponential';
            delay: number;
        };
    };
}

interface QueueStats {
    processed: number;
    failed: number;
    retried: number;
    pending: number;
    averageProcessingTime: number;
}

export class TaskQueueService {
    private monitor: MonitoringService;
    private audit: AuditTrailService;
    private eventBus: EventBusService;
    private redis: Redis;
    private handlers: Map<string, TaskHandler>;
    private stats: Map<string, QueueStats>;
    private isProcessing: boolean;
    private processingInterval: NodeJS.Timeout | null;
    private readonly PROCESSING_INTERVAL = 1000; // 1 second
    private readonly STATS_UPDATE_INTERVAL = 60000; // 1 minute

    constructor(
        monitor: MonitoringService,
        audit: AuditTrailService,
        eventBus: EventBusService,
        redisUrl: string
    ) {
        this.monitor = monitor;
        this.audit = audit;
        this.eventBus = eventBus;
        this.redis = new Redis(redisUrl);
        this.handlers = new Map();
        this.stats = new Map();
        this.isProcessing = false;
        this.processingInterval = null;

        this.initialize();
    }

    private async initialize(): Promise<void> {
        await this.startProcessing();
        this.startStatsCollection();
    }

    async registerHandler(handler: TaskHandler): Promise<void> {
        try {
            if (this.handlers.has(handler.type)) {
                throw new Error(`Handler already registered for type: ${handler.type}`);
            }

            this.handlers.set(handler.type, handler);
            this.stats.set(handler.type, {
                processed: 0,
                failed: 0,
                retried: 0,
                pending: 0,
                averageProcessingTime: 0
            });

            await this.audit.logEvent({
                eventType: 'system.config',
                actor: {
                    id: 'system',
                    type: 'service',
                    metadata: {}
                },
                resource: {
                    type: 'task-handler',
                    id: handler.type,
                    action: 'register'
                },
                context: {
                    location: 'task-queue',
                    ipAddress: 'internal',
                    userAgent: 'system'
                },
                status: 'success',
                details: { handler: { type: handler.type, options: handler.options } }
            });

        } catch (error) {
            await this.handleError('handler_registration_error', error);
            throw error;
        }
    }

    async enqueueTask(
        type: string,
        data: any,
        options: {
            priority?: Task['priority'];
            maxAttempts?: number;
        } = {}
    ): Promise<string> {
        try {
            const handler = this.handlers.get(type);
            if (!handler) {
                throw new Error(`No handler registered for task type: ${type}`);
            }

            const task: Task = {
                id: uuidv4(),
                type,
                priority: options.priority || 'medium',
                data,
                status: 'pending',
                attempts: 0,
                maxAttempts: options.maxAttempts || handler.options.maxAttempts,
                timing: {
                    created: new Date()
                }
            };

            // Store task in Redis
            await this.storeTask(task);

            // Update stats
            const stats = this.stats.get(type)!;
            stats.pending++;

            // Record metric
            await this.monitor.recordMetric({
                name: 'task_enqueued',
                value: 1,
                labels: {
                    type,
                    priority: task.priority
                }
            });

            return task.id;

        } catch (error) {
            await this.handleError('task_enqueue_error', error);
            throw error;
        }
    }

    async getTaskStatus(taskId: string): Promise<Task | null> {
        try {
            const task = await this.getTask(taskId);
            if (!task) {
                return null;
            }

            return task;

        } catch (error) {
            await this.handleError('task_status_error', error);
            throw error;
        }
    }

    private async startProcessing(): Promise<void> {
        if (this.isProcessing) return;

        this.isProcessing = true;
        this.processingInterval = setInterval(
            async () => {
                try {
                    await this.processNextTask();
                } catch (error) {
                    await this.handleError('task_processing_error', error);
                }
            },
            this.PROCESSING_INTERVAL
        );
    }

    private async processNextTask(): Promise<void> {
        // Get next task based on priority
        const task = await this.getNextTask();
        if (!task) return;

        const handler = this.handlers.get(task.type);
        if (!handler) {
            await this.failTask(task, new Error('Handler not found'));
            return;
        }

        try {
            // Update task status
            task.status = 'processing';
            task.timing.started = new Date();
            await this.updateTask(task);

            // Execute task with timeout
            const result = await Promise.race([
                handler.handler(task.data),
                new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Task timeout')), handler.options.timeout)
                )
            ]);

            // Update task with success
            await this.completeTask(task, result);

            // Update stats
            const stats = this.stats.get(task.type)!;
            stats.processed++;
            stats.pending--;
            stats.averageProcessingTime = this.calculateAverageProcessingTime(
                stats.averageProcessingTime,
                stats.processed,
                Date.now() - task.timing.started.getTime()
            );

        } catch (error) {
            // Handle task failure
            await this.handleTaskFailure(task, error, handler);
        }
    }

    private async handleTaskFailure(
        task: Task,
        error: Error,
        handler: TaskHandler
    ): Promise<void> {
        task.attempts++;
        const stats = this.stats.get(task.type)!;

        if (task.attempts >= task.maxAttempts) {
            await this.failTask(task, error);
            stats.failed++;
            stats.pending--;

            // Emit failure event
            await this.eventBus.publish('task.failed', {
                type: 'task.execution.failed',
                source: 'task-queue',
                data: {
                    taskId: task.id,
                    type: task.type,
                    error: error.message,
                    attempts: task.attempts
                },
                metadata: {
                    severity: 'high',
                    environment: process.env.NODE_ENV || 'development'
                }
            });

        } else {
            // Calculate next retry time
            const delay = this.calculateBackoff(
                handler.options.backoff,
                task.attempts
            );

            task.status = 'retrying';
            task.timing.nextRetry = new Date(Date.now() + delay);
            await this.updateTask(task);

            stats.retried++;
        }
    }

    private calculateBackoff(
        backoff: TaskHandler['options']['backoff'],
        attempts: number
    ): number {
        if (backoff.type === 'fixed') {
            return backoff.delay;
        }

        // Exponential backoff with jitter
        const delay = backoff.delay * Math.pow(2, attempts - 1);
        const jitter = delay * 0.1 * Math.random();
        return delay + jitter;
    }

    private async storeTask(task: Task): Promise<void> {
        const key = `task:${task.id}`;
        await this.redis.set(key, JSON.stringify(task));
        await this.redis.zadd(
            `tasks:${task.type}:${task.status}`,
            this.getPriorityScore(task.priority),
            task.id
        );
    }

    private async updateTask(task: Task): Promise<void> {
        const key = `task:${task.id}`;
        await this.redis.set(key, JSON.stringify(task));
        
        // Update index
        await this.redis.zrem(`tasks:${task.type}:${task.status}`, task.id);
        await this.redis.zadd(
            `tasks:${task.type}:${task.status}`,
            this.getPriorityScore(task.priority),
            task.id
        );
    }

    private async getTask(taskId: string): Promise<Task | null> {
        const key = `task:${taskId}`;
        const data = await this.redis.get(key);
        return data ? JSON.parse(data) : null;
    }

    private async getNextTask(): Promise<Task | null> {
        // Try high priority tasks first
        for (const priority of ['high', 'medium', 'low']) {
            for (const type of this.handlers.keys()) {
                const taskId = await this.redis.zrange(
                    `tasks:${type}:pending`,
                    0,
                    0
                );

                if (taskId.length) {
                    const task = await this.getTask(taskId[0]);
                    if (task && task.priority === priority) {
                        return task;
                    }
                }
            }
        }

        return null;
    }

    private async completeTask(task: Task, result: any): Promise<void> {
        task.status = 'completed';
        task.timing.completed = new Date();
        task.result = result;
        await this.updateTask(task);

        // Record success metric
        await this.monitor.recordMetric({
            name: 'task_completed',
            value: task.timing.completed.getTime() - task.timing.started!.getTime(),
            labels: {
                type: task.type,
                status: 'success'
            }
        });
    }

    private async failTask(task: Task, error: Error): Promise<void> {
        task.status = 'failed';
        task.timing.completed = new Date();
        task.error = {
            message: error.message,
            stack: error.stack,
            code: (error as any).code
        };
        await this.updateTask(task);

        // Record failure metric
        await this.monitor.recordMetric({
            name: 'task_failed',
            value: 1,
            labels: {
                type: task.type,
                error: error.message
            }
        });
    }

    private getPriorityScore(priority: Task['priority']): number {
        switch (priority) {
            case 'high': return 3;
            case 'medium': return 2;
            case 'low': return 1;
            default: return 0;
        }
    }

    private calculateAverageProcessingTime(
        currentAvg: number,
        totalProcessed: number,
        newTime: number
    ): number {
        return (currentAvg * (totalProcessed - 1) + newTime) / totalProcessed;
    }

    private startStatsCollection(): void {
        setInterval(async () => {
            try {
                for (const [type, stats] of this.stats.entries()) {
                    await this.monitor.recordMetric({
                        name: 'queue_stats',
                        value: stats.pending,
                        labels: {
                            type,
                            processed: stats.processed.toString(),
                            failed: stats.failed.toString(),
                            retried: stats.retried.toString(),
                            avg_time: stats.averageProcessingTime.toString()
                        }
                    });
                }
            } catch (error) {
                await this.handleError('stats_collection_error', error);
            }
        }, this.STATS_UPDATE_INTERVAL);
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
        this.isProcessing = false;
        if (this.processingInterval) {
            clearInterval(this.processingInterval);
        }

        // Wait for active tasks to complete
        await new Promise(resolve => setTimeout(resolve, 5000));

        // Close Redis connection
        await this.redis.quit();
    }
}

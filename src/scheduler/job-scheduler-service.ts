import { MonitoringService } from '../monitoring/monitoring-service';
import { TaskQueueService } from '../queue/task-queue-service';
import { EventBusService } from '../events/event-bus-service';
import { AuditTrailService } from '../audit/audit-trail-service';
import { Redis } from 'ioredis';
import { parse as cronParse } from 'cron-parser';
import { v4 as uuidv4 } from 'uuid';

interface ScheduledJob {
    id: string;
    name: string;
    type: 'cron' | 'interval' | 'datetime';
    schedule: string; // cron expression or ISO date string
    taskType: string;
    taskData: any;
    options: {
        timeout?: number;
        retries?: number;
        priority?: 'high' | 'medium' | 'low';
        timezone?: string;
    };
    status: 'active' | 'paused' | 'completed' | 'failed';
    lastRun?: {
        timestamp: Date;
        status: 'success' | 'failure';
        error?: string;
        duration: number;
    };
    nextRun?: Date;
    metadata: {
        createdAt: Date;
        createdBy: string;
        tags: string[];
    };
}

interface JobExecutionResult {
    jobId: string;
    taskId: string;
    status: 'success' | 'failure';
    startTime: Date;
    endTime: Date;
    error?: Error;
}

export class JobSchedulerService {
    private monitor: MonitoringService;
    private taskQueue: TaskQueueService;
    private eventBus: EventBusService;
    private audit: AuditTrailService;
    private redis: Redis;
    private jobs: Map<string, ScheduledJob>;
    private timers: Map<string, NodeJS.Timeout>;
    private readonly CHECK_INTERVAL = 60000; // 1 minute
    private readonly MAX_CONCURRENT_JOBS = 100;

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
        this.jobs = new Map();
        this.timers = new Map();

        this.initialize();
    }

    private async initialize(): Promise<void> {
        await this.loadJobs();
        this.startScheduler();
        this.setupEventListeners();
    }

    async scheduleJob(
        name: string,
        schedule: string,
        taskType: string,
        taskData: any,
        options: ScheduledJob['options'] = {}
    ): Promise<string> {
        try {
            // Validate schedule
            await this.validateSchedule(schedule);

            // Create job
            const job: ScheduledJob = {
                id: uuidv4(),
                name,
                type: this.determineScheduleType(schedule),
                schedule,
                taskType,
                taskData,
                options: {
                    timeout: options.timeout || 300000, // 5 minutes default
                    retries: options.retries || 3,
                    priority: options.priority || 'medium',
                    timezone: options.timezone || 'UTC'
                },
                status: 'active',
                metadata: {
                    createdAt: new Date(),
                    createdBy: 'system',
                    tags: []
                },
                nextRun: this.calculateNextRun(schedule, options.timezone)
            };

            // Store job
            await this.storeJob(job);
            this.jobs.set(job.id, job);

            // Schedule immediate check
            this.scheduleNextRun(job);

            await this.audit.logEvent({
                eventType: 'system.config',
                actor: {
                    id: 'system',
                    type: 'service',
                    metadata: {}
                },
                resource: {
                    type: 'scheduled-job',
                    id: job.id,
                    action: 'create'
                },
                context: {
                    location: 'job-scheduler',
                    ipAddress: 'internal',
                    userAgent: 'system'
                },
                status: 'success',
                details: { job: { name, schedule, taskType } }
            });

            return job.id;

        } catch (error) {
            await this.handleError('job_scheduling_error', error);
            throw error;
        }
    }

    async updateJob(
        jobId: string,
        updates: Partial<Pick<ScheduledJob, 'schedule' | 'taskData' | 'options' | 'status'>>
    ): Promise<void> {
        try {
            const job = this.jobs.get(jobId);
            if (!job) {
                throw new Error(`Job not found: ${jobId}`);
            }

            // Validate updates
            if (updates.schedule) {
                await this.validateSchedule(updates.schedule);
            }

            // Update job
            Object.assign(job, updates);
            job.nextRun = this.calculateNextRun(
                updates.schedule || job.schedule,
                updates.options?.timezone || job.options.timezone
            );

            // Store updated job
            await this.storeJob(job);

            // Reschedule if needed
            this.cancelScheduledRun(jobId);
            if (job.status === 'active') {
                this.scheduleNextRun(job);
            }

            await this.audit.logEvent({
                eventType: 'system.config',
                actor: {
                    id: 'system',
                    type: 'service',
                    metadata: {}
                },
                resource: {
                    type: 'scheduled-job',
                    id: jobId,
                    action: 'update'
                },
                context: {
                    location: 'job-scheduler',
                    ipAddress: 'internal',
                    userAgent: 'system'
                },
                status: 'success',
                details: { updates }
            });

        } catch (error) {
            await this.handleError('job_update_error', error);
            throw error;
        }
    }

    async deleteJob(jobId: string): Promise<void> {
        try {
            const job = this.jobs.get(jobId);
            if (!job) {
                throw new Error(`Job not found: ${jobId}`);
            }

            // Cancel scheduled execution
            this.cancelScheduledRun(jobId);

            // Remove job
            this.jobs.delete(jobId);
            await this.removeJob(jobId);

            await this.audit.logEvent({
                eventType: 'system.config',
                actor: {
                    id: 'system',
                    type: 'service',
                    metadata: {}
                },
                resource: {
                    type: 'scheduled-job',
                    id: jobId,
                    action: 'delete'
                },
                context: {
                    location: 'job-scheduler',
                    ipAddress: 'internal',
                    userAgent: 'system'
                },
                status: 'success',
                details: { job_name: job.name }
            });

        } catch (error) {
            await this.handleError('job_deletion_error', error);
            throw error;
        }
    }

    async getJobStatus(jobId: string): Promise<ScheduledJob | null> {
        try {
            return this.jobs.get(jobId) || null;
        } catch (error) {
            await this.handleError('job_status_error', error);
            throw error;
        }
    }

    private startScheduler(): void {
        setInterval(async () => {
            try {
                await this.checkAndExecuteJobs();
            } catch (error) {
                await this.handleError('scheduler_error', error);
            }
        }, this.CHECK_INTERVAL);
    }

    private async checkAndExecuteJobs(): Promise<void> {
        const now = new Date();
        const activeJobs = Array.from(this.jobs.values())
            .filter(job => 
                job.status === 'active' && 
                job.nextRun && 
                job.nextRun <= now
            );

        // Execute jobs in parallel with concurrency limit
        const runningJobs = activeJobs.map(job => this.executeJob(job));
        await Promise.allSettled(runningJobs);

        // Update metrics
        await this.monitor.recordMetric({
            name: 'scheduler_check',
            value: activeJobs.length,
            labels: {
                total_jobs: this.jobs.size.toString(),
                active_jobs: activeJobs.length.toString()
            }
        });
    }

    private async executeJob(job: ScheduledJob): Promise<JobExecutionResult> {
        const startTime = new Date();
        try {
            // Enqueue task
            const taskId = await this.taskQueue.enqueueTask(
                job.taskType,
                job.taskData,
                {
                    priority: job.options.priority,
                    maxAttempts: job.options.retries
                }
            );

            // Update job status
            job.lastRun = {
                timestamp: startTime,
                status: 'success',
                duration: Date.now() - startTime.getTime()
            };
            job.nextRun = this.calculateNextRun(
                job.schedule,
                job.options.timezone
            );

            // Store updated job
            await this.storeJob(job);

            // Schedule next run
            this.scheduleNextRun(job);

            const result: JobExecutionResult = {
                jobId: job.id,
                taskId,
                status: 'success',
                startTime,
                endTime: new Date()
            };

            await this.monitor.recordMetric({
                name: 'job_execution',
                value: result.endTime.getTime() - startTime.getTime(),
                labels: {
                    job_id: job.id,
                    status: 'success'
                }
            });

            return result;

        } catch (error) {
            job.lastRun = {
                timestamp: startTime,
                status: 'failure',
                error: error.message,
                duration: Date.now() - startTime.getTime()
            };

            await this.storeJob(job);

            await this.monitor.recordMetric({
                name: 'job_execution',
                value: 1,
                labels: {
                    job_id: job.id,
                    status: 'failure',
                    error: error.message
                }
            });

            return {
                jobId: job.id,
                taskId: '',
                status: 'failure',
                startTime,
                endTime: new Date(),
                error
            };
        }
    }

    private scheduleNextRun(job: ScheduledJob): void {
        if (!job.nextRun || job.status !== 'active') return;

        const delay = Math.max(0, job.nextRun.getTime() - Date.now());
        const timer = setTimeout(async () => {
            try {
                await this.executeJob(job);
            } catch (error) {
                await this.handleError('job_execution_error', error);
            }
        }, delay);

        this.timers.set(job.id, timer);
    }

    private cancelScheduledRun(jobId: string): void {
        const timer = this.timers.get(jobId);
        if (timer) {
            clearTimeout(timer);
            this.timers.delete(jobId);
        }
    }

    private determineScheduleType(schedule: string): ScheduledJob['type'] {
        if (schedule.includes('|')) return 'interval';
        if (schedule.match(/^\d{4}-\d{2}-\d{2}/)) return 'datetime';
        return 'cron';
    }

    private calculateNextRun(schedule: string, timezone?: string): Date {
        switch (this.determineScheduleType(schedule)) {
            case 'cron':
                return cronParse
                    .parseExpression(schedule, { tz: timezone })
                    .next()
                    .toDate();
            case 'interval':
                const [value, unit] = schedule.split('|');
                const ms = this.parseInterval(value, unit);
                return new Date(Date.now() + ms);
            case 'datetime':
                return new Date(schedule);
            default:
                throw new Error(`Invalid schedule type: ${schedule}`);
        }
    }

    private parseInterval(value: string, unit: string): number {
        const val = parseInt(value, 10);
        switch (unit.toLowerCase()) {
            case 'ms': return val;
            case 's': return val * 1000;
            case 'm': return val * 60000;
            case 'h': return val * 3600000;
            case 'd': return val * 86400000;
            default: throw new Error(`Invalid interval unit: ${unit}`);
        }
    }

    private async validateSchedule(schedule: string): Promise<void> {
        try {
            const type = this.determineScheduleType(schedule);
            switch (type) {
                case 'cron':
                    cronParse.parseExpression(schedule);
                    break;
                case 'interval':
                    const [value, unit] = schedule.split('|');
                    this.parseInterval(value, unit);
                    break;
                case 'datetime':
                    if (isNaN(new Date(schedule).getTime())) {
                        throw new Error('Invalid datetime');
                    }
                    break;
            }
        } catch (error) {
            throw new Error(`Invalid schedule: ${error.message}`);
        }
    }

    private async loadJobs(): Promise<void> {
        const jobs = await this.redis.hgetall('scheduler:jobs');
        for (const [id, data] of Object.entries(jobs)) {
            const job = JSON.parse(data) as ScheduledJob;
            this.jobs.set(id, job);
            if (job.status === 'active') {
                this.scheduleNextRun(job);
            }
        }
    }

    private async storeJob(job: ScheduledJob): Promise<void> {
        await this.redis.hset(
            'scheduler:jobs',
            job.id,
            JSON.stringify(job)
        );
    }

    private async removeJob(jobId: string): Promise<void> {
        await this.redis.hdel('scheduler:jobs', jobId);
    }

    private setupEventListeners(): void {
        this.eventBus.subscribe({
            id: 'job-scheduler-monitor',
            topic: 'task.completed',
            handler: async (event) => {
                // Handle task completion events
                const job = Array.from(this.jobs.values())
                    .find(j => j.lastRun?.timestamp.getTime() === event.data.startTime);

                if (job) {
                    job.lastRun!.status = 'success';
                    await this.storeJob(job);
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
    }

    // Cleanup method for proper service shutdown
    async shutdown(): Promise<void> {
        // Cancel all scheduled jobs
        for (const timer of this.timers.values()) {
            clearTimeout(timer);
        }
        this.timers.clear();

        // Close Redis connection
        await this.redis.quit();
    }
}

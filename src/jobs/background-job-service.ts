import { MonitoringService } from '../monitoring/monitoring-service';
import { AuditTrailService } from '../audit/audit-trail-service';
import { Redis } from 'ioredis';
import { EventEmitter } from 'events';

interface Job {
    id: string;
    type: string;
    data: any;
    priority: 'high' | 'medium' | 'low';
    status: 'pending' | 'processing' | 'completed' | 'failed' | 'retrying';
    attempts: number;
    maxAttempts: number;
    retryDelay: number;
    timeout: number;
    progress: number;
    result?: any;
    error?: string;
    metadata: {
        createdAt: Date;
        updatedAt: Date;
        startedAt?: Date;
        completedAt?: Date;
        nextRetryAt?: Date;
    };
}

interface JobHandler {
    (job: Job): Promise<any>;
}

export class BackgroundJobService extends EventEmitter {
    private monitor: MonitoringService;
    private auditService: AuditTrailService;
    private redis: Redis;
    private handlers: Map<string, JobHandler>;
    private isProcessing: boolean;
    private readonly MAX_CONCURRENT_JOBS = 10;
    private readonly DEFAULT_MAX_ATTEMPTS = 3;
    private readonly DEFAULT_RETRY_DELAY = 5000;
    private readonly DEFAULT_TIMEOUT = 300000;

    constructor(
        monitor: MonitoringService,
        auditService: AuditTrailService,
        redisUrl: string
    ) {
        super();
        this.monitor = monitor;
        this.auditService = auditService;
        this.redis = new Redis(redisUrl);
        this.handlers = new Map();
        this.isProcessing = false;

        this.initialize();
    }

    private async initialize(): Promise<void> {
        await this.startProcessing();
        this.setupEventListeners();
    }

    registerHandler(jobType: string, handler: JobHandler): void {
        if (this.handlers.has(jobType)) {
            throw new Error(`Handler already registered for job type: ${jobType}`);
        }
        this.handlers.set(jobType, handler);
    }

    async enqueueJob(
        type: string,
        data: any,
        options: Partial<Pick<Job, 'priority' | 'maxAttempts' | 'retryDelay' | 'timeout'>> = {}
    ): Promise<Job> {
        try {
            if (!this.handlers.has(type)) {
                throw new Error(`No handler registered for job type: ${type}`);
            }

            const job: Job = {
                id: this.generateJobId(),
                type,
                data,
                priority: options.priority || 'medium',
                status: 'pending',
                attempts: 0,
                maxAttempts: options.maxAttempts || this.DEFAULT_MAX_ATTEMPTS,
                retryDelay: options.retryDelay || this.DEFAULT_RETRY_DELAY,
                timeout: options.timeout || this.DEFAULT_TIMEOUT,
                progress: 0,
                metadata: {
                    createdAt: new Date(),
                    updatedAt: new Date()
                }
            };

            await this.saveJob(job);
            await this.addToQueue(job);

            await this.monitor.recordMetric({
                name: 'job_enqueued',
                value: 1,
                labels: {
                    job_type: type,
                    priority: job.priority
                }
            });

            this.emit('jobEnqueued', job);
            return job;
        } catch (error) {
            await this.handleError('job_enqueue_error', error);
            throw error;
        }
    }

    async getJob(jobId: string): Promise<Job | null> {
        try {
            const jobData = await this.redis.hget('jobs', jobId);
            return jobData ? JSON.parse(jobData) : null;
        } catch (error) {
            await this.handleError('job_get_error', error);
            throw error;
        }
    }

    async cancelJob(jobId: string): Promise<void> {
        try {
            const job = await this.getJob(jobId);
            if (!job) {
                throw new Error('Job not found');
            }

            if (['completed', 'failed'].includes(job.status)) {
                throw new Error('Cannot cancel completed or failed job');
            }

            job.status = 'failed';
            job.error = 'Job cancelled by user';
            job.metadata.updatedAt = new Date();
            job.metadata.completedAt = new Date();

            await this.saveJob(job);
            await this.removeFromQueue(job);

            await this.monitor.recordMetric({
                name: 'job_cancelled',
                value: 1,
                labels: {
                    job_type: job.type,
                    priority: job.priority
                }
            });

            this.emit('jobCancelled', job);
        } catch (error) {
            await this.handleError('job_cancel_error', error);
            throw error;
        }
    }

    private async startProcessing(): Promise<void> {
        if (this.isProcessing) return;

        this.isProcessing = true;
        while (this.isProcessing) {
            try {
                const activeJobs = await this.getActiveJobCount();
                if (activeJobs >= this.MAX_CONCURRENT_JOBS) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    continue;
                }

                const job = await this.getNextJob();
                if (!job) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    continue;
                }

                this.processJob(job).catch(async error => {
                    await this.handleError('job_processing_error', error);
                });
            } catch (error) {
                await this.handleError('job_processing_loop_error', error);
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
        }
    }

    private async processJob(job: Job): Promise<void> {
        try {
            job.status = 'processing';
            job.metadata.startedAt = new Date();
            job.metadata.updatedAt = new Date();
            await this.saveJob(job);

            const handler = this.handlers.get(job.type)!;
            const timeout = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Job timeout')), job.timeout)
            );

            const result = await Promise.race([
                handler(job),
                timeout
            ]);

            job.status = 'completed';
            job.result = result;
            job.progress = 100;
            job.metadata.completedAt = new Date();
            job.metadata.updatedAt = new Date();

            await this.saveJob(job);
            await this.removeFromQueue(job);

            await this.monitor.recordMetric({
                name: 'job_completed',
                value: 1,
                labels: {
                    job_type: job.type,
                    priority: job.priority
                }
            });

            this.emit('jobCompleted', job);

        } catch (error) {
            await this.handleJobError(job, error);
        }
    }

    private async handleJobError(job: Job, error: Error): Promise<void> {
        job.attempts++;
        job.error = error.message;
        job.metadata.updatedAt = new Date();

        if (job.attempts >= job.maxAttempts) {
            job.status = 'failed';
            job.metadata.completedAt = new Date();
            await this.removeFromQueue(job);
        } else {
            job.status = 'retrying';
            job.metadata.nextRetryAt = new Date(Date.now() + job.retryDelay);
            await this.addToQueue(job);
        }

        await this.saveJob(job);

        await this.monitor.recordMetric({
            name: 'job_error',
            value: 1,
            labels: {
                job_type: job.type,
                error: error.message,
                attempt: job.attempts.toString()
            }
        });

        this.emit('jobError', job, error);
    }

    private async saveJob(job: Job): Promise<void> {
        await this.redis.hset('jobs', job.id, JSON.stringify(job));
    }

    private async addToQueue(job: Job): Promise<void> {
        const score = this.calculatePriorityScore(job);
        await this.redis.zadd('jobQueue', score, job.id);
    }

    private async removeFromQueue(job: Job): Promise<void> {
        await this.redis.zrem('jobQueue', job.id);
    }

    private async getNextJob(): Promise<Job | null> {
        const jobId = await this.redis.zpopmin('jobQueue');
        if (!jobId || !jobId[0]) return null;

        return this.getJob(jobId[0]);
    }

    private async getActiveJobCount(): Promise<number> {
        const jobs = await this.redis.hgetall('jobs');
        return Object.values(jobs)
            .map(j => JSON.parse(j))
            .filter(j => j.status === 'processing')
            .length;
    }

    private calculatePriorityScore(job: Job): number {
        const priorityWeights = {
            high: 100,
            medium: 50,
            low: 0
        };

        return Date.now() - priorityWeights[job.priority];
    }

    private setupEventListeners(): void {
        this.on('error', async error => {
            await this.handleError('job_service_error', error);
        });
    }

    private generateJobId(): string {
        return `job-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }

    private async handleError(type: string, error: Error): Promise<void> {
        await this.monitor.recordMetric({
            name: type,
            value: 1,
            labels: { error: error.message }
        });
    }
}

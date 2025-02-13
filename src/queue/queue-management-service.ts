import { MonitoringService } from '../monitoring/monitoring-service';
import { EventBusService } from '../events/event-bus-service';
import { PubSub, Message, Subscription } from '@google-cloud/pubsub';
import { CloudTasks } from '@google-cloud/tasks';
import { Redis } from 'ioredis';
import { v4 as uuidv4 } from 'uuid';

interface QueueConfig {
    name: string;
    type: 'pubsub' | 'tasks' | 'redis';
    dlq?: string; // Dead Letter Queue
    retries: {
        maxAttempts: number;
        backoffSeconds: number;
    };
    rateLimit?: {
        maxPerSecond: number;
        burstSize: number;
    };
    retention: {
        successfulMessages: number; // hours
        failedMessages: number; // hours
    };
}

interface QueueMessage {
    id: string;
    payload: any;
    metadata: {
        timestamp: Date;
        priority: 'high' | 'medium' | 'low';
        attempts: number;
        correlationId?: string;
        source: string;
    };
    processing: {
        status: 'pending' | 'processing' | 'completed' | 'failed';
        startTime?: Date;
        endTime?: Date;
        error?: string;
    };
}

interface QueueStats {
    messagesPublished: number;
    messagesProcessed: number;
    messagesFailed: number;
    averageLatency: number;
    errorRate: number;
}

export class QueueManagementService {
    private monitor: MonitoringService;
    private eventBus: EventBusService;
    private pubsub: PubSub;
    private tasks: CloudTasks;
    private redis: Redis;
    private queues: Map<string, QueueConfig>;
    private subscriptions: Map<string, Subscription>;
    private stats: Map<string, QueueStats>;
    private messageHandlers: Map<string, (message: QueueMessage) => Promise<void>>;
    private readonly MAX_BATCH_SIZE = 100;
    private readonly STATS_UPDATE_INTERVAL = 60000; // 1 minute

    constructor(
        monitor: MonitoringService,
        eventBus: EventBusService,
        config: {
            projectId: string;
            region: string;
            redisUrl: string;
        }
    ) {
        this.monitor = monitor;
        this.eventBus = eventBus;
        this.pubsub = new PubSub({ projectId: config.projectId });
        this.tasks = new CloudTasks({ projectId: config.projectId });
        this.redis = new Redis(config.redisUrl);
        this.queues = new Map();
        this.subscriptions = new Map();
        this.stats = new Map();
        this.messageHandlers = new Map();

        this.initialize();
    }

    private async initialize(): Promise<void> {
        await this.setupInfrastructure();
        this.startStatsCollection();
        this.setupEventListeners();
    }

    async createQueue(config: QueueConfig): Promise<void> {
        try {
            // Validate configuration
            this.validateQueueConfig(config);

            // Create queue infrastructure based on type
            switch (config.type) {
                case 'pubsub':
                    await this.createPubSubQueue(config);
                    break;
                case 'tasks':
                    await this.createTaskQueue(config);
                    break;
                case 'redis':
                    await this.createRedisQueue(config);
                    break;
            }

            // Store queue configuration
            this.queues.set(config.name, config);

            // Initialize queue statistics
            this.stats.set(config.name, {
                messagesPublished: 0,
                messagesProcessed: 0,
                messagesFailed: 0,
                averageLatency: 0,
                errorRate: 0
            });

            await this.monitor.recordMetric({
                name: 'queue_created',
                value: 1,
                labels: {
                    queue: config.name,
                    type: config.type
                }
            });

        } catch (error) {
            await this.handleError('queue_creation_error', error);
            throw error;
        }
    }

    async publishMessage(
        queueName: string,
        payload: any,
        options: {
            priority?: 'high' | 'medium' | 'low';
            correlationId?: string;
        } = {}
    ): Promise<string> {
        const startTime = Date.now();
        try {
            const queue = this.queues.get(queueName);
            if (!queue) {
                throw new Error(`Queue not found: ${queueName}`);
            }

            const message: QueueMessage = {
                id: uuidv4(),
                payload,
                metadata: {
                    timestamp: new Date(),
                    priority: options.priority || 'medium',
                    attempts: 0,
                    correlationId: options.correlationId,
                    source: 'queue-management-service'
                },
                processing: {
                    status: 'pending'
                }
            };

            // Apply rate limiting if configured
            if (queue.rateLimit) {
                await this.enforceRateLimit(queueName, queue.rateLimit);
            }

            // Publish based on queue type
            switch (queue.type) {
                case 'pubsub':
                    await this.publishToPubSub(queueName, message);
                    break;
                case 'tasks':
                    await this.publishToTasks(queueName, message);
                    break;
                case 'redis':
                    await this.publishToRedis(queueName, message);
                    break;
            }

            // Update statistics
            const stats = this.stats.get(queueName)!;
            stats.messagesPublished++;

            await this.monitor.recordMetric({
                name: 'message_published',
                value: Date.now() - startTime,
                labels: {
                    queue: queueName,
                    priority: message.metadata.priority
                }
            });

            return message.id;

        } catch (error) {
            await this.handleError('message_publish_error', error);
            throw error;
        }
    }

    async subscribe(
        queueName: string,
        handler: (message: QueueMessage) => Promise<void>
    ): Promise<void> {
        try {
            const queue = this.queues.get(queueName);
            if (!queue) {
                throw new Error(`Queue not found: ${queueName}`);
            }

            // Store handler
            this.messageHandlers.set(queueName, handler);

            // Setup subscription based on queue type
            switch (queue.type) {
                case 'pubsub':
                    await this.subscribeToPubSub(queueName, queue);
                    break;
                case 'tasks':
                    await this.subscribeToTasks(queueName, queue);
                    break;
                case 'redis':
                    await this.subscribeToRedis(queueName, queue);
                    break;
            }

            await this.monitor.recordMetric({
                name: 'queue_subscription',
                value: 1,
                labels: {
                    queue: queueName,
                    type: queue.type
                }
            });

        } catch (error) {
            await this.handleError('subscription_error', error);
            throw error;
        }
    }

    private async createPubSubQueue(config: QueueConfig): Promise<void> {
        // Create topic
        const [topic] = await this.pubsub.createTopic(config.name);

        // Create subscription
        const [subscription] = await topic.createSubscription(config.name, {
            deadLetterPolicy: config.dlq ? {
                deadLetterTopic: `projects/${this.pubsub.projectId}/topics/${config.dlq}`,
                maxDeliveryAttempts: config.retries.maxAttempts
            } : undefined,
            retryPolicy: {
                minimumBackoff: { seconds: config.retries.backoffSeconds },
                maximumBackoff: { seconds: config.retries.backoffSeconds * 10 }
            },
            messageRetentionDuration: {
                seconds: config.retention.successfulMessages * 3600
            }
        });

        this.subscriptions.set(config.name, subscription);
    }

    private async createTaskQueue(config: QueueConfig): Promise<void> {
        const [queue] = await this.tasks.createQueue({
            parent: this.tasks.locationPath(this.tasks.projectId, 'us-central1'),
            queue: {
                name: config.name,
                retryConfig: {
                    maxAttempts: config.retries.maxAttempts,
                    minBackoff: `${config.retries.backoffSeconds}s`,
                    maxBackoff: `${config.retries.backoffSeconds * 10}s`
                },
                rateLimits: config.rateLimit ? {
                    maxDispatchesPerSecond: config.rateLimit.maxPerSecond,
                    maxBurstSize: config.rateLimit.burstSize
                } : undefined
            }
        });
    }

    private async createRedisQueue(config: QueueConfig): Promise<void> {
        // Create Redis queue structures
        await this.redis.multi()
            .del(`queue:${config.name}:messages`)
            .del(`queue:${config.name}:processing`)
            .del(`queue:${config.name}:failed`)
            .exec();
    }

    private async publishToPubSub(queueName: string, message: QueueMessage): Promise<void> {
        const topic = this.pubsub.topic(queueName);
        const data = Buffer.from(JSON.stringify(message));
        await topic.publish(data);
    }

    private async publishToTasks(queueName: string, message: QueueMessage): Promise<void> {
        const parent = this.tasks.queuePath(
            this.tasks.projectId,
            'us-central1',
            queueName
        );

        await this.tasks.createTask({
            parent,
            task: {
                httpRequest: {
                    httpMethod: 'POST',
                    url: process.env.TASK_HANDLER_URL,
                    body: Buffer.from(JSON.stringify(message)).toString('base64'),
                    headers: {
                        'Content-Type': 'application/json'
                    }
                }
            }
        });
    }

    private async publishToRedis(queueName: string, message: QueueMessage): Promise<void> {
        await this.redis.rpush(
            `queue:${queueName}:messages`,
            JSON.stringify(message)
        );
    }

    private async subscribeToPubSub(queueName: string, config: QueueConfig): Promise<void> {
        const subscription = this.subscriptions.get(queueName);
        if (!subscription) return;

        const messageHandler = this.messageHandlers.get(queueName);
        if (!messageHandler) return;

        subscription.on('message', async (message: Message) => {
            try {
                const queueMessage: QueueMessage = JSON.parse(message.data.toString());
                await this.processMessage(queueName, queueMessage, messageHandler);
                message.ack();
            } catch (error) {
                message.nack();
                await this.handleError('message_processing_error', error);
            }
        });
    }

    private async subscribeToTasks(queueName: string, config: QueueConfig): Promise<void> {
        // Task queue subscription is handled via HTTP endpoint
    }

    private async subscribeToRedis(queueName: string, config: QueueConfig): Promise<void> {
        const messageHandler = this.messageHandlers.get(queueName);
        if (!messageHandler) return;

        // Start Redis queue processor
        setInterval(async () => {
            try {
                const message = await this.redis.lpop(`queue:${queueName}:messages`);
                if (message) {
                    const queueMessage: QueueMessage = JSON.parse(message);
                    await this.processMessage(queueName, queueMessage, messageHandler);
                }
            } catch (error) {
                await this.handleError('redis_processing_error', error);
            }
        }, 100); // Poll every 100ms
    }

    private async processMessage(
        queueName: string,
        message: QueueMessage,
        handler: (message: QueueMessage) => Promise<void>
    ): Promise<void> {
        const startTime = Date.now();
        message.processing.status = 'processing';
        message.processing.startTime = new Date();

        try {
            await handler(message);
            
            message.processing.status = 'completed';
            message.processing.endTime = new Date();

            // Update stats
            const stats = this.stats.get(queueName)!;
            stats.messagesProcessed++;
            stats.averageLatency = (stats.averageLatency * (stats.messagesProcessed - 1) + 
                (Date.now() - startTime)) / stats.messagesProcessed;

            await this.monitor.recordMetric({
                name: 'message_processed',
                value: Date.now() - startTime,
                labels: {
                    queue: queueName,
                    status: 'success'
                }
            });

        } catch (error) {
            message.processing.status = 'failed';
            message.processing.error = error.message;
            message.metadata.attempts++;

            // Update stats
            const stats = this.stats.get(queueName)!;
            stats.messagesFailed++;
            stats.errorRate = stats.messagesFailed / stats.messagesProcessed;

            // Handle retry logic
            const queue = this.queues.get(queueName)!;
            if (message.metadata.attempts < queue.retries.maxAttempts) {
                await this.retryMessage(queueName, message, queue);
            } else {
                await this.moveToDeadLetter(queueName, message);
            }

            await this.monitor.recordMetric({
                name: 'message_processed',
                value: Date.now() - startTime,
                labels: {
                    queue: queueName,
                    status: 'failed'
                }
            });
        }
    }

    private async retryMessage(
        queueName: string,
        message: QueueMessage,
        queue: QueueConfig
    ): Promise<void> {
        const delay = queue.retries.backoffSeconds * Math.pow(2, message.metadata.attempts - 1);
        setTimeout(async () => {
            try {
                await this.publishMessage(queueName, message.payload, {
                    priority: message.metadata.priority,
                    correlationId: message.metadata.correlationId
                });
            } catch (error) {
                await this.handleError('message_retry_error', error);
            }
        }, delay * 1000);
    }

    private async moveToDeadLetter(
        queueName: string,
        message: QueueMessage
    ): Promise<void> {
        const queue = this.queues.get(queueName)!;
        if (!queue.dlq) return;

        try {
            await this.publishMessage(queue.dlq, {
                originalQueue: queueName,
                originalMessage: message
            });

            await this.eventBus.publish('queue.message.dead_letter', {
                type: 'queue.message.dead_letter',
                source: 'queue-management',
                data: {
                    queueName,
                    messageId: message.id,
                    error: message.processing.error,
                    timestamp: new Date()
                },
                metadata: {
                    severity: 'high',
                    environment: process.env.NODE_ENV || 'development'
                }
            });
        } catch (error) {
            await this.handleError('dead_letter_error', error);
        }
    }

    private async enforceRateLimit(
        queueName: string,
        limits: NonNullable<QueueConfig['rateLimit']>
    ): Promise<void> {
        const key = `ratelimit:${queueName}`;
        const now = Date.now();
        const windowSize = 1000; // 1 second

        const multi = this.redis.multi();
        multi.zremrangebyscore(key, '-inf', now - windowSize);
        multi.zadd(key, now, uuidv4());
        multi.zcard(key);
        const [,, count] = await multi.exec();

        if (count[1] as number > limits.maxPerSecond) {
            throw new Error('Rate limit exceeded');
        }
    }

    private validateQueueConfig(config: QueueConfig): void {
        if (!config.name || !config.type) {
            throw new Error('Invalid queue configuration');
        }

        if (config.retries.maxAttempts < 1) {
            throw new Error('Invalid retry configuration');
        }

        if (config.rateLimit && (
            config.rateLimit.maxPerSecond < 1 ||
            config.rateLimit.burstSize < config.rateLimit.maxPerSecond
        )) {
            throw new Error('Invalid rate limit configuration');
        }
    }

    private startStatsCollection(): void {
        setInterval(async () => {
            for (const [queueName, stats] of this.stats.entries()) {
                await this.monitor.recordMetric({
                    name: 'queue_stats',
                    value: 1,
                    labels: {
                        queue: queueName,
                        processed: stats.messagesProcessed.toString(),
                        failed: stats.messagesFailed.toString(),
                        error_rate: stats.errorRate.toString(),
                        latency: stats.averageLatency.toString()
                    }
                });
            }
        }, this.STATS_UPDATE_INTERVAL);
    }

    private setupEventListeners(): void {
        this.eventBus.subscribe({
            id: 'queue-monitor',
            topic: 'system.shutdown',
            handler: async () => {
                await this.shutdown();
            }
        });
    }

    private async setupInfrastructure(): Promise<void> {
        // Create dead letter topics if needed
        const topics = await this.pubsub.getTopics();
        const existingTopics = topics[0].map(t => t.name);

        for (const queue of this.queues.values()) {
            if (queue.dlq && !existingTopics.includes(queue.dlq)) {
                await this.pubsub.createTopic(queue.dlq);
            }
        }
    }

    private async handleError(type: string, error: Error): Promise<void> {
        await this.monitor.recordMetric({
            name: type,
            value: 1,
            labels: { error: error.message }
        });

        await this.eventBus.publish('queue.error', {
            type: 'queue.error',
            source: 'queue-management',
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

    async shutdown(): Promise<void> {
        // Stop all subscriptions
        for (const subscription of this.subscriptions.values()) {
            subscription.removeAllListeners();
        }

        // Close Redis connection
        await this.redis.quit();
    }
}

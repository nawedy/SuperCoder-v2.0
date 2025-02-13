import { MonitoringService } from '../monitoring/monitoring-service';
import { EventBusService } from '../events/event-bus-service';
import { AuditTrailService } from '../audit/audit-trail-service';
import { Redis } from 'ioredis';
import { PubSub } from '@google-cloud/pubsub';
import { v4 as uuidv4 } from 'uuid';

interface QueueMessage {
    id: string;
    topic: string;
    data: any;
    attributes: Record<string, string>;
    priority: 'high' | 'medium' | 'low';
    timestamp: Date;
    retryCount: number;
    status: 'pending' | 'processing' | 'completed' | 'failed';
    processingTime?: number;
    error?: string;
}

interface QueueConfig {
    maxRetries: number;
    retryDelay: number;
    deadLetterQueue: string;
    processingTimeout: number;
    maxBatchSize: number;
    maxConcurrent: number;
}

interface QueueStats {
    processed: number;
    failed: number;
    retried: number;
    deadLettered: number;
    averageProcessingTime: number;
}

type MessageHandler = (message: QueueMessage) => Promise<void>;

export class DistributedQueueService {
    private monitor: MonitoringService;
    private eventBus: EventBusService;
    private audit: AuditTrailService;
    private redis: Redis;
    private pubsub: PubSub;
    private handlers: Map<string, MessageHandler>;
    private stats: Map<string, QueueStats>;
    private processing: Map<string, Promise<void>>;
    private config: QueueConfig;
    private isRunning: boolean;

    constructor(
        monitor: MonitoringService,
        eventBus: EventBusService,
        audit: AuditTrailService,
        redisUrl: string,
        projectId: string,
        config: Partial<QueueConfig> = {}
    ) {
        this.monitor = monitor;
        this.eventBus = eventBus;
        this.audit = audit;
        this.redis = new Redis(redisUrl);
        this.pubsub = new PubSub({ projectId });
        this.handlers = new Map();
        this.stats = new Map();
        this.processing = new Map();
        this.isRunning = false;

        this.config = {
            maxRetries: config.maxRetries || 3,
            retryDelay: config.retryDelay || 5000,
            deadLetterQueue: config.deadLetterQueue || 'dead-letter',
            processingTimeout: config.processingTimeout || 30000,
            maxBatchSize: config.maxBatchSize || 100,
            maxConcurrent: config.maxConcurrent || 10
        };

        this.initialize();
    }

    private async initialize(): Promise<void> {
        await this.ensureTopics();
        await this.startMessageProcessing();
        this.setupHealthCheck();
    }

    async publish(
        topic: string,
        data: any,
        options: {
            priority?: QueueMessage['priority'];
            attributes?: Record<string, string>;
        } = {}
    ): Promise<string> {
        try {
            const message: QueueMessage = {
                id: uuidv4(),
                topic,
                data,
                attributes: options.attributes || {},
                priority: options.priority || 'medium',
                timestamp: new Date(),
                retryCount: 0,
                status: 'pending'
            };

            // Store message in Redis for durability
            await this.storeMessage(message);

            // Publish to PubSub
            await this.publishToPubSub(message);

            await this.monitor.recordMetric({
                name: 'queue_publish',
                value: 1,
                labels: {
                    topic,
                    priority: message.priority
                }
            });

            return message.id;

        } catch (error) {
            await this.handleError('publish_error', error);
            throw error;
        }
    }

    async subscribe(
        topic: string,
        handler: MessageHandler,
        options: {
            subscriptionName?: string;
            filter?: string;
        } = {}
    ): Promise<void> {
        try {
            // Store handler
            this.handlers.set(topic, handler);

            // Initialize stats
            this.stats.set(topic, {
                processed: 0,
                failed: 0,
                retried: 0,
                deadLettered: 0,
                averageProcessingTime: 0
            });

            // Create PubSub subscription
            const subscription = this.pubsub.topic(topic).subscription(
                options.subscriptionName || `${topic}-subscription`
            );

            const [exists] = await subscription.exists();
            if (!exists) {
                await subscription.create({
                    filter: options.filter,
                    retryPolicy: {
                        minimumBackoff: { seconds: 10 },
                        maximumBackoff: { seconds: 600 }
                    }
                });
            }

            // Start message listener
            subscription.on('message', async (pubsubMessage) => {
                try {
                    const message: QueueMessage = JSON.parse(pubsubMessage.data.toString());
                    await this.processMessage(message);
                    pubsubMessage.ack();
                } catch (error) {
                    pubsubMessage.nack();
                    await this.handleError('message_processing_error', error);
                }
            });

            await this.audit.logEvent({
                eventType: 'system.config',
                actor: {
                    id: 'system',
                    type: 'service',
                    metadata: {}
                },
                resource: {
                    type: 'queue-subscription',
                    id: topic,
                    action: 'subscribe'
                },
                context: {
                    location: 'distributed-queue',
                    ipAddress: 'internal',
                    userAgent: 'system'
                },
                status: 'success',
                details: { options }
            });

        } catch (error) {
            await this.handleError('subscription_error', error);
            throw error;
        }
    }

    async getMessageStatus(messageId: string): Promise<QueueMessage | null> {
        try {
            return this.getMessage(messageId);
        } catch (error) {
            await this.handleError('status_retrieval_error', error);
            throw error;
        }
    }

    private async processMessage(message: QueueMessage): Promise<void> {
        const startTime = Date.now();
        const handler = this.handlers.get(message.topic);

        if (!handler) {
            throw new Error(`No handler registered for topic: ${message.topic}`);
        }

        try {
            // Update status
            message.status = 'processing';
            await this.updateMessage(message);

            // Process with timeout
            await Promise.race([
                handler(message),
                new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Processing timeout')), this.config.processingTimeout)
                )
            ]);

            // Update success status
            message.status = 'completed';
            message.processingTime = Date.now() - startTime;
            await this.updateMessage(message);

            // Update stats
            const stats = this.stats.get(message.topic)!;
            stats.processed++;
            stats.averageProcessingTime = this.calculateAverageProcessingTime(
                stats.averageProcessingTime,
                stats.processed,
                message.processingTime
            );

            await this.monitor.recordMetric({
                name: 'message_processed',
                value: message.processingTime,
                labels: {
                    topic: message.topic,
                    status: 'success'
                }
            });

        } catch (error) {
            await this.handleMessageFailure(message, error);
        }
    }

    private async handleMessageFailure(
        message: QueueMessage,
        error: Error
    ): Promise<void> {
        message.retryCount++;
        message.error = error.message;

        if (message.retryCount >= this.config.maxRetries) {
            // Move to dead letter queue
            message.status = 'failed';
            await this.moveToDeadLetterQueue(message);

            const stats = this.stats.get(message.topic)!;
            stats.failed++;
            stats.deadLettered++;

            await this.eventBus.publish('queue.message.failed', {
                type: 'queue.message.failed',
                source: 'distributed-queue',
                data: {
                    messageId: message.id,
                    topic: message.topic,
                    error: error.message,
                    retries: message.retryCount
                },
                metadata: {
                    severity: 'high',
                    environment: process.env.NODE_ENV || 'development'
                }
            });
        } else {
            // Schedule retry
            message.status = 'pending';
            await this.scheduleRetry(message);

            const stats = this.stats.get(message.topic)!;
            stats.retried++;
        }

        await this.updateMessage(message);

        await this.monitor.recordMetric({
            name: 'message_failed',
            value: 1,
            labels: {
                topic: message.topic,
                error: error.message,
                retry_count: message.retryCount.toString()
            }
        });
    }

    private async scheduleRetry(message: QueueMessage): Promise<void> {
        const delay = this.config.retryDelay * Math.pow(2, message.retryCount - 1);
        await new Promise(resolve => setTimeout(resolve, delay));
        await this.publishToPubSub(message);
    }

    private async moveToDeadLetterQueue(message: QueueMessage): Promise<void> {
        await this.publish(
            this.config.deadLetterQueue,
            message,
            { priority: 'low' }
        );
    }

    private async storeMessage(message: QueueMessage): Promise<void> {
        const key = `message:${message.id}`;
        await this.redis.set(key, JSON.stringify(message));
    }

    private async updateMessage(message: QueueMessage): Promise<void> {
        await this.storeMessage(message);
    }

    private async getMessage(messageId: string): Promise<QueueMessage | null> {
        const key = `message:${messageId}`;
        const data = await this.redis.get(key);
        return data ? JSON.parse(data) : null;
    }

    private async publishToPubSub(message: QueueMessage): Promise<void> {
        const topic = this.pubsub.topic(message.topic);
        const data = Buffer.from(JSON.stringify(message));
        await topic.publish(data);
    }

    private async ensureTopics(): Promise<void> {
        const [topics] = await this.pubsub.getTopics();
        const existingTopics = new Set(topics.map(t => t.name));

        for (const topic of this.handlers.keys()) {
            if (!existingTopics.has(topic)) {
                await this.pubsub.createTopic(topic);
            }
        }

        // Ensure dead letter queue topic exists
        if (!existingTopics.has(this.config.deadLetterQueue)) {
            await this.pubsub.createTopic(this.config.deadLetterQueue);
        }
    }

    private async startMessageProcessing(): Promise<void> {
        this.isRunning = true;

        while (this.isRunning) {
            try {
                // Process messages in batches
                const pendingMessages = await this.getPendingMessages();
                
                for (const batch of this.chunkArray(pendingMessages, this.config.maxBatchSize)) {
                    await Promise.all(
                        batch.map(message => {
                            const processing = this.processMessage(message);
                            this.processing.set(message.id, processing);
                            return processing;
                        })
                    );
                }

            } catch (error) {
                await this.handleError('message_processing_error', error);
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
    }

    private async getPendingMessages(): Promise<QueueMessage[]> {
        // Implementation for retrieving pending messages from Redis
        return [];
    }

    private setupHealthCheck(): void {
        setInterval(async () => {
            try {
                const health = {
                    activeHandlers: this.handlers.size,
                    processingMessages: this.processing.size,
                    stats: Object.fromEntries(this.stats)
                };

                await this.monitor.recordMetric({
                    name: 'queue_health',
                    value: this.processing.size,
                    labels: {
                        handlers: this.handlers.size.toString(),
                        status: 'healthy'
                    }
                });

            } catch (error) {
                await this.handleError('health_check_error', error);
            }
        }, 60000); // Every minute
    }

    private calculateAverageProcessingTime(
        currentAvg: number,
        totalProcessed: number,
        newTime: number
    ): number {
        return (currentAvg * (totalProcessed - 1) + newTime) / totalProcessed;
    }

    private chunkArray<T>(array: T[], size: number): T[][] {
        const chunks: T[][] = [];
        for (let i = 0; i < array.length; i += size) {
            chunks.push(array.slice(i, i + size));
        }
        return chunks;
    }

    private async handleError(type: string, error: Error): Promise<void> {
        await this.monitor.recordMetric({
            name: type,
            value: 1,
            labels: { error: error.message }
        });
    }

    async shutdown(): Promise<void> {
        this.isRunning = false;

        // Wait for in-progress messages to complete
        await Promise.all(Array.from(this.processing.values()));
        
        // Close connections
        await this.redis.quit();
    }
}

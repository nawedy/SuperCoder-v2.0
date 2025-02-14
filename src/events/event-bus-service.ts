import { MonitoringService } from '../monitoring/monitoring-service';
import { PubSub, Topic, Subscription } from '@google-cloud/pubsub';
import { v4 as uuidv4 } from 'uuid';

interface Event {
    id: string;
    type: string;
    source: string;
    data: any;
    metadata: {
        timestamp: Date;
        correlation_id?: string;
        causation_id?: string;
        severity: 'low' | 'medium' | 'high';
        environment: string;
    };
}

interface Subscriber {
    id: string;
    topic: string;
    handler: (event: Event) => Promise<void>;
    filter?: (event: Event) => boolean;
    retryConfig?: {
        maxRetries: number;
        backoff: {
            initialDelayMs: number;
            maxDelayMs: number;
            multiplier: number;
        };
    };
}

interface PublishOptions {
    priority?: 'high' | 'normal' | 'low';
    deduplicationId?: string;
    delaySeconds?: number;
}

export class EventBusService {
    private monitor: MonitoringService;
    private pubsub: PubSub;
    private topics: Map<string, Topic>;
    private subscriptions: Map<string, Subscription>;
    private subscribers: Map<string, Subscriber>;
    private readonly MAX_BATCH_SIZE = 1000;
    private readonly DEFAULT_RETRY_CONFIG = {
        maxRetries: 3,
        backoff: {
            initialDelayMs: 100,
            maxDelayMs: 10000,
            multiplier: 2
        }
    };

    constructor(
        monitor: MonitoringService,
        config: {
            projectId: string;
        }
    ) {
        this.monitor = monitor;
        this.pubsub = new PubSub({ projectId: config.projectId });
        this.topics = new Map();
        this.subscriptions = new Map();
        this.subscribers = new Map();

        this.initialize();
    }

    private async initialize(): Promise<void> {
        await this.setupInfrastructure();
        this.startErrorMonitoring();
    }

    async publish(
        topic: string,
        event: Omit<Event, 'id' | 'metadata'>,
        options?: PublishOptions
    ): Promise<string> {
        const startTime = Date.now();
        try {
            // Generate event ID and metadata
            const eventId = uuidv4();
            const fullEvent: Event = {
                ...event,
                id: eventId,
                metadata: {
                    timestamp: new Date(),
                    severity: options?.priority || 'normal',
                    environment: process.env.NODE_ENV || 'development'
                }
            };

            // Get or create topic
            const pubsubTopic = await this.getOrCreateTopic(topic);

            // Prepare message attributes
            const attributes = {
                event_id: eventId,
                event_type: event.type,
                source: event.source,
                priority: options?.priority || 'normal',
                deduplication_id: options?.deduplicationId || eventId
            };

            // Publish event
            const messageId = await pubsubTopic.publish(
                Buffer.from(JSON.stringify(fullEvent)),
                attributes
            );

            // Record metrics
            await this.monitor.recordMetric({
                name: 'event_published',
                value: Date.now() - startTime,
                labels: {
                    topic,
                    event_type: event.type,
                    priority: options?.priority || 'normal'
                }
            });

            return messageId;

        } catch (error) {
            await this.handleError('event_publish_error', error);
            throw error;
        }
    }

    async subscribe(subscriber: Subscriber): Promise<void> {
        try {
            // Get or create topic
            const topic = await this.getOrCreateTopic(subscriber.topic);

            // Create subscription name
            const subscriptionName = `${subscriber.topic}-${subscriber.id}`;

            // Create subscription
            const [subscription] = await topic.createSubscription(subscriptionName, {
                retryPolicy: subscriber.retryConfig || this.DEFAULT_RETRY_CONFIG
            });

            // Store subscriber
            this.subscribers.set(subscriber.id, subscriber);
            this.subscriptions.set(subscriber.id, subscription);

            // Setup message handler
            subscription.on('message', async (message) => {
                try {
                    const event: Event = JSON.parse(message.data.toString());

                    // Apply filter if exists
                    if (subscriber.filter && !subscriber.filter(event)) {
                        message.ack();
                        return;
                    }

                    // Process event
                    await this.processEvent(subscriber, event);
                    message.ack();

                } catch (error) {
                    await this.handleError('event_processing_error', error);
                    message.nack();
                }
            });

            subscription.on('error', async (error) => {
                await this.handleError('subscription_error', error);
            });

        } catch (error) {
            await this.handleError('subscription_creation_error', error);
            throw error;
        }
    }

    async unsubscribe(subscriberId: string): Promise<void> {
        try {
            const subscription = this.subscriptions.get(subscriberId);
            if (subscription) {
                await subscription.delete();
                this.subscriptions.delete(subscriberId);
                this.subscribers.delete(subscriberId);
            }
        } catch (error) {
            await this.handleError('unsubscribe_error', error);
            throw error;
        }
    }

    private async processEvent(
        subscriber: Subscriber,
        event: Event
    ): Promise<void> {
        const startTime = Date.now();
        try {
            await subscriber.handler(event);

            // Record metrics
            await this.monitor.recordMetric({
                name: 'event_processed',
                value: Date.now() - startTime,
                labels: {
                    subscriber_id: subscriber.id,
                    topic: subscriber.topic,
                    event_type: event.type
                }
            });

        } catch (error) {
            await this.handleError('event_handler_error', error);
            throw error;
        }
    }

    private async getOrCreateTopic(name: string): Promise<Topic> {
        // Check cache
        const cached = this.topics.get(name);
        if (cached) return cached;

        // Get or create topic
        const [topic] = await this.pubsub.topic(name).get({
            autoCreate: true
        });

        // Cache topic
        this.topics.set(name, topic);
        return topic;
    }

    private async setupInfrastructure(): Promise<void> {
        // Create default topics
        const defaultTopics = [
            'system.events',
            'security.alerts',
            'model.updates',
            'data.changes'
        ];

        await Promise.all(
            defaultTopics.map(topic => this.getOrCreateTopic(topic))
        );
    }

    private startErrorMonitoring(): void {
        this.pubsub.on('error', async (error) => {
            await this.handleError('pubsub_error', error);
        });
    }

    private async handleError(type: string, error: Error): Promise<void> {
        await this.monitor.recordMetric({
            name: type,
            value: 1,
            labels: { error: error.message }
        });

        // Self-publish error event
        try {
            await this.publish('system.events', {
                type: 'event_bus.error',
                source: 'event-bus',
                data: {
                    error: error.message,
                    type,
                    timestamp: new Date()
                }
            });
        } catch (e) {
            // Avoid infinite recursion
            console.error('Failed to publish error event:', e);
        }
    }
}

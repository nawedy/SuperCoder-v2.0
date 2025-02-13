import { MonitoringService } from '../monitoring/monitoring-service';
import { AuditTrailService } from '../audit/audit-trail-service';
import { PubSub, Topic, Subscription } from '@google-cloud/pubsub';

interface EventSubscription {
    id: string;
    topic: string;
    handler: (event: SystemEvent) => Promise<void>;
    filter?: (event: SystemEvent) => boolean;
    errorHandler?: (error: Error, event: SystemEvent) => Promise<void>;
    options: {
        retryPolicy?: {
            maxRetries: number;
            backoffSeconds: number;
        };
        deadLetterTopic?: string;
        orderingKey?: string;
    };
}

interface SystemEvent {
    id: string;
    type: string;
    source: string;
    timestamp: Date;
    data: any;
    metadata: {
        correlationId?: string;
        causationId?: string;
        version: string;
        environment: string;
    };
}

export class EventBusService {
    private monitor: MonitoringService;
    private audit: AuditTrailService;
    private pubsub: PubSub;
    private topics: Map<string, Topic>;
    private subscriptions: Map<string, Subscription>;
    private handlers: Map<string, EventSubscription[]>;

    constructor(
        monitor: MonitoringService,
        audit: AuditTrailService,
        projectId: string
    ) {
        this.monitor = monitor;
        this.audit = audit;
        this.pubsub = new PubSub({ projectId });
        this.topics = new Map();
        this.subscriptions = new Map();
        this.handlers = new Map();

        this.initialize();
    }

    private async initialize(): Promise<void> {
        await this.setupDefaultTopics();
    }

    async publish(
        topic: string,
        event: Omit<SystemEvent, 'id' | 'timestamp'>
    ): Promise<string> {
        const startTime = Date.now();
        try {
            const pubsubTopic = await this.ensureTopic(topic);
            
            const fullEvent: SystemEvent = {
                ...event,
                id: this.generateEventId(),
                timestamp: new Date(),
            };

            const messageId = await pubsubTopic.publish(
                Buffer.from(JSON.stringify(fullEvent)),
                {
                    eventId: fullEvent.id,
                    eventType: fullEvent.type,
                    source: fullEvent.source,
                    timestamp: fullEvent.timestamp.toISOString(),
                    correlationId: fullEvent.metadata.correlationId
                }
            );

            await this.monitor.recordMetric({
                name: 'event_published',
                value: Date.now() - startTime,
                labels: {
                    topic,
                    event_type: event.type,
                    source: event.source
                }
            });

            return messageId;

        } catch (error) {
            await this.handleError('event_publish_error', error);
            throw error;
        }
    }

    async subscribe(subscription: EventSubscription): Promise<() => Promise<void>> {
        try {
            const pubsubTopic = await this.ensureTopic(subscription.topic);

            const subName = this.generateSubscriptionName(
                subscription.topic,
                subscription.id
            );

            const pubsubSubscription = await this.ensureSubscription(
                pubsubTopic,
                subName,
                subscription.options
            );

            const existingHandlers = this.handlers.get(subscription.topic) || [];
            this.handlers.set(subscription.topic, [...existingHandlers, subscription]);

            // Setup message handler
            pubsubSubscription.on('message', async (message) => {
                try {
                    const event = JSON.parse(message.data.toString()) as SystemEvent;

                    if (!subscription.filter || subscription.filter(event)) {
                        await subscription.handler(event);
                    }

                    message.ack();

                } catch (error) {
                    if (subscription.errorHandler) {
                        await subscription.errorHandler(error, JSON.parse(message.data.toString()));
                    }
                    message.nack();
                }
            });

            // Setup error handler
            pubsubSubscription.on('error', async (error) => {
                await this.handleError('subscription_error', error);
            });

            await this.audit.logEvent({
                eventType: 'system.config',
                actor: {
                    id: 'system',
                    type: 'service',
                    metadata: {}
                },
                resource: {
                    type: 'event-subscription',
                    id: subscription.id,
                    action: 'create'
                },
                context: {
                    location: 'event-bus',
                    ipAddress: 'internal',
                    userAgent: 'system'
                },
                status: 'success',
                details: {
                    topic: subscription.topic,
                    subscription_name: subName
                }
            });

            // Return unsubscribe function
            return async () => {
                await this.unsubscribe(subscription.topic, subscription.id);
            };

        } catch (error) {
            await this.handleError('subscription_creation_error', error);
            throw error;
        }
    }

    private async unsubscribe(topic: string, subscriptionId: string): Promise<void> {
        try {
            const subName = this.generateSubscriptionName(topic, subscriptionId);
            const subscription = this.subscriptions.get(subName);

            if (subscription) {
                await subscription.close();
                this.subscriptions.delete(subName);

                // Remove handler
                const handlers = this.handlers.get(topic) || [];
                this.handlers.set(
                    topic,
                    handlers.filter(h => h.id !== subscriptionId)
                );
            }

        } catch (error) {
            await this.handleError('unsubscribe_error', error);
            throw error;
        }
    }

    private async setupDefaultTopics(): Promise<void> {
        const defaultTopics = [
            'system.events',
            'model.events',
            'security.events',
            'audit.events'
        ];

        for (const topic of defaultTopics) {
            await this.ensureTopic(topic);
        }
    }

    private async ensureTopic(name: string): Promise<Topic> {
        if (this.topics.has(name)) {
            return this.topics.get(name)!;
        }

        const [topic] = await this.pubsub.topic(name).get({
            autoCreate: true
        });

        this.topics.set(name, topic);
        return topic;
    }

    private async ensureSubscription(
        topic: Topic,
        name: string,
        options: EventSubscription['options']
    ): Promise<Subscription> {
        if (this.subscriptions.has(name)) {
            return this.subscriptions.get(name)!;
        }

        const [subscription] = await topic.createSubscription(name, {
            retryPolicy: options.retryPolicy && {
                maximumRetries: options.retryPolicy.maxRetries,
                minimumBackoff: {
                    seconds: options.retryPolicy.backoffSeconds
                },
                maximumBackoff: {
                    seconds: options.retryPolicy.backoffSeconds * 10
                }
            },
            deadLetterPolicy: options.deadLetterTopic && {
                deadLetterTopic: options.deadLetterTopic,
                maxDeliveryAttempts: options.retryPolicy?.maxRetries || 5
            },
            enableMessageOrdering: !!options.orderingKey
        });

        this.subscriptions.set(name, subscription);
        return subscription;
    }

    private generateSubscriptionName(topic: string, id: string): string {
        return `${topic.replace(/\./g, '-')}-${id}`;
    }

    private generateEventId(): string {
        return `evt-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }

    private async handleError(type: string, error: Error): Promise<void> {
        await this.monitor.recordMetric({
            name: type,
            value: 1,
            labels: { error: error.message }
        });
    }
}

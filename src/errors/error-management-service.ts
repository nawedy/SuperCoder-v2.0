import { MonitoringService } from '../monitoring/monitoring-service';
import { AuditTrailService } from '../audit/audit-trail-service';
import { ErrorReporting } from '@google-cloud/error-reporting';
import { PubSub } from '@google-cloud/pubsub';

interface ErrorEvent {
    id: string;
    timestamp: Date;
    level: 'critical' | 'error' | 'warning';
    source: {
        service: string;
        method: string;
        line?: number;
        file?: string;
    };
    error: {
        name: string;
        message: string;
        stack?: string;
        code?: string;
    };
    context: {
        userId?: string;
        requestId?: string;
        metadata: Record<string, any>;
    };
    status: 'new' | 'investigating' | 'resolved';
}

interface ErrorPattern {
    id: string;
    pattern: RegExp;
    level: ErrorEvent['level'];
    action: 'alert' | 'retry' | 'ignore';
    metadata: {
        description: string;
        resolution?: string;
        maxRetries?: number;
    };
}

export class ErrorManagementService {
    private monitor: MonitoringService;
    private audit: AuditTrailService;
    private errorReporting: ErrorReporting;
    private pubsub: PubSub;
    private patterns: Map<string, ErrorPattern>;
    private readonly ERROR_TOPIC = 'error-events';

    constructor(
        monitor: MonitoringService,
        audit: AuditTrailService,
        projectId: string
    ) {
        this.monitor = monitor;
        this.audit = audit;
        this.errorReporting = new ErrorReporting({ projectId });
        this.pubsub = new PubSub({ projectId });
        this.patterns = this.initializePatterns();

        this.setupErrorSubscription();
    }

    async handleError(
        error: Error,
        context: Partial<ErrorEvent['context']> = {},
        source: Partial<ErrorEvent['source']> = {}
    ): Promise<ErrorEvent> {
        try {
            // Create error event
            const errorEvent = await this.createErrorEvent(error, context, source);

            // Check for known patterns
            const pattern = this.findMatchingPattern(errorEvent);
            if (pattern) {
                await this.handlePatternMatch(errorEvent, pattern);
            }

            // Report error
            await this.reportError(errorEvent);

            // Publish event
            await this.publishErrorEvent(errorEvent);

            // Record metric
            await this.monitor.recordMetric({
                name: 'error_handled',
                value: 1,
                labels: {
                    level: errorEvent.level,
                    source: errorEvent.source.service,
                    error_type: error.name
                }
            });

            return errorEvent;

        } catch (e) {
            // Fallback error handling
            console.error('Error in error handling:', e);
            await this.monitor.recordMetric({
                name: 'error_handling_failure',
                value: 1,
                labels: { error: e.message }
            });
            throw e;
        }
    }

    async addErrorPattern(pattern: Omit<ErrorPattern, 'id'>): Promise<ErrorPattern> {
        const patternId = this.generatePatternId();
        const newPattern: ErrorPattern = {
            ...pattern,
            id: patternId
        };

        this.patterns.set(patternId, newPattern);

        await this.audit.logEvent({
            eventType: 'system.config',
            actor: {
                id: 'system',
                type: 'service',
                metadata: {}
            },
            resource: {
                type: 'error-pattern',
                id: patternId,
                action: 'create'
            },
            context: {
                location: 'error-management',
                ipAddress: 'internal',
                userAgent: 'system'
            },
            status: 'success',
            details: { pattern: newPattern }
        });

        return newPattern;
    }

    private initializePatterns(): Map<string, ErrorPattern> {
        const patterns = new Map<string, ErrorPattern>();

        // Add default patterns
        patterns.set('timeout', {
            id: 'timeout',
            pattern: /timeout|timed? out/i,
            level: 'error',
            action: 'retry',
            metadata: {
                description: 'Operation timeout',
                maxRetries: 3
            }
        });

        patterns.set('permission', {
            id: 'permission',
            pattern: /permission|unauthorized|forbidden/i,
            level: 'error',
            action: 'alert',
            metadata: {
                description: 'Permission denied',
                resolution: 'Check access rights'
            }
        });

        return patterns;
    }

    private async createErrorEvent(
        error: Error,
        context: Partial<ErrorEvent['context']>,
        source: Partial<ErrorEvent['source']>
    ): Promise<ErrorEvent> {
        return {
            id: this.generateErrorId(),
            timestamp: new Date(),
            level: this.determineErrorLevel(error),
            source: {
                service: source.service || 'unknown',
                method: source.method || 'unknown',
                line: source.line,
                file: source.file
            },
            error: {
                name: error.name,
                message: error.message,
                stack: error.stack,
                code: (error as any).code
            },
            context: {
                userId: context.userId,
                requestId: context.requestId,
                metadata: context.metadata || {}
            },
            status: 'new'
        };
    }

    private determineErrorLevel(error: Error): ErrorEvent['level'] {
        if (error instanceof TypeError || error instanceof ReferenceError) {
            return 'critical';
        }
        if (error.message.toLowerCase().includes('timeout')) {
            return 'warning';
        }
        return 'error';
    }

    private findMatchingPattern(errorEvent: ErrorEvent): ErrorPattern | undefined {
        for (const pattern of this.patterns.values()) {
            if (pattern.pattern.test(errorEvent.error.message)) {
                return pattern;
            }
        }
        return undefined;
    }

    private async handlePatternMatch(
        errorEvent: ErrorEvent,
        pattern: ErrorPattern
    ): Promise<void> {
        switch (pattern.action) {
            case 'alert':
                await this.triggerAlert(errorEvent, pattern);
                break;
            case 'retry':
                await this.handleRetry(errorEvent, pattern);
                break;
            case 'ignore':
                // Log but don't take action
                break;
        }
    }

    private async triggerAlert(
        errorEvent: ErrorEvent,
        pattern: ErrorPattern
    ): Promise<void> {
        await this.pubsub
            .topic('error-alerts')
            .publish(Buffer.from(JSON.stringify({
                errorEvent,
                pattern,
                timestamp: new Date()
            })));
    }

    private async handleRetry(
        errorEvent: ErrorEvent,
        pattern: ErrorPattern
    ): Promise<void> {
        const retryCount = errorEvent.context.metadata.retryCount || 0;
        if (retryCount < (pattern.metadata.maxRetries || 3)) {
            await this.pubsub
                .topic('error-retries')
                .publish(Buffer.from(JSON.stringify({
                    errorEvent,
                    retryCount: retryCount + 1
                })));
        }
    }

    private async reportError(errorEvent: ErrorEvent): Promise<void> {
        this.errorReporting.report(errorEvent.error.message, {
            user: errorEvent.context.userId,
            service: errorEvent.source.service,
            serviceContext: {
                service: errorEvent.source.service,
                version: process.env.SERVICE_VERSION
            }
        });
    }

    private async publishErrorEvent(errorEvent: ErrorEvent): Promise<void> {
        await this.pubsub
            .topic(this.ERROR_TOPIC)
            .publish(Buffer.from(JSON.stringify(errorEvent)));
    }

    private async setupErrorSubscription(): Promise<void> {
        const subscription = this.pubsub
            .topic(this.ERROR_TOPIC)
            .subscription('error-processor');

        subscription.on('message', async (message) => {
            try {
                const errorEvent = JSON.parse(message.data.toString());
                await this.processErrorEvent(errorEvent);
                message.ack();
            } catch (error) {
                console.error('Error processing message:', error);
                message.nack();
            }
        });
    }

    private async processErrorEvent(errorEvent: ErrorEvent): Promise<void> {
        // Implement error event processing logic
        // This could include aggregation, analysis, etc.
    }

    private generateErrorId(): string {
        return `err-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }

    private generatePatternId(): string {
        return `pat-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }
}

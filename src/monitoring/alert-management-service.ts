import { MonitoringService } from './monitoring-service';
import { EventBusService } from '../events/event-bus-service';
import { createClient as createRedisClient } from 'redis';
import { BigQuery } from '@google-cloud/bigquery';
import { SNS } from '@aws-sdk/client-sns';
import { WebClient as SlackClient } from '@slack/web-api';
import { v4 as uuidv4 } from 'uuid';

interface Alert {
    id: string;
    type: string;
    severity: 'critical' | 'high' | 'medium' | 'low';
    source: string;
    message: string;
    metadata: Record<string, any>;
    status: 'active' | 'acknowledged' | 'resolved';
    created: Date;
    updated: Date;
    acknowledgedBy?: string;
    resolvedBy?: string;
    notifications: AlertNotification[];
}

interface AlertRule {
    id: string;
    name: string;
    condition: {
        metric: string;
        operator: 'gt' | 'lt' | 'eq' | 'ne';
        value: number;
        duration?: number;
    };
    severity: Alert['severity'];
    notifications: {
        channels: ('email' | 'slack' | 'sms')[];
        recipients: string[];
    };
    cooldown: number;
    enabled: boolean;
}

interface AlertNotification {
    id: string;
    channel: 'email' | 'slack' | 'sms';
    recipient: string;
    status: 'pending' | 'sent' | 'failed';
    timestamp: Date;
    error?: string;
}

export class AlertManagementService {
    private redis: ReturnType<typeof createRedisClient>;
    private bigquery: BigQuery;
    private sns: SNS;
    private slack?: SlackClient;
    private rules: Map<string, AlertRule>;
    private activeAlerts: Map<string, Alert>;
    private cooldowns: Map<string, Date>;
    
    private readonly ALERT_TTL = 86400; // 24 hours
    private readonly CHECK_INTERVAL = 60000; // 1 minute

    constructor(
        private monitor: MonitoringService,
        private eventBus: EventBusService,
        private config: {
            redisUrl: string;
            projectId: string;
            region: string;
            slack?: { token: string };
        }
    ) {
        this.redis = createRedisClient({ url: config.redisUrl });
        this.bigquery = new BigQuery({ projectId: config.config.projectId });
        this.sns = new SNS({ region: config.region });
        if (config.slack) {
            this.slack = new SlackClient(config.slack.token);
        }
        
        this.rules = new Map();
        this.activeAlerts = new Map();
        this.cooldowns = new Map();
        
        this.initialize();
    }

    private async initialize(): Promise<void> {
        await this.redis.connect();
        await this.loadAlertRules();
        await this.loadActiveAlerts();
        this.startAlertCheck();
        this.setupEventListeners();
    }

    async createAlertRule(rule: Omit<AlertRule, 'id'>): Promise<string> {
        const ruleId = uuidv4();
        const newRule: AlertRule = {
            ...rule,
            id: ruleId
        };

        this.rules.set(ruleId, newRule);
        await this.saveAlertRules();

        await this.monitor.recordMetric({
            name: 'alert_rule_created',
            value: 1,
            labels: { rule_id: ruleId }
        });

        return ruleId;
    }

    async updateAlertRule(ruleId: string, updates: Partial<AlertRule>): Promise<void> {
        const rule = this.rules.get(ruleId);
        if (!rule) throw new Error('Alert rule not found');

        const updatedRule = {
            ...rule,
            ...updates,
            updated: new Date()
        };

        this.rules.set(ruleId, updatedRule);
        await this.saveAlertRules();
    }

    async deleteAlertRule(ruleId: string): Promise<void> {
        this.rules.delete(ruleId);
        await this.saveAlertRules();
    }

    async acknowledgeAlert(alertId: string, userId: string): Promise<void> {
        const alert = this.activeAlerts.get(alertId);
        if (!alert) throw new Error('Alert not found');

        alert.status = 'acknowledged';
        alert.acknowledgedBy = userId;
        alert.updated = new Date();

        await this.updateAlert(alert);
        await this.notifyAlertUpdate(alert);
    }

    async resolveAlert(alertId: string, userId: string): Promise<void> {
        const alert = this.activeAlerts.get(alertId);
        if (!alert) throw new Error('Alert not found');

        alert.status = 'resolved';
        alert.resolvedBy = userId;
        alert.updated = new Date();

        await this.updateAlert(alert);
        await this.notifyAlertUpdate(alert);
        this.activeAlerts.delete(alertId);
    }

    private async loadAlertRules(): Promise<void> {
        const saved = await this.redis.get('alert_rules');
        if (saved) {
            const rules = JSON.parse(saved);
            rules.forEach((rule: AlertRule) => {
                this.rules.set(rule.id, rule);
            });
        }
    }

    private async saveAlertRules(): Promise<void> {
        await this.redis.set(
            'alert_rules',
            JSON.stringify(Array.from(this.rules.values()))
        );
    }

    private async loadActiveAlerts(): Promise<void> {
        const saved = await this.redis.get('active_alerts');
        if (saved) {
            const alerts = JSON.parse(saved);
            alerts.forEach((alert: Alert) => {
                this.activeAlerts.set(alert.id, {
                    ...alert,
                    created: new Date(alert.created),
                    updated: new Date(alert.updated)
                });
            });
        }
    }

    private async saveActiveAlerts(): Promise<void> {
        await this.redis.set(
            'active_alerts',
            JSON.stringify(Array.from(this.activeAlerts.values()))
        );
    }

    private startAlertCheck(): void {
        setInterval(async () => {
            try {
                await this.checkAlertConditions();
            } catch (error) {
                await this.handleError('alert_check_error', error);
            }
        }, this.CHECK_INTERVAL);
    }

    private async checkAlertConditions(): Promise<void> {
        const metrics = await this.monitor.getMetrics({
            timeframe: '5m'
        });

        for (const rule of this.rules.values()) {
            if (!rule.enabled) continue;

            const matchingMetrics = metrics.filter(m => m.name === rule.condition.metric);
            if (!matchingMetrics.length) continue;

            const violatesCondition = this.evaluateCondition(
                matchingMetrics,
                rule.condition
            );

            if (violatesCondition && !this.isInCooldown(rule.id)) {
                await this.createAlert(rule, matchingMetrics);
                this.setCooldown(rule.id, rule.cooldown);
            }
        }
    }

    private evaluateCondition(
        metrics: any[],
        condition: AlertRule['condition']
    ): boolean {
        const value = metrics.reduce((sum, m) => sum + m.value, 0) / metrics.length;

        switch (condition.operator) {
            case 'gt': return value > condition.value;
            case 'lt': return value < condition.value;
            case 'eq': return value === condition.value;
            case 'ne': return value !== condition.value;
            default: return false;
        }
    }

    private async createAlert(rule: AlertRule, metrics: any[]): Promise<void> {
        const alertId = uuidv4();
        const alert: Alert = {
            id: alertId,
            type: rule.name,
            severity: rule.severity,
            source: 'monitoring',
            message: this.formatAlertMessage(rule, metrics),
            metadata: {
                ruleId: rule.id,
                metrics: metrics.map(m => ({
                    name: m.name,
                    value: m.value,
                    timestamp: m.timestamp
                }))
            },
            status: 'active',
            created: new Date(),
            updated: new Date(),
            notifications: []
        };

        this.activeAlerts.set(alertId, alert);
        await this.saveActiveAlerts();
        await this.sendNotifications(alert, rule.notifications);
        await this.notifyAlertCreated(alert);
    }

    private formatAlertMessage(rule: AlertRule, metrics: any[]): string {
        const value = metrics.reduce((sum, m) => sum + m.value, 0) / metrics.length;
        return `${rule.name}: ${rule.condition.metric} is ${rule.condition.operator} ${rule.condition.value} (current: ${value})`;
    }

    private async sendNotifications(
        alert: Alert,
        notifications: AlertRule['notifications']
    ): Promise<void> {
        const promises = notifications.channels.flatMap(channel =>
            notifications.recipients.map(recipient =>
                this.sendNotification(alert, channel, recipient)
            )
        );

        const results = await Promise.allSettled(promises);
        
        alert.notifications = results.map((result, index) => ({
            id: uuidv4(),
            channel: notifications.channels[Math.floor(index / notifications.recipients.length)],
            recipient: notifications.recipients[index % notifications.recipients.length],
            status: result.status === 'fulfilled' ? 'sent' : 'failed',
            timestamp: new Date(),
            error: result.status === 'rejected' ? result.reason.message : undefined
        }));

        await this.updateAlert(alert);
    }

    private async sendNotification(
        alert: Alert,
        channel: 'email' | 'slack' | 'sms',
        recipient: string
    ): Promise<void> {
        switch (channel) {
            case 'email':
                await this.sendEmailNotification(alert, recipient);
                break;
            case 'slack':
                await this.sendSlackNotification(alert, recipient);
                break;
            case 'sms':
                await this.sendSMSNotification(alert, recipient);
                break;
        }
    }

    private async sendEmailNotification(alert: Alert, recipient: string): Promise<void> {
        await this.sns.publish({
            TopicArn: process.env.SNS_TOPIC_ARN,
            Message: JSON.stringify({
                default: alert.message,
                email: this.formatEmailMessage(alert)
            }),
            Subject: `Alert: ${alert.type}`,
            MessageStructure: 'json'
        });
    }

    private async sendSlackNotification(alert: Alert, channel: string): Promise<void> {
        if (!this.slack) return;

        await this.slack.chat.postMessage({
            channel,
            text: alert.message,
            blocks: [
                {
                    type: 'header',
                    text: {
                        type: 'plain_text',
                        text: `Alert: ${alert.type}`
                    }
                },
                {
                    type: 'section',
                    text: {
                        type: 'mrkdwn',
                        text: this.formatSlackMessage(alert)
                    }
                }
            ]
        });
    }

    private async sendSMSNotification(alert: Alert, phoneNumber: string): Promise<void> {
        await this.sns.publish({
            PhoneNumber: phoneNumber,
            Message: alert.message
        });
    }

    private formatEmailMessage(alert: Alert): string {
        return `
Alert Details:
Type: ${alert.type}
Severity: ${alert.severity}
Message: ${alert.message}
Created: ${alert.created.toISOString()}
Status: ${alert.status}
        `;
    }

    private formatSlackMessage(alert: Alert): string {
        return `
*Alert Details*
• Type: ${alert.type}
• Severity: ${alert.severity}
• Message: ${alert.message}
• Created: ${alert.created.toISOString()}
• Status: ${alert.status}
        `;
    }

    private async updateAlert(alert: Alert): Promise<void> {
        this.activeAlerts.set(alert.id, alert);
        await this.saveActiveAlerts();
    }

    private async notifyAlertCreated(alert: Alert): Promise<void> {
        await this.eventBus.publish('alert.created', {
            type: 'alert.created',
            source: 'alert-management',
            data: alert
        });
    }

    private async notifyAlertUpdate(alert: Alert): Promise<void> {
        await this.eventBus.publish('alert.updated', {
            type: 'alert.updated',
            source: 'alert-management',
            data: alert
        });
    }

    private isInCooldown(ruleId: string): boolean {
        const cooldownEnd = this.cooldowns.get(ruleId);
        return cooldownEnd ? cooldownEnd > new Date() : false;
    }

    private setCooldown(ruleId: string, duration: number): void {
        this.cooldowns.set(ruleId, new Date(Date.now() + duration * 1000));
    }

    private setupEventListeners(): void {
        this.eventBus.subscribe({
            id: 'alert-monitor',
            topic: 'system.metrics',
            handler: async (event) => {
                if (event.data.type === 'threshold_breach') {
                    await this.handleMetricBreach(event.data);
                }
            }
        });
    }

    private async handleMetricBreach(data: any): Promise<void> {
        const matchingRules = Array.from(this.rules.values())
            .filter(rule => rule.enabled && rule.condition.metric === data.metric);

        for (const rule of matchingRules) {
            if (this.evaluateCondition([data], rule.condition)) {
                await this.createAlert(rule, [data]);
            }
        }
    }

    private async handleError(type: string, error: Error): Promise<void> {
        await this.monitor.recordMetric({
            name: `alert_${type}`,
            value: 1,
            labels: { error: error.message }
        });

        await this.eventBus.publish('alert.error', {
            type: 'alert.error',
            source: 'alert-management',
            data: {
                error: error.message,
                type,
                timestamp: new Date()
            }
        });
    }

    async close(): Promise<void> {
        await this.redis.quit();
    }
}

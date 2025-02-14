import { MonitoringService } from '../../monitoring/monitoring-service';
import { EventBusService } from '../../events/event-bus-service';
import { DeploymentStatus } from '../deployment-pipeline-service';
import { TestResult } from '../testing/deployment-testing-service';
import { SNS } from '@aws-sdk/client-sns';
import { WebClient as SlackClient } from '@slack/web-api';
import { Octokit } from '@octokit/rest';

interface NotificationChannel {
    type: 'email' | 'slack' | 'teams' | 'github';
    config: {
        recipients?: string[];
        channel?: string;
        webhook?: string;
    };
}

interface NotificationTemplate {
    id: string;
    type: 'deployment' | 'test' | 'alert';
    subject: string;
    body: string;
    priority: 'high' | 'normal' | 'low';
}

export class DeploymentNotificationService {
    private sns: SNS;
    private slack: SlackClient;
    private github: Octokit;
    private templates: Map<string, NotificationTemplate>;
    private channels: NotificationChannel[];

    constructor(
        private monitor: MonitoringService,
        private eventBus: EventBusService,
        private config: {
            aws: { region: string };
            slack?: { token: string };
            github?: { token: string };
            defaultChannels: NotificationChannel[];
        }
    ) {
        this.sns = new SNS({ region: config.aws.region });
        if (config.slack) {
            this.slack = new SlackClient(config.slack.token);
        }
        if (config.github) {
            this.github = new Octokit({ auth: config.github.token });
        }
        this.channels = config.defaultChannels;
        this.templates = new Map();
        this.initialize();
    }

    private async initialize(): Promise<void> {
        await this.loadTemplates();
        this.setupEventListeners();
    }

    async notifyDeploymentStatus(
        status: DeploymentStatus,
        channels?: NotificationChannel[]
    ): Promise<void> {
        const template = this.templates.get('deployment_status');
        if (!template) throw new Error('Deployment status template not found');

        const notification = this.formatDeploymentNotification(status, template);
        await this.sendNotifications(notification, channels || this.channels);
    }

    async notifyTestResults(
        results: TestResult[],
        deploymentId: string,
        channels?: NotificationChannel[]
    ): Promise<void> {
        const template = this.templates.get('test_results');
        if (!template) throw new Error('Test results template not found');

        const notification = this.formatTestResultsNotification(results, deploymentId, template);
        await this.sendNotifications(notification, channels || this.channels);
    }

    private async sendNotifications(
        notification: { subject: string; body: string; priority: string },
        channels: NotificationChannel[]
    ): Promise<void> {
        const startTime = Date.now();

        try {
            await Promise.all(
                channels.map(channel => this.sendToChannel(channel, notification))
            );

            await this.monitor.recordMetric({
                name: 'notifications_sent',
                value: channels.length,
                labels: {
                    duration: (Date.now() - startTime).toString(),
                    priority: notification.priority
                }
            });

        } catch (error) {
            await this.handleError('notification_error', error);
        }
    }

    private async sendToChannel(
        channel: NotificationChannel,
        notification: { subject: string; body: string; priority: string }
    ): Promise<void> {
        switch (channel.type) {
            case 'email':
                await this.sendEmail(channel.config.recipients!, notification);
                break;
            case 'slack':
                await this.sendSlack(channel.config.channel!, notification);
                break;
            case 'teams':
                await this.sendTeams(channel.config.webhook!, notification);
                break;
            case 'github':
                await this.sendGithub(notification);
                break;
        }
    }

    private async sendEmail(
        recipients: string[],
        notification: { subject: string; body: string }
    ): Promise<void> {
        await this.sns.publish({
            TopicArn: process.env.SNS_TOPIC_ARN,
            Message: JSON.stringify({
                default: notification.body,
                email: notification.body
            }),
            Subject: notification.subject,
            MessageStructure: 'json'
        });
    }

    private async sendSlack(
        channel: string,
        notification: { subject: string; body: string }
    ): Promise<void> {
        if (!this.slack) return;

        await this.slack.chat.postMessage({
            channel,
            text: notification.subject,
            blocks: [
                {
                    type: 'header',
                    text: {
                        type: 'plain_text',
                        text: notification.subject
                    }
                },
                {
                    type: 'section',
                    text: {
                        type: 'mrkdwn',
                        text: notification.body
                    }
                }
            ]
        });
    }

    private async sendTeams(
        webhook: string,
        notification: { subject: string; body: string }
    ): Promise<void> {
        await fetch(webhook, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: notification.subject,
                text: notification.body
            })
        });
    }

    private async sendGithub(
        notification: { subject: string; body: string }
    ): Promise<void> {
        if (!this.github) return;

        // Create a GitHub issue or comment
        await this.github.issues.create({
            owner: process.env.GITHUB_OWNER!,
            repo: process.env.GITHUB_REPO!,
            title: notification.subject,
            body: notification.body
        });
    }

    private formatDeploymentNotification(
        status: DeploymentStatus,
        template: NotificationTemplate
    ): { subject: string; body: string; priority: string } {
        const duration = status.endTime 
            ? Math.round((status.endTime.getTime() - status.startTime.getTime()) / 1000)
            : 0;

        const serviceStatus = Object.entries(status.services)
            .map(([service, details]) => `${service}: ${details?.status}`)
            .join('\n');

        return {
            subject: template.subject
                .replace('{{status}}', status.status)
                .replace('{{environment}}', status.environment),
            body: template.body
                .replace('{{id}}', status.id)
                .replace('{{duration}}', `${duration}s`)
                .replace('{{services}}', serviceStatus)
                .replace('{{error}}', status.error || 'None'),
            priority: status.status === 'failed' ? 'high' : 'normal'
        };
    }

    private formatTestResultsNotification(
        results: TestResult[],
        deploymentId: string,
        template: NotificationTemplate
    ): { subject: string; body: string; priority: string } {
        const total = results.length;
        const passed = results.filter(r => r.status === 'passed').length;
        const failed = results.filter(r => r.status === 'failed').length;

        const failureDetails = results
            .filter(r => r.status === 'failed')
            .map(r => `${r.suiteId}/${r.testId}: ${r.error}`)
            .join('\n');

        return {
            subject: template.subject
                .replace('{{total}}', total.toString())
                .replace('{{passed}}', passed.toString()),
            body: template.body
                .replace('{{deployment_id}}', deploymentId)
                .replace('{{total}}', total.toString())
                .replace('{{passed}}', passed.toString())
                .replace('{{failed}}', failed.toString())
                .replace('{{failures}}', failureDetails || 'None'),
            priority: failed > 0 ? 'high' : 'normal'
        };
    }

    private async loadTemplates(): Promise<void> {
        // Load notification templates from configuration or database
        this.templates.set('deployment_status', {
            id: 'deployment_status',
            type: 'deployment',
            subject: 'Deployment {{status}} in {{environment}}',
            body: `
Deployment Details:
ID: {{id}}
Duration: {{duration}}
Services:
{{services}}

Error: {{error}}
            `,
            priority: 'normal'
        });

        this.templates.set('test_results', {
            id: 'test_results',
            type: 'test',
            subject: 'Test Results: {{passed}}/{{total}} passed',
            body: `
Deployment: {{deployment_id}}
Total Tests: {{total}}
Passed: {{passed}}
Failed: {{failed}}

Failed Tests:
{{failures}}
            `,
            priority: 'normal'
        });
    }

    private setupEventListeners(): void {
        this.eventBus.subscribe({
            id: 'notification-monitor',
            topic: 'deployment.status',
            handler: async (event) => {
                if (event.data.status) {
                    await this.notifyDeploymentStatus(event.data);
                }
            }
        });

        this.eventBus.subscribe({
            id: 'test-results-monitor',
            topic: 'deployment.tests.completed',
            handler: async (event) => {
                await this.notifyTestResults(
                    event.data.results,
                    event.data.deploymentId
                );
            }
        });
    }

    private async handleError(type: string, error: Error): Promise<void> {
        await this.monitor.recordMetric({
            name: `notification_${type}`,
            value: 1,
            labels: { error: error.message }
        });
    }
}

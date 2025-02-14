import { MonitoringService } from '../../monitoring/monitoring-service';
import { EventBusService } from '../../events/event-bus-service';
import { DeploymentAnalyticsService } from '../analytics/deployment-analytics-service';
import { BigQuery } from '@google-cloud/bigquery';
import { createClient as createRedisClient } from 'redis';

interface DashboardMetrics {
    realtime: {
        activeDeployments: number;
        queuedDeployments: number;
        systemLoad: {
            cpu: number;
            memory: number;
            network: number;
        };
        errorRate: number;
    };
    historical: {
        deploymentSuccess: number;
        averageDuration: number;
        serviceHealth: Record<string, number>;
        topErrors: Array<{
            type: string;
            count: number;
            trend: 'up' | 'down' | 'stable';
        }>;
    };
    alerts: Array<{
        id: string;
        severity: 'critical' | 'warning' | 'info';
        message: string;
        timestamp: Date;
        acknowledged: boolean;
    }>;
}

export class DashboardService {
    private redis: ReturnType<typeof createRedisClient>;
    private bigquery: BigQuery;
    private metrics: DashboardMetrics;
    private updateInterval: NodeJS.Timeout;
    private readonly CACHE_TTL = 300; // 5 minutes
    private readonly UPDATE_INTERVAL = 10000; // 10 seconds

    constructor(
        private monitor: MonitoringService,
        private eventBus: EventBusService,
        private analytics: DeploymentAnalyticsService,
        private config: {
            redisUrl: string;
            projectId: string;
        }
    ) {
        this.redis = createRedisClient({ url: config.redisUrl });
        this.bigquery = new BigQuery({ projectId: config.projectId });
        this.metrics = this.getInitialMetrics();
        this.initialize();
    }

    private async initialize(): Promise<void> {
        await this.redis.connect();
        await this.setupEventListeners();
        this.startMetricsCollection();
    }

    async getDashboardData(): Promise<DashboardMetrics> {
        try {
            // Try to get from cache first
            const cached = await this.redis.get('dashboard_metrics');
            if (cached) {
                return JSON.parse(cached);
            }

            // Get fresh data
            const metrics = await this.collectMetrics();
            
            // Cache the results
            await this.redis.setEx(
                'dashboard_metrics',
                this.CACHE_TTL,
                JSON.stringify(metrics)
            );

            return metrics;

        } catch (error) {
            await this.handleError('dashboard_data_error', error);
            return this.metrics; // Return last known good state
        }
    }

    async getServiceHealth(): Promise<Record<string, number>> {
        try {
            const query = `
                SELECT
                    service_name,
                    AVG(health_score) as avg_health
                FROM deployment_analytics.service_health
                WHERE timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 HOUR)
                GROUP BY service_name
            `;

            const [rows] = await this.bigquery.query({ query });
            return rows.reduce((acc, row) => ({
                ...acc,
                [row.service_name]: row.avg_health
            }), {});

        } catch (error) {
            await this.handleError('health_query_error', error);
            return {};
        }
    }

    async acknowledgeAlert(alertId: string): Promise<void> {
        try {
            const alert = this.metrics.alerts.find(a => a.id === alertId);
            if (alert) {
                alert.acknowledged = true;
                await this.updateAlerts();
            }
        } catch (error) {
            await this.handleError('alert_ack_error', error);
        }
    }

    private async collectMetrics(): Promise<DashboardMetrics> {
        const [
            realtime,
            historical,
            alerts
        ] = await Promise.all([
            this.collectRealtimeMetrics(),
            this.collectHistoricalMetrics(),
            this.collectActiveAlerts()
        ]);

        return {
            realtime,
            historical,
            alerts
        };
    }

    private async collectRealtimeMetrics(): Promise<DashboardMetrics['realtime']> {
        const [systemMetrics, deploymentMetrics] = await Promise.all([
            this.monitor.getSystemMetrics(),
            this.monitor.getDeploymentMetrics()
        ]);

        return {
            activeDeployments: deploymentMetrics.active,
            queuedDeployments: deploymentMetrics.queued,
            systemLoad: {
                cpu: systemMetrics.cpu,
                memory: systemMetrics.memory,
                network: systemMetrics.network
            },
            errorRate: await this.calculateErrorRate()
        };
    }

    private async collectHistoricalMetrics(): Promise<DashboardMetrics['historical']> {
        const insights = await this.analytics.generateInsights();
        const errors = await this.getTopErrors();

        return {
            deploymentSuccess: insights.successRate * 100,
            averageDuration: insights.averageDuration,
            serviceHealth: insights.serviceHealthScores,
            topErrors: errors
        };
    }

    private async collectActiveAlerts(): Promise<DashboardMetrics['alerts']> {
        const query = `
            SELECT *
            FROM deployment_analytics.alerts
            WHERE resolved = FALSE
            ORDER BY severity DESC, timestamp DESC
            LIMIT 100
        `;

        const [rows] = await this.bigquery.query({ query });
        return rows.map(row => ({
            id: row.id,
            severity: row.severity,
            message: row.message,
            timestamp: new Date(row.timestamp),
            acknowledged: row.acknowledged
        }));
    }

    private async calculateErrorRate(): Promise<number> {
        const metrics = await this.monitor.getMetrics({
            name: 'deployment_error',
            timeframe: '5m'
        });

        const total = metrics.reduce((sum, m) => sum + m.value, 0);
        const timeWindowMinutes = 5;
        return total / timeWindowMinutes;
    }

    private async getTopErrors(): Promise<DashboardMetrics['historical']['topErrors']> {
        const query = `
            WITH current_errors AS (
                SELECT
                    error_type,
                    COUNT(*) as current_count
                FROM deployment_analytics.errors
                WHERE timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 HOUR)
                GROUP BY error_type
            ),
            previous_errors AS (
                SELECT
                    error_type,
                    COUNT(*) as previous_count
                FROM deployment_analytics.errors
                WHERE timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 2 HOUR)
                    AND timestamp < TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 HOUR)
                GROUP BY error_type
            )
            SELECT
                c.error_type,
                c.current_count as count,
                CASE
                    WHEN c.current_count > IFNULL(p.previous_count, 0) THEN 'up'
                    WHEN c.current_count < IFNULL(p.previous_count, 0) THEN 'down'
                    ELSE 'stable'
                END as trend
            FROM current_errors c
            LEFT JOIN previous_errors p ON c.error_type = p.error_type
            ORDER BY c.current_count DESC
            LIMIT 10
        `;

        const [rows] = await this.bigquery.query({ query });
        return rows.map(row => ({
            type: row.error_type,
            count: row.count,
            trend: row.trend
        }));
    }

    private startMetricsCollection(): void {
        this.updateInterval = setInterval(async () => {
            try {
                const metrics = await this.collectMetrics();
                this.metrics = metrics;

                // Update cache
                await this.redis.setEx(
                    'dashboard_metrics',
                    this.CACHE_TTL,
                    JSON.stringify(metrics)
                );

                // Emit metrics update event
                await this.eventBus.publish('dashboard.metrics.updated', {
                    type: 'metrics.updated',
                    source: 'dashboard-service',
                    data: metrics
                });

            } catch (error) {
                await this.handleError('metrics_collection_error', error);
            }
        }, this.UPDATE_INTERVAL);
    }

    private setupEventListeners(): void {
        this.eventBus.subscribe({
            id: 'dashboard-monitor',
            topic: 'system.alert',
            handler: async (event) => {
                if (event.data.type === 'new_alert') {
                    await this.handleNewAlert(event.data);
                }
            }
        });
    }

    private async handleNewAlert(data: any): Promise<void> {
        const alert = {
            id: uuidv4(),
            severity: data.severity,
            message: data.message,
            timestamp: new Date(),
            acknowledged: false
        };

        this.metrics.alerts.unshift(alert);
        this.metrics.alerts = this.metrics.alerts.slice(0, 100); // Keep last 100 alerts

        await this.updateAlerts();
    }

    private async updateAlerts(): Promise<void> {
        await this.redis.setEx(
            'dashboard_alerts',
            this.CACHE_TTL,
            JSON.stringify(this.metrics.alerts)
        );
    }

    private getInitialMetrics(): DashboardMetrics {
        return {
            realtime: {
                activeDeployments: 0,
                queuedDeployments: 0,
                systemLoad: {
                    cpu: 0,
                    memory: 0,
                    network: 0
                },
                errorRate: 0
            },
            historical: {
                deploymentSuccess: 0,
                averageDuration: 0,
                serviceHealth: {},
                topErrors: []
            },
            alerts: []
        };
    }

    private async handleError(type: string, error: Error): Promise<void> {
        await this.monitor.recordMetric({
            name: `dashboard_${type}`,
            value: 1,
            labels: { error: error.message }
        });

        await this.eventBus.publish('dashboard.error', {
            type: 'dashboard.error',
            source: 'dashboard-service',
            data: {
                error: error.message,
                type,
                timestamp: new Date()
            }
        });
    }

    async close(): Promise<void> {
        clearInterval(this.updateInterval);
        await this.redis.quit();
    }
}

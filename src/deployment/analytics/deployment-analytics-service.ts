import { MonitoringService } from '../../monitoring/monitoring-service';
import { BigQuery } from '@google-cloud/bigquery';
import { DeploymentStatus } from '../deployment-pipeline-service';

interface DeploymentMetrics {
    totalDeployments: number;
    successRate: number;
    averageDuration: number;
    failuresByService: Record<string, number>;
    rollbackRate: number;
    serviceHealthScores: Record<string, number>;
}

interface TimeSeriesData {
    timestamp: Date;
    metric: string;
    value: number;
    labels: Record<string, string>;
}

export class DeploymentAnalyticsService {
    private bigquery: BigQuery;
    private readonly DATASET = 'deployment_analytics';
    private readonly METRICS_TABLE = 'deployment_metrics';

    constructor(
        private monitor: MonitoringService,
        private config: {
            projectId: string;
        }
    ) {
        this.bigquery = new BigQuery({
            projectId: config.projectId
        });
        this.initialize();
    }

    private async initialize(): Promise<void> {
        await this.ensureTablesExist();
    }

    async analyzeDeployment(deployment: DeploymentStatus): Promise<void> {
        const metrics = this.calculateDeploymentMetrics(deployment);
        await this.storeMetrics(metrics, deployment.id);
    }

    async getDeploymentTrends(days: number = 30): Promise<TimeSeriesData[]> {
        const query = `
            SELECT 
                timestamp,
                metric_name,
                metric_value,
                labels
            FROM ${this.DATASET}.${this.METRICS_TABLE}
            WHERE timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL ${days} DAY)
            ORDER BY timestamp ASC
        `;

        const [rows] = await this.bigquery.query({ query });
        return rows.map(row => ({
            timestamp: new Date(row.timestamp),
            metric: row.metric_name,
            value: row.metric_value,
            labels: JSON.parse(row.labels)
        }));
    }

    async generateInsights(): Promise<DeploymentMetrics> {
        const query = `
            SELECT
                COUNT(*) as total_deployments,
                AVG(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as success_rate,
                AVG(TIMESTAMP_DIFF(end_time, start_time, SECOND)) as avg_duration,
                COUNTIF(status = 'rolled_back') / COUNT(*) as rollback_rate,
                JSON_EXTRACT_SCALAR(service_health_scores, '$.vercel') as vercel_health,
                JSON_EXTRACT_SCALAR(service_health_scores, '$.supabase') as supabase_health,
                JSON_EXTRACT_SCALAR(service_health_scores, '$.gcp') as gcp_health
            FROM ${this.DATASET}.deployments
            WHERE timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY)
        `;

        const [rows] = await this.bigquery.query({ query });
        const row = rows[0];

        return {
            totalDeployments: row.total_deployments,
            successRate: row.success_rate,
            averageDuration: row.avg_duration,
            failuresByService: await this.getFailuresByService(),
            rollbackRate: row.rollback_rate,
            serviceHealthScores: {
                vercel: parseFloat(row.vercel_health),
                supabase: parseFloat(row.supabase_health),
                gcp: parseFloat(row.gcp_health)
            }
        };
    }

    private async getFailuresByService(): Promise<Record<string, number>> {
        const query = `
            SELECT
                service_name,
                COUNT(*) as failure_count
            FROM ${this.DATASET}.deployment_failures
            WHERE timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY)
            GROUP BY service_name
        `;

        const [rows] = await this.bigquery.query({ query });
        return rows.reduce((acc, row) => ({
            ...acc,
            [row.service_name]: row.failure_count
        }), {});
    }

    private calculateDeploymentMetrics(deployment: DeploymentStatus): Record<string, number> {
        const duration = deployment.endTime 
            ? deployment.endTime.getTime() - deployment.startTime.getTime()
            : 0;

        return {
            duration_ms: duration,
            services_total: Object.keys(deployment.services).length,
            services_succeeded: Object.values(deployment.services)
                .filter(s => s?.status === 'completed').length,
            services_failed: Object.values(deployment.services)
                .filter(s => s?.status === 'failed').length,
        };
    }

    private async storeMetrics(
        metrics: Record<string, number>,
        deploymentId: string
    ): Promise<void> {
        const rows = Object.entries(metrics).map(([metric, value]) => ({
            timestamp: new Date(),
            deployment_id: deploymentId,
            metric_name: metric,
            metric_value: value,
            labels: JSON.stringify({
                environment: process.env.NODE_ENV
            })
        }));

        await this.bigquery
            .dataset(this.DATASET)
            .table(this.METRICS_TABLE)
            .insert(rows);
    }

    private async ensureTablesExist(): Promise<void> {
        const dataset = this.bigquery.dataset(this.DATASET);
        const [exists] = await dataset.exists();
        
        if (!exists) {
            await dataset.create();
            await this.createTables(dataset);
        }
    }

    private async createTables(dataset: any): Promise<void> {
        const schema = {
            fields: [
                { name: 'timestamp', type: 'TIMESTAMP' },
                { name: 'deployment_id', type: 'STRING' },
                { name: 'metric_name', type: 'STRING' },
                { name: 'metric_value', type: 'FLOAT' },
                { name: 'labels', type: 'STRING' }
            ]
        };

        await dataset.createTable(this.METRICS_TABLE, { schema });
    }
}

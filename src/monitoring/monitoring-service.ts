import { Monitoring } from '@google-cloud/monitoring';
import { SecurityConfig } from '../config/security-config';

export interface MetricData {
    name: string;
    value: number;
    labels: Record<string, string>;
    timestamp?: Date;
}

export class MonitoringService {
    private client: Monitoring;
    private projectId: string;

    constructor(projectId: string) {
        this.client = new Monitoring();
        this.projectId = projectId;
    }

    async recordMetric(data: MetricData): Promise<void> {
        try {
            const timeSeriesData = {
                metric: {
                    type: `custom.googleapis.com/supercoder/${data.name}`,
                    labels: data.labels,
                },
                resource: {
                    type: 'global',
                    labels: {
                        project_id: this.projectId,
                    },
                },
                points: [
                    {
                        interval: {
                            endTime: {
                                seconds: Math.floor((data.timestamp || new Date()).getTime() / 1000),
                            },
                        },
                        value: {
                            doubleValue: data.value,
                        },
                    },
                ],
            };

            await this.client.createTimeSeries({
                name: this.client.projectPath(this.projectId),
                timeSeries: [timeSeriesData],
            });
        } catch (error) {
            console.error('Failed to record metric:', error);
            throw error;
        }
    }

    async createAlert(metricName: string, threshold: number): Promise<void> {
        try {
            const [alertPolicy] = await this.client.createAlertPolicy({
                name: this.client.projectPath(this.projectId),
                alertPolicy: {
                    displayName: `Alert for ${metricName}`,
                    conditions: [{
                        displayName: `${metricName} threshold`,
                        conditionThreshold: {
                            filter: `metric.type="custom.googleapis.com/supercoder/${metricName}"`,
                            comparison: 'COMPARISON_GT',
                            threshold: threshold,
                            duration: { seconds: 60 },
                        },
                    }],
                },
            });
        } catch (error) {
            console.error('Failed to create alert:', error);
            throw error;
        }
    }
}

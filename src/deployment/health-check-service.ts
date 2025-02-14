import { MonitoringService } from '../monitoring/monitoring-service';
import { EventBusService } from '../events/event-bus-service';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { fetch } from 'cross-fetch';

interface HealthStatus {
    vercel: {
        status: 'healthy' | 'degraded' | 'unhealthy';
        latency: number;
        errors: string[];
    };
    supabase: {
        status: 'healthy' | 'degraded' | 'unhealthy';
        latency: number;
        connectionPool: {
            active: number;
            idle: number;
            total: number;
        };
        errors: string[];
    };
    gcp: {
        status: 'healthy' | 'degraded' | 'unhealthy';
        services: Record<string, {
            status: 'healthy' | 'degraded' | 'unhealthy';
            latency: number;
        }>;
        errors: string[];
    };
    timestamp: Date;
}

export class HealthCheckService {
    private supabase: any;
    private checks: Map<string, () => Promise<void>>;
    private status: HealthStatus;
    private readonly CHECK_INTERVAL = 60000; // 1 minute

    constructor(
        private config: any,
        private monitor: MonitoringService,
        private eventBus: EventBusService
    ) {
        this.supabase = createSupabaseClient(config.supabase.url, config.supabase.serviceKey);
        this.checks = new Map();
        this.status = this.getInitialStatus();
        
        this.initialize();
    }

    private initialize(): void {
        // Register health checks
        this.registerVercelChecks();
        this.registerSupabaseChecks();
        this.registerGCPChecks();

        // Start periodic checks
        this.startPeriodicChecks();
    }

    async performHealthCheck(): Promise<HealthStatus> {
        const startTime = Date.now();

        try {
            // Execute all health checks in parallel
            await Promise.all(
                Array.from(this.checks.values()).map(check => check())
            );

            // Record metrics
            await this.monitor.recordMetric({
                name: 'health_check',
                value: Date.now() - startTime,
                labels: {
                    vercel_status: this.status.vercel.status,
                    supabase_status: this.status.supabase.status,
                    gcp_status: this.status.gcp.status
                }
            });

            return this.status;

        } catch (error) {
            await this.handleError('health_check_error', error);
            throw error;
        }
    }

    private registerVercelChecks(): void {
        this.checks.set('vercel_api', async () => {
            const startTime = Date.now();
            try {
                const response = await fetch(
                    `https://api.vercel.com/v1/projects/${this.config.vercel.projectId}/status`,
                    {
                        headers: {
                            Authorization: `Bearer ${this.config.vercel.token}`
                        }
                    }
                );

                this.status.vercel.latency = Date.now() - startTime;
                
                if (!response.ok) {
                    throw new Error(`Vercel API returned ${response.status}`);
                }

                this.status.vercel.status = 'healthy';
                this.status.vercel.errors = [];

            } catch (error) {
                this.status.vercel.status = 'unhealthy';
                this.status.vercel.errors.push(error.message);
                throw error;
            }
        });
    }

    private registerSupabaseChecks(): void {
        this.checks.set('supabase_db', async () => {
            const startTime = Date.now();
            try {
                // Check database connection
                const { data, error } = await this.supabase
                    .rpc('check_database_health');

                if (error) throw error;

                // Check connection pool
                const poolStats = await this.getConnectionPoolStats();
                
                this.status.supabase.latency = Date.now() - startTime;
                this.status.supabase.connectionPool = poolStats;
                this.status.supabase.status = 'healthy';
                this.status.supabase.errors = [];

            } catch (error) {
                this.status.supabase.status = 'unhealthy';
                this.status.supabase.errors.push(error.message);
                throw error;
            }
        });
    }

    private registerGCPChecks(): void {
        const services = ['functions', 'storage', 'monitoring'];

        services.forEach(service => {
            this.checks.set(`gcp_${service}`, async () => {
                const startTime = Date.now();
                try {
                    const response = await fetch(
                        `https://${service}.googleapis.com/v1/projects/${this.config.gcp.projectId}/locations/${this.config.gcp.region}/services`,
                        {
                            headers: {
                                Authorization: `Bearer ${this.config.gcp.credentials.token}`
                            }
                        }
                    );

                    if (!response.ok) {
                        throw new Error(`GCP ${service} returned ${response.status}`);
                    }

                    this.status.gcp.services[service] = {
                        status: 'healthy',
                        latency: Date.now() - startTime
                    };

                } catch (error) {
                    this.status.gcp.services[service] = {
                        status: 'unhealthy',
                        latency: -1
                    };
                    this.status.gcp.errors.push(`${service}: ${error.message}`);
                    throw error;
                }
            });
        });
    }

    private async getConnectionPoolStats(): Promise<HealthStatus['supabase']['connectionPool']> {
        const { data } = await this.supabase
            .rpc('get_pool_stats');

        return {
            active: data.active_connections,
            idle: data.idle_connections,
            total: data.total_connections
        };
    }

    private startPeriodicChecks(): void {
        setInterval(async () => {
            try {
                const status = await this.performHealthCheck();
                await this.handleHealthStatus(status);
            } catch (error) {
                await this.handleError('periodic_check_error', error);
            }
        }, this.CHECK_INTERVAL);
    }

    private async handleHealthStatus(status: HealthStatus): Promise<void> {
        // Emit events for status changes
        const previousStatus = this.status;
        this.status = status;

        if (this.hasStatusChanged(previousStatus, status)) {
            await this.eventBus.publish('deployment.health.changed', {
                type: 'health.status.changed',
                source: 'health-check-service',
                data: {
                    previous: previousStatus,
                    current: status,
                    timestamp: new Date()
                }
            });
        }

        // Record detailed metrics
        await this.recordHealthMetrics(status);
    }

    private hasStatusChanged(previous: HealthStatus, current: HealthStatus): boolean {
        return (
            previous.vercel.status !== current.vercel.status ||
            previous.supabase.status !== current.supabase.status ||
            previous.gcp.status !== current.gcp.status
        );
    }

    private async recordHealthMetrics(status: HealthStatus): Promise<void> {
        const metrics = [
            {
                name: 'vercel_health',
                value: this.getStatusValue(status.vercel.status),
                labels: { latency: status.vercel.latency.toString() }
            },
            {
                name: 'supabase_health',
                value: this.getStatusValue(status.supabase.status),
                labels: {
                    latency: status.supabase.latency.toString(),
                    active_connections: status.supabase.connectionPool.active.toString()
                }
            },
            {
                name: 'gcp_health',
                value: this.getStatusValue(status.gcp.status),
                labels: {
                    services: Object.keys(status.gcp.services).join(',')
                }
            }
        ];

        await Promise.all(
            metrics.map(metric => this.monitor.recordMetric(metric))
        );
    }

    private getStatusValue(status: string): number {
        switch (status) {
            case 'healthy': return 1;
            case 'degraded': return 0.5;
            case 'unhealthy': return 0;
            default: return -1;
        }
    }

    private getInitialStatus(): HealthStatus {
        return {
            vercel: {
                status: 'unhealthy',
                latency: -1,
                errors: []
            },
            supabase: {
                status: 'unhealthy',
                latency: -1,
                connectionPool: {
                    active: 0,
                    idle: 0,
                    total: 0
                },
                errors: []
            },
            gcp: {
                status: 'unhealthy',
                services: {},
                errors: []
            },
            timestamp: new Date()
        };
    }

    private async handleError(type: string, error: Error): Promise<void> {
        await this.monitor.recordMetric({
            name: `health_check_${type}`,
            value: 1,
            labels: { error: error.message }
        });

        await this.eventBus.publish('deployment.health.error', {
            type: 'health.error',
            source: 'health-check-service',
            data: {
                error: error.message,
                type,
                timestamp: new Date()
            }
        });
    }
}

import { MonitoringService } from '../monitoring/monitoring-service';
import { EventBusService } from '../events/event-bus-service';
import { SecurityTestingService } from '../testing/security-testing-service';
import { BigQuery } from '@google-cloud/bigquery';
import { createClient as createRedisClient } from 'redis';
import { v4 as uuidv4 } from 'uuid';

interface SecurityDashboard {
    overview: {
        threatLevel: 'critical' | 'high' | 'medium' | 'low';
        securityScore: number;
        activeThreats: number;
        lastAssessment: Date;
    };
    vulnerabilities: {
        total: number;
        byLevel: {
            critical: number;
            high: number;
            medium: number;
            low: number;
        };
        byCategory: Record<string, number>;
        recent: Array<{
            id: string;
            type: string;
            severity: string;
            description: string;
            location: string;
            discovered: Date;
            status: 'open' | 'investigating' | 'mitigated';
        }>;
    };
    compliance: {
        overall: number;
        standards: Array<{
            name: string;
            compliance: number;
            violations: number;
            lastCheck: Date;
        }>;
    };
    incidents: Array<{
        id: string;
        type: string;
        severity: string;
        status: 'active' | 'investigating' | 'resolved';
        detected: Date;
        resolved?: Date;
        affectedSystems: string[];
        description: string;
    }>;
    monitoring: {
        endpoints: Array<{
            url: string;
            lastCheck: Date;
            status: 'secure' | 'vulnerable' | 'error';
            issues: string[];
        }>;
        services: Array<{
            name: string;
            status: 'secure' | 'at-risk' | 'compromised';
            vulnerabilities: number;
            lastScan: Date;
        }>;
    };
}

export class SecurityDashboardService {
    private redis: ReturnType<typeof createRedisClient>;
    private bigquery: BigQuery;
    private currentState: SecurityDashboard;
    private readonly UPDATE_INTERVAL = 300000; // 5 minutes
    private readonly METRICS_RETENTION = 2592000; // 30 days

    constructor(
        private monitor: MonitoringService,
        private security: SecurityTestingService,
        private eventBus: EventBusService,
        private config: {
            projectId: string;
            redisUrl: string;
            endpoints: string[];
            complianceStandards: string[];
        }
    ) {
        this.redis = createRedisClient({ url: config.redisUrl });
        this.bigquery = new BigQuery({ projectId: config.projectId });
        this.currentState = this.getInitialState();
        this.initialize();
    }

    private async initialize(): Promise<void> {
        await this.redis.connect();
        // New: load initial state from Redis if available
        await this.loadInitialData();
        this.startSecurityMonitoring();
        this.setupEventListeners();
        await this.loadInitialData();
    }

    private async loadInitialData(): Promise<void> {
        try {
            const data = await this.redis.get('security_dashboard');
            if (data) {
                this.currentState = JSON.parse(data);
            } else {
                this.currentState = this.getInitialState();
            }
        } catch (error) {
            // In case of error, fallback to initial state
            this.currentState = this.getInitialState();
            await this.monitor.recordMetric({
                name: 'security_initial_state_error',
                value: 1,
                labels: { error: error.message }
            });
        }
    }

    async getDashboardData(): Promise<SecurityDashboard> {
        return this.currentState;
    }

    async getVulnerabilityTrends(
        timeframe: '24h' | '7d' | '30d'
    ): Promise<Array<{ timestamp: Date; count: number; severity: string }>> {
        const query = `
            SELECT
                TIMESTAMP_TRUNC(timestamp, HOUR) as timestamp,
                severity,
                COUNT(*) as count
            FROM ${this.config.projectId}.security.vulnerabilities
            WHERE timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL ${timeframe})
            GROUP BY timestamp, severity
            ORDER BY timestamp DESC
        `;

        const [rows] = await this.bigquery.query({ query });
        return rows;
    }

    async getComplianceHistory(
        standard: string,
        timeframe: '7d' | '30d' | '90d'
    ): Promise<Array<{ timestamp: Date; compliance: number }>> {
        const query = `
            SELECT
                timestamp,
                compliance_score as compliance
            FROM ${this.config.projectId}.security.compliance_checks
            WHERE 
                standard = @standard
                AND timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL ${timeframe})
            ORDER BY timestamp DESC
        `;

        const [rows] = await this.bigquery.query({
            query,
            params: { standard }
        });
        return rows;
    }

    private startSecurityMonitoring(): void {
        setInterval(async () => {
            try {
                const dashboard = await this.collectSecurityMetrics();
                this.currentState = dashboard;

                // Store state
                await this.storeDashboardState(dashboard);

                // Emit update event
                await this.eventBus.publish('security.dashboard.updated', {
                    type: 'dashboard.updated',
                    source: 'security-dashboard',
                    data: dashboard
                });

                // Check for critical security conditions
                await this.checkSecurityConditions(dashboard);

            } catch (error) {
                await this.handleError('security_monitoring_error', error);
            }
        }, this.UPDATE_INTERVAL);
    }

    private async collectSecurityMetrics(): Promise<SecurityDashboard> {
        const [
            vulnerabilities,
            compliance,
            incidents,
            monitoring
        ] = await Promise.all([
            this.collectVulnerabilityMetrics(),
            this.collectComplianceMetrics(),
            this.collectIncidentMetrics(),
            this.collectMonitoringMetrics()
        ]);

        return {
            overview: this.calculateOverview(vulnerabilities, incidents),
            vulnerabilities,
            compliance,
            incidents,
            monitoring
        };
    }

    private calculateOverview(
        vulnerabilities: SecurityDashboard['vulnerabilities'],
        incidents: SecurityDashboard['incidents']
    ): SecurityDashboard['overview'] {
        const activeIncidents = incidents.filter(i => i.status === 'active');
        const criticalVulns = vulnerabilities.byLevel.critical;
        const highVulns = vulnerabilities.byLevel.high;

        let threatLevel: SecurityDashboard['overview']['threatLevel'] = 'low';
        if (criticalVulns > 0 || activeIncidents.length > 0) {
            threatLevel = 'critical';
        } else if (highVulns > 0) {
            threatLevel = 'high';
        } else if (vulnerabilities.byLevel.medium > 0) {
            threatLevel = 'medium';
        }

        // Calculate security score (0-100, higher is better)
        const securityScore = Math.max(0, 100 - (
            criticalVulns * 20 +
            highVulns * 10 +
            vulnerabilities.byLevel.medium * 5 +
            vulnerabilities.byLevel.low * 1 +
            activeIncidents.length * 15
        ));

        return {
            threatLevel,
            securityScore,
            activeThreats: activeIncidents.length + criticalVulns + highVulns,
            lastAssessment: new Date()
        };
    }

    private async collectVulnerabilityMetrics(): Promise<SecurityDashboard['vulnerabilities']> {
        const recentScans = await this.security.getRecentScans('24h');
        const vulnerabilities = recentScans.flatMap(scan => scan.vulnerabilities);

        const byLevel = {
            critical: 0,
            high: 0,
            medium: 0,
            low: 0
        };

        const byCategory: Record<string, number> = {};

        vulnerabilities.forEach(vuln => {
            byLevel[vuln.severity.toLowerCase()]++;
            byCategory[vuln.type] = (byCategory[vuln.type] || 0) + 1;
        });

        return {
            total: vulnerabilities.length,
            byLevel,
            byCategory,
            recent: vulnerabilities.slice(0, 10).map(v => ({
                id: v.id,
                type: v.type,
                severity: v.severity,
                description: v.description,
                location: v.location,
                discovered: new Date(),
                status: 'open'
            }))
        };
    }

    private async collectComplianceMetrics(): Promise<SecurityDashboard['compliance']> {
        const standards = await Promise.all(
            this.config.complianceStandards.map(async standard => {
                const check = await this.security.checkCompliance(standard);
                return {
                    name: standard,
                    compliance: check.complianceScore,
                    violations: check.violations.length,
                    lastCheck: new Date()
                };
            })
        );

        const overall = standards.reduce(
            (acc, std) => acc + std.compliance,
            0
        ) / standards.length;

        return {
            overall,
            standards
        };
    }

    private async collectIncidentMetrics(): Promise<SecurityDashboard['incidents']> {
        const query = `
            SELECT *
            FROM ${this.config.projectId}.security.incidents
            WHERE status != 'resolved'
            OR resolved >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 24 HOUR)
            ORDER BY detected DESC
        `;

        const [rows] = await this.bigquery.query({ query });
        return rows.map(this.deserializeIncident);
    }

    private async collectMonitoringMetrics(): Promise<SecurityDashboard['monitoring']> {
        const endpoints = await Promise.all(
            this.config.endpoints.map(async url => {
                const scan = await this.security.scanEndpoint(url);
                return {
                    url,
                    lastCheck: new Date(),
                    status: this.determineEndpointStatus(scan),
                    issues: scan.issues
                };
            })
        );

        const services = await this.security.getServicesStatus();

        return {
            endpoints,
            services: services.map(s => ({
                name: s.name,
                status: s.status,
                vulnerabilities: s.vulnerabilities.length,
                lastScan: s.lastScan
            }))
        };
    }

    private determineEndpointStatus(
        scan: any
    ): SecurityDashboard['monitoring']['endpoints'][0]['status'] {
        if (scan.criticalIssues > 0) return 'vulnerable';
        if (scan.error) return 'error';
        return 'secure';
    }

    private async checkSecurityConditions(
        dashboard: SecurityDashboard
    ): Promise<void> {
        // Check for critical security conditions
        if (
            dashboard.overview.threatLevel === 'critical' ||
            dashboard.vulnerabilities.byLevel.critical > 0 ||
            dashboard.incidents.some(i => 
                i.status === 'active' && i.severity === 'critical'
            )
        ) {
            await this.eventBus.publish('security.critical', {
                type: 'security.critical',
                source: 'security-dashboard',
                data: {
                    threatLevel: dashboard.overview.threatLevel,
                    criticalVulnerabilities: dashboard.vulnerabilities.byLevel.critical,
                    activeIncidents: dashboard.incidents.filter(i => i.status === 'active'),
                    timestamp: new Date()
                }
            });
        }
    }

    private async storeDashboardState(dashboard: SecurityDashboard): Promise<void> {
        // Store in Redis for real-time access
        await this.redis.setEx(
            'security_dashboard',
            300, // 5 minutes
            JSON.stringify(dashboard)
        );

        // Store in BigQuery for historical analysis
        await this.bigquery
            .dataset('security')
            .table('dashboard_snapshots')
            .insert([{
                timestamp: new Date(),
                state: JSON.stringify(dashboard)
            }]);
    }

    private setupEventListeners(): void {
        this.eventBus.subscribe({
            id: 'security-dashboard-monitor',
            topic: 'security.alert',
            handler: async (event) => {
                if (event.data.type === 'new_vulnerability') {
                    await this.handleNewVulnerability(event.data);
                }
            }
        });
    }

    private async handleNewVulnerability(data: any): Promise<void> {
        try {
            // When a new vulnerability is reported, force a refresh of security metrics
            const dashboard = await this.collectSecurityMetrics();
            this.currentState = dashboard;
            await this.storeDashboardState(dashboard);
            await this.eventBus.publish('security.dashboard.refreshed', {
                type: 'dashboard.refreshed',
                source: 'security-dashboard',
                data: dashboard
            });
        } catch (error) {
            await this.handleError('handle_new_vulnerability_error', error);
        }
    }

    private async handleError(type: string, error: Error): Promise<void> {
        await this.monitor.recordMetric({
            name: `security_dashboard_${type}`,
            value: 1,
            labels: { error: error.message }
        });

        await this.eventBus.publish('security.dashboard.error', {
            type: 'dashboard.error',
            source: 'security-dashboard',
            data: {
                error: error.message,
                type,
                timestamp: new Date()
            }
        });
    }

    private getInitialState(): SecurityDashboard {
        return {
            overview: {
                threatLevel: 'low',
                securityScore: 100,
                activeThreats: 0,
                lastAssessment: new Date()
            },
            vulnerabilities: {
                total: 0,
                byLevel: {
                    critical: 0,
                    high: 0,
                    medium: 0,
                    low: 0
                },
                byCategory: {},
                recent: []
            },
            compliance: {
                overall: 100,
                standards: []
            },
            incidents: [],
            monitoring: {
                endpoints: [],
                services: []
            }
        };
    }

    async close(): Promise<void> {
        await this.redis.quit();
    }
}

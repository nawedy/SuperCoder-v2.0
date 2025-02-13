import { MonitoringService } from '../monitoring/monitoring-service';
import { EventBusService } from '../events/event-bus-service';
import { AuditTrailService } from '../audit/audit-trail-service';
import { CodeAnalysisService } from '../analysis/code-analysis-service';
import { v4 as uuidv4 } from 'uuid';

interface SecurityScan {
    id: string;
    timestamp: Date;
    target: {
        type: 'code' | 'model' | 'data';
        id: string;
        version?: string;
    };
    status: ScanStatus;
    vulnerabilities: Vulnerability[];
    metrics: SecurityMetrics;
    configuration: ScanConfig;
}

interface Vulnerability {
    id: string;
    type: VulnerabilityType;
    severity: 'critical' | 'high' | 'medium' | 'low';
    description: string;
    location?: {
        file: string;
        line?: number;
        column?: number;
    };
    codeSnippet?: string;
    cveId?: string;
    remediation?: string;
    confidence: number;
    metadata: Record<string, any>;
}

interface SecurityMetrics {
    overallScore: number;
    criticalCount: number;
    highCount: number;
    mediumCount: number;
    lowCount: number;
    falsePositives: number;
    scanDuration: number;
    policyCompliance: {
        passed: number;
        failed: number;
        rules: string[];
    };
}

interface ScanConfig {
    rules: SecurityRule[];
    ignorePatterns: string[];
    customPolicies: SecurityPolicy[];
    thresholds: {
        maxCritical: number;
        maxHigh: number;
        minOverallScore: number;
    };
}

interface SecurityRule {
    id: string;
    type: VulnerabilityType;
    pattern: string | RegExp;
    severity: 'critical' | 'high' | 'medium' | 'low';
    description: string;
    remediation?: string;
    enabled: boolean;
}

interface SecurityPolicy {
    id: string;
    name: string;
    rules: string[];
    action: 'block' | 'warn' | 'audit';
    threshold: number;
}

type VulnerabilityType = 
    | 'code_injection'
    | 'sql_injection'
    | 'xss'
    | 'authentication_bypass'
    | 'authorization_bypass'
    | 'sensitive_data_exposure'
    | 'insecure_configuration'
    | 'dependency_vulnerability'
    | 'custom';

type ScanStatus = 'queued' | 'running' | 'completed' | 'failed';

export class SecurityScannerService {
    private monitor: MonitoringService;
    private eventBus: EventBusService;
    private audit: AuditTrailService;
    private codeAnalysis: CodeAnalysisService;
    private activeScans: Map<string, SecurityScan>;
    private rules: Map<string, SecurityRule>;
    private policies: Map<string, SecurityPolicy>;
    private readonly SCAN_TIMEOUT = 300000; // 5 minutes

    constructor(
        monitor: MonitoringService,
        eventBus: EventBusService,
        audit: AuditTrailService,
        codeAnalysis: CodeAnalysisService
    ) {
        this.monitor = monitor;
        this.eventBus = eventBus;
        this.audit = audit;
        this.codeAnalysis = codeAnalysis;
        this.activeScans = new Map();
        this.rules = new Map();
        this.policies = new Map();

        this.initialize();
    }

    private async initialize(): Promise<void> {
        await this.loadSecurityRules();
        await this.loadSecurityPolicies();
        this.setupEventListeners();
    }

    async scanCode(
        code: string,
        config?: Partial<ScanConfig>
    ): Promise<SecurityScan> {
        const startTime = Date.now();
        try {
            const scanId = uuidv4();
            const scanConfig = this.createScanConfig(config);

            // Create initial scan record
            const scan: SecurityScan = {
                id: scanId,
                timestamp: new Date(),
                target: {
                    type: 'code',
                    id: scanId
                },
                status: 'running',
                vulnerabilities: [],
                metrics: this.initializeMetrics(),
                configuration: scanConfig
            };

            this.activeScans.set(scanId, scan);

            // Start security scan
            const vulnerabilities = await this.performSecurityScan(code, scanConfig);
            
            // Update metrics
            scan.metrics = this.calculateMetrics(vulnerabilities);
            scan.vulnerabilities = vulnerabilities;
            scan.status = 'completed';
            scan.metrics.scanDuration = Date.now() - startTime;

            // Check policy compliance
            const compliance = await this.checkPolicyCompliance(scan);
            scan.metrics.policyCompliance = compliance;

            // Record metrics
            await this.monitor.recordMetric({
                name: 'security_scan',
                value: scan.metrics.scanDuration,
                labels: {
                    scan_id: scanId,
                    vulnerabilities: vulnerabilities.length.toString(),
                    critical: scan.metrics.criticalCount.toString()
                }
            });

            // Audit log
            await this.audit.logEvent({
                eventType: 'security.alert',
                actor: {
                    id: 'system',
                    type: 'service',
                    metadata: {}
                },
                resource: {
                    type: 'security-scan',
                    id: scanId,
                    action: 'complete'
                },
                context: {
                    location: 'security-scanner',
                    ipAddress: 'internal',
                    userAgent: 'system'
                },
                status: 'success',
                details: {
                    metrics: scan.metrics,
                    critical_vulnerabilities: scan.metrics.criticalCount
                }
            });

            return scan;

        } catch (error) {
            await this.handleError('scan_error', error);
            throw error;
        }
    }

    async addSecurityRule(rule: Omit<SecurityRule, 'id'>): Promise<string> {
        try {
            // Validate rule
            await this.validateSecurityRule(rule);

            const id = uuidv4();
            const newRule: SecurityRule = {
                ...rule,
                id,
                enabled: true
            };

            this.rules.set(id, newRule);

            await this.audit.logEvent({
                eventType: 'security.alert',
                actor: {
                    id: 'system',
                    type: 'service',
                    metadata: {}
                },
                resource: {
                    type: 'security-rule',
                    id,
                    action: 'create'
                },
                context: {
                    location: 'security-scanner',
                    ipAddress: 'internal',
                    userAgent: 'system'
                },
                status: 'success',
                details: { rule: newRule }
            });

            return id;

        } catch (error) {
            await this.handleError('rule_creation_error', error);
            throw error;
        }
    }

    private async performSecurityScan(
        code: string,
        config: ScanConfig
    ): Promise<Vulnerability[]> {
        const vulnerabilities: Vulnerability[] = [];

        // Perform code analysis
        const analysisResult = await this.codeAnalysis.analyzeCode(code, 'scan.ts');

        // Apply security rules
        for (const rule of config.rules) {
            if (!rule.enabled) continue;

            const matches = await this.applySecurityRule(code, rule);
            vulnerabilities.push(...matches);
        }

        // Check for known vulnerabilities in dependencies
        const dependencyVulnerabilities = await this.scanDependencies(code);
        vulnerabilities.push(...dependencyVulnerabilities);

        // Remove duplicates and false positives
        return this.filterVulnerabilities(vulnerabilities, config.ignorePatterns);
    }

    private async applySecurityRule(
        code: string,
        rule: SecurityRule
    ): Promise<Vulnerability[]> {
        const vulnerabilities: Vulnerability[] = [];
        let matches: RegExpMatchArray | null;

        if (rule.pattern instanceof RegExp) {
            matches = code.match(rule.pattern);
        } else {
            matches = code.match(new RegExp(rule.pattern, 'g'));
        }

        if (matches) {
            for (const match of matches) {
                const location = this.findCodeLocation(code, match);
                vulnerabilities.push({
                    id: uuidv4(),
                    type: rule.type,
                    severity: rule.severity,
                    description: rule.description,
                    location,
                    codeSnippet: this.extractCodeSnippet(code, location),
                    remediation: rule.remediation,
                    confidence: 0.8,
                    metadata: {
                        ruleId: rule.id,
                        pattern: rule.pattern.toString()
                    }
                });
            }
        }

        return vulnerabilities;
    }

    private async scanDependencies(code: string): Promise<Vulnerability[]> {
        const vulnerabilities: Vulnerability[] = [];

        // Extract dependencies from code
        const dependencies = this.extractDependencies(code);

        // Check each dependency against vulnerability databases
        for (const dep of dependencies) {
            const vulns = await this.checkDependencyVulnerabilities(dep);
            vulnerabilities.push(...vulns);
        }

        return vulnerabilities;
    }

    private extractDependencies(code: string): string[] {
        const imports = code.match(/import.*from\s+['"](.+)['"]/g) || [];
        const requires = code.match(/require\(['"](.+)['"]\)/g) || [];

        return [...imports, ...requires].map(dep => {
            const match = dep.match(/['"](.+)['"]/);
            return match ? match[1] : '';
        });
    }

    private async checkDependencyVulnerabilities(
        dependency: string
    ): Promise<Vulnerability[]> {
        // Implementation would typically involve checking against vulnerability databases
        return [];
    }

    private findCodeLocation(
        code: string,
        match: string
    ): NonNullable<Vulnerability['location']> {
        const index = code.indexOf(match);
        const lines = code.slice(0, index).split('\n');
        
        return {
            file: 'scan.ts',
            line: lines.length,
            column: lines[lines.length - 1].length + 1
        };
    }

    private extractCodeSnippet(
        code: string,
        location: NonNullable<Vulnerability['location']>
    ): string {
        const lines = code.split('\n');
        const start = Math.max(0, location.line - 2);
        const end = Math.min(lines.length, location.line + 2);
        
        return lines.slice(start, end).join('\n');
    }

    private filterVulnerabilities(
        vulnerabilities: Vulnerability[],
        ignorePatterns: string[]
    ): Vulnerability[] {
        return vulnerabilities.filter(vuln => {
            // Remove duplicates
            const isDuplicate = vulnerabilities.some(v => 
                v.id !== vuln.id &&
                v.type === vuln.type &&
                v.location?.file === vuln.location?.file &&
                v.location?.line === vuln.location?.line
            );

            // Check ignore patterns
            const isIgnored = ignorePatterns.some(pattern => 
                new RegExp(pattern).test(vuln.codeSnippet || '')
            );

            return !isDuplicate && !isIgnored;
        });
    }

    private async checkPolicyCompliance(
        scan: SecurityScan
    ): Promise<SecurityMetrics['policyCompliance']> {
        const compliance = {
            passed: 0,
            failed: 0,
            rules: [] as string[]
        };

        for (const policy of this.policies.values()) {
            const relevantVulns = scan.vulnerabilities.filter(v => 
                policy.rules.includes(v.type)
            );

            if (relevantVulns.length > policy.threshold) {
                compliance.failed++;
                compliance.rules.push(policy.id);

                if (policy.action === 'block') {
                    await this.handlePolicyViolation(scan, policy, relevantVulns);
                }
            } else {
                compliance.passed++;
            }
        }

        return compliance;
    }

    private async handlePolicyViolation(
        scan: SecurityScan,
        policy: SecurityPolicy,
        violations: Vulnerability[]
    ): Promise<void> {
        await this.eventBus.publish('security.policy.violation', {
            type: 'security.policy.violation',
            source: 'security-scanner',
            data: {
                scanId: scan.id,
                policyId: policy.id,
                violations: violations.map(v => ({
                    type: v.type,
                    severity: v.severity,
                    description: v.description
                })),
                timestamp: new Date()
            },
            metadata: {
                severity: 'high',
                environment: process.env.NODE_ENV || 'development'
            }
        });
    }

    private calculateMetrics(vulnerabilities: Vulnerability[]): SecurityMetrics {
        const metrics = this.initializeMetrics();
        
        for (const vuln of vulnerabilities) {
            switch (vuln.severity) {
                case 'critical':
                    metrics.criticalCount++;
                    break;
                case 'high':
                    metrics.highCount++;
                    break;
                case 'medium':
                    metrics.mediumCount++;
                    break;
                case 'low':
                    metrics.lowCount++;
                    break;
            }
        }

        // Calculate overall score (0-100)
        metrics.overallScore = Math.max(0, 100 - (
            metrics.criticalCount * 20 +
            metrics.highCount * 10 +
            metrics.mediumCount * 5 +
            metrics.lowCount * 2
        ));

        return metrics;
    }

    private initializeMetrics(): SecurityMetrics {
        return {
            overallScore: 100,
            criticalCount: 0,
            highCount: 0,
            mediumCount: 0,
            lowCount: 0,
            falsePositives: 0,
            scanDuration: 0,
            policyCompliance: {
                passed: 0,
                failed: 0,
                rules: []
            }
        };
    }

    private createScanConfig(
        config?: Partial<ScanConfig>
    ): ScanConfig {
        return {
            rules: Array.from(this.rules.values()),
            ignorePatterns: config?.ignorePatterns || [],
            customPolicies: config?.customPolicies || [],
            thresholds: {
                maxCritical: config?.thresholds?.maxCritical || 0,
                maxHigh: config?.thresholds?.maxHigh || 2,
                minOverallScore: config?.thresholds?.minOverallScore || 80
            }
        };
    }

    private async validateSecurityRule(rule: Partial<SecurityRule>): Promise<void> {
        if (!rule.type || !rule.pattern || !rule.severity || !rule.description) {
            throw new Error('Missing required rule fields');
        }

        // Validate pattern
        try {
            new RegExp(rule.pattern);
        } catch {
            throw new Error('Invalid rule pattern');
        }
    }

    private async loadSecurityRules(): Promise<void> {
        // Implementation for loading security rules from configuration
        // This would typically involve loading from a secure configuration store
    }

    private async loadSecurityPolicies(): Promise<void> {
        // Implementation for loading security policies from configuration
        // This would typically involve loading from a secure configuration store
    }

    private setupEventListeners(): void {
        this.eventBus.subscribe({
            id: 'security-scanner-monitor',
            topic: 'code.update',
            handler: async (event) => {
                await this.scanCode(event.data.code);
            }
        });
    }

    private async handleError(type: string, error: Error): Promise<void> {
        await this.monitor.recordMetric({
            name: type,
            value: 1,
            labels: { error: error.message }
        });

        await this.eventBus.publish('security.error', {
            type: 'security.error',
            source: 'security-scanner',
            data: {
                error: error.message,
                timestamp: new Date()
            },
            metadata: {
                severity: 'high',
                environment: process.env.NODE_ENV || 'development'
            }
        });
    }
}

import { MonitoringService } from '../monitoring/monitoring-service';
import { EventBusService } from '../events/event-bus-service';
import { AuditTrailService } from '../audit/audit-trail-service';
import { DLP } from '@google-cloud/dlp';
import { SecurityConfig } from '../config/security-config';
import { v4 as uuidv4 } from 'uuid';

interface PrivacyConfig {
    piiDetection: {
        enabled: boolean;
        sensitivity: 'high' | 'medium' | 'low';
        customPatterns?: RegExp[];
    };
    anonymization: {
        method: 'mask' | 'encrypt' | 'redact';
        preserveLength: boolean;
        maskChar?: string;
    };
    compliance: {
        gdpr: boolean;
        hipaa: boolean;
        ccpa: boolean;
        customRules?: ComplianceRule[];
    };
}

interface ComplianceRule {
    id: string;
    name: string;
    pattern: RegExp | string;
    action: 'mask' | 'encrypt' | 'redact' | 'allow';
    category: string;
}

interface PrivacyResult {
    id: string;
    timestamp: Date;
    findings: PrivacyFinding[];
    stats: {
        piiCount: number;
        sensitiveDataTypes: string[];
        riskLevel: 'high' | 'medium' | 'low';
    };
    actions: {
        type: string;
        field: string;
        action: string;
    }[];
    compliance: {
        status: 'compliant' | 'non-compliant';
        violations: string[];
        recommendations: string[];
    };
}

interface PrivacyFinding {
    type: string;
    value: string;
    location: {
        field: string;
        start: number;
        end: number;
    };
    confidence: number;
    action: string;
}

export class PrivacyEngineService {
    private monitor: MonitoringService;
    private eventBus: EventBusService;
    private audit: AuditTrailService;
    private dlp: DLP;
    private security: SecurityConfig;
    private complianceRules: Map<string, ComplianceRule>;
    private readonly DEFAULT_CONFIG: PrivacyConfig = {
        piiDetection: {
            enabled: true,
            sensitivity: 'high'
        },
        anonymization: {
            method: 'mask',
            preserveLength: true,
            maskChar: '*'
        },
        compliance: {
            gdpr: true,
            hipaa: true,
            ccpa: true
        }
    };

    constructor(
        monitor: MonitoringService,
        eventBus: EventBusService,
        audit: AuditTrailService,
        security: SecurityConfig,
        config: {
            projectId: string;
        }
    ) {
        this.monitor = monitor;
        this.eventBus = eventBus;
        this.audit = audit;
        this.security = security;
        this.dlp = new DLP({ projectId: config.projectId });
        this.complianceRules = new Map();

        this.initialize();
    }

    private async initialize(): Promise<void> {
        await this.loadComplianceRules();
        this.setupEventListeners();
    }

    async scanData(
        data: any,
        dataType: string,
        config?: Partial<PrivacyConfig>
    ): Promise<PrivacyResult> {
        const startTime = Date.now();
        try {
            // Merge config with defaults
            const effectiveConfig = this.mergeConfig(config);

            // Initialize result
            const result: PrivacyResult = {
                id: uuidv4(),
                timestamp: new Date(),
                findings: [],
                stats: {
                    piiCount: 0,
                    sensitiveDataTypes: [],
                    riskLevel: 'low'
                },
                actions: [],
                compliance: {
                    status: 'compliant',
                    violations: [],
                    recommendations: []
                }
            };

            // Detect PII and sensitive data
            if (effectiveConfig.piiDetection.enabled) {
                const piiFindings = await this.detectPII(data, dataType);
                result.findings.push(...piiFindings);
                result.stats.piiCount = piiFindings.length;
                result.stats.sensitiveDataTypes = this.extractSensitiveDataTypes(piiFindings);
            }

            // Check compliance
            const complianceResult = await this.checkCompliance(
                data,
                effectiveConfig.compliance
            );
            result.compliance = complianceResult;

            // Determine risk level
            result.stats.riskLevel = this.calculateRiskLevel(result);

            // Record metrics
            await this.monitor.recordMetric({
                name: 'privacy_scan',
                value: Date.now() - startTime,
                labels: {
                    data_type: dataType,
                    risk_level: result.stats.riskLevel,
                    pii_count: result.stats.piiCount.toString()
                }
            });

            // Audit log
            await this.audit.logEvent({
                eventType: 'privacy.scan',
                actor: {
                    id: 'system',
                    type: 'service',
                    metadata: {}
                },
                resource: {
                    type: 'data',
                    id: result.id,
                    action: 'scan'
                },
                context: {
                    location: 'privacy-engine',
                    ipAddress: 'internal',
                    userAgent: 'system'
                },
                status: result.compliance.status,
                details: {
                    findings: result.stats.piiCount,
                    risk_level: result.stats.riskLevel
                }
            });

            return result;

        } catch (error) {
            await this.handleError('privacy_scan_error', error);
            throw error;
        }
    }

    async anonymizeData(
        data: any,
        findings: PrivacyFinding[],
        config?: Partial<PrivacyConfig>
    ): Promise<any> {
        try {
            const effectiveConfig = this.mergeConfig(config);
            let anonymizedData = JSON.stringify(data);

            // Sort findings by location end index in reverse order
            // to avoid offset issues when replacing text
            const sortedFindings = [...findings].sort(
                (a, b) => b.location.end - a.location.end
            );

            for (const finding of sortedFindings) {
                const replacement = this.getAnonymizedValue(
                    finding,
                    effectiveConfig.anonymization
                );

                anonymizedData = this.replaceInString(
                    anonymizedData,
                    finding.location.start,
                    finding.location.end,
                    replacement
                );
            }

            return JSON.parse(anonymizedData);

        } catch (error) {
            await this.handleError('anonymization_error', error);
            throw error;
        }
    }

    async addComplianceRule(rule: Omit<ComplianceRule, 'id'>): Promise<string> {
        try {
            const ruleId = uuidv4();
            const newRule: ComplianceRule = {
                ...rule,
                id: ruleId
            };

            // Validate rule
            await this.validateComplianceRule(newRule);

            // Store rule
            this.complianceRules.set(ruleId, newRule);

            // Audit log
            await this.audit.logEvent({
                eventType: 'compliance.rule.create',
                actor: {
                    id: 'system',
                    type: 'service',
                    metadata: {}
                },
                resource: {
                    type: 'compliance-rule',
                    id: ruleId,
                    action: 'create'
                },
                context: {
                    location: 'privacy-engine',
                    ipAddress: 'internal',
                    userAgent: 'system'
                },
                status: 'success',
                details: {
                    name: rule.name,
                    category: rule.category
                }
            });

            return ruleId;

        } catch (error) {
            await this.handleError('compliance_rule_creation_error', error);
            throw error;
        }
    }

    private async detectPII(data: any, dataType: string): Promise<PrivacyFinding[]> {
        const findings: PrivacyFinding[] = [];

        // Use Cloud DLP to detect sensitive data
        const request = {
            parent: `projects/${process.env.PROJECT_ID}`,
            item: {
                value: JSON.stringify(data)
            },
            inspectConfig: {
                includeQuote: true,
                minLikelihood: 'LIKELY',
                limits: {
                    maxFindingsPerRequest: 100
                },
                infoTypes: this.getInfoTypesForDataType(dataType)
            }
        };

        const [response] = await this.dlp.inspectContent(request);
        
        if (response.result?.findings) {
            for (const finding of response.result.findings) {
                findings.push({
                    type: finding.infoType?.name || 'unknown',
                    value: finding.quote || '',
                    location: {
                        field: 'content',
                        start: finding.location?.byteRange?.start || 0,
                        end: finding.location?.byteRange?.end || 0
                    },
                    confidence: this.getLikelihoodScore(finding.likelihood),
                    action: this.determineAction(finding)
                });
            }
        }

        return findings;
    }

    private getInfoTypesForDataType(dataType: string): { name: string }[] {
        // Define info types based on data type
        const commonTypes = [
            { name: 'PERSON_NAME' },
            { name: 'EMAIL_ADDRESS' },
            { name: 'PHONE_NUMBER' },
            { name: 'IP_ADDRESS' }
        ];

        // Add specific types based on data type
        switch (dataType) {
            case 'health':
                return [
                    ...commonTypes,
                    { name: 'MEDICAL_RECORD_NUMBER' },
                    { name: 'MEDICAL_TERM' }
                ];
            case 'financial':
                return [
                    ...commonTypes,
                    { name: 'CREDIT_CARD_NUMBER' },
                    { name: 'BANK_ACCOUNT_NUMBER' }
                ];
            default:
                return commonTypes;
        }
    }

    private getLikelihoodScore(likelihood: string | null | undefined): number {
        const scores: Record<string, number> = {
            VERY_LIKELY: 0.9,
            LIKELY: 0.7,
            POSSIBLE: 0.5,
            UNLIKELY: 0.3,
            VERY_UNLIKELY: 0.1
        };
        return scores[likelihood || 'POSSIBLE'] || 0.5;
    }

    private determineAction(finding: any): string {
        // Determine action based on info type and likelihood
        if (finding.likelihood === 'VERY_LIKELY') {
            return 'redact';
        }
        return 'mask';
    }

    private async checkCompliance(
        data: any,
        complianceConfig: PrivacyConfig['compliance']
    ): Promise<PrivacyResult['compliance']> {
        const violations: string[] = [];
        const recommendations: string[] = [];

        // Check GDPR compliance
        if (complianceConfig.gdpr) {
            const gdprViolations = await this.checkGDPRCompliance(data);
            violations.push(...gdprViolations.violations);
            recommendations.push(...gdprViolations.recommendations);
        }

        // Check HIPAA compliance
        if (complianceConfig.hipaa) {
            const hipaaViolations = await this.checkHIPAACompliance(data);
            violations.push(...hipaaViolations.violations);
            recommendations.push(...hipaaViolations.recommendations);
        }

        // Check CCPA compliance
        if (complianceConfig.ccpa) {
            const ccpaViolations = await this.checkCCPACompliance(data);
            violations.push(...ccpaViolations.violations);
            recommendations.push(...ccpaViolations.recommendations);
        }

        // Check custom rules
        if (complianceConfig.customRules) {
            const customViolations = await this.checkCustomRules(
                data,
                complianceConfig.customRules
            );
            violations.push(...customViolations.violations);
            recommendations.push(...customViolations.recommendations);
        }

        return {
            status: violations.length === 0 ? 'compliant' : 'non-compliant',
            violations,
            recommendations
        };
    }

    private async checkGDPRCompliance(data: any): Promise<{
        violations: string[];
        recommendations: string[];
    }> {
        // Implement GDPR compliance checks
        return {
            violations: [],
            recommendations: []
        };
    }

    private async checkHIPAACompliance(data: any): Promise<{
        violations: string[];
        recommendations: string[];
    }> {
        // Implement HIPAA compliance checks
        return {
            violations: [],
            recommendations: []
        };
    }

    private async checkCCPACompliance(data: any): Promise<{
        violations: string[];
        recommendations: string[];
    }> {
        // Implement CCPA compliance checks
        return {
            violations: [],
            recommendations: []
        };
    }

    private async checkCustomRules(
        data: any,
        rules: ComplianceRule[]
    ): Promise<{
        violations: string[];
        recommendations: string[];
    }> {
        // Implement custom rule checks
        return {
            violations: [],
            recommendations: []
        };
    }

    private calculateRiskLevel(result: PrivacyResult): PrivacyResult['stats']['riskLevel'] {
        const highRiskTypes = new Set([
            'CREDIT_CARD_NUMBER',
            'SOCIAL_SECURITY_NUMBER',
            'MEDICAL_RECORD_NUMBER'
        ]);

        const hasHighRiskData = result.findings.some(f => highRiskTypes.has(f.type));
        if (hasHighRiskData || result.stats.piiCount > 10) {
            return 'high';
        }
        if (result.stats.piiCount > 5) {
            return 'medium';
        }
        return 'low';
    }

    private getAnonymizedValue(
        finding: PrivacyFinding,
        config: PrivacyConfig['anonymization']
    ): string {
        const value = finding.value;
        switch (config.method) {
            case 'mask':
                return config.preserveLength ?
                    value.replace(/./g, config.maskChar || '*') :
                    '[REDACTED]';
            case 'encrypt':
                // Implement encryption
                return '[ENCRYPTED]';
            case 'redact':
                return '[REDACTED]';
            default:
                return '[REDACTED]';
        }
    }

    private replaceInString(
        str: string,
        start: number,
        end: number,
        replacement: string
    ): string {
        return str.substring(0, start) + replacement + str.substring(end);
    }

    private mergeConfig(
        config?: Partial<PrivacyConfig>
    ): PrivacyConfig {
        return {
            ...this.DEFAULT_CONFIG,
            ...config,
            piiDetection: {
                ...this.DEFAULT_CONFIG.piiDetection,
                ...config?.piiDetection
            },
            anonymization: {
                ...this.DEFAULT_CONFIG.anonymization,
                ...config?.anonymization
            },
            compliance: {
                ...this.DEFAULT_CONFIG.compliance,
                ...config?.compliance
            }
        };
    }

    private async validateComplianceRule(rule: ComplianceRule): Promise<void> {
        if (!rule.name || !rule.pattern) {
            throw new Error('Invalid compliance rule configuration');
        }
        
        if (rule.pattern instanceof RegExp) {
            try {
                'test'.match(rule.pattern);
            } catch {
                throw new Error('Invalid regular expression in compliance rule');
            }
        }
    }

    private extractSensitiveDataTypes(findings: PrivacyFinding[]): string[] {
        return [...new Set(findings.map(f => f.type))];
    }

    private async loadComplianceRules(): Promise<void> {
        // Load compliance rules from storage
    }

    private setupEventListeners(): void {
        this.eventBus.subscribe({
            id: 'privacy-engine-monitor',
            topic: 'data.update',
            handler: async (event) => {
                if (event.data.type === 'sensitive_data_update') {
                    await this.handleSensitiveDataUpdate(event.data);
                }
            }
        });
    }

    private async handleSensitiveDataUpdate(data: any): Promise<void> {
        // Handle sensitive data updates
        // This might involve re-scanning or updating privacy settings
    }

    private async handleError(type: string, error: Error): Promise<void> {
        await this.monitor.recordMetric({
            name: type,
            value: 1,
            labels: { error: error.message }
        });

        await this.eventBus.publish('privacy.error', {
            type: 'privacy.error',
            source: 'privacy-engine',
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


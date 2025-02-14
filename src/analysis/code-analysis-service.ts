import { MonitoringService } from '../monitoring/monitoring-service';
import { SecurityScanner } from '../security/security-scanner';

interface CodeAnalysisResult {
    id: string;
    timestamp: Date;
    metrics: {
        complexity: number;
        maintainability: number;
        reliability: number;
        security: number;
    };
    issues: CodeIssue[];
    suggestions: string[];
    securityReport: SecurityReport;
}

interface CodeIssue {
    type: 'security' | 'quality' | 'performance';
    severity: 'critical' | 'high' | 'medium' | 'low';
    location: {
        file: string;
        line: number;
        column: number;
    };
    message: string;
    suggestion?: string;
}

interface SecurityReport {
    vulnerabilities: string[];
    securityScore: number;
    riskLevel: 'high' | 'medium' | 'low';
    recommendations: string[];
}

export class CodeAnalysisService {
    private monitor: MonitoringService;
    private securityScanner: SecurityScanner;
    private readonly COMPLEXITY_THRESHOLD = 20;

    constructor(monitor: MonitoringService, securityScanner: SecurityScanner) {
        this.monitor = monitor;
        this.securityScanner = securityScanner;
    }

    async analyzeCode(
        code: string,
        filename: string
    ): Promise<CodeAnalysisResult> {
        const startTime = Date.now();
        try {
            const complexityMetrics = await this.analyzeComplexity(code);
            const qualityMetrics = await this.analyzeCodeQuality(code);
            const securityReport = await this.performSecurityAnalysis(code);
            const issues = await this.identifyIssues(code, filename);

            const result: CodeAnalysisResult = {
                id: `analysis-${Date.now()}`,
                timestamp: new Date(),
                metrics: {
                    complexity: complexityMetrics.overall,
                    maintainability: qualityMetrics.maintainability,
                    reliability: qualityMetrics.reliability,
                    security: securityReport.securityScore
                },
                issues,
                suggestions: this.generateSuggestions(issues),
                securityReport
            };

            await this.monitor.recordMetric({
                name: 'code_analysis',
                value: Date.now() - startTime,
                labels: {
                    analysis_id: result.id,
                    file: filename
                }
            });

            return result;

        } catch (error) {
            await this.monitor.recordMetric({
                name: 'code_analysis_error',
                value: 1,
                labels: { error: error.message }
            });
            throw error;
        }
    }

    private async analyzeComplexity(code: string): Promise<{ overall: number; details: any }> {
        // Implement cyclomatic complexity analysis
        const complexity = {
            overall: 0,
            details: {}
        };

        // Calculate complexity metrics
        const functionMatches = code.match(/function\s+\w+\s*\(([^)]*)\)/g) || [];
        complexity.overall = functionMatches.length;

        return complexity;
    }

    private async analyzeCodeQuality(code: string): Promise<{ maintainability: number; reliability: number }> {
        // Implement code quality analysis
        return {
            maintainability: 0.85,
            reliability: 0.90
        };
    }

    private async performSecurityAnalysis(code: string): Promise<SecurityReport> {
        const securityScan = await this.securityScanner.scanCode(code);
        
        return {
            vulnerabilities: securityScan.vulnerabilities.map(v => v.description),
            securityScore: securityScan.score,
            riskLevel: this.calculateRiskLevel(securityScan.score),
            recommendations: securityScan.vulnerabilities.map(v => v.remediation || '')
        };
    }

    private async identifyIssues(code: string, filename: string): Promise<CodeIssue[]> {
        const issues: CodeIssue[] = [];

        // Add security issues
        const securityScan = await this.securityScanner.scanCode(code);
        issues.push(...this.convertVulnerabilitiesToIssues(securityScan.vulnerabilities));

        // Add quality issues
        const qualityIssues = this.analyzeCodeQuality(code);
        // Add quality-related issues

        return issues;
    }

    private convertVulnerabilitiesToIssues(vulnerabilities: any[]): CodeIssue[] {
        return vulnerabilities.map(vuln => ({
            type: 'security',
            severity: vuln.severity,
            location: {
                file: 'unknown',
                line: 0,
                column: 0
            },
            message: vuln.description,
            suggestion: vuln.remediation
        }));
    }

    private calculateRiskLevel(securityScore: number): SecurityReport['riskLevel'] {
        if (securityScore < 50) return 'high';
        if (securityScore < 80) return 'medium';
        return 'low';
    }

    private generateSuggestions(issues: CodeIssue[]): string[] {
        return issues
            .filter(issue => issue.suggestion)
            .map(issue => issue.suggestion!)
            .filter((suggestion, index, self) => self.indexOf(suggestion) === index);
    }
}

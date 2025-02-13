import { MonitoringService } from '../monitoring/monitoring-service';
import { SecurityScanner } from '../security/security-scanner';
import { CodeAnalysisService } from '../analysis/code-analysis-service';
import { AuditTrailService } from '../audit/audit-trail-service';

interface GenerationRequest {
    prompt: string;
    context?: string;
    language: string;
    maxTokens: number;
    temperature: number;
    security: {
        strictMode: boolean;
        allowedPatterns: string[];
        blockedPatterns: string[];
    };
    quality: {
        minScore: number;
        requireTests: boolean;
        style: 'clean' | 'documented' | 'optimized';
    };
}

interface GenerationResult {
    id: string;
    code: string;
    explanation: string;
    metadata: {
        timestamp: Date;
        executionTime: number;
        tokenCount: number;
        promptTokens: number;
    };
    security: {
        passed: boolean;
        issues: string[];
        score: number;
    };
    quality: {
        score: number;
        suggestions: string[];
        complexity: number;
    };
    tests?: string;
}

export class CodeGenerationService {
    private monitor: MonitoringService;
    private securityScanner: SecurityScanner;
    private codeAnalysis: CodeAnalysisService;
    private auditService: AuditTrailService;
    private readonly MAX_ATTEMPTS = 3;

    constructor(
        monitor: MonitoringService,
        securityScanner: SecurityScanner,
        codeAnalysis: CodeAnalysisService,
        auditService: AuditTrailService
    ) {
        this.monitor = monitor;
        this.securityScanner = securityScanner;
        this.codeAnalysis = codeAnalysis;
        this.auditService = auditService;
    }

    async generateCode(request: GenerationRequest): Promise<GenerationResult> {
        const startTime = Date.now();
        try {
            // Validate request
            await this.validateRequest(request);

            // Generate code with retries
            let attempts = 0;
            let generatedCode: string | null = null;
            let securityIssues: string[] = [];

            while (attempts < this.MAX_ATTEMPTS) {
                generatedCode = await this.generateInitialCode(request);
                
                // Security scan
                const securityResult = await this.securityScanner.scanCode(generatedCode);
                securityIssues = securityResult.vulnerabilities.map(v => v.description);

                if (securityIssues.length === 0 || !request.security.strictMode) {
                    break;
                }

                attempts++;
            }

            if (!generatedCode) {
                throw new Error('Failed to generate secure code');
            }

            // Analyze code quality
            const analysisResult = await this.codeAnalysis.analyzeCode(
                generatedCode,
                'generated.ts'
            );

            // Generate tests if required
            const tests = request.quality.requireTests ?
                await this.generateTests(generatedCode, request.language) :
                undefined;

            // Create result
            const result: GenerationResult = {
                id: this.generateResultId(),
                code: generatedCode,
                explanation: await this.generateExplanation(generatedCode),
                metadata: {
                    timestamp: new Date(),
                    executionTime: Date.now() - startTime,
                    tokenCount: this.countTokens(generatedCode),
                    promptTokens: this.countTokens(request.prompt)
                },
                security: {
                    passed: securityIssues.length === 0,
                    issues: securityIssues,
                    score: analysisResult.metrics.security
                },
                quality: {
                    score: analysisResult.metrics.maintainability,
                    suggestions: analysisResult.suggestions,
                    complexity: analysisResult.metrics.complexity
                },
                tests
            };

            // Audit trail
            await this.auditService.logEvent({
                eventType: 'model.access',
                actor: {
                    id: 'code-generator',
                    type: 'service',
                    metadata: { resultId: result.id }
                },
                resource: {
                    type: 'code',
                    id: result.id,
                    action: 'generate'
                },
                context: {
                    location: 'code-generation',
                    ipAddress: 'internal',
                    userAgent: 'system'
                },
                status: 'success',
                details: {
                    language: request.language,
                    securityPassed: result.security.passed
                }
            });

            await this.monitor.recordMetric({
                name: 'code_generation',
                value: result.metadata.executionTime,
                labels: {
                    result_id: result.id,
                    language: request.language,
                    security_passed: result.security.passed.toString()
                }
            });

            return result;

        } catch (error) {
            await this.handleGenerationError(error);
            throw error;
        }
    }

    private async validateRequest(request: GenerationRequest): Promise<void> {
        if (!request.prompt || !request.language) {
            throw new Error('Invalid generation request');
        }

        if (request.maxTokens <= 0 || request.maxTokens > 4096) {
            throw new Error('Invalid token limit');
        }

        if (request.temperature < 0 || request.temperature > 1) {
            throw new Error('Invalid temperature value');
        }
    }

    private async generateInitialCode(request: GenerationRequest): Promise<string> {
        // Implementation for initial code generation
        return '// Generated code placeholder';
    }

    private async generateTests(code: string, language: string): Promise<string> {
        // Implementation for test generation
        return '// Generated tests placeholder';
    }

    private async generateExplanation(code: string): Promise<string> {
        // Implementation for code explanation generation
        return 'Code explanation placeholder';
    }

    private countTokens(text: string): number {
        // Implementation for token counting
        return text.split(/\s+/).length;
    }

    private async handleGenerationError(error: Error): Promise<void> {
        await this.monitor.recordMetric({
            name: 'generation_error',
            value: 1,
            labels: { error: error.message }
        });
    }

    private generateResultId(): string {
        return `gen-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }
}

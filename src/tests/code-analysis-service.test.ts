import { CodeAnalysisService } from '../analysis/code-analysis-service';
import { MonitoringService } from '../monitoring/monitoring-service';
import { SecurityScanner } from '../security/security-scanner';

describe('CodeAnalysisService', () => {
    let analysisService: CodeAnalysisService;
    let mockMonitor: jest.Mocked<MonitoringService>;
    let mockSecurityScanner: jest.Mocked<SecurityScanner>;

    beforeEach(() => {
        mockMonitor = {
            recordMetric: jest.fn()
        } as any;

        mockSecurityScanner = {
            scanCode: jest.fn()
        } as any;

        analysisService = new CodeAnalysisService(
            mockMonitor,
            mockSecurityScanner
        );
    });

    describe('analyzeCode', () => {
        it('should analyze code successfully', async () => {
            const testCode = `
                function test() {
                    console.log('test');
                }
            `;

            mockSecurityScanner.scanCode.mockResolvedValue({
                vulnerabilities: [],
                score: 95,
                timestamp: new Date(),
                scanId: 'test-scan'
            });

            const result = await analysisService.analyzeCode(testCode, 'test.js');

            expect(result.metrics).toBeDefined();
            expect(result.issues).toBeDefined();
            expect(result.securityReport).toBeDefined();
            expect(mockMonitor.recordMetric).toHaveBeenCalled();
        });

        it('should identify security issues', async () => {
            const testCode = `
                function test() {
                    eval('console.log("test")');
                }
            `;

            mockSecurityScanner.scanCode.mockResolvedValue({
                vulnerabilities: [{
                    severity: 'high',
                    description: 'Unsafe eval() usage',
                    remediation: 'Avoid using eval()'
                }],
                score: 60,
                timestamp: new Date(),
                scanId: 'test-scan'
            });

            const result = await analysisService.analyzeCode(testCode, 'test.js');

            expect(result.securityReport.riskLevel).toBe('medium');
            expect(result.issues.length).toBeGreaterThan(0);
            expect(result.issues[0].type).toBe('security');
        });
    });
});

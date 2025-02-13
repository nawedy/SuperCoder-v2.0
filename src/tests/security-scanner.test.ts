import { SecurityScanner } from '../security/security-scanner';
import { MonitoringService } from '../monitoring/monitoring-service';
import { defaultSecurityConfig } from '../config/security-config';

describe('SecurityScanner', () => {
    let securityScanner: SecurityScanner;
    let mockMonitor: jest.Mocked<MonitoringService>;

    beforeEach(() => {
        mockMonitor = {
            recordMetric: jest.fn()
        } as any;

        securityScanner = new SecurityScanner(
            mockMonitor,
            defaultSecurityConfig
        );
    });

    describe('scanCode', () => {
        it('should detect eval usage', async () => {
            const code = 'function test() { eval("console.log(\'test\')"); }';
            const result = await securityScanner.scanCode(code);

            expect(result.vulnerabilities).toHaveLength(1);
            expect(result.vulnerabilities[0].id).toBe('SECURE-001');
            expect(result.score).toBeLessThan(100);
        });

        it('should handle secure code', async () => {
            const code = 'function test() { console.log("test"); }';
            const result = await securityScanner.scanCode(code);

            expect(result.vulnerabilities).toHaveLength(0);
            expect(result.score).toBe(100);
        });
    });
});

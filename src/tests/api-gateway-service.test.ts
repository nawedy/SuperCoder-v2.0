import { APIGatewayService } from '../api/api-gateway-service';
import { AuthService } from '../auth/auth-service';
import { MonitoringService } from '../monitoring/monitoring-service';
import { defaultSecurityConfig } from '../config/security-config';

describe('APIGatewayService', () => {
    let apiGateway: APIGatewayService;
    let mockAuth: jest.Mocked<AuthService>;
    let mockMonitor: jest.Mocked<MonitoringService>;

    beforeEach(() => {
        mockAuth = {
            validateToken: jest.fn(),
            createSession: jest.fn(),
            verifyMFA: jest.fn()
        } as any;

        mockMonitor = {
            recordMetric: jest.fn()
        } as any;

        apiGateway = new APIGatewayService(
            mockAuth,
            mockMonitor,
            defaultSecurityConfig
        );
    });

    describe('handleRequest', () => {
        it('should handle valid requests', async () => {
            mockAuth.validateToken.mockResolvedValue(true);

            const request = {
                path: '/test',
                method: 'GET' as const,
                headers: {
                    'authorization': 'Bearer token',
                    'x-client-id': 'test-client'
                }
            };

            const response = await apiGateway.handleRequest(request);
            expect(response.status).toBe(200);
            expect(mockMonitor.recordMetric).toHaveBeenCalled();
        });

        it('should reject unauthorized requests', async () => {
            mockAuth.validateToken.mockResolvedValue(false);

            const request = {
                path: '/test',
                method: 'GET' as const,
                headers: {
                    'authorization': 'Bearer invalid-token',
                    'x-client-id': 'test-client'
                }
            };

            await expect(
                apiGateway.handleRequest(request)
            ).rejects.toThrow('Unauthorized');
        });
    });
});

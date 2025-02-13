import { SessionService } from '../session/session-service';
import { MonitoringService } from '../monitoring/monitoring-service';
import { defaultSecurityConfig } from '../config/security-config';

describe('SessionService', () => {
    let sessionService: SessionService;
    let mockMonitor: jest.Mocked<MonitoringService>;

    beforeEach(() => {
        mockMonitor = {
            recordMetric: jest.fn()
        } as any;

        sessionService = new SessionService(
            mockMonitor,
            defaultSecurityConfig
        );
    });

    describe('createSession', () => {
        it('should create a valid session', async () => {
            const userId = 'test-user';
            const metadata = {
                userAgent: 'test-agent',
                ipAddress: '127.0.0.1'
            };

            const session = await sessionService.createSession(userId, metadata);

            expect(session.userId).toBe(userId);
            expect(session.metadata.userAgent).toBe(metadata.userAgent);
            expect(mockMonitor.recordMetric).toHaveBeenCalled();
        });
    });

    describe('validateSession', () => {
        it('should validate an active session', async () => {
            const userId = 'test-user';
            const session = await sessionService.createSession(userId, {});
            const isValid = await sessionService.validateSession(session.id);
            
            expect(isValid).toBe(true);
        });

        it('should reject an invalid session', async () => {
            const isValid = await sessionService.validateSession('invalid-session');
            expect(isValid).toBe(false);
        });
    });
});

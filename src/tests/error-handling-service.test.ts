import { ErrorHandlingService } from '../error/error-handling-service';
import { MonitoringService } from '../monitoring/monitoring-service';

describe('ErrorHandlingService', () => {
    let errorHandler: ErrorHandlingService;
    let mockMonitor: jest.Mocked<MonitoringService>;

    beforeEach(() => {
        mockMonitor = {
            recordMetric: jest.fn()
        } as any;

        errorHandler = new ErrorHandlingService(mockMonitor);
    });

    describe('handleError', () => {
        it('should handle validation errors', async () => {
            const error = new Error('Invalid input');
            error.name = 'ValidationError';

            const context = {
                component: 'test-component',
                severity: 'high' as const,
                metadata: {}
            };

            const response = await errorHandler.handleError(error, context);

            expect(response.handled).toBe(true);
            expect(response.recoverySteps).toBeDefined();
            expect(mockMonitor.recordMetric).toHaveBeenCalled();
        });

        it('should sanitize error messages', async () => {
            const error = new Error('Error with email: test@example.com');
            const context = {
                component: 'test-component',
                severity: 'medium' as const,
                metadata: {}
            };

            const response = await errorHandler.handleError(error, context);

            expect(response.message).not.toContain('test@example.com');
            expect(response.message).toContain('[EMAIL]');
        });
    });
});

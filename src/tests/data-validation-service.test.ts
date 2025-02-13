import { DataValidationService } from '../validation/data-validation-service';
import { MonitoringService } from '../monitoring/monitoring-service';
import { ErrorHandlingService } from '../error/error-handling-service';

describe('DataValidationService', () => {
    let validationService: DataValidationService;
    let mockMonitor: jest.Mocked<MonitoringService>;
    let mockErrorHandler: jest.Mocked<ErrorHandlingService>;

    beforeEach(() => {
        mockMonitor = {
            recordMetric: jest.fn()
        } as any;

        mockErrorHandler = {
            handleError: jest.fn()
        } as any;

        validationService = new DataValidationService(
            mockMonitor,
            mockErrorHandler
        );
    });

    describe('validateData', () => {
        it('should validate correct model input data', async () => {
            const data = {
                code: 'console.log("test")',
                language: 'javascript',
                settings: {
                    temperature: 0.7,
                    maxTokens: 100
                }
            };

            const result = await validationService.validateData(
                data,
                'model-input',
                { source: 'test', type: 'model-input', metadata: {} }
            );

            expect(result.valid).toBe(true);
            expect(result.errors).toHaveLength(0);
            expect(mockMonitor.recordMetric).toHaveBeenCalled();
        });

        it('should reject invalid model input data', async () => {
            const data = {
                code: '',  // Invalid: empty string
                language: 'javascript',
                settings: {
                    temperature: 2,  // Invalid: > 1
                    maxTokens: 100
                }
            };

            const result = await validationService.validateData(
                data,
                'model-input',
                { source: 'test', type: 'model-input', metadata: {} }
            );

            expect(result.valid).toBe(false);
            expect(result.errors.length).toBeGreaterThan(0);
            expect(mockMonitor.recordMetric).toHaveBeenCalled();
        });
    });

    describe('addCustomSchema', () => {
        it('should allow adding custom schemas', async () => {
            const customSchema = z.object({
                name: z.string(),
                age: z.number().min(0)
            });

            await validationService.addCustomSchema('custom', customSchema);

            const data = { name: 'Test', age: 25 };
            const result = await validationService.validateData(
                data,
                'custom',
                { source: 'test', type: 'api-request', metadata: {} }
            );

            expect(result.valid).toBe(true);
        });
    });
});

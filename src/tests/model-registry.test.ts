import { ModelRegistry } from '../models/model-registry';
import { MonitoringService } from '../monitoring/monitoring-service';
import { defaultSecurityConfig } from '../config/security-config';

describe('ModelRegistry', () => {
    let modelRegistry: ModelRegistry;
    let mockMonitor: jest.Mocked<MonitoringService>;

    beforeEach(() => {
        mockMonitor = {
            recordMetric: jest.fn(),
            createAlert: jest.fn(),
        } as any;

        modelRegistry = new ModelRegistry(
            'test-bucket',
            defaultSecurityConfig,
            mockMonitor
        );
    });

    describe('registerModel', () => {
        it('should successfully register a new model', async () => {
            const modelBuffer = Buffer.from('test model data');
            const result = await modelRegistry.registerModel(
                'test-model-1',
                modelBuffer,
                {}
            );

            expect(result.id).toBe('test-model-1');
            expect(result.securityScanStatus).toBe('pending');
            expect(result.deploymentStatus).toBe('draft');
            expect(mockMonitor.recordMetric).toHaveBeenCalledWith({
                name: 'model_registration',
                value: 1,
                labels: { model_id: 'test-model-1' }
            });
        });

        it('should handle registration failures', async () => {
            const modelBuffer = Buffer.from('test model data');
            jest.spyOn(modelRegistry as any, 'encryptModel')
                .mockRejectedValue(new Error('Encryption failed'));

            await expect(
                modelRegistry.registerModel('test-model-2', modelBuffer, {})
            ).rejects.toThrow('Encryption failed');

            expect(mockMonitor.recordMetric).toHaveBeenCalledWith({
                name: 'model_registration_error',
                value: 1,
                labels: {
                    model_id: 'test-model-2',
                    error: 'Encryption failed'
                }
            });
        });
    });

    // Add more test cases for other methods...
});

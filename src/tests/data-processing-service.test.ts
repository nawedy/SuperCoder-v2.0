import { DataProcessingService } from '../data/data-processing-service';
import { PrivacyEngine } from '../privacy/privacy-engine';
import { MonitoringService } from '../monitoring/monitoring-service';
import { defaultSecurityConfig } from '../config/security-config';

describe('DataProcessingService', () => {
    let dataProcessingService: DataProcessingService;
    let mockPrivacyEngine: jest.Mocked<PrivacyEngine>;
    let mockMonitor: jest.Mocked<MonitoringService>;

    beforeEach(() => {
        mockPrivacyEngine = {
            scanForPII: jest.fn(),
            anonymizeData: jest.fn()
        } as any;

        mockMonitor = {
            recordMetric: jest.fn()
        } as any;

        dataProcessingService = new DataProcessingService(
            mockPrivacyEngine,
            mockMonitor,
            defaultSecurityConfig
        );
    });

    describe('processData', () => {
        it('should process data with all options enabled', async () => {
            const testData = 'test data';
            mockPrivacyEngine.scanForPII.mockResolvedValue(true);
            mockPrivacyEngine.anonymizeData.mockResolvedValue('anonymized data');

            const result = await dataProcessingService.processData(testData, {
                anonymize: true,
                validate: true,
                tokenize: true
            });

            expect(mockPrivacyEngine.scanForPII).toHaveBeenCalled();
            expect(mockPrivacyEngine.anonymizeData).toHaveBeenCalled();
            expect(mockMonitor.recordMetric).toHaveBeenCalled();
            expect(result).toBeDefined();
        });

        it('should handle empty data', async () => {
            await expect(
                dataProcessingService.processData('', {
                    anonymize: true,
                    validate: true,
                    tokenize: true
                })
            ).rejects.toThrow('Invalid data');
        });
    });
});

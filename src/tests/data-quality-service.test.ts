import { DataQualityService } from '../data/data-quality-service';
import { MonitoringService } from '../monitoring/monitoring-service';

describe('DataQualityService', () => {
    let dataQualityService: DataQualityService;
    let mockMonitor: jest.Mocked<MonitoringService>;

    beforeEach(() => {
        mockMonitor = {
            recordMetric: jest.fn(),
            createAlert: jest.fn()
        } as any;

        dataQualityService = new DataQualityService(mockMonitor);
    });

    describe('analyzeDataQuality', () => {
        it('should generate quality report for valid data', async () => {
            const testData = Buffer.from('test quality data');
            const report = await dataQualityService.analyzeDataQuality(testData);

            expect(report).toBeDefined();
            expect(report.metrics).toBeDefined();
            expect(report.issues).toBeDefined();
            expect(mockMonitor.recordMetric).toHaveBeenCalled();
        });

        it('should handle empty data', async () => {
            const emptyData = Buffer.from('');
            const report = await dataQualityService.analyzeDataQuality(emptyData);

            expect(report.issues).toHaveLength(1);
            expect(report.issues[0].type).toBe('error');
            expect(report.issues[0].impact).toBe('high');
        });
    });
});

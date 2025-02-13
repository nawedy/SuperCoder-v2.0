import { MonitoringService } from '../monitoring/monitoring-service';

describe('MonitoringService', () => {
    let monitoringService: MonitoringService;

    beforeEach(() => {
        monitoringService = new MonitoringService('test-project');
    });

    describe('recordMetric', () => {
        it('should successfully record a metric', async () => {
            const metricData = {
                name: 'test-metric',
                value: 1.0,
                labels: { test: 'label' }
            };

            await expect(
                monitoringService.recordMetric(metricData)
            ).resolves.not.toThrow();
        });

        it('should handle metric recording failures', async () => {
            const metricData = {
                name: 'test-metric',
                value: 1.0,
                labels: { test: 'label' }
            };

            jest.spyOn(monitoringService as any, 'client')
                .mockRejectedValue(new Error('Recording failed'));

            await expect(
                monitoringService.recordMetric(metricData)
            ).rejects.toThrow('Recording failed');
        });
    });

    describe('createAlert', () => {
        it('should successfully create an alert', async () => {
            await expect(
                monitoringService.createAlert('test-metric', 100)
            ).resolves.not.toThrow();
        });

        // Add more test cases...
    });
});

import { MonitoringService } from '../monitoring/monitoring-service';
import { EventBusService } from '../events/event-bus-service';
import { BigQuery } from '@google-cloud/bigquery';
import { RealTimeMetricsService } from '../monitoring/real-time-metrics-service';
import { createClient as createRedisClient } from 'redis';
import { Worker } from 'worker_threads';
import { v4 as uuidv4 } from 'uuid';

interface LoadTestConfig {
    name: string;
    target: {
        url: string;
        method: string;
        headers?: Record<string, string>;
        body?: any;
    };
    phases: Array<{
        duration: number;
        rps: number;
        rampUp?: boolean;
    }>;
    assertions: Array<{
        metric: string;
        condition: 'gt' | 'lt' | 'eq';
        value: number;
    }>;
    timeout: number;
}

interface LoadTestResult {
    id: string;
    config: LoadTestConfig;
    metrics: {
        duration: number;
        totalRequests: number;
        successfulRequests: number;
        failedRequests: number;
        averageLatency: number;
        p95Latency: number;
        p99Latency: number;
        rps: number;
        errors: Array<{
            count: number;
            type: string;
            message: string;
        }>;
    };
    status: 'passed' | 'failed';
    assertions: Array<{
        metric: string;
        expected: number;
        actual: number;
        passed: boolean;
    }>;
    timestamp: Date;
}

export class LoadTestingService {
    private redis: ReturnType<typeof createRedisClient>;
    private bigquery: BigQuery;
    private activeTests: Map<string, Worker[]>;
    private results: Map<string, LoadTestResult>;
    private readonly MAX_CONCURRENT_TESTS = 5;

    constructor(
        private monitor: MonitoringService,
        private metrics: RealTimeMetricsService,
        private eventBus: EventBusService,
        private config: {
            projectId: string;
            redisUrl: string;
            workerScript: string;
        }
    ) {
        this.redis = createRedisClient({ url: config.redisUrl });
        this.bigquery = new BigQuery({ projectId: config.projectId });
        this.activeTests = new Map();
        this.results = new Map();
        this.initialize();
    }

    private async initialize(): Promise<void> {
        await this.redis.connect();
        this.setupEventListeners();
    }

    async startLoadTest(config: LoadTestConfig): Promise<string> {
        const testId = uuidv4();
        const startTime = Date.now();

        try {
            // Validate concurrent test limit
            if (this.activeTests.size >= this.MAX_CONCURRENT_TESTS) {
                throw new Error('Maximum concurrent tests limit reached');
            }

            // Validate configuration
            this.validateConfig(config);

            // Initialize test resources
            const workers = await this.initializeWorkers(testId, config);
            this.activeTests.set(testId, workers);

            // Start test execution
            const result = await this.executeLoadTest(testId, config, workers);

            // Store and analyze results
            await this.processResults(testId, config, result);

            return testId;

        } catch (error) {
            await this.handleError('load_test_error', error, testId);
            throw error;
        }
    }

    async stopLoadTest(testId: string): Promise<void> {
        const workers = this.activeTests.get(testId);
        if (workers) {
            await this.terminateWorkers(workers);
            this.activeTests.delete(testId);
        }
    }

    async getTestResults(testId: string): Promise<LoadTestResult | null> {
        return this.results.get(testId) || null;
    }

    private validateConfig(config: LoadTestConfig): void {
        if (!config.target.url || !config.target.method) {
            throw new Error('Invalid target configuration');
        }

        if (!config.phases || config.phases.length === 0) {
            throw new Error('At least one test phase is required');
        }

        for (const phase of config.phases) {
            if (phase.duration <= 0 || phase.rps <= 0) {
                throw new Error('Invalid phase configuration');
            }
        }
    }

    private async initializeWorkers(
        testId: string,
        config: LoadTestConfig
    ): Promise<Worker[]> {
        const workers: Worker[] = [];
        const workerCount = Math.ceil(
            Math.max(...config.phases.map(p => p.rps)) / 100
        );

        for (let i = 0; i < workerCount; i++) {
            const worker = new Worker(this.config.workerScript, {
                workerData: {
                    testId,
                    workerId: i,
                    config
                }
            });

            workers.push(worker);
            this.setupWorkerListeners(worker, testId);
        }

        return workers;
    }

    private setupWorkerListeners(worker: Worker, testId: string): void {
        worker.on('message', async (message) => {
            if (message.type === 'metric') {
                await this.metrics.recordMetric({
                    name: message.metric,
                    value: message.value,
                    timestamp: new Date(),
                    labels: {
                        test_id: testId,
                        worker_id: message.workerId.toString()
                    }
                });
            }
        });

        worker.on('error', async (error) => {
            await this.handleError('worker_error', error, testId);
        });
    }

    private async executeLoadTest(
        testId: string,
        config: LoadTestConfig,
        workers: Worker[]
    ): Promise<any> {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.terminateWorkers(workers);
                reject(new Error('Load test timeout'));
            }, config.timeout);

            let completedWorkers = 0;
            const results: any[] = [];

            workers.forEach(worker => {
                worker.on('message', (message) => {
                    if (message.type === 'complete') {
                        results.push(message.results);
                        completedWorkers++;

                        if (completedWorkers === workers.length) {
                            clearTimeout(timeout);
                            resolve(this.aggregateResults(results));
                        }
                    }
                });
            });

            // Start the test
            workers.forEach(worker => worker.postMessage({ command: 'start' }));
        });
    }

    private async terminateWorkers(workers: Worker[]): Promise<void> {
        await Promise.all(
            workers.map(worker => worker.terminate())
        );
    }

    private aggregateResults(workerResults: any[]): LoadTestResult['metrics'] {
        const allLatencies = workerResults.flatMap(r => r.latencies).sort((a, b) => a - b);
        const totalRequests = workerResults.reduce((sum, r) => sum + r.totalRequests, 0);
        const successfulRequests = workerResults.reduce((sum, r) => sum + r.successfulRequests, 0);
        const duration = Math.max(...workerResults.map(r => r.duration));

        return {
            duration,
            totalRequests,
            successfulRequests,
            failedRequests: totalRequests - successfulRequests,
            averageLatency: allLatencies.reduce((a, b) => a + b, 0) / allLatencies.length,
            p95Latency: allLatencies[Math.floor(allLatencies.length * 0.95)],
            p99Latency: allLatencies[Math.floor(allLatencies.length * 0.99)],
            rps: totalRequests / (duration / 1000),
            errors: this.aggregateErrors(workerResults)
        };
    }

    private aggregateErrors(workerResults: any[]): LoadTestResult['metrics']['errors'] {
        const errorMap = new Map<string, { count: number; message: string }>();

        for (const result of workerResults) {
            for (const error of result.errors) {
                const key = `${error.type}:${error.message}`;
                const existing = errorMap.get(key) || { count: 0, message: error.message };
                existing.count += error.count;
                errorMap.set(key, existing);
            }
        }

        return Array.from(errorMap.entries()).map(([type, data]) => ({
            type,
            count: data.count,
            message: data.message
        }));
    }

    private async processResults(
        testId: string,
        config: LoadTestConfig,
        metrics: LoadTestResult['metrics']
    ): Promise<void> {
        const assertions = await this.validateAssertions(config.assertions, metrics);
        const result: LoadTestResult = {
            id: testId,
            config,
            metrics,
            status: assertions.every(a => a.passed) ? 'passed' : 'failed',
            assertions,
            timestamp: new Date()
        };

        // Store results
        this.results.set(testId, result);
        await this.storeResults(result);

        // Emit completion event
        await this.eventBus.publish('load_test.completed', {
            type: 'load_test.completed',
            source: 'load-testing',
            data: result
        });
    }

    private async validateAssertions(
        assertions: LoadTestConfig['assertions'],
        metrics: LoadTestResult['metrics']
    ): Promise<LoadTestResult['assertions']> {
        return assertions.map(assertion => {
            const actual = this.getMetricValue(assertion.metric, metrics);
            return {
                metric: assertion.metric,
                expected: assertion.value,
                actual,
                passed: this.evaluateCondition(
                    actual,
                    assertion.condition,
                    assertion.value
                )
            };
        });
    }

    private getMetricValue(metric: string, metrics: LoadTestResult['metrics']): number {
        switch (metric) {
            case 'rps': return metrics.rps;
            case 'latency_p95': return metrics.p95Latency;
            case 'latency_p99': return metrics.p99Latency;
            case 'error_rate':
                return (metrics.failedRequests / metrics.totalRequests) * 100;
            default:
                throw new Error(`Unknown metric: ${metric}`);
        }
    }

    private evaluateCondition(
        actual: number,
        condition: string,
        expected: number
    ): boolean {
        switch (condition) {
            case 'gt': return actual > expected;
            case 'lt': return actual < expected;
            case 'eq': return Math.abs(actual - expected) < 0.0001;
            default: return false;
        }
    }

    private async storeResults(result: LoadTestResult): Promise<void> {
        await this.bigquery
            .dataset('testing')
            .table('load_test_results')
            .insert([{
                test_id: result.id,
                config: JSON.stringify(result.config),
                metrics: JSON.stringify(result.metrics),
                assertions: JSON.stringify(result.assertions),
                status: result.status,
                timestamp: result.timestamp
            }]);
    }

    private setupEventListeners(): void {
        this.eventBus.subscribe({
            id: 'load-test-monitor',
            topic: 'system.health',
            handler: async (event) => {
                if (event.data.type === 'system_overload') {
                    await this.handleSystemOverload();
                }
            }
        });
    }

    private async handleSystemOverload(): Promise<void> {
        // Stop all active tests
        for (const [testId, workers] of this.activeTests) {
            await this.stopLoadTest(testId);
        }
    }

    private async handleError(
        type: string,
        error: Error,
        testId?: string
    ): Promise<void> {
        await this.monitor.recordMetric({
            name: `load_test_${type}`,
            value: 1,
            labels: {
                error: error.message,
                test_id: testId || 'unknown'
            }
        });

        await this.eventBus.publish('load_test.error', {
            type: 'load_test.error',
            source: 'load-testing',
            data: {
                error: error.message,
                type,
                testId,
                timestamp: new Date()
            }
        });
    }

    async close(): Promise<void> {
        // Stop all active tests
        for (const [testId, workers] of this.activeTests) {
            await this.stopLoadTest(testId);
        }
        await this.redis.quit();
    }
}

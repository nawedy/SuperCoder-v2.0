import { MonitoringService } from '../monitoring/monitoring-service';
import { EventBusService } from '../events/event-bus-service';
import { BigQuery } from '@google-cloud/bigquery';
import { createClient as createRedisClient } from 'redis';
import { DeploymentTestingService } from '../deployment/testing/deployment-testing-service';

interface TestSuiteConfig {
    id: string;
    name: string;
    description: string;
    type: 'unit' | 'integration' | 'e2e' | 'performance' | 'security';
    priority: 'critical' | 'high' | 'medium' | 'low';
    dependencies: string[];
    timeout: number;
    retryConfig: {
        maxAttempts: number;
        backoffMs: number;
    };
    parallelization: boolean;
}

interface TestResult {
    suiteId: string;
    runId: string;
    status: 'passed' | 'failed' | 'skipped' | 'error';
    duration: number;
    metrics: {
        totalTests: number;
        passed: number;
        failed: number;
        skipped: number;
        coverage: number;
    };
    errors: Array<{
        message: string;
        stackTrace: string;
        testCase: string;
    }>;
    timestamp: Date;
}

interface TestRun {
    id: string;
    suites: string[];
    status: 'pending' | 'running' | 'completed' | 'failed';
    results: Map<string, TestResult>;
    startTime: Date;
    endTime?: Date;
}

export class TestManagerService {
    private redis: ReturnType<typeof createRedisClient>;
    private bigquery: BigQuery;
    private activeRuns: Map<string, TestRun>;
    private testSuites: Map<string, TestSuiteConfig>;
    private deploymentTesting: DeploymentTestingService;

    constructor(
        private monitor: MonitoringService,
        private eventBus: EventBusService,
        private config: {
            redisUrl: string;
            projectId: string;
            maxConcurrentRuns: number;
        }
    ) {
        this.redis = createRedisClient({ url: config.redisUrl });
        this.bigquery = new BigQuery({ projectId: config.projectId });
        this.activeRuns = new Map();
        this.testSuites = new Map();
        this.initialize();
    }

    private async initialize(): Promise<void> {
        await this.redis.connect();
        await this.loadTestSuites();
        this.setupEventListeners();
    }

    async startTestRun(
        suiteIds: string[],
        options: {
            parallel?: boolean;
            timeout?: number;
            retries?: number;
        } = {}
    ): Promise<string> {
        try {
            // Validate suites exist
            for (const id of suiteIds) {
                if (!this.testSuites.has(id)) {
                    throw new Error(`Test suite ${id} not found`);
                }
            }

            // Create test run
            const runId = `run_${Date.now()}`;
            const run: TestRun = {
                id: runId,
                suites: suiteIds,
                status: 'pending',
                results: new Map(),
                startTime: new Date()
            };

            // Store run
            this.activeRuns.set(runId, run);
            await this.storeRunState(run);

            // Execute tests
            this.executeTestRun(run, options).catch(error => 
                this.handleError('test_execution_error', error, runId)
            );

            return runId;

        } catch (error) {
            await this.handleError('test_start_error', error);
            throw error;
        }
    }

    async getTestRunStatus(runId: string): Promise<TestRun | null> {
        const run = this.activeRuns.get(runId);
        if (run) return run;

        // Try to get from Redis
        const stored = await this.redis.get(`test_run:${runId}`);
        return stored ? JSON.parse(stored) : null;
    }

    async getTestResults(
        timeframe: '1h' | '24h' | '7d' = '24h'
    ): Promise<TestResult[]> {
        const query = `
            SELECT *
            FROM ${this.config.projectId}.testing.test_results
            WHERE timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL ${timeframe})
            ORDER BY timestamp DESC
        `;

        const [rows] = await this.bigquery.query({ query });
        return rows.map(this.deserializeTestResult);
    }

    private async executeTestRun(
        run: TestRun,
        options: any
    ): Promise<void> {
        const startTime = Date.now();
        run.status = 'running';
        await this.updateRunStatus(run);

        try {
            // Execute suites in parallel or series
            const results = await (options.parallel 
                ? this.executeParallel(run.suites, options)
                : this.executeSeries(run.suites, options)
            );

            // Update run with results
            results.forEach((result, suiteId) => run.results.set(suiteId, result));
            
            run.status = this.determineRunStatus(results);
            run.endTime = new Date();

            // Store final results
            await this.storeTestResults(run);
            await this.updateRunStatus(run);

            // Emit completion event
            await this.eventBus.publish('testing.run.completed', {
                type: 'test.run.completed',
                source: 'test-manager',
                data: {
                    runId: run.id,
                    duration: Date.now() - startTime,
                    status: run.status,
                    metrics: this.calculateRunMetrics(run)
                }
            });

        } catch (error) {
            run.status = 'failed';
            run.endTime = new Date();
            await this.updateRunStatus(run);
            throw error;
        }
    }

    private async executeParallel(
        suiteIds: string[],
        options: any
    ): Promise<Map<string, TestResult>> {
        const results = new Map();
        await Promise.all(
            suiteIds.map(async id => {
                const result = await this.executeSuite(id, options);
                results.set(id, result);
            })
        );
        return results;
    }

    private async executeSeries(
        suiteIds: string[],
        options: any
    ): Promise<Map<string, TestResult>> {
        const results = new Map();
        for (const id of suiteIds) {
            const result = await this.executeSuite(id, options);
            results.set(id, result);
            
            // Stop if critical suite fails
            const suite = this.testSuites.get(id)!;
            if (result.status === 'failed' && suite.priority === 'critical') {
                break;
            }
        }
        return results;
    }

    private async executeSuite(
        suiteId: string,
        options: any
    ): Promise<TestResult> {
        const suite = this.testSuites.get(suiteId)!;
        const startTime = Date.now();

        try {
            // Execute with retries
            const result = await this.executeWithRetry(
                () => this.runSuite(suite),
                suite.retryConfig.maxAttempts,
                suite.retryConfig.backoffMs
            );

            return {
                suiteId,
                runId: uuidv4(),
                status: result.success ? 'passed' : 'failed',
                duration: Date.now() - startTime,
                metrics: result.metrics,
                errors: result.errors,
                timestamp: new Date()
            };

        } catch (error) {
            return {
                suiteId,
                runId: uuidv4(),
                status: 'error',
                duration: Date.now() - startTime,
                metrics: {
                    totalTests: 0,
                    passed: 0,
                    failed: 0,
                    skipped: 0,
                    coverage: 0
                },
                errors: [{
                    message: error.message,
                    stackTrace: error.stack || '',
                    testCase: 'suite_execution'
                }],
                timestamp: new Date()
            };
        }
    }

    private async executeWithRetry(
        fn: () => Promise<any>,
        maxAttempts: number,
        backoffMs: number
    ): Promise<any> {
        let lastError;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                return await fn();
            } catch (error) {
                lastError = error;
                if (attempt < maxAttempts) {
                    await new Promise(resolve => 
                        setTimeout(resolve, backoffMs * attempt)
                    );
                }
            }
        }
        throw lastError;
    }

    private async runSuite(suite: TestSuiteConfig): Promise<any> {
        // Implement actual test execution based on suite type
        switch (suite.type) {
            case 'unit':
                return this.runUnitTests(suite);
            case 'integration':
                return this.runIntegrationTests(suite);
            case 'e2e':
                return this.runE2ETests(suite);
            case 'performance':
                return this.runPerformanceTests(suite);
            case 'security':
                return this.runSecurityTests(suite);
            default:
                throw new Error(`Unknown test type: ${suite.type}`);
        }
    }

    private determineRunStatus(results: Map<string, TestResult>): TestRun['status'] {
        const statuses = Array.from(results.values()).map(r => r.status);
        if (statuses.includes('error')) return 'failed';
        if (statuses.includes('failed')) return 'failed';
        return 'completed';
    }

    private calculateRunMetrics(run: TestRun): any {
        const metrics = Array.from(run.results.values()).reduce(
            (acc, result) => ({
                totalTests: acc.totalTests + result.metrics.totalTests,
                passed: acc.passed + result.metrics.passed,
                failed: acc.failed + result.metrics.failed,
                skipped: acc.skipped + result.metrics.skipped,
                coverage: (acc.coverage + result.metrics.coverage) / 2
            }),
            { totalTests: 0, passed: 0, failed: 0, skipped: 0, coverage: 0 }
        );

        return {
            ...metrics,
            successRate: metrics.passed / metrics.totalTests,
            duration: run.endTime 
                ? run.endTime.getTime() - run.startTime.getTime()
                : 0
        };
    }

    private async storeRunState(run: TestRun): Promise<void> {
        await this.redis.setEx(
            `test_run:${run.id}`,
            86400, // 24 hours
            JSON.stringify(run)
        );
    }

    private async updateRunStatus(run: TestRun): Promise<void> {
        await this.storeRunState(run);
        
        await this.monitor.recordMetric({
            name: 'test_run_status',
            value: 1,
            labels: {
                run_id: run.id,
                status: run.status
            }
        });
    }

    private async storeTestResults(run: TestRun): Promise<void> {
        const results = Array.from(run.results.entries()).map(([suiteId, result]) => ({
            run_id: run.id,
            suite_id: suiteId,
            ...result,
            timestamp: result.timestamp.toISOString(),
            metrics: JSON.stringify(result.metrics),
            errors: JSON.stringify(result.errors)
        }));

        await this.bigquery
            .dataset('testing')
            .table('test_results')
            .insert(results);
    }

    private async loadTestSuites(): Promise<void> {
        const query = `
            SELECT *
            FROM ${this.config.projectId}.testing.test_suites
            WHERE active = TRUE
        `;

        const [rows] = await this.bigquery.query({ query });
        rows.forEach(row => {
            this.testSuites.set(row.id, this.deserializeTestSuite(row));
        });
    }

    private deserializeTestSuite(row: any): TestSuiteConfig {
        return {
            id: row.id,
            name: row.name,
            description: row.description,
            type: row.type,
            priority: row.priority,
            dependencies: JSON.parse(row.dependencies),
            timeout: row.timeout,
            retryConfig: JSON.parse(row.retry_config),
            parallelization: row.parallelization
        };
    }

    private deserializeTestResult(row: any): TestResult {
        return {
            suiteId: row.suite_id,
            runId: row.run_id,
            status: row.status,
            duration: row.duration,
            metrics: JSON.parse(row.metrics),
            errors: JSON.parse(row.errors),
            timestamp: new Date(row.timestamp)
        };
    }

    private setupEventListeners(): void {
        this.eventBus.subscribe({
            id: 'test-manager-monitor',
            topic: 'deployment.status',
            handler: async (event) => {
                if (event.data.status === 'completed') {
                    await this.handleDeploymentComplete(event.data);
                }
            }
        });
    }

    private async handleDeploymentComplete(data: any): Promise<void> {
        // Start post-deployment tests
        const criticalSuites = Array.from(this.testSuites.values())
            .filter(s => s.priority === 'critical')
            .map(s => s.id);

        await this.startTestRun(criticalSuites, {
            parallel: false,
            timeout: 300000, // 5 minutes
            retries: 2
        });
    }

    private async handleError(type: string, error: Error, runId?: string): Promise<void> {
        await this.monitor.recordMetric({
            name: `test_manager_${type}`,
            value: 1,
            labels: {
                error: error.message,
                run_id: runId || 'unknown'
            }
        });

        await this.eventBus.publish('testing.error', {
            type: 'testing.error',
            source: 'test-manager',
            data: {
                error: error.message,
                type,
                runId,
                timestamp: new Date()
            }
        });
    }

    async close(): Promise<void> {
        await this.redis.quit();
    }
}

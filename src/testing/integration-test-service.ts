import { MonitoringService } from '../monitoring/monitoring-service';
import { EventBusService } from '../events/event-bus-service';
import { TestManagerService } from './test-manager-service';
import { BigQuery } from '@google-cloud/bigquery';
import { createClient as createRedisClient } from 'redis';

interface IntegrationTest {
    id: string;
    name: string;
    description: string;
    services: string[];
    dependencies: string[];
    steps: TestStep[];
    cleanup: TestStep[];
    timeout: number;
    retries: number;
    environment: Record<string, string>;
}

interface TestStep {
    id: string;
    name: string;
    type: 'http' | 'grpc' | 'db' | 'queue' | 'custom';
    action: string;
    params: Record<string, any>;
    assertions: Assertion[];
    timeout?: number;
    retries?: number;
}

interface Assertion {
    type: 'equal' | 'contains' | 'match' | 'status';
    expected: any;
    path?: string;
    message?: string;
}

interface TestResult {
    testId: string;
    runId: string;
    status: 'passed' | 'failed' | 'error';
    duration: number;
    steps: {
        id: string;
        status: 'passed' | 'failed' | 'error';
        duration: number;
        error?: string;
        assertions: {
            passed: number;
            failed: number;
            errors: Array<{
                assertion: Assertion;
                actual: any;
                message: string;
            }>;
        };
    }[];
    error?: string;
    timestamp: Date;
}

export class IntegrationTestService {
    private redis: ReturnType<typeof createRedisClient>;
    private bigquery: BigQuery;
    private testManager: TestManagerService;
    private tests: Map<string, IntegrationTest>;
    private results: Map<string, TestResult>;
    private activeRuns: Set<string>;

    constructor(
        private monitor: MonitoringService,
        private eventBus: EventBusService,
        private config: {
            projectId: string;
            redisUrl: string;
            maxConcurrentTests: number;
        }
    ) {
        this.redis = createRedisClient({ url: config.redisUrl });
        this.bigquery = new BigQuery({ projectId: config.projectId });
        this.tests = new Map();
        this.results = new Map();
        this.activeRuns = new Set();
        this.initialize();
    }

    private async initialize(): Promise<void> {
        await this.redis.connect();
        await this.loadTests();
        this.setupEventListeners();
    }

    async runTest(testId: string, options?: {
        environment?: Record<string, string>;
        timeout?: number;
        retries?: number;
    }): Promise<string> {
        const test = this.tests.get(testId);
        if (!test) throw new Error('Test not found');

        const runId = `run_${Date.now()}`;
        const startTime = Date.now();

        try {
            // Check concurrent runs limit
            if (this.activeRuns.size >= this.config.maxConcurrentTests) {
                throw new Error('Maximum concurrent tests limit reached');
            }

            this.activeRuns.add(runId);

            // Merge environment variables
            const environment = {
                ...test.environment,
                ...options?.environment
            };

            // Execute test steps
            const result = await this.executeTest(
                test,
                runId,
                environment,
                options
            );

            // Store results
            await this.storeResult(result);

            // Record metrics
            await this.monitor.recordMetric({
                name: 'integration_test_completed',
                value: Date.now() - startTime,
                labels: {
                    test_id: testId,
                    run_id: runId,
                    status: result.status
                }
            });

            return runId;

        } catch (error) {
            await this.handleError('test_execution_error', error, runId);
            throw error;
        } finally {
            this.activeRuns.delete(runId);
        }
    }

    private async executeTest(
        test: IntegrationTest,
        runId: string,
        environment: Record<string, string>,
        options?: {
            timeout?: number;
            retries?: number;
        }
    ): Promise<TestResult> {
        const startTime = Date.now();
        const stepResults = [];

        try {
            // Execute setup steps if any
            await this.executeSetup(test, environment);

            // Execute test steps
            for (const step of test.steps) {
                const stepResult = await this.executeStep(
                    step,
                    environment,
                    options
                );
                stepResults.push(stepResult);

                // Stop if step failed and we're not continuing on failure
                if (stepResult.status === 'failed' && !test.continueOnFailure) {
                    break;
                }
            }

            const result: TestResult = {
                testId: test.id,
                runId,
                status: this.determineTestStatus(stepResults),
                duration: Date.now() - startTime,
                steps: stepResults,
                timestamp: new Date()
            };

            return result;

        } catch (error) {
            return {
                testId: test.id,
                runId,
                status: 'error',
                duration: Date.now() - startTime,
                steps: stepResults,
                error: error.message,
                timestamp: new Date()
            };
        } finally {
            // Always execute cleanup
            await this.executeCleanup(test, environment);
        }
    }

    private async executeStep(
        step: TestStep,
        environment: Record<string, string>,
        options?: {
            timeout?: number;
            retries?: number;
        }
    ): Promise<TestResult['steps'][0]> {
        const startTime = Date.now();
        const timeout = options?.timeout || step.timeout;
        const retries = options?.retries || step.retries || 0;

        let lastError: Error | undefined;
        
        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                const result = await this.executeStepWithTimeout(
                    step,
                    environment,
                    timeout
                );

                // Validate assertions
                const assertionResults = await this.validateAssertions(
                    step.assertions,
                    result
                );

                return {
                    id: step.id,
                    status: assertionResults.failed > 0 ? 'failed' : 'passed',
                    duration: Date.now() - startTime,
                    assertions: assertionResults
                };

            } catch (error) {
                lastError = error;
                if (attempt < retries) {
                    await new Promise(resolve => 
                        setTimeout(resolve, Math.pow(2, attempt) * 1000)
                    );
                }
            }
        }

        return {
            id: step.id,
            status: 'error',
            duration: Date.now() - startTime,
            error: lastError?.message,
            assertions: {
                passed: 0,
                failed: 0,
                errors: []
            }
        };
    }

    private async executeStepWithTimeout(
        step: TestStep,
        environment: Record<string, string>,
        timeout?: number
    ): Promise<any> {
        const execution = this.executeStepAction(step, environment);

        if (!timeout) {
            return execution;
        }

        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Step timeout')), timeout)
        );

        return Promise.race([execution, timeoutPromise]);
    }

    private async executeStepAction(
        step: TestStep,
        environment: Record<string, string>
    ): Promise<any> {
        switch (step.type) {
            case 'http':
                return this.executeHttpStep(step, environment);
            case 'grpc':
                return this.executeGrpcStep(step, environment);
            case 'db':
                return this.executeDbStep(step, environment);
            case 'queue':
                return this.executeQueueStep(step, environment);
            case 'custom':
                return this.executeCustomStep(step, environment);
            default:
                throw new Error(`Unknown step type: ${step.type}`);
        }
    }

    private async validateAssertions(
        assertions: Assertion[],
        result: any
    ): Promise<TestResult['steps'][0]['assertions']> {
        const errors = [];
        let passed = 0;
        let failed = 0;

        for (const assertion of assertions) {
            try {
                const actual = assertion.path
                    ? this.getValueByPath(result, assertion.path)
                    : result;

                const valid = this.validateAssertion(assertion, actual);
                if (valid) {
                    passed++;
                } else {
                    failed++;
                    errors.push({
                        assertion,
                        actual,
                        message: assertion.message || 'Assertion failed'
                    });
                }
            } catch (error) {
                failed++;
                errors.push({
                    assertion,
                    actual: undefined,
                    message: error.message
                });
            }
        }

        return { passed, failed, errors };
    }

    private validateAssertion(assertion: Assertion, actual: any): boolean {
        switch (assertion.type) {
            case 'equal':
                return JSON.stringify(actual) === JSON.stringify(assertion.expected);
            case 'contains':
                return JSON.stringify(actual).includes(
                    JSON.stringify(assertion.expected)
                );
            case 'match':
                return new RegExp(assertion.expected).test(actual);
            case 'status':
                return actual === assertion.expected;
            default:
                throw new Error(`Unknown assertion type: ${assertion.type}`);
        }
    }

    private getValueByPath(obj: any, path: string): any {
        return path.split('.').reduce((acc, part) => acc?.[part], obj);
    }

    private determineTestStatus(
        stepResults: TestResult['steps']
    ): TestResult['status'] {
        if (stepResults.some(r => r.status === 'error')) return 'error';
        if (stepResults.some(r => r.status === 'failed')) return 'failed';
        return 'passed';
    }

    private async loadTests(): Promise<void> {
        const query = `
            SELECT *
            FROM \`${this.config.projectId}.testing.integration_tests\`
            WHERE active = TRUE
        `;

        const [rows] = await this.bigquery.query(query);
        
        for (const row of rows) {
            this.tests.set(row.id, this.deserializeTest(row));
        }
    }

    private deserializeTest(row: any): IntegrationTest {
        return {
            id: row.id,
            name: row.name,
            description: row.description,
            services: JSON.parse(row.services),
            dependencies: JSON.parse(row.dependencies),
            steps: JSON.parse(row.steps),
            cleanup: JSON.parse(row.cleanup),
            timeout: row.timeout,
            retries: row.retries,
            environment: JSON.parse(row.environment)
        };
    }

    private async storeResult(result: TestResult): Promise<void> {
        // Store in memory
        this.results.set(result.runId, result);

        // Store in BigQuery
        await this.bigquery
            .dataset('testing')
            .table('integration_test_results')
            .insert([{
                test_id: result.testId,
                run_id: result.runId,
                status: result.status,
                duration: result.duration,
                steps: JSON.stringify(result.steps),
                error: result.error,
                timestamp: result.timestamp
            }]);
    }

    private setupEventListeners(): void {
        this.eventBus.subscribe({
            id: 'integration-test-monitor',
            topic: 'deployment.completed',
            handler: async (event) => {
                await this.handleDeploymentCompleted(event.data);
            }
        });
    }

    private async handleDeploymentCompleted(data: any): Promise<void> {
        // Run integration tests after deployment
        const tests = Array.from(this.tests.values())
            .filter(test => test.services.includes(data.service));

        for (const test of tests) {
            await this.runTest(test.id, {
                environment: {
                    DEPLOYMENT_ID: data.deploymentId
                }
            });
        }
    }

    private async handleError(
        type: string,
        error: Error,
        runId?: string
    ): Promise<void> {
        await this.monitor.recordMetric({
            name: `integration_test_${type}`,
            value: 1,
            labels: {
                error: error.message,
                run_id: runId || 'unknown'
            }
        });

        await this.eventBus.publish('test.error', {
            type: 'test.error',
            source: 'integration-test',
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

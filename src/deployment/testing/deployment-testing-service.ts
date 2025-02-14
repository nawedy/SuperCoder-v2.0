import { MonitoringService } from '../../monitoring/monitoring-service';
import { EventBusService } from '../../events/event-bus-service';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { fetch } from 'cross-fetch';

interface TestSuite {
    id: string;
    name: string;
    tests: Test[];
    dependencies: string[];
    environment: string;
}

interface Test {
    id: string;
    name: string;
    type: 'api' | 'integration' | 'e2e' | 'smoke';
    steps: TestStep[];
    timeout?: number;
    retries?: number;
}

interface TestStep {
    name: string;
    action: string;
    params: Record<string, any>;
    assertions: Assertion[];
}

interface Assertion {
    type: 'equal' | 'contains' | 'exists' | 'status';
    expected: any;
    actual?: any;
    path?: string;
}

interface TestResult {
    suiteId: string;
    testId: string;
    status: 'passed' | 'failed' | 'skipped';
    duration: number;
    error?: string;
    assertions: {
        total: number;
        passed: number;
        failed: number;
    };
    steps: {
        name: string;
        status: 'passed' | 'failed';
        duration: number;
        error?: string;
    }[];
}

export class DeploymentTestingService {
    private supabase: any;
    private testSuites: Map<string, TestSuite>;
    private results: Map<string, TestResult[]>;

    constructor(
        private monitor: MonitoringService,
        private eventBus: EventBusService,
        private config: {
            supabaseUrl: string;
            supabaseKey: string;
            endpoints: Record<string, string>;
        }
    ) {
        this.supabase = createSupabaseClient(config.supabaseUrl, config.supabaseKey);
        this.testSuites = new Map();
        this.results = new Map();
        this.initialize();
    }

    private async initialize(): Promise<void> {
        await this.loadTestSuites();
    }

    async runDeploymentTests(deploymentId: string): Promise<TestResult[]> {
        const startTime = Date.now();
        const results: TestResult[] = [];

        try {
            for (const suite of this.testSuites.values()) {
                if (suite.environment === process.env.NODE_ENV) {
                    const suiteResults = await this.runTestSuite(suite, deploymentId);
                    results.push(...suiteResults);
                }
            }

            await this.storeResults(deploymentId, results);
            await this.notifyResults(deploymentId, results);

            // Record metrics
            await this.monitor.recordMetric({
                name: 'deployment_tests',
                value: Date.now() - startTime,
                labels: {
                    deployment_id: deploymentId,
                    total: results.length.toString(),
                    passed: results.filter(r => r.status === 'passed').length.toString()
                }
            });

            return results;

        } catch (error) {
            await this.handleError('test_execution_error', error, deploymentId);
            throw error;
        }
    }

    private async runTestSuite(
        suite: TestSuite,
        deploymentId: string
    ): Promise<TestResult[]> {
        const results: TestResult[] = [];

        for (const test of suite.tests) {
            const result = await this.runTest(suite.id, test, deploymentId);
            results.push(result);

            // Stop suite if critical test fails
            if (result.status === 'failed' && test.type === 'smoke') {
                break;
            }
        }

        return results;
    }

    private async runTest(
        suiteId: string,
        test: Test,
        deploymentId: string
    ): Promise<TestResult> {
        const startTime = Date.now();
        const stepResults = [];

        try {
            for (const step of test.steps) {
                const stepStartTime = Date.now();
                try {
                    await this.executeTestStep(step);
                    stepResults.push({
                        name: step.name,
                        status: 'passed',
                        duration: Date.now() - stepStartTime
                    });
                } catch (error) {
                    stepResults.push({
                        name: step.name,
                        status: 'failed',
                        duration: Date.now() - stepStartTime,
                        error: error.message
                    });
                    throw error;
                }
            }

            return {
                suiteId,
                testId: test.id,
                status: 'passed',
                duration: Date.now() - startTime,
                assertions: {
                    total: test.steps.reduce((sum, step) => sum + step.assertions.length, 0),
                    passed: test.steps.reduce((sum, step) => sum + step.assertions.length, 0),
                    failed: 0
                },
                steps: stepResults
            };

        } catch (error) {
            return {
                suiteId,
                testId: test.id,
                status: 'failed',
                duration: Date.now() - startTime,
                error: error.message,
                assertions: {
                    total: test.steps.reduce((sum, step) => sum + step.assertions.length, 0),
                    passed: stepResults.filter(r => r.status === 'passed')
                        .reduce((sum, step) => sum + test.steps
                            .find(s => s.name === step.name)!.assertions.length, 0),
                    failed: stepResults.filter(r => r.status === 'failed')
                        .reduce((sum, step) => sum + test.steps
                            .find(s => s.name === step.name)!.assertions.length, 0)
                },
                steps: stepResults
            };
        }
    }

    private async executeTestStep(step: TestStep): Promise<void> {
        switch (step.action) {
            case 'api_call':
                await this.executeApiCall(step);
                break;
            case 'database_query':
                await this.executeDatabaseQuery(step);
                break;
            case 'function_invoke':
                await this.executeFunctionInvocation(step);
                break;
            default:
                throw new Error(`Unknown test action: ${step.action}`);
        }
    }

    private async executeApiCall(step: TestStep): Promise<void> {
        const { endpoint, method, body, headers } = step.params;
        const response = await fetch(this.config.endpoints[endpoint], {
            method,
            body: JSON.stringify(body),
            headers: {
                'Content-Type': 'application/json',
                ...headers
            }
        });

        await this.validateAssertions(step.assertions, {
            status: response.status,
            body: await response.json()
        });
    }

    private async executeDatabaseQuery(step: TestStep): Promise<void> {
        const { query, params } = step.params;
        const { data, error } = await this.supabase.rpc(query, params);

        if (error) throw error;

        await this.validateAssertions(step.assertions, { data });
    }

    private async executeFunctionInvocation(step: TestStep): Promise<void> {
        const { functionName, payload } = step.params;
        const { data, error } = await this.supabase.functions.invoke(functionName, {
            body: payload
        });

        if (error) throw error;

        await this.validateAssertions(step.assertions, { data });
    }

    private async validateAssertions(
        assertions: Assertion[],
        context: Record<string, any>
    ): Promise<void> {
        for (const assertion of assertions) {
            const actual = assertion.path
                ? this.getValueByPath(context, assertion.path)
                : context[Object.keys(context)[0]];

            switch (assertion.type) {
                case 'equal':
                    if (actual !== assertion.expected) {
                        throw new Error(
                            `Expected ${assertion.expected} but got ${actual}`
                        );
                    }
                    break;
                case 'contains':
                    if (!actual.includes(assertion.expected)) {
                        throw new Error(
                            `Expected ${actual} to contain ${assertion.expected}`
                        );
                    }
                    break;
                case 'exists':
                    if (actual === undefined) {
                        throw new Error(`Expected value to exist at ${assertion.path}`);
                    }
                    break;
                case 'status':
                    if (context.status !== assertion.expected) {
                        throw new Error(
                            `Expected status ${assertion.expected} but got ${context.status}`
                        );
                    }
                    break;
            }
        }
    }

    private getValueByPath(obj: any, path: string): any {
        return path.split('.').reduce((acc, part) => acc?.[part], obj);
    }

    private async loadTestSuites(): Promise<void> {
        const { data: suites, error } = await this.supabase
            .from('test_suites')
            .select('*');

        if (error) throw error;

        for (const suite of suites) {
            this.testSuites.set(suite.id, suite);
        }
    }

    private async storeResults(
        deploymentId: string,
        results: TestResult[]
    ): Promise<void> {
        await this.supabase
            .from('test_results')
            .insert(results.map(result => ({
                deployment_id: deploymentId,
                ...result,
                timestamp: new Date()
            })));
    }

    private async notifyResults(
        deploymentId: string,
        results: TestResult[]
    ): Promise<void> {
        await this.eventBus.publish('deployment.tests.completed', {
            type: 'tests.completed',
            source: 'deployment-testing',
            data: {
                deploymentId,
                results: {
                    total: results.length,
                    passed: results.filter(r => r.status === 'passed').length,
                    failed: results.filter(r => r.status === 'failed').length,
                    skipped: results.filter(r => r.status === 'skipped').length
                },
                failures: results
                    .filter(r => r.status === 'failed')
                    .map(r => ({
                        suite: r.suiteId,
                        test: r.testId,
                        error: r.error
                    }))
            }
        });
    }

    private async handleError(
        type: string,
        error: Error,
        deploymentId: string
    ): Promise<void> {
        await this.monitor.recordMetric({
            name: `deployment_test_${type}`,
            value: 1,
            labels: {
                deployment_id: deploymentId,
                error: error.message
            }
        });
    }
}

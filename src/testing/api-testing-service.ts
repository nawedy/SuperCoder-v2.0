import { MonitoringService } from '../monitoring/monitoring-service';
import { EventBusService } from '../events/event-bus-service';
import { SecurityTestingService } from './security-testing-service';
import { BigQuery } from '@google-cloud/bigquery';
import { createClient as createRedisClient } from 'redis';
import { v4 as uuidv4 } from 'uuid';
import axios, { AxiosInstance } from 'axios';

interface APITest {
    id: string;
    name: string;
    description: string;
    endpoints: APIEndpoint[];
    environment: {
        baseUrl: string;
        variables: Record<string, string>;
        headers: Record<string, string>;
    };
    auth?: {
        type: 'bearer' | 'basic' | 'apiKey';
        credentials: Record<string, string>;
    };
    options: {
        timeout: number;
        retries: number;
        delay: number;
        parallel: boolean;
    };
}

interface APIEndpoint {
    path: string;
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
    headers?: Record<string, string>;
    queryParams?: Record<string, string>;
    body?: any;
    assertions: APIAssertion[];
    dependencies?: string[];
}

interface APIAssertion {
    type: 'status' | 'json' | 'header' | 'response';
    target: string;
    operator: 'eq' | 'neq' | 'gt' | 'lt' | 'contains' | 'regex';
    expected: any;
}

interface APITestResult {
    id: string;
    testId: string;
    status: 'passed' | 'failed' | 'error';
    results: Array<{
        endpoint: string;
        method: string;
        duration: number;
        status: number;
        assertions: Array<{
            type: string;
            target: string;
            expected: any;
            actual: any;
            passed: boolean;
        }>;
        error?: string;
    }>;
    metrics: {
        totalEndpoints: number;
        passedEndpoints: number;
        failedEndpoints: number;
        totalAssertions: number;
        passedAssertions: number;
        averageResponseTime: number;
    };
    timestamp: Date;
}

export class APITestingService {
    private redis: ReturnType<typeof createRedisClient>;
    private bigquery: BigQuery;
    private securityTesting: SecurityTestingService;
    private httpClient: AxiosInstance;
    private activeTests: Map<string, { cancel: () => void }>;
    private results: Map<string, APITestResult>;

    constructor(
        private monitor: MonitoringService,
        private eventBus: EventBusService,
        private config: {
            projectId: string;
            redisUrl: string;
            securityConfig: any;
        }
    ) {
        this.redis = createRedisClient({ url: config.redisUrl });
        this.bigquery = new BigQuery({ projectId: config.projectId });
        this.securityTesting = new SecurityTestingService(monitor, eventBus, {
            projectId: config.projectId,
            redisUrl: config.redisUrl,
            scannerConfig: config.securityConfig
        });
        this.httpClient = axios.create();
        this.activeTests = new Map();
        this.results = new Map();
        this.initialize();
    }

    private async initialize(): Promise<void> {
        await this.redis.connect();
        this.setupAxiosInterceptors();
        this.setupEventListeners();
    }

    async runAPITest(test: APITest): Promise<string> {
        const testId = uuidv4();
        const startTime = Date.now();

        try {
            // Validate test configuration
            this.validateTestConfig(test);

            // Create cancellable test
            const { promise, cancel } = this.createCancellableTest(testId, test);
            this.activeTests.set(testId, { cancel });

            // Execute API test
            const result = await promise;

            // Store results
            await this.storeResults(result);

            // Record metrics
            await this.monitor.recordMetric({
                name: 'api_test_completed',
                value: Date.now() - startTime,
                labels: {
                    test_id: testId,
                    status: result.status,
                    endpoints: result.metrics.totalEndpoints.toString()
                }
            });

            return testId;

        } catch (error) {
            await this.handleError('api_test_error', error, testId);
            throw error;
        }
    }

    private createCancellableTest(
        testId: string,
        test: APITest
    ): { promise: Promise<APITestResult>; cancel: () => void } {
        let isCancelled = false;
        const cancel = () => { isCancelled = true; };

        const promise = this.executeAPITest(test, testId, () => isCancelled);

        return { promise, cancel };
    }

    private async executeAPITest(
        test: APITest,
        testId: string,
        isCancelled: () => boolean
    ): Promise<APITestResult> {
        const results: APITestResult['results'] = [];
        const startTime = Date.now();

        try {
            // Configure HTTP client
            this.configureHttpClient(test.environment, test.auth);

            // Execute endpoints
            if (test.options.parallel) {
                const endpointResults = await Promise.all(
                    test.endpoints.map(endpoint => 
                        this.executeEndpoint(endpoint, test.environment)
                    )
                );
                results.push(...endpointResults);
            } else {
                for (const endpoint of test.endpoints) {
                    if (isCancelled()) break;
                    const result = await this.executeEndpoint(
                        endpoint,
                        test.environment
                    );
                    results.push(result);

                    // Add delay between requests if specified
                    if (test.options.delay > 0) {
                        await new Promise(resolve => 
                            setTimeout(resolve, test.options.delay)
                        );
                    }
                }
            }

            // Calculate metrics
            const metrics = this.calculateMetrics(results);

            return {
                id: uuidv4(),
                testId,
                status: this.determineTestStatus(results),
                results,
                metrics,
                timestamp: new Date()
            };

        } catch (error) {
            throw new Error(`API test execution failed: ${error.message}`);
        }
    }

    private async executeEndpoint(
        endpoint: APIEndpoint,
        environment: APITest['environment']
    ): Promise<APITestResult['results'][0]> {
        const startTime = Date.now();

        try {
            // Replace environment variables in URL
            const url = this.replaceEnvironmentVariables(
                `${environment.baseUrl}${endpoint.path}`,
                environment.variables
            );

            // Make request
            const response = await this.httpClient.request({
                url,
                method: endpoint.method,
                headers: {
                    ...environment.headers,
                    ...endpoint.headers
                },
                params: endpoint.queryParams,
                data: endpoint.body,
                validateStatus: () => true // Don't throw on any status
            });

            // Validate assertions
            const assertionResults = await this.validateAssertions(
                endpoint.assertions,
                response
            );

            return {
                endpoint: endpoint.path,
                method: endpoint.method,
                duration: Date.now() - startTime,
                status: response.status,
                assertions: assertionResults
            };

        } catch (error) {
            return {
                endpoint: endpoint.path,
                method: endpoint.method,
                duration: Date.now() - startTime,
                status: 0,
                assertions: [],
                error: error.message
            };
        }
    }

    private async validateAssertions(
        assertions: APIAssertion[],
        response: any
    ): Promise<APITestResult['results'][0]['assertions']> {
        return assertions.map(assertion => {
            const actual = this.getAssertionValue(assertion, response);
            const passed = this.evaluateAssertion(assertion, actual);

            return {
                type: assertion.type,
                target: assertion.target,
                expected: assertion.expected,
                actual,
                passed
            };
        });
    }

    private getAssertionValue(assertion: APIAssertion, response: any): any {
        switch (assertion.type) {
            case 'status':
                return response.status;
            case 'header':
                return response.headers[assertion.target.toLowerCase()];
            case 'json':
                return this.getValueByPath(response.data, assertion.target);
            case 'response':
                return response.data;
            default:
                throw new Error(`Unknown assertion type: ${assertion.type}`);
        }
    }

    private evaluateAssertion(assertion: APIAssertion, actual: any): boolean {
        switch (assertion.operator) {
            case 'eq':
                return actual === assertion.expected;
            case 'neq':
                return actual !== assertion.expected;
            case 'gt':
                return actual > assertion.expected;
            case 'lt':
                return actual < assertion.expected;
            case 'contains':
                return actual.includes(assertion.expected);
            case 'regex':
                return new RegExp(assertion.expected).test(actual);
            default:
                throw new Error(`Unknown operator: ${assertion.operator}`);
        }
    }

    private calculateMetrics(
        results: APITestResult['results']
    ): APITestResult['metrics'] {
        const totalEndpoints = results.length;
        const passedEndpoints = results.filter(r => 
            !r.error && r.assertions.every(a => a.passed)
        ).length;

        const totalAssertions = results.reduce(
            (sum, r) => sum + r.assertions.length,
            0
        );
        const passedAssertions = results.reduce(
            (sum, r) => sum + r.assertions.filter(a => a.passed).length,
            0
        );

        const averageResponseTime = results.reduce(
            (sum, r) => sum + r.duration,
            0
        ) / totalEndpoints;

        return {
            totalEndpoints,
            passedEndpoints,
            failedEndpoints: totalEndpoints - passedEndpoints,
            totalAssertions,
            passedAssertions,
            averageResponseTime
        };
    }

    private determineTestStatus(
        results: APITestResult['results']
    ): APITestResult['status'] {
        if (results.some(r => r.error)) return 'error';
        if (results.some(r => r.assertions.some(a => !a.passed))) return 'failed';
        return 'passed';
    }

    private setupAxiosInterceptors(): void {
        this.httpClient.interceptors.request.use(async config => {
            const startTime = Date.now();
            config.metadata = { startTime };
            return config;
        });

        this.httpClient.interceptors.response.use(
            async response => {
                const duration = Date.now() - response.config.metadata.startTime;
                await this.monitor.recordMetric({
                    name: 'api_request',
                    value: duration,
                    labels: {
                        method: response.config.method!,
                        status: response.status.toString()
                    }
                });
                return response;
            },
            async error => {
                const duration = Date.now() - error.config.metadata.startTime;
                await this.monitor.recordMetric({
                    name: 'api_error',
                    value: duration,
                    labels: {
                        method: error.config.method,
                        error: error.message
                    }
                });
                throw error;
            }
        );
    }

    private setupEventListeners(): void {
        this.eventBus.subscribe({
            id: 'api-test-monitor',
            topic: 'deployment.completed',
            handler: async (event) => {
                await this.handleDeploymentComplete(event.data);
            }
        });
    }

    private async handleError(
        type: string,
        error: Error,
        testId?: string
    ): Promise<void> {
        await this.monitor.recordMetric({
            name: `api_test_${type}`,
            value: 1,
            labels: {
                error: error.message,
                test_id: testId || 'unknown'
            }
        });

        await this.eventBus.publish('api.test.error', {
            type: 'api.test.error',
            source: 'api-testing',
            data: {
                error: error.message,
                type,
                testId,
                timestamp: new Date()
            }
        });
    }

    async close(): Promise<void> {
        // Cancel all active tests
        for (const [testId] of this.activeTests) {
            await this.cancelTest(testId);
        }
        await this.redis.quit();
    }
}

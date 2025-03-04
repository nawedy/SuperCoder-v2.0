/**
 * SuperCode AI Platform - Integration Testing Framework
 * 
 * This module provides a comprehensive integration testing framework for the SuperCode
 * platform, testing interactions between various components including the context bridge,
 * ensemble models, and end-to-end functionality.
 * 
 * @module integrationTesting
 */

import * as path from 'path';
import * as fs from 'fs';
import { setupLogging } from '../src/utils/logging';
import { ContextBridge } from '../src/services/context/contextBridge';
import { ModelEnsemble } from '../src/services/models/modelEnsemble';
import { CodeAnalyzer } from '../src/services/analyzer/codeAnalyzer';
import { QueryEngine } from '../src/services/query/queryEngine';
import { ResultFormatter } from '../src/services/formatter/resultFormatter';
import { ConfigManager } from '../src/utils/configManager';
import { TestResult, IntegrationTestCase, ComponentTestResult, TestReport, TestSuite } from '../src/types/testing';

// Initialize logger
const logger = setupLogging('integration:testing');

/**
 * Configuration for the integration test environment
 */
interface TestConfig {
  testDataDir: string;
  outputDir: string;
  timeoutMs: number;
  contextConfig: {
    maxTokens: number;
    relevanceThreshold: number;
    cacheEnabled: boolean;
  };
  ensembleConfig: {
    models: string[];
    routingStrategy: string;
  };
}

/**
 * Default test configuration
 */
const DEFAULT_CONFIG: TestConfig = {
  testDataDir: path.join(__dirname, '../test/fixtures/integration'),
  outputDir: path.join(__dirname, '../test/results/integration'),
  timeoutMs: 30000,
  contextConfig: {
    maxTokens: 4000,
    relevanceThreshold: 0.6,
    cacheEnabled: true,
  },
  ensembleConfig: {
    models: ['gpt-4-code', 'claude-code', 'local-llama'],
    routingStrategy: 'weighted',
  },
};

/**
 * Integration test runner for the SuperCode AI system
 */
export class IntegrationTestRunner {
  private config: TestConfig;
  private contextBridge: ContextBridge;
  private modelEnsemble: ModelEnsemble;
  private codeAnalyzer: CodeAnalyzer;
  private queryEngine: QueryEngine;
  private resultFormatter: ResultFormatter;
  private configManager: ConfigManager;
  private testCases: IntegrationTestCase[] = [];
  private testSuites: TestSuite[] = [];

  /**
   * Creates a new instance of the integration test runner
   * 
   * @param customConfig Optional custom configuration to override defaults
   */
  constructor(customConfig: Partial<TestConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...customConfig };
    
    // Ensure output directory exists
    if (!fs.existsSync(this.config.outputDir)) {
      fs.mkdirSync(this.config.outputDir, { recursive: true });
    }
    
    logger.info('Initializing integration test runner with config:', this.config);
    
    // Initialize system components
    this.configManager = new ConfigManager();
    this.contextBridge = new ContextBridge(this.config.contextConfig);
    this.modelEnsemble = new ModelEnsemble(this.config.ensembleConfig);
    this.codeAnalyzer = new CodeAnalyzer();
    this.queryEngine = new QueryEngine();
    this.resultFormatter = new ResultFormatter();
    
    // Load test cases
    this.loadTestCases();
    this.loadTestSuites();
  }

  /**
   * Loads test cases from the test data directory
   */
  private loadTestCases(): void {
    const testCaseDir = path.join(this.config.testDataDir, 'cases');
    
    if (!fs.existsSync(testCaseDir)) {
      logger.error(`Test case directory not found: ${testCaseDir}`);
      return;
    }
    
    const files = fs.readdirSync(testCaseDir).filter(file => file.endsWith('.json'));
    
    for (const file of files) {
      try {
        const testCase = JSON.parse(fs.readFileSync(path.join(testCaseDir, file), 'utf8')) as IntegrationTestCase;
        this.testCases.push(testCase);
        logger.info(`Loaded test case: ${testCase.name}`);
      } catch (error) {
        logger.error(`Failed to load test case from ${file}:`, error);
      }
    }
    
    logger.info(`Loaded ${this.testCases.length} test cases`);
  }
  
  /**
   * Loads test suites from the test data directory
   */
  private loadTestSuites(): void {
    const testSuiteDir = path.join(this.config.testDataDir, 'suites');
    
    if (!fs.existsSync(testSuiteDir)) {
      logger.error(`Test suite directory not found: ${testSuiteDir}`);
      return;
    }
    
    const files = fs.readdirSync(testSuiteDir).filter(file => file.endsWith('.json'));
    
    for (const file of files) {
      try {
        const testSuite = JSON.parse(fs.readFileSync(path.join(testSuiteDir, file), 'utf8')) as TestSuite;
        this.testSuites.push(testSuite);
        logger.info(`Loaded test suite: ${testSuite.name}`);
      } catch (error) {
        logger.error(`Failed to load test suite from ${file}:`, error);
      }
    }
    
    logger.info(`Loaded ${this.testSuites.length} test suites`);
  }

  /**
   * Runs a specific integration test case
   * 
   * @param testCase The test case to run
   * @returns Test result
   */
  private async runTestCase(testCase: IntegrationTestCase): Promise<TestResult> {
    logger.info(`Running test case: ${testCase.name}`);
    
    const startTime = Date.now();
    const componentResults: ComponentTestResult[] = [];
    let success = true;
    let errorMessage = '';
    
    try {
      // Set up the test environment
      const projectDir = path.join(this.config.testDataDir, 'projects', testCase.projectDir);
      
      if (!fs.existsSync(projectDir)) {
        throw new Error(`Project directory not found: ${projectDir}`);
      }
      
      // Test context retrieval
      const contextStartTime = Date.now();
      const context = await this.contextBridge.getContext({
        query: testCase.query,
        projectPath: projectDir,
        filePath: testCase.targetFile ? path.join(projectDir, testCase.targetFile) : undefined,
        maxTokens: testCase.maxContextTokens || this.config.contextConfig.maxTokens,
      });
      
      componentResults.push({
        component: 'ContextBridge',
        success: context.snippets.length > 0,
        durationMs: Date.now() - contextStartTime,
        details: {
          retrievedSnippets: context.snippets.length,
          relevanceScores: context.snippets.map(s => s.relevance),
        }
      });
      
      // Test code analysis
      const analysisStartTime = Date.now();
      const analysis = await this.codeAnalyzer.analyze({
        code: testCase.targetFile ? fs.readFileSync(path.join(projectDir, testCase.targetFile), 'utf8') : '',
        language: testCase.language || 'typescript',
        projectPath: projectDir,
      });
      
      componentResults.push({
        component: 'CodeAnalyzer',
        success: analysis !== null,
        durationMs: Date.now() - analysisStartTime,
        details: {
          analysisDepth: analysis?.depth || 0,
          entities: analysis?.entities.length || 0,
        }
      });
      
      // Test query processing
      const queryStartTime = Date.now();
      const processedQuery = await this.queryEngine.processQuery({
        query: testCase.query,
        context,
        analysis: analysis || undefined,
      });
      
      componentResults.push({
        component: 'QueryEngine',
        success: processedQuery !== null,
        durationMs: Date.now() - queryStartTime,
        details: {
          queryExpanded: processedQuery?.query !== testCase.query,
          contextSize: processedQuery?.contextSize || 0,
        }
      });
      
      // Test model ensemble
      const ensembleStartTime = Date.now();
      const modelResponse = await this.modelEnsemble.generateResponse({
        query: processedQuery || { query: testCase.query, contextSize: 0 },
        context,
        maxTokens: testCase.maxResponseTokens || 1000,
        temperature: testCase.temperature || 0.7,
      });
      
      componentResults.push({
        component: 'ModelEnsemble',
        success: modelResponse !== null,
        durationMs: Date.now() - ensembleStartTime,
        details: {
          modelUsed: modelResponse?.model || 'unknown',
          tokensGenerated: modelResponse?.tokens || 0,
        }
      });
      
      // Test result formatting
      const formatterStartTime = Date.now();
      const formattedResult = await this.resultFormatter.format({
        response: modelResponse?.response || '',
        query: testCase.query,
        format: testCase.outputFormat || 'markdown',
      });
      
      componentResults.push({
        component: 'ResultFormatter',
        success: formattedResult !== null,
        durationMs: Date.now() - formatterStartTime,
        details: {
          outputFormat: testCase.outputFormat || 'markdown',
          outputLength: formattedResult?.length || 0,
        }
      });
      
      // Validate against expected output pattern if provided
      if (testCase.expectedOutputPattern) {
        const regex = new RegExp(testCase.expectedOutputPattern);
        const outputMatches = regex.test(formattedResult || '');
        
        componentResults.push({
          component: 'OutputValidation',
          success: outputMatches,
          durationMs: 0,
          details: {
            pattern: testCase.expectedOutputPattern,
            matches: outputMatches,
          }
        });
        
        if (!outputMatches) {
          success = false;
          errorMessage = 'Output does not match expected pattern';
        }
      }
      
      // Write the response to output file
      const outputFile = path.join(this.config.outputDir, `${testCase.id}_result.txt`);
      fs.writeFileSync(outputFile, formattedResult || '');
      logger.info(`Test result written to ${outputFile}`);
      
    } catch (error) {
      success = false;
      errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`Test case failed: ${testCase.name}`, error);
    }
    
    const durationMs = Date.now() - startTime;
    
    // Check if test exceeded timeout
    if (durationMs > this.config.timeoutMs) {
      success = false;
      errorMessage = `Test case exceeded timeout (${this.config.timeoutMs}ms)`;
      logger.warn(`Test case timed out: ${testCase.name}`);
    }
    
    const result: TestResult = {
      testCaseId: testCase.id,
      testCaseName: testCase.name,
      success,
      durationMs,
      timestamp: new Date().toISOString(),
      errorMessage,
      componentResults,
    };
    
    return result;
  }

  /**
   * Runs a specific test suite
   * 
   * @param suite The test suite to run
   * @returns Array of test results
   */
  private async runTestSuite(suite: TestSuite): Promise<TestResult[]> {
    logger.info(`Running test suite: ${suite.name}`);
    
    const results: TestResult[] = [];
    
    for (const testCaseId of suite.testCases) {
      const testCase = this.testCases.find(tc => tc.id === testCaseId);
      
      if (!testCase) {
        logger.error(`Test case not found: ${testCaseId}`);
        results.push({
          testCaseId: testCaseId,
          testCaseName: 'Unknown',
          success: false,
          durationMs: 0,
          timestamp: new Date().toISOString(),
          errorMessage: `Test case not found: ${testCaseId}`,
          componentResults: [],
        });
        continue;
      }
      
      const result = await this.runTestCase(testCase);
      results.push(result);
    }
    
    return results;
  }

  /**
   * Runs all test cases
   * 
   * @returns Array of test results
   */
  public async runAllTestCases(): Promise<TestResult[]> {
    logger.info('Running all test cases');
    
    const results: TestResult[] = [];
    
    for (const testCase of this.testCases) {
      const result = await this.runTestCase(testCase);
      results.push(result);
    }
    
    return results;
  }

  /**
   * Runs all test suites
   * 
   * @returns Object mapping suite names to test results
   */
  public async runAllTestSuites(): Promise<Record<string, TestResult[]>> {
    logger.info('Running all test suites');
    
    const results: Record<string, TestResult[]> = {};
    
    for (const suite of this.testSuites) {
      results[suite.name] = await this.runTestSuite(suite);
    }
    
    return results;
  }

  /**
   * Generates a comprehensive HTML report of the test results
   * 
   * @param results Results to include in the report
   * @returns Path to the generated report file
   */
  public generateReport(results: TestResult[]): string {
    logger.info('Generating integration test report');
    
    const reportPath = path.join(this.config.outputDir, 'integration_test_report.html');
    
    // Calculate overall statistics
    const totalTests = results.length;
    const passedTests = results.filter(r => r.success).length;
    const failedTests = totalTests - passedTests;
    const successRate = totalTests > 0 ? (passedTests / totalTests) * 100 : 0;
    const averageDuration = totalTests > 0 
      ? results.reduce((sum, r) => sum + r.durationMs, 0) / totalTests 
      : 0;
    
    // Component-specific statistics
    const componentStats: Record<string, { success: number, total: number, avgDuration: number }> = {};
    
    for (const result of results) {
      for (const cr of result.componentResults) {
        if (!componentStats[cr.component]) {
          componentStats[cr.component] = { success: 0, total: 0, avgDuration: 0 };
        }
        
        componentStats[cr.component].total += 1;
        if (cr.success) {
          componentStats[cr.component].success += 1;
        }
        componentStats[cr.component].avgDuration += cr.durationMs;
      }
    }
    
    // Calculate averages
    for (const component in componentStats) {
      if (componentStats[component].total > 0) {
        componentStats[component].avgDuration /= componentStats[component].total;
      }
    }
    
    // Generate HTML report
    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SuperCode AI Integration Test Report</title>
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 1200px; margin: 0 auto; padding: 20px; }
    h1, h2, h3 { color: #2c3e50; }
    .summary { display: flex; justify-content: space-between; margin-bottom: 30px; }
    .summary-box { background-color: #f9f9f9; border-radius: 5px; padding: 15px; min-width: 200px; box-shadow: 0 2px 5px rgba(0,0,0,0.1); }
    .success-rate { font-size: 24px; font-weight: bold; color: ${successRate >= 90 ? '#27ae60' : successRate >= 70 ? '#f39c12' : '#e74c3c'}; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
    th, td { padding: 12px 15px; text-align: left; border-bottom: 1px solid #ddd; }
    th { background-color: #f2f2f2; font-weight: bold; }
    tr.failed { background-color: #ffeaea; }
    tr.passed { background-color: #f0fff0; }
    tr:hover { background-color: #f5f5f5; }
    .component-bars { margin-top: 30px; }
    .bar-container { margin-bottom: 10px; }
    .bar-label { display: inline-block; width: 150px; font-weight: bold; }
    .bar { height: 20px; background-color: #3498db; border-radius: 3px; display: inline-block; }
    .bar-text { margin-left: 10px; }
    .details-toggle { cursor: pointer; color: #3498db; }
    .test-details { display: none; padding: 10px; background-color: #f9f9f9; border-radius: 5px; margin: 10px 0; }
    footer { margin-top: 40px; color: #7f8c8d; font-size: 0.9em; }
  </style>
  <script>
    function toggleDetails(id) {
      const details = document.getElementById('details-' + id);
      if (details.style.display === 'block') {
        details.style.display = 'none';
      } else {
        details.style.display = 'block';
      }
    }
  </script>
</head>
<body>
  <h1>SuperCode AI Integration Test Report</h1>
  <p>Generated on: ${new Date().toLocaleString()}</p>
  
  <div class="summary">
    <div class="summary-box">
      <h3>Success Rate</h3>
      <div class="success-rate">${successRate.toFixed(1)}%</div>
      <p>${passedTests} passed, ${failedTests} failed</p>
    </div>
    <div class="summary-box">
      <h3>Total Tests</h3>
      <div class="success-rate">${totalTests}</div>
      <p>Average duration: ${(averageDuration / 1000).toFixed(2)}s</p>
    </div>
    <div class="summary-box">
      <h3>Component Reliability</h3>
      <table style="width:100%; font-size: 0.9em;">
        ${Object.entries(componentStats).map(([component, stats]) => `
          <tr>
            <td>${component}</td>
            <td>${((stats.success / stats.total) * 100).toFixed(0)}%</td>
          </tr>
        `).join('')}
      </table>
    </div>
  </div>
  
  <h2>Test Results</h2>
  <table>
    <thead>
      <tr>
        <th>Test Case</th>
        <th>Status</th>
        <th>Duration</th>
        <th>Timestamp</th>
        <th>Details</th>
      </tr>
    </thead>
    <tbody>
      ${results.map((result, index) => `
        <tr class="${result.success ? 'passed' : 'failed'}">
          <td>${result.testCaseName}</td>
          <td>${result.success ? '✅ PASS' : '❌ FAIL'}</td>
          <td>${(result.durationMs / 1000).toFixed(2)}s</td>
          <td>${new Date(result.timestamp).toLocaleString()}</td>
          <td><span class="details-toggle" onclick="toggleDetails(${index})">Show Details</span></td>
        </tr>
        <tr>
          <td colspan="5">
            <div id="details-${index}" class="test-details">
              ${result.errorMessage ? `<p><strong>Error:</strong> ${result.errorMessage}</p>` : ''}
              <h4>Component Results</h4>
              <table style="width:100%">
                <thead>
                  <tr>
                    <th>Component</th>
                    <th>Status</th>
                    <th>Duration</th>
                    <th>Details</th>
                  </tr>
                </thead>
                <tbody>
                  ${result.componentResults.map(cr => `
                    <tr>
                      <td>${cr.component}</td>
                      <td>${cr.success ? '✅ PASS' : '❌ FAIL'}</td>
                      <td>${(cr.durationMs / 1000).toFixed(3)}s</td>
                      <td><pre>${JSON.stringify(cr.details, null, 2)}</pre></td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          </td>
        </tr>
      `).join('')}
    </tbody>
  </table>
  
  <h2>Component Performance</h2>
  <div class="component-bars">
    ${Object.entries(componentStats).map(([component, stats]) => `
      <div class="bar-container">
        <div class="bar-label">${component}</div>
        <div class="bar" style="width: ${Math.min(stats.avgDuration / 50, 300)}px;"></div>
        <span class="bar-text">${(stats.avgDuration / 1000).toFixed(3)}s avg</span>
      </div>
    `).join('')}
  </div>
  
  <footer>
    <p>SuperCode AI Platform - Integration Test Report</p>
    <p>Test environment: ${process.env.NODE_ENV || 'development'}</p>
  </footer>
</body>
</html>
`;
    
    fs.writeFileSync(reportPath, html);
    logger.info(`Report generated at ${reportPath}`);
    
    return reportPath;
  }

  /**
   * Creates a sample test fixture if none exists
   */
  public createSampleFixture(): void {
    const fixtureDir = path.join(this.config.testDataDir, 'cases');
    const projectDir = path.join(this.config.testDataDir, 'projects', 'sample');
    
    // Create directories if they don't exist
    if (!fs.existsSync(fixtureDir)) {
      fs.mkdirSync(fixtureDir, { recursive: true });
    }
    
    if (!fs.existsSync(projectDir)) {
      fs.mkdirSync(projectDir, { recursive: true });
    }
    
    // Create a sample test project
    const sampleProjectFiles = {
      'index.ts': `
/**
 * Sample project main file
 */
import { hello } from './utils';

function main() {
  console.log(hello('world'));
}

main();
`,
      'utils.ts': `
/**
 * Utility functions
 */
export function hello(name: string): string {
  return \`Hello, \${name}!\`;
}

export function add(a: number, b: number): number {
  return a + b;
}
`
    };
    
    for (const [filename, content] of Object.entries(sampleProjectFiles)) {
      fs.writeFileSync(path.join(projectDir, filename), content);
    }
    
    // Create sample test cases
    const sampleTestCases: IntegrationTestCase[] = [
      {
        id: 'test-001',
        name: 'Basic Code Generation Test',
        description: 'Tests the ability to generate a simple function based on description',
        query: 'Create a function to calculate the factorial of a number',
        projectDir: 'sample',
        language: 'typescript',
        maxContextTokens: 2000,
        maxResponseTokens: 500,
        temperature: 0.7,
        expectedOutputPattern: 'function\\s+factorial',
      },
      {
        id: 'test-002',
        name: 'Code Explanation Test',
        description: 'Tests the ability to explain existing code',
        query: 'Explain what the add function does in utils.ts',
        projectDir: 'sample',
        targetFile: 'utils.ts',
        language: 'typescript',
        maxContextTokens: 2000,
        maxResponseTokens: 500,
        temperature: 0.1,
        expectedOutputPattern: 'function.*?adds.*?numbers',
        outputFormat: 'markdown',
      }
    ];
    
    // Create sample test suite
    const sampleTestSuite: TestSuite = {
      id: 'suite-001',
      name: 'Basic Functionality Tests',
      description: 'Tests the core functionality of the SuperCode AI system',
      testCases: sampleTestCases.map(tc => tc.id),
    };
    
    // Write sample test cases
    for (const testCase of sampleTestCases) {
      fs.writeFileSync(
        path.join(fixtureDir, `${testCase.id}.json`),
        JSON.stringify(testCase, null, 2)
      );
    }
    
    // Write sample test suite
    const suitesDir = path.join(this.config.testDataDir, 'suites');
    if (!fs.existsSync(suitesDir)) {
      fs.mkdirSync(suitesDir, { recursive: true });
    }
    
    fs.writeFileSync(
      path.join(suitesDir, `${sampleTestSuite.id}.json`),
      JSON.stringify(sampleTestSuite, null, 2)
    );
    
    logger.info('Created sample test fixtures');
  }
}

/**
 * Main entry point for running integration tests from command line
 */
async function main() {
  const testRunner = new IntegrationTestRunner();
  
  // Check if we need to create sample fixtures
  if (process.argv.includes('--create-fixtures')) {
    testRunner.createSampleFixture();
    return;
  }
  
  // Determine what tests to run
  if (process.argv.includes('--suite')) {
    const suiteIndex = process.argv.indexOf('--suite');
    if (suiteIndex < process.argv.length - 1) {
      const suiteName = process.argv[suiteIndex + 1];
      const results = await testRunner.runAllTestSuites();
      if (results[suiteName]) {
        testRunner.generateReport(results[suiteName]);
      } else {
        logger.error(`Test suite not found: ${suiteName}`);
      }
    } else {
      logger.error('No suite name provided after --suite');
    }
  } else {
    // Run all test cases by default
    const results = await testRunner.runAllTestCases();
    testRunner.generateReport(results);
  }
}

// Run if called directly
if (require.main === module) {
  main().catch(error => {
    logger.error('Integration test run failed:', error);
    process.exit(1);
  });
}

export { IntegrationTestRunner }; 
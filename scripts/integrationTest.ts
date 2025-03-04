/**
 * SuperCode AI Platform - Integration Testing
 * 
 * This script implements end-to-end integration testing for the SuperCode platform,
 * validating the complete workflow from context gathering through ensemble execution
 * to result generation.
 */

import * as path from 'path';
import * as fs from 'fs';
import { getContextManager } from '../src/context/contextManager.js';
import { TaskType } from '../src/ensemble/types.js';
import { getEnsembleManager } from '../src/ensemble/ensembleManager.js';
import { getModelRegistry } from '../src/llm/modelRegistry.js';
import { setupLogging } from '../src/core/logging.js';

// Initialize logger
const logger = setupLogging('integration:test');

// Test cases with expected outcomes
interface TestCase {
  name: string;
  taskType: TaskType;
  query: string;
  contextOptions: any;
  expectedOutcome: {
    minFilesIncluded: number;
    requiredFilePaths?: string[];
    ensembleSteps: number;
    maxExecutionTimeMs: number;
  };
}

const TEST_CASES: TestCase[] = [
  {
    name: 'Code Generation - Authentication Service',
    taskType: TaskType.GENERATE_CODE,
    query: 'Create a user authentication service with JWT support',
    contextOptions: {
      includePaths: ['src/security', 'src/core'],
      maxFiles: 10,
      includeImports: true
    },
    expectedOutcome: {
      minFilesIncluded: 3,
      requiredFilePaths: ['src/security', 'src/core'],
      ensembleSteps: 3,
      maxExecutionTimeMs: 10000
    }
  },
  {
    name: 'Code Refactoring - Logging Module',
    taskType: TaskType.REFACTOR_CODE,
    query: 'Refactor the logging system for better performance',
    contextOptions: {
      includePaths: ['src/core/logging.js'],
      maxFiles: 5,
      includeImports: true,
      considerFileHistory: true
    },
    expectedOutcome: {
      minFilesIncluded: 1,
      requiredFilePaths: ['src/core/logging.js'],
      ensembleSteps: 2,
      maxExecutionTimeMs: 8000
    }
  },
  {
    name: 'Security Analysis - Vulnerability Detection',
    taskType: TaskType.DETECT_VULNERABILITIES,
    query: 'Check for security vulnerabilities in the API layer',
    contextOptions: {
      includePaths: ['src/api'],
      maxFiles: 15,
      includeTests: false
    },
    expectedOutcome: {
      minFilesIncluded: 5,
      ensembleSteps: 2,
      maxExecutionTimeMs: 12000
    }
  }
];

// Results and metrics
interface TestResult {
  testCase: TestCase;
  success: boolean;
  contextMetrics: {
    filesIncluded: number;
    requiredFilesPresent: boolean;
    contextGenerationTimeMs: number;
  };
  ensembleMetrics: {
    stepsExecuted: number;
    totalExecutionTimeMs: number;
    modelUsed: string;
  };
  output: string;
  errors?: string[];
}

/**
 * Run integration tests
 */
async function runIntegrationTests(): Promise<TestResult[]> {
  logger.info('Starting SuperCode integration tests');
  
  // Initialize components
  const contextManager = getContextManager({
    projectRoot: path.resolve(__dirname, '..'),
    embeddingsEnabled: true,
    includeImports: true
  });
  
  const modelRegistry = getModelRegistry();
  await modelRegistry.initialize();
  
  const ensembleManager = getEnsembleManager();
  await ensembleManager.initialize();
  
  const results: TestResult[] = [];
  
  // Run each test case
  for (const testCase of TEST_CASES) {
    logger.info(`Running test case: ${testCase.name}`);
    
    const result: TestResult = {
      testCase,
      success: false,
      contextMetrics: {
        filesIncluded: 0,
        requiredFilesPresent: true,
        contextGenerationTimeMs: 0
      },
      ensembleMetrics: {
        stepsExecuted: 0,
        totalExecutionTimeMs: 0,
        modelUsed: ''
      },
      output: '',
      errors: []
    };
    
    try {
      // Measure context generation performance
      const contextStartTime = Date.now();
      const context = await contextManager.getContext(
        testCase.taskType,
        testCase.query,
        testCase.contextOptions
      );
      const contextEndTime = Date.now();
      
      // Record context metrics
      result.contextMetrics.filesIncluded = context.codebase?.files?.length || 0;
      result.contextMetrics.contextGenerationTimeMs = contextEndTime - contextStartTime;
      
      // Check if required files are included
      if (testCase.expectedOutcome.requiredFilePaths) {
        const includedPaths = context.codebase?.files?.map(f => f.path) || [];
        const requiredPathsPresent = testCase.expectedOutcome.requiredFilePaths.every(
          requiredPath => includedPaths.some(p => p.includes(requiredPath))
        );
        
        result.contextMetrics.requiredFilesPresent = requiredPathsPresent;
        
        if (!requiredPathsPresent) {
          result.errors?.push('Missing required files in context');
        }
      }
      
      // Execute ensemble
      const ensembleStartTime = Date.now();
      const ensembleResult = await ensembleManager.executeTask(
        testCase.taskType,
        testCase.query,
        context
      );
      const ensembleEndTime = Date.now();
      
      // Record ensemble metrics
      result.ensembleMetrics.stepsExecuted = ensembleResult.steps.length;
      result.ensembleMetrics.totalExecutionTimeMs = ensembleEndTime - ensembleStartTime;
      result.ensembleMetrics.modelUsed = ensembleResult.steps[0].modelId;
      result.output = ensembleResult.output;
      
      // Determine success
      result.success = (
        result.contextMetrics.filesIncluded >= testCase.expectedOutcome.minFilesIncluded &&
        result.contextMetrics.requiredFilesPresent &&
        result.ensembleMetrics.stepsExecuted >= testCase.expectedOutcome.ensembleSteps &&
        result.ensembleMetrics.totalExecutionTimeMs <= testCase.expectedOutcome.maxExecutionTimeMs
      );
      
      logger.info(`Test case ${testCase.name} ${result.success ? 'PASSED' : 'FAILED'}`);
    } catch (error) {
      logger.error(`Error in test case ${testCase.name}:`, error);
      result.success = false;
      result.errors?.push(`Exception: ${error}`);
    }
    
    results.push(result);
  }
  
  return results;
}

/**
 * Generate HTML report of test results
 */
function generateHTMLReport(results: TestResult[]): string {
  const successCount = results.filter(r => r.success).length;
  const failureCount = results.length - successCount;
  
  let html = `
<!DOCTYPE html>
<html>
<head>
  <title>SuperCode Integration Test Results</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 20px; }
    .header { background-color: #222831; color: #00FFF5; padding: 20px; }
    .summary { background-color: #393E46; color: white; padding: 15px; margin-top: 20px; }
    .test-case { margin: 20px 0; border: 1px solid #ddd; padding: 15px; }
    .success { border-left: 5px solid #4CAF50; }
    .failure { border-left: 5px solid #F44336; }
    .metrics { background-color: #f5f5f5; padding: 10px; margin: 10px 0; }
    .output { background-color: #f9f9f9; padding: 10px; margin: 10px 0; white-space: pre-wrap; }
    .errors { color: #F44336; }
  </style>
</head>
<body>
  <div class="header">
    <h1>SuperCode Integration Test Results</h1>
    <p>Run on ${new Date().toLocaleString()}</p>
  </div>
  
  <div class="summary">
    <h2>Summary</h2>
    <p>Total Tests: ${results.length}</p>
    <p>Successes: ${successCount}</p>
    <p>Failures: ${failureCount}</p>
  </div>
`;

  for (const result of results) {
    html += `
  <div class="test-case ${result.success ? 'success' : 'failure'}">
    <h3>${result.testCase.name}</h3>
    <p><strong>Status:</strong> ${result.success ? 'PASSED' : 'FAILED'}</p>
    <p><strong>Task Type:</strong> ${result.testCase.taskType}</p>
    <p><strong>Query:</strong> ${result.testCase.query}</p>
    
    <div class="metrics">
      <h4>Context Metrics</h4>
      <p>Files Included: ${result.contextMetrics.filesIncluded}</p>
      <p>Required Files Present: ${result.contextMetrics.requiredFilesPresent ? 'Yes' : 'No'}</p>
      <p>Context Generation Time: ${result.contextMetrics.contextGenerationTimeMs}ms</p>
      
      <h4>Ensemble Metrics</h4>
      <p>Steps Executed: ${result.ensembleMetrics.stepsExecuted}</p>
      <p>Total Execution Time: ${result.ensembleMetrics.totalExecutionTimeMs}ms</p>
      <p>Model Used: ${result.ensembleMetrics.modelUsed}</p>
    </div>
    
    ${result.errors && result.errors.length > 0 ? `
    <div class="errors">
      <h4>Errors</h4>
      <ul>
        ${result.errors.map(err => `<li>${err}</li>`).join('')}
      </ul>
    </div>
    ` : ''}
    
    <div class="output">
      <h4>Output</h4>
      <code>${result.output}</code>
    </div>
  </div>
`;
  }

  html += `
</body>
</html>
`;

  return html;
}

/**
 * Main function
 */
async function main() {
  try {
    // Run integration tests
    const results = await runIntegrationTests();
    
    // Generate HTML report
    const report = generateHTMLReport(results);
    
    // Write report to file
    const reportPath = path.join(__dirname, '../reports/integration-test-report.html');
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, report);
    
    logger.info(`Integration test report saved to ${reportPath}`);
    
    // Log summary
    const successCount = results.filter(r => r.success).length;
    logger.info(`Tests completed: ${successCount}/${results.length} passed`);
    
    // Exit with appropriate code
    process.exit(successCount === results.length ? 0 : 1);
  } catch (error) {
    logger.error('Error running integration tests:', error);
    process.exit(1);
  }
}

// Run the tests
main(); 
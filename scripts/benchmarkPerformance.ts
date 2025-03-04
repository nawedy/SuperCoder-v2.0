/**
 * SuperCode AI Platform - Performance Benchmarking
 * 
 * This script performs comprehensive performance benchmarking of the SuperCode platform,
 * measuring execution times, memory usage, and throughput for various components and workflows.
 */

import * as path from 'path';
import * as fs from 'fs';
import { performance } from 'perf_hooks';
import { getContextManager } from '../src/context/contextManager.js';
import { TaskType } from '../src/ensemble/types.js';
import { getEnsembleManager } from '../src/ensemble/ensembleManager.js';
import { getModelRegistry } from '../src/llm/modelRegistry.js';
import { setupLogging } from '../src/core/logging.js';

// CLI argument parsing
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

// Initialize logger
const logger = setupLogging('benchmark:performance');

/**
 * Benchmark categories
 */
enum BenchmarkCategory {
  CONTEXT_BRIDGE = 'Context Bridge',
  MODEL_INFERENCE = 'Model Inference',
  ENSEMBLE_EXECUTION = 'Ensemble Execution',
  END_TO_END = 'End-to-End Workflow',
  MEMORY_USAGE = 'Memory Usage',
  THROUGHPUT = 'Throughput'
}

/**
 * Benchmark test configuration
 */
interface BenchmarkTest {
  name: string;
  category: BenchmarkCategory;
  iterations: number;
  execute: () => Promise<any>;
  warmupIterations?: number;
  timeout?: number; // Timeout in milliseconds
  tags?: string[]; // For filtering tests
}

/**
 * Benchmark result
 */
interface BenchmarkResult {
  test: BenchmarkTest;
  executionTimes: number[];
  averageExecutionTime: number;
  medianExecutionTime: number;
  minExecutionTime: number;
  maxExecutionTime: number;
  p95ExecutionTime: number;
  standardDeviation: number;
  memoryUsage: {
    before: NodeJS.MemoryUsage;
    after: NodeJS.MemoryUsage;
    diff: {
      rss: number;
      heapTotal: number;
      heapUsed: number;
      external: number;
    };
  };
  timestamp: number;
}

/**
 * Benchmark configuration
 */
interface BenchmarkConfig {
  categories?: BenchmarkCategory[];
  tags?: string[];
  iterations?: number;
  warmupIterations?: number;
  timeout?: number;
  exportFormats?: ('html' | 'json' | 'csv')[];
  outputDir?: string;
  compareWithBaseline?: boolean;
  baselineFile?: string;
}

/**
 * Run a benchmark test
 */
async function runBenchmark(test: BenchmarkTest, config?: BenchmarkConfig): Promise<BenchmarkResult> {
  logger.info(`Running benchmark: ${test.name} (${test.category})`);
  
  // Apply config overrides if provided
  const iterations = config?.iterations || test.iterations;
  const warmupIterations = config?.warmupIterations || test.warmupIterations || 1;
  const timeout = config?.timeout || test.timeout || 60000; // Default 60s timeout
  
  logger.info(`Performing ${warmupIterations} warmup iterations...`);
  
  // Create timeout promise
  const createTimeoutPromise = () => {
    return new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`Benchmark timed out after ${timeout}ms`)), timeout);
    });
  };
  
  // Perform warmup iterations
  for (let i = 0; i < warmupIterations; i++) {
    try {
      await Promise.race([test.execute(), createTimeoutPromise()]);
    } catch (error) {
      if (error.message.includes('timed out')) {
        logger.warn(`Warmup iteration ${i + 1} timed out`);
      } else {
        throw error;
      }
    }
  }
  
  // Force garbage collection if available
  if (global.gc) {
    logger.info('Forcing garbage collection before benchmark');
    global.gc();
  }
  
  // Record memory usage before test
  const memoryBefore = process.memoryUsage();
  
  // Run benchmark iterations
  logger.info(`Running ${iterations} benchmark iterations...`);
  const executionTimes: number[] = [];
  
  for (let i = 0; i < iterations; i++) {
    const startTime = performance.now();
    try {
      await Promise.race([test.execute(), createTimeoutPromise()]);
      const endTime = performance.now();
      
      const executionTime = endTime - startTime;
      executionTimes.push(executionTime);
      
      logger.info(`Iteration ${i + 1}/${iterations}: ${executionTime.toFixed(2)}ms`);
    } catch (error) {
      if (error.message.includes('timed out')) {
        logger.warn(`Iteration ${i + 1} timed out, recording as ${timeout}ms`);
        executionTimes.push(timeout);
      } else {
        throw error;
      }
    }
  }
  
  // Record memory usage after test
  const memoryAfter = process.memoryUsage();
  
  // Calculate statistics
  executionTimes.sort((a, b) => a - b);
  
  const minExecutionTime = executionTimes[0];
  const maxExecutionTime = executionTimes[executionTimes.length - 1];
  const medianExecutionTime = executionTimes[Math.floor(executionTimes.length / 2)];
  
  const sum = executionTimes.reduce((acc, time) => acc + time, 0);
  const averageExecutionTime = sum / executionTimes.length;
  
  // Calculate standard deviation
  const squaredDifferences = executionTimes.map(time => Math.pow(time - averageExecutionTime, 2));
  const variance = squaredDifferences.reduce((acc, val) => acc + val, 0) / executionTimes.length;
  const standardDeviation = Math.sqrt(variance);
  
  const p95Index = Math.ceil(executionTimes.length * 0.95) - 1;
  const p95ExecutionTime = executionTimes[p95Index];
  
  // Calculate memory usage diff
  const memoryDiff = {
    rss: memoryAfter.rss - memoryBefore.rss,
    heapTotal: memoryAfter.heapTotal - memoryBefore.heapTotal,
    heapUsed: memoryAfter.heapUsed - memoryBefore.heapUsed,
    external: memoryAfter.external - memoryBefore.external
  };
  
  // Return result
  return {
    test,
    executionTimes,
    averageExecutionTime,
    medianExecutionTime,
    minExecutionTime,
    maxExecutionTime,
    p95ExecutionTime,
    standardDeviation,
    memoryUsage: {
      before: memoryBefore,
      after: memoryAfter,
      diff: memoryDiff
    },
    timestamp: Date.now()
  };
}

/**
 * Generate HTML report
 */
function generateHTMLReport(results: BenchmarkResult[], baselineResults?: BenchmarkResult[]): string {
  const resultsByCategory = results.reduce((acc, result) => {
    const category = result.test.category;
    if (!acc[category]) {
      acc[category] = [];
    }
    acc[category].push(result);
    return acc;
  }, {} as Record<BenchmarkCategory, BenchmarkResult[]>);
  
  // Map baseline results by test name for easy lookup
  const baselineMap = new Map<string, BenchmarkResult>();
  if (baselineResults) {
    baselineResults.forEach(result => {
      baselineMap.set(result.test.name, result);
    });
  }
  
  let html = `
<!DOCTYPE html>
<html>
<head>
  <title>SuperCode Performance Benchmark Results</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    body { font-family: Arial, sans-serif; margin: 20px; }
    .header { background-color: #222831; color: #00FFF5; padding: 20px; }
    .category { background-color: #393E46; color: white; padding: 15px; margin-top: 20px; }
    .benchmark { margin: 20px 0; border: 1px solid #ddd; padding: 15px; }
    .chart-container { height: 300px; margin: 20px 0; }
    .metrics { background-color: #f5f5f5; padding: 10px; margin: 10px 0; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 8px; text-align: left; border-bottom: 1px solid #ddd; }
    th { background-color: #f2f2f2; }
    .memory { margin-top: 15px; }
    .improvement { color: green; }
    .regression { color: red; }
    .summary-metrics { display: flex; justify-content: space-between; flex-wrap: wrap; }
    .summary-metric { width: 30%; background-color: #f0f0f0; margin: 10px 0; padding: 15px; border-radius: 5px; }
    .summary-metric h3 { margin-top: 0; }
  </style>
</head>
<body>
  <div class="header">
    <h1>SuperCode Performance Benchmark Results</h1>
    <p>Run on ${new Date().toLocaleString()}</p>
  </div>
  
  <div class="category">
    <h2>Summary Metrics</h2>
    <div class="summary-metrics">
      <div class="summary-metric">
        <h3>Average Execution Time</h3>
        <p>${(results.reduce((acc, r) => acc + r.averageExecutionTime, 0) / results.length).toFixed(2)}ms</p>
      </div>
      <div class="summary-metric">
        <h3>Total Tests</h3>
        <p>${results.length}</p>
      </div>
      <div class="summary-metric">
        <h3>Categories Tested</h3>
        <p>${Object.keys(resultsByCategory).length}</p>
      </div>
    </div>
  </div>
`;

  // Add summary table
  html += `
  <div class="category">
    <h2>Summary</h2>
    <table>
      <tr>
        <th>Category</th>
        <th>Test</th>
        <th>Avg (ms)</th>
        <th>Median (ms)</th>
        <th>P95 (ms)</th>
        <th>Min (ms)</th>
        <th>Max (ms)</th>
        <th>Std Dev</th>
        ${baselineResults ? '<th>vs Baseline</th>' : ''}
      </tr>
`;

  for (const category of Object.values(BenchmarkCategory)) {
    const categoryResults = resultsByCategory[category] || [];
    
    for (const result of categoryResults) {
      const baseline = baselineMap.get(result.test.name);
      let comparisonHtml = '';
      
      if (baseline) {
        const diff = result.averageExecutionTime - baseline.averageExecutionTime;
        const percentChange = (diff / baseline.averageExecutionTime) * 100;
        const isImprovement = diff < 0;
        
        comparisonHtml = `<td class="${isImprovement ? 'improvement' : 'regression'}">${isImprovement ? '' : '+'}${percentChange.toFixed(2)}%</td>`;
      }
      
      html += `
      <tr>
        <td>${result.test.category}</td>
        <td>${result.test.name}</td>
        <td>${result.averageExecutionTime.toFixed(2)}</td>
        <td>${result.medianExecutionTime.toFixed(2)}</td>
        <td>${result.p95ExecutionTime.toFixed(2)}</td>
        <td>${result.minExecutionTime.toFixed(2)}</td>
        <td>${result.maxExecutionTime.toFixed(2)}</td>
        <td>${result.standardDeviation.toFixed(2)}</td>
        ${baselineResults ? comparisonHtml : ''}
      </tr>
`;
    }
  }

  html += `
    </table>
  </div>
`;

  // Add detailed results by category
  for (const category of Object.values(BenchmarkCategory)) {
    const categoryResults = resultsByCategory[category] || [];
    
    if (categoryResults.length === 0) {
      continue;
    }
    
    html += `
  <div class="category">
    <h2>${category}</h2>
`;

    for (const result of categoryResults) {
      const testId = `benchmark-${result.test.name.replace(/\s+/g, '-').toLowerCase()}`;
      const baseline = baselineMap.get(result.test.name);
      
      html += `
    <div class="benchmark">
      <h3>${result.test.name}</h3>
      
      <div class="metrics">
        <p><strong>Iterations:</strong> ${result.test.iterations}</p>
        <p><strong>Average Execution Time:</strong> ${result.averageExecutionTime.toFixed(2)}ms</p>
        <p><strong>Median Execution Time:</strong> ${result.medianExecutionTime.toFixed(2)}ms</p>
        <p><strong>95th Percentile:</strong> ${result.p95ExecutionTime.toFixed(2)}ms</p>
        <p><strong>Min Execution Time:</strong> ${result.minExecutionTime.toFixed(2)}ms</p>
        <p><strong>Max Execution Time:</strong> ${result.maxExecutionTime.toFixed(2)}ms</p>
        <p><strong>Standard Deviation:</strong> ${result.standardDeviation.toFixed(2)}ms</p>
        
        ${baseline ? `
        <p><strong>Comparison to Baseline:</strong> 
          <span class="${result.averageExecutionTime < baseline.averageExecutionTime ? 'improvement' : 'regression'}">
            ${result.averageExecutionTime < baseline.averageExecutionTime ? 'Improved by ' : 'Regressed by '}
            ${Math.abs(((result.averageExecutionTime - baseline.averageExecutionTime) / baseline.averageExecutionTime) * 100).toFixed(2)}%
          </span>
        </p>` : ''}
      </div>
      
      <div class="chart-container">
        <canvas id="${testId}-chart"></canvas>
      </div>
      
      <div class="memory">
        <h4>Memory Usage</h4>
        <p>RSS: ${(result.memoryUsage.diff.rss / 1024 / 1024).toFixed(2)} MB</p>
        <p>Heap Total: ${(result.memoryUsage.diff.heapTotal / 1024 / 1024).toFixed(2)} MB</p>
        <p>Heap Used: ${(result.memoryUsage.diff.heapUsed / 1024 / 1024).toFixed(2)} MB</p>
        <p>External: ${(result.memoryUsage.diff.external / 1024 / 1024).toFixed(2)} MB</p>
      </div>
      
      <script>
        new Chart(document.getElementById('${testId}-chart'), {
          type: 'line',
          data: {
            labels: ${JSON.stringify([...Array(result.executionTimes.length).keys()].map(i => `Iteration ${i + 1}`))},
            datasets: [{
              label: 'Execution Time (ms)',
              data: ${JSON.stringify(result.executionTimes)},
              borderColor: '#00ADB5',
              tension: 0.1
            }${baseline ? `, {
              label: 'Baseline (ms)',
              data: ${JSON.stringify(Array(result.executionTimes.length).fill(baseline.averageExecutionTime))},
              borderColor: '#FF5722',
              borderDash: [5, 5],
              tension: 0.1
            }` : ''}]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
              y: {
                beginAtZero: true,
                title: {
                  display: true,
                  text: 'Time (ms)'
                }
              }
            }
          }
        });
      </script>
    </div>
`;
    }
    
    html += `
  </div>
`;
  }

  html += `
  <script>
    // Add any additional interactive features here
    document.addEventListener('DOMContentLoaded', function() {
      console.log('Performance benchmark report loaded');
    });
  </script>
</body>
</html>`;

  return html;
}

/**
 * Generate CSV report
 */
function generateCSVReport(results: BenchmarkResult[]): string {
  let csv = 'Category,Test Name,Iterations,Average (ms),Median (ms),P95 (ms),Min (ms),Max (ms),Std Dev (ms),RSS (MB),Heap Total (MB),Heap Used (MB),External (MB),Timestamp\n';
  
  for (const result of results) {
    csv += [
      result.test.category,
      result.test.name,
      result.test.iterations,
      result.averageExecutionTime.toFixed(2),
      result.medianExecutionTime.toFixed(2),
      result.p95ExecutionTime.toFixed(2),
      result.minExecutionTime.toFixed(2),
      result.maxExecutionTime.toFixed(2),
      result.standardDeviation.toFixed(2),
      (result.memoryUsage.diff.rss / 1024 / 1024).toFixed(2),
      (result.memoryUsage.diff.heapTotal / 1024 / 1024).toFixed(2),
      (result.memoryUsage.diff.heapUsed / 1024 / 1024).toFixed(2),
      (result.memoryUsage.diff.external / 1024 / 1024).toFixed(2),
      result.timestamp
    ].join(',') + '\n';
  }
  
  return csv;
}

/**
 * Define benchmark tests
 */
async function getBenchmarks(): Promise<BenchmarkTest[]> {
  // Initialize managers
  const contextManager = await getContextManager();
  const ensembleManager = await getEnsembleManager();
  const modelRegistry = await getModelRegistry();
  
  return [
    // Context Bridge benchmarks
    {
      name: 'Context Retrieval - Basic',
      category: BenchmarkCategory.CONTEXT_BRIDGE,
      iterations: 5,
      warmupIterations: 1,
      tags: ['context', 'fast'],
      execute: async () => {
        return contextManager.getContext(
          TaskType.GENERATE_CODE,
          'Implement a simple logging utility',
          {
            includePaths: ['src/core'],
            maxFiles: 5
          }
        );
      }
    },
    {
      name: 'Context Retrieval - With Dependencies',
      category: BenchmarkCategory.CONTEXT_BRIDGE,
      iterations: 5,
      warmupIterations: 1,
      tags: ['context', 'dependencies'],
      execute: async () => {
        return contextManager.getContext(
          TaskType.GENERATE_CODE,
          'Add authentication to the API',
          {
            includePaths: ['src/api', 'src/security'],
            maxFiles: 10,
            includeImports: true
          }
        );
      }
    },
    
    // Model Inference benchmarks
    {
      name: 'Model Inference - Small Prompt',
      category: BenchmarkCategory.MODEL_INFERENCE,
      iterations: 3,
      warmupIterations: 1,
      tags: ['inference', 'fast'],
      execute: async () => {
        const models = await modelRegistry.getModels();
        const model = models[0]; // Use first available model
        return model.generate('Generate a simple hello world function in JavaScript', {
          maxTokens: 100
        });
      }
    },
    {
      name: 'Model Inference - Large Prompt',
      category: BenchmarkCategory.MODEL_INFERENCE,
      iterations: 3,
      warmupIterations: 1,
      tags: ['inference', 'slow'],
      execute: async () => {
        const models = await modelRegistry.getModels();
        const model = models[0]; // Use first available model
        
        // Create a larger prompt with some code context
        const prompt = `
        Generate a TypeScript class for managing user authentication with the following requirements:
        
        1. Support registration with email/password
        2. Login with email/password
        3. Password reset functionality
        4. JWT token generation and validation
        5. Middleware for protected routes
        
        Here's an example of a similar class:
        
        \`\`\`typescript
        export class UserManager {
          private users: User[] = [];
          
          constructor(private db: Database) {}
          
          async findUserByEmail(email: string): Promise<User | null> {
            return this.db.users.findOne({ email });
          }
          
          async createUser(userData: UserData): Promise<User> {
            // Implementation
          }
        }
        \`\`\`
        `;
        
        return model.generate(prompt, {
          maxTokens: 500
        });
      }
    },
    
    // Memory usage specific benchmark
    {
      name: 'Memory Growth - Sequential Operations',
      category: BenchmarkCategory.MEMORY_USAGE,
      iterations: 5,
      warmupIterations: 1,
      tags: ['memory'],
      execute: async () => {
        // Perform a sequence of operations and measure memory impact
        const models = await modelRegistry.getModels();
        const model = models[0];
        
        // Generate 5 small completions in sequence
        for (let i = 0; i < 5; i++) {
          await model.generate(`Generate a function to calculate the ${i}th Fibonacci number`, {
            maxTokens: 100
          });
        }
        
        return true;
      }
    },
    
    // Throughput benchmark
    {
      name: 'Throughput - Parallel Operations',
      category: BenchmarkCategory.THROUGHPUT,
      iterations: 3,
      warmupIterations: 1,
      tags: ['throughput'],
      execute: async () => {
        const models = await modelRegistry.getModels();
        const model = models[0];
        
        // Run 10 parallel operations
        const operations = Array(10).fill(0).map((_, i) => {
          return model.generate(`Generate a function to calculate ${i} squared`, {
            maxTokens: 50
          });
        });
        
        await Promise.all(operations);
        return true;
      }
    },
    
    // Ensemble Execution benchmarks
    {
      name: 'Ensemble Execution - Simple Task',
      category: BenchmarkCategory.ENSEMBLE_EXECUTION,
      iterations: 3,
      warmupIterations: 1,
      tags: ['ensemble', 'fast'],
      execute: async () => {
        // Get a simple context first
        const context = await contextManager.getContext(
          TaskType.GENERATE_CODE,
          'Create a utility function to format dates',
          { maxFiles: 2 }
        );
        
        return ensembleManager.executeTask(
          TaskType.GENERATE_CODE,
          'Create a utility function to format dates',
          context
        );
      }
    },
    
    // End-to-End benchmarks
    {
      name: 'End-to-End - Code Generation',
      category: BenchmarkCategory.END_TO_END,
      iterations: 2,
      warmupIterations: 1,
      tags: ['e2e', 'slow'],
      execute: async () => {
        // Full workflow from context to result
        const context = await contextManager.getContext(
          TaskType.GENERATE_CODE,
          'Create a REST API endpoint to fetch user data',
          {
            includePaths: ['src/api', 'src/core'],
            maxFiles: 8,
            includeImports: true
          }
        );
        
        return ensembleManager.executeTask(
          TaskType.GENERATE_CODE,
          'Create a REST API endpoint to fetch user data',
          context
        );
      }
    }
  ];
}

/**
 * Run benchmarks with filter options
 */
async function runBenchmarks(config?: BenchmarkConfig): Promise<BenchmarkResult[]> {
  const allBenchmarks = await getBenchmarks();
  
  // Filter benchmarks based on config
  let benchmarks = allBenchmarks;
  
  if (config?.categories && config.categories.length > 0) {
    benchmarks = benchmarks.filter(benchmark => 
      config.categories!.includes(benchmark.test.category)
    );
  }
  
  if (config?.tags && config.tags.length > 0) {
    benchmarks = benchmarks.filter(benchmark => 
      benchmark.tags && benchmark.tags.some(tag => config.tags!.includes(tag))
    );
  }
  
  // Run benchmarks
  const results: BenchmarkResult[] = [];
  
  for (const benchmark of benchmarks) {
    try {
      const result = await runBenchmark(benchmark, config);
      results.push(result);
    } catch (error) {
      logger.error(`Error running benchmark ${benchmark.name}:`, error);
    }
  }
  
  return results;
}

/**
 * Load baseline results from file
 */
function loadBaselineResults(filePath: string): BenchmarkResult[] | null {
  try {
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(data);
    }
  } catch (error) {
    logger.error(`Error loading baseline results from ${filePath}:`, error);
  }
  
  return null;
}

/**
 * Parse command line arguments
 */
function parseArgs() {
  return yargs(hideBin(process.argv))
    .option('category', {
      alias: 'c',
      type: 'array',
      description: 'Filter benchmarks by category',
      choices: Object.values(BenchmarkCategory)
    })
    .option('tag', {
      alias: 't',
      type: 'array',
      description: 'Filter benchmarks by tag'
    })
    .option('iterations', {
      alias: 'i',
      type: 'number',
      description: 'Number of iterations to run'
    })
    .option('warmup', {
      alias: 'w',
      type: 'number',
      description: 'Number of warmup iterations'
    })
    .option('timeout', {
      type: 'number',
      description: 'Timeout in milliseconds'
    })
    .option('output', {
      alias: 'o',
      type: 'string',
      description: 'Output directory',
      default: path.join(__dirname, '../reports')
    })
    .option('format', {
      alias: 'f',
      type: 'array',
      description: 'Output formats',
      choices: ['html', 'json', 'csv'],
      default: ['html', 'json']
    })
    .option('compare', {
      alias: 'b',
      type: 'string',
      description: 'Baseline file to compare against'
    })
    .option('save-baseline', {
      type: 'boolean',
      description: 'Save results as new baseline'
    })
    .option('gc', {
      type: 'boolean',
      description: 'Force garbage collection between tests (requires --expose-gc)'
    })
    .option('verbose', {
      alias: 'v',
      type: 'boolean',
      description: 'Verbose output'
    })
    .help()
    .alias('help', 'h')
    .version()
    .alias('version', 'V')
    .argv;
}

/**
 * Main function
 */
async function main() {
  try {
    // Parse command line arguments
    const args = await parseArgs();
    
    // Enable garbage collection warning
    if (args.gc && !global.gc) {
      logger.warn('Garbage collection requested but not available. Run with --expose-gc flag.');
    } else if (global.gc) {
      logger.info('Garbage collection is available');
    } else {
      logger.warn('Garbage collection is not available. Run with --expose-gc for more accurate memory metrics.');
    }
    
    // Prepare benchmark config
    const config: BenchmarkConfig = {
      categories: args.category as BenchmarkCategory[],
      tags: args.tag as string[],
      iterations: args.iterations,
      warmupIterations: args.warmup,
      timeout: args.timeout,
      exportFormats: args.format as ('html' | 'json' | 'csv')[],
      outputDir: args.output,
      compareWithBaseline: !!args.compare,
      baselineFile: args.compare as string
    };
    
    // Load baseline results if needed
    let baselineResults: BenchmarkResult[] | null = null;
    if (config.compareWithBaseline && config.baselineFile) {
      baselineResults = loadBaselineResults(config.baselineFile);
      if (baselineResults) {
        logger.info(`Loaded baseline results from ${config.baselineFile}`);
      }
    }
    
    // Run benchmarks
    logger.info('Starting performance benchmarks...');
    const results = await runBenchmarks(config);
    logger.info(`Completed ${results.length} benchmarks`);
    
    // Create output directory if it doesn't exist
    const outputDir = config.outputDir || path.join(__dirname, '../reports');
    fs.mkdirSync(outputDir, { recursive: true });
    
    // Generate reports based on format
    const formats = config.exportFormats || ['html', 'json'];
    const timestamp = new Date().toISOString().replace(/:/g, '-').split('.')[0];
    
    if (formats.includes('html')) {
      const htmlReport = generateHTMLReport(results, baselineResults || undefined);
      const htmlPath = path.join(outputDir, `performance-benchmark-report-${timestamp}.html`);
      fs.writeFileSync(htmlPath, htmlReport);
      logger.info(`HTML report saved to ${htmlPath}`);
    }
    
    if (formats.includes('json')) {
      const jsonPath = path.join(outputDir, `performance-benchmark-data-${timestamp}.json`);
      fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2));
      logger.info(`JSON data saved to ${jsonPath}`);
    }
    
    if (formats.includes('csv')) {
      const csvReport = generateCSVReport(results);
      const csvPath = path.join(outputDir, `performance-benchmark-data-${timestamp}.csv`);
      fs.writeFileSync(csvPath, csvReport);
      logger.info(`CSV report saved to ${csvPath}`);
    }
    
    // Save as new baseline if requested
    if (args['save-baseline']) {
      const baselinePath = path.join(outputDir, 'performance-baseline.json');
      fs.writeFileSync(baselinePath, JSON.stringify(results, null, 2));
      logger.info(`Results saved as new baseline to ${baselinePath}`);
    }
    
    logger.info('Performance benchmarking completed successfully');
  } catch (error) {
    logger.error('Error running performance benchmarks:', error);
    process.exit(1);
  }
}

// Run the benchmarks
main(); 
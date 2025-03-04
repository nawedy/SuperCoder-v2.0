/**
 * SuperCode AI Platform - User Acceptance Testing
 * 
 * This script implements a framework for collecting user feedback during UAT,
 * tracking interactions, summarizing results, and generating reports.
 */

import * as path from 'path';
import * as fs from 'fs';
import * as readline from 'readline';
import { getContextManager } from '../src/context/contextManager.js';
import { TaskType } from '../src/ensemble/types.js';
import { getEnsembleManager } from '../src/ensemble/ensembleManager.js';
import { getModelRegistry } from '../src/llm/modelRegistry.js';
import { setupLogging } from '../src/core/logging.js';

// Initialize logger
const logger = setupLogging('uat:testing');

/**
 * User feedback categories
 */
enum FeedbackCategory {
  ACCURACY = 'Accuracy',
  RELEVANCE = 'Relevance',
  SPEED = 'Speed',
  UI_EXPERIENCE = 'UI Experience',
  USABILITY = 'Usability',
  SUGGESTIONS = 'Suggestions'
}

/**
 * User test scenarios
 */
enum TestScenario {
  CODE_GENERATION = 'Code Generation',
  CODE_EXPLANATION = 'Code Explanation',
  REFACTORING = 'Code Refactoring',
  SECURITY_ANALYSIS = 'Security Analysis',
  DOCUMENTATION = 'Documentation Generation'
}

/**
 * User profile
 */
interface UserProfile {
  id: string;
  role: string;
  experienceLevel: string;
  preferredLanguages: string[];
}

/**
 * UAT session data
 */
interface UATSession {
  id: string;
  user: UserProfile;
  startTime: number;
  endTime?: number;
  interactions: Interaction[];
  feedbackResponses: FeedbackResponse[];
  overallSatisfaction?: number; // 1-10 rating
  netPromoterScore?: number; // 0-10 rating
}

/**
 * User interaction with the system
 */
interface Interaction {
  id: string;
  timestamp: number;
  scenario: TestScenario;
  query: string;
  taskType: TaskType;
  contextOptions?: any;
  durationMs: number;
  success: boolean;
  errorMessage?: string;
  userRating?: number; // 1-5 rating
  userComments?: string;
}

/**
 * User feedback on specific aspects
 */
interface FeedbackResponse {
  category: FeedbackCategory;
  rating: number; // 1-5 rating
  comments: string;
}

/**
 * UAT result summary
 */
interface UATResults {
  sessions: UATSession[];
  averageRatings: Record<FeedbackCategory, number>;
  scenarioPerformance: Record<TestScenario, {
    averageRating: number;
    averageDuration: number;
    successRate: number;
    count: number;
  }>;
  netPromoterScore: number;
  overallSatisfaction: number;
  topIssues: string[];
  topSuggestions: string[];
}

/**
 * Create a readline interface for interactive CLI
 */
function createInterface(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
}

/**
 * Ask a question and get user input
 */
async function askQuestion(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(`${question} `, (answer) => {
      resolve(answer);
    });
  });
}

/**
 * Get a numeric rating from the user
 */
async function getRating(rl: readline.Interface, question: string, min: number, max: number): Promise<number> {
  while (true) {
    const input = await askQuestion(rl, `${question} (${min}-${max}):`);
    const rating = parseInt(input, 10);
    
    if (!isNaN(rating) && rating >= min && rating <= max) {
      return rating;
    }
    
    console.log(`Please enter a number between ${min} and ${max}.`);
  }
}

/**
 * Collect user profile information
 */
async function collectUserProfile(rl: readline.Interface): Promise<UserProfile> {
  console.log("\n--- User Profile ---");
  
  const id = await askQuestion(rl, "Enter user ID:");
  const role = await askQuestion(rl, "Select role (Developer/Manager/Designer/Other):");
  const experienceLevel = await askQuestion(rl, "Experience level (Beginner/Intermediate/Advanced):");
  const languages = await askQuestion(rl, "Preferred programming languages (comma-separated):");
  
  return {
    id,
    role,
    experienceLevel,
    preferredLanguages: languages.split(',').map(lang => lang.trim())
  };
}

/**
 * Run a specific test scenario
 */
async function runTestScenario(
  rl: readline.Interface,
  scenario: TestScenario,
  contextManager: any,
  ensembleManager: any
): Promise<Interaction> {
  console.log(`\n--- ${scenario} Scenario ---`);
  
  // Map scenario to task type
  const taskTypeMap: Record<TestScenario, TaskType> = {
    [TestScenario.CODE_GENERATION]: TaskType.GENERATE_CODE,
    [TestScenario.CODE_EXPLANATION]: TaskType.EXPLAIN_CODE,
    [TestScenario.REFACTORING]: TaskType.REFACTOR_CODE,
    [TestScenario.SECURITY_ANALYSIS]: TaskType.DETECT_VULNERABILITIES,
    [TestScenario.DOCUMENTATION]: TaskType.DOCUMENT_CODE
  };
  
  const taskType = taskTypeMap[scenario];
  
  // Get user query
  const query = await askQuestion(rl, "Enter your query/request:");
  
  // Create interaction record
  const interaction: Interaction = {
    id: `int-${Date.now()}`,
    timestamp: Date.now(),
    scenario,
    query,
    taskType,
    durationMs: 0,
    success: false
  };
  
  try {
    console.log("\nProcessing your request...");
    
    // Start timing
    const startTime = Date.now();
    
    // Get context
    const context = await contextManager.getContext(taskType, query, {
      maxFiles: 10,
      includeImports: true
    });
    
    console.log(`Found ${context.codebase?.files?.length || 0} relevant files`);
    
    // Execute ensemble
    const result = await ensembleManager.executeTask(taskType, query, context);
    
    // End timing
    const endTime = Date.now();
    interaction.durationMs = endTime - startTime;
    
    // Display result
    console.log("\n--- Result ---");
    console.log(result.output);
    console.log(`\nCompleted in ${interaction.durationMs}ms`);
    
    interaction.success = true;
  } catch (error) {
    interaction.success = false;
    interaction.errorMessage = error.toString();
    console.log("\nError processing request:", error);
  }
  
  // Get user rating and comments
  interaction.userRating = await getRating(rl, "How would you rate this result", 1, 5);
  interaction.userComments = await askQuestion(rl, "Any comments about this result?");
  
  return interaction;
}

/**
 * Collect feedback for a specific category
 */
async function collectCategoryFeedback(
  rl: readline.Interface,
  category: FeedbackCategory
): Promise<FeedbackResponse> {
  console.log(`\n--- ${category} Feedback ---`);
  
  const rating = await getRating(rl, `How would you rate the ${category.toLowerCase()}`, 1, 5);
  const comments = await askQuestion(rl, `Comments about ${category.toLowerCase()}:`);
  
  return {
    category,
    rating,
    comments
  };
}

/**
 * Conduct a complete UAT session
 */
async function conductUATSession(): Promise<UATSession> {
  const rl = createInterface();
  
  // Create session
  const session: UATSession = {
    id: `session-${Date.now()}`,
    startTime: Date.now(),
    interactions: [],
    feedbackResponses: [],
    user: {
      id: '',
      role: '',
      experienceLevel: '',
      preferredLanguages: []
    }
  };
  
  try {
    console.log("Welcome to the SuperCode AI Platform User Acceptance Testing");
    console.log("===========================================================");
    console.log("This session will guide you through testing various scenarios and collecting feedback.");
    
    // Collect user profile
    session.user = await collectUserProfile(rl);
    
    // Initialize components
    console.log("\nInitializing SuperCode components...");
    
    const contextManager = getContextManager({
      projectRoot: path.resolve(__dirname, '..'),
      embeddingsEnabled: true,
      includeImports: true
    });
    
    const modelRegistry = getModelRegistry();
    await modelRegistry.initialize();
    
    const ensembleManager = getEnsembleManager();
    await ensembleManager.initialize();
    
    console.log("Components initialized successfully.");
    
    // Run scenarios
    const scenarios = [
      TestScenario.CODE_GENERATION,
      TestScenario.CODE_EXPLANATION,
      TestScenario.REFACTORING,
      TestScenario.SECURITY_ANALYSIS,
      TestScenario.DOCUMENTATION
    ];
    
    for (const scenario of scenarios) {
      const runScenario = await askQuestion(rl, `\nWould you like to test the ${scenario} scenario? (y/n):`);
      
      if (runScenario.toLowerCase() === 'y') {
        const interaction = await runTestScenario(rl, scenario, contextManager, ensembleManager);
        session.interactions.push(interaction);
      }
    }
    
    // Collect feedback for each category
    console.log("\n--- Overall Feedback ---");
    
    for (const category of Object.values(FeedbackCategory)) {
      const feedback = await collectCategoryFeedback(rl, category);
      session.feedbackResponses.push(feedback);
    }
    
    // Collect overall satisfaction
    session.overallSatisfaction = await getRating(rl, "Overall satisfaction with SuperCode", 1, 10);
    
    // Collect NPS
    session.netPromoterScore = await getRating(
      rl,
      "How likely are you to recommend SuperCode to a colleague",
      0,
      10
    );
    
    // Thank the user
    console.log("\nThank you for participating in the SuperCode UAT session!");
    
  } catch (error) {
    logger.error("Error during UAT session:", error);
    console.log("An error occurred during the UAT session. Some data may be incomplete.");
  } finally {
    // Close readline interface
    rl.close();
    
    // Set end time
    session.endTime = Date.now();
  }
  
  return session;
}

/**
 * Analyze UAT results and generate a summary
 */
function analyzeUATResults(sessions: UATSession[]): UATResults {
  // Initialize result structure
  const results: UATResults = {
    sessions,
    averageRatings: {} as Record<FeedbackCategory, number>,
    scenarioPerformance: {} as Record<TestScenario, any>,
    netPromoterScore: 0,
    overallSatisfaction: 0,
    topIssues: [],
    topSuggestions: []
  };
  
  // Initialize category ratings
  for (const category of Object.values(FeedbackCategory)) {
    results.averageRatings[category] = 0;
  }
  
  // Initialize scenario performance
  for (const scenario of Object.values(TestScenario)) {
    results.scenarioPerformance[scenario] = {
      averageRating: 0,
      averageDuration: 0,
      successRate: 0,
      count: 0
    };
  }
  
  // Calculate average ratings by category
  let totalFeedbackResponses = 0;
  for (const session of sessions) {
    for (const feedback of session.feedbackResponses) {
      results.averageRatings[feedback.category] += feedback.rating;
      totalFeedbackResponses++;
    }
  }
  
  for (const category of Object.values(FeedbackCategory)) {
    const totalResponses = sessions.flatMap(s => 
      s.feedbackResponses.filter(f => f.category === category)
    ).length;
    
    if (totalResponses > 0) {
      results.averageRatings[category] /= totalResponses;
    }
  }
  
  // Calculate scenario performance
  for (const session of sessions) {
    for (const interaction of session.interactions) {
      const scenario = interaction.scenario;
      const performance = results.scenarioPerformance[scenario];
      
      performance.count++;
      
      if (interaction.success) {
        performance.successRate++;
      }
      
      if (interaction.userRating) {
        performance.averageRating += interaction.userRating;
      }
      
      performance.averageDuration += interaction.durationMs;
    }
  }
  
  // Finalize scenario calculations
  for (const scenario of Object.values(TestScenario)) {
    const performance = results.scenarioPerformance[scenario];
    
    if (performance.count > 0) {
      performance.averageRating /= performance.count;
      performance.averageDuration /= performance.count;
      performance.successRate = (performance.successRate / performance.count) * 100;
    }
  }
  
  // Calculate Net Promoter Score
  const npsScores = sessions.filter(s => s.netPromoterScore !== undefined)
                            .map(s => s.netPromoterScore!);
  
  if (npsScores.length > 0) {
    const promoters = npsScores.filter(score => score >= 9).length;
    const detractors = npsScores.filter(score => score <= 6).length;
    results.netPromoterScore = ((promoters - detractors) / npsScores.length) * 100;
  }
  
  // Calculate overall satisfaction
  const satisfactionScores = sessions.filter(s => s.overallSatisfaction !== undefined)
                                    .map(s => s.overallSatisfaction!);
  
  if (satisfactionScores.length > 0) {
    results.overallSatisfaction = satisfactionScores.reduce((sum, score) => sum + score, 0) / 
                                  satisfactionScores.length;
  }
  
  // Compile top issues (low-rated feedback with comments)
  const issues = sessions.flatMap(s => 
    s.feedbackResponses
      .filter(f => f.rating <= 3 && f.comments.trim().length > 0)
      .map(f => ({ category: f.category, comment: f.comments }))
  );
  
  results.topIssues = issues.map(issue => `${issue.category}: ${issue.comment}`);
  
  // Compile suggestions
  const suggestions = sessions.flatMap(s => 
    s.feedbackResponses
      .filter(f => f.category === FeedbackCategory.SUGGESTIONS && f.comments.trim().length > 0)
      .map(f => f.comments)
  );
  
  results.topSuggestions = suggestions;
  
  return results;
}

/**
 * Generate HTML report for UAT results
 */
function generateHTMLReport(results: UATResults): string {
  let html = `
<!DOCTYPE html>
<html>
<head>
  <title>SuperCode UAT Results</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    body { font-family: Arial, sans-serif; margin: 20px; }
    .header { background-color: #222831; color: #00FFF5; padding: 20px; }
    .section { background-color: #393E46; color: white; padding: 15px; margin-top: 20px; }
    .subsection { margin: 20px 0; border: 1px solid #ddd; padding: 15px; }
    .chart-container { height: 300px; margin: 20px 0; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 8px; text-align: left; border-bottom: 1px solid #ddd; }
    th { background-color: #f2f2f2; }
    .issues, .suggestions { margin: 15px 0; }
    .good { color: #4CAF50; }
    .neutral { color: #FF9800; }
    .bad { color: #F44336; }
  </style>
</head>
<body>
  <div class="header">
    <h1>SuperCode User Acceptance Testing Results</h1>
    <p>Report generated on ${new Date().toLocaleString()}</p>
  </div>
  
  <div class="section">
    <h2>Summary</h2>
    <div class="subsection">
      <p><strong>Number of Sessions:</strong> ${results.sessions.length}</p>
      <p><strong>Overall Satisfaction:</strong> <span class="${results.overallSatisfaction >= 8 ? 'good' : results.overallSatisfaction >= 6 ? 'neutral' : 'bad'}">${results.overallSatisfaction.toFixed(1)}/10</span></p>
      <p><strong>Net Promoter Score:</strong> <span class="${results.netPromoterScore >= 50 ? 'good' : results.netPromoterScore >= 0 ? 'neutral' : 'bad'}">${results.netPromoterScore.toFixed(1)}</span></p>
      
      <div class="chart-container">
        <canvas id="categoryRatingsChart"></canvas>
      </div>
    </div>
  </div>
  
  <div class="section">
    <h2>Scenario Performance</h2>
    <div class="subsection">
      <table>
        <tr>
          <th>Scenario</th>
          <th>Count</th>
          <th>Avg Rating</th>
          <th>Avg Duration (ms)</th>
          <th>Success Rate</th>
        </tr>
`;

  // Add scenario performance rows
  for (const scenario of Object.values(TestScenario)) {
    const performance = results.scenarioPerformance[scenario];
    
    if (performance.count > 0) {
      html += `
        <tr>
          <td>${scenario}</td>
          <td>${performance.count}</td>
          <td class="${performance.averageRating >= 4 ? 'good' : performance.averageRating >= 3 ? 'neutral' : 'bad'}">${performance.averageRating.toFixed(1)}/5</td>
          <td>${performance.averageDuration.toFixed(0)}</td>
          <td class="${performance.successRate >= 90 ? 'good' : performance.successRate >= 70 ? 'neutral' : 'bad'}">${performance.successRate.toFixed(1)}%</td>
        </tr>
`;
    }
  }

  html += `
      </table>
      
      <div class="chart-container">
        <canvas id="scenarioRatingsChart"></canvas>
      </div>
    </div>
  </div>
  
  <div class="section">
    <h2>Issues and Suggestions</h2>
    <div class="subsection">
      <div class="issues">
        <h3>Top Issues</h3>
        <ul>
`;

  // Add top issues
  if (results.topIssues.length > 0) {
    for (const issue of results.topIssues) {
      html += `          <li>${issue}</li>\n`;
    }
  } else {
    html += `          <li>No major issues reported</li>\n`;
  }

  html += `
        </ul>
      </div>
      
      <div class="suggestions">
        <h3>User Suggestions</h3>
        <ul>
`;

  // Add suggestions
  if (results.topSuggestions.length > 0) {
    for (const suggestion of results.topSuggestions) {
      html += `          <li>${suggestion}</li>\n`;
    }
  } else {
    html += `          <li>No suggestions provided</li>\n`;
  }

  html += `
        </ul>
      </div>
    </div>
  </div>
  
  <script>
    document.addEventListener('DOMContentLoaded', function() {
      // Category ratings chart
      new Chart(document.getElementById('categoryRatingsChart'), {
        type: 'bar',
        data: {
          labels: ${JSON.stringify(Object.values(FeedbackCategory))},
          datasets: [{
            label: 'Average Rating (1-5)',
            data: [
              ${Object.values(FeedbackCategory).map(category => 
                results.averageRatings[category].toFixed(1)
              ).join(', ')}
            ],
            backgroundColor: '#00ADB5'
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            y: {
              beginAtZero: true,
              max: 5,
              title: {
                display: true,
                text: 'Average Rating'
              }
            }
          }
        }
      });
      
      // Scenario ratings chart
      new Chart(document.getElementById('scenarioRatingsChart'), {
        type: 'bar',
        data: {
          labels: ${JSON.stringify(Object.values(TestScenario))},
          datasets: [{
            label: 'Average Rating (1-5)',
            data: [
              ${Object.values(TestScenario).map(scenario => 
                results.scenarioPerformance[scenario].count > 0 
                  ? results.scenarioPerformance[scenario].averageRating.toFixed(1)
                  : 0
              ).join(', ')}
            ],
            backgroundColor: '#00ADB5'
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            y: {
              beginAtZero: true,
              max: 5,
              title: {
                display: true,
                text: 'Average Rating'
              }
            }
          }
        }
      });
    });
  </script>
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
    logger.info('Starting SuperCode UAT session');
    
    // Check if we should load existing sessions or create a new one
    let sessions: UATSession[] = [];
    const sessionsPath = path.join(__dirname, '../reports/uat-sessions.json');
    
    // Load existing sessions if available
    if (fs.existsSync(sessionsPath)) {
      try {
        const data = fs.readFileSync(sessionsPath, 'utf-8');
        sessions = JSON.parse(data);
        logger.info(`Loaded ${sessions.length} existing UAT sessions`);
      } catch (error) {
        logger.error('Error loading existing sessions:', error);
      }
    }
    
    // Conduct a new UAT session
    const session = await conductUATSession();
    sessions.push(session);
    
    // Save all sessions
    fs.mkdirSync(path.dirname(sessionsPath), { recursive: true });
    fs.writeFileSync(sessionsPath, JSON.stringify(sessions, null, 2));
    logger.info(`Saved ${sessions.length} UAT sessions to ${sessionsPath}`);
    
    // Analyze results and generate report
    const results = analyzeUATResults(sessions);
    
    // Save results
    const resultsPath = path.join(__dirname, '../reports/uat-results.json');
    fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2));
    logger.info(`Saved UAT results to ${resultsPath}`);
    
    // Generate HTML report
    const report = generateHTMLReport(results);
    const reportPath = path.join(__dirname, '../reports/uat-report.html');
    fs.writeFileSync(reportPath, report);
    logger.info(`Generated UAT report at ${reportPath}`);
    
    console.log(`\nUAT session completed. Report available at ${reportPath}`);
  } catch (error) {
    logger.error('Error in UAT process:', error);
    console.log('An error occurred during the UAT process.');
  }
}

// Start the UAT process
main(); 
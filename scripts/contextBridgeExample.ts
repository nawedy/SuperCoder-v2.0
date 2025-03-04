/**
 * SuperCode AI Platform - Enhanced Context Bridge Example
 * 
 * This script demonstrates the usage of the enhanced context bridge
 * with its advanced features including caching, dependency analysis,
 * file chunking, and task-specific context optimization.
 */

import { getContextManager, initializeContextManager } from '../src/context/contextManager.js';
import { TaskType } from '../src/ensemble/types.js';
import * as path from 'path';

// Main function to demonstrate the enhanced context bridge
async function demonstrateEnhancedContextBridge() {
  console.log('Enhanced Context Bridge Example\n');
  
  // Initialize context manager with specific configuration
  const contextManager = initializeContextManager({
    projectRoot: path.resolve(__dirname, '..'),
    maxFilesPerTask: 15,
    embeddingsEnabled: true,
    includeTests: true,
    maxChunkSize: 300,
    includeImports: true,
    considerFileHistory: true
  });
  
  // Example 1: Get context for code generation task
  console.log('Example 1: Code Generation Context');
  const codeGenContext = await contextManager.getContext(
    TaskType.GENERATE_CODE,
    'Create a service to handle authentication with JWT',
    {
      includePaths: ['src/security', 'src/core'],
      excludePaths: ['node_modules', 'dist'],
      fileTypes: ['ts', 'js']
    }
  );
  
  console.log(`Got ${codeGenContext.codebase?.files?.length} files for code generation task`);
  console.log('Files included:');
  codeGenContext.codebase?.files?.forEach(file => {
    console.log(`- ${file.path} (${file.content.length} bytes)`);
  });
  console.log();
  
  // Example 2: Get context for security analysis task
  console.log('Example 2: Security Analysis Context');
  const securityContext = await contextManager.getContext(
    TaskType.DETECT_VULNERABILITIES,
    'Check for SQL injection and XSS vulnerabilities',
    {
      semanticThreshold: 0.7,
      includeDocs: false
    }
  );
  
  console.log(`Got ${securityContext.codebase?.files?.length} files for security analysis task`);
  console.log('Files included:');
  securityContext.codebase?.files?.forEach(file => {
    console.log(`- ${file.path} (${file.content.length} bytes)`);
  });
  console.log();
  
  // Example 3: Get context for refactoring task with dependency analysis
  console.log('Example 3: Refactoring Context with Dependencies');
  const refactoringContext = await contextManager.getContext(
    TaskType.REFACTOR_CODE,
    'Refactor the logging module for better performance',
    {
      includePaths: ['src/core'],
      includeImports: true
    }
  );
  
  console.log(`Got ${refactoringContext.codebase?.files?.length} files for refactoring task`);
  console.log('Files included:');
  refactoringContext.codebase?.files?.forEach(file => {
    console.log(`- ${file.path} (${file.content.length} bytes)`);
  });
  console.log();
  
  // Example 4: Generate a prompt for code generation
  console.log('Example 4: Generate Prompt for Code Generation');
  const prompt = await contextManager.generatePrompt(
    TaskType.GENERATE_CODE,
    'Create a data access layer for user management',
    'code-generation-default',
    {
      language: 'typescript',
      framework: 'express'
    }
  );
  
  console.log(`Generated prompt with ${prompt.length} characters`);
  console.log('Prompt excerpt:');
  console.log(prompt.substring(0, 500) + '...');
  console.log();
  
  // Example 5: Demonstrate caching
  console.log('Example 5: Demonstrating Caching');
  console.time('First request');
  await contextManager.getContext(
    TaskType.ANALYZE_CODE,
    'Analyze performance bottlenecks in the API layer',
    {
      includePaths: ['src/api'],
      maxFiles: 5
    }
  );
  console.timeEnd('First request');
  
  console.time('Cached request (should be faster)');
  await contextManager.getContext(
    TaskType.ANALYZE_CODE,
    'Analyze performance bottlenecks in the API layer',
    {
      includePaths: ['src/api'],
      maxFiles: 5
    }
  );
  console.timeEnd('Cached request (should be faster)');
  console.log();
  
  // Example 6: Clear cache and update dependency graph
  console.log('Example 6: Clearing Cache and Updating Dependency Graph');
  contextManager.clearCache();
  console.log('Cache cleared');
  
  await contextManager.updateDependencyGraph();
  console.log('Dependency graph updated');
  console.log();
  
  // Example 7: Chunking large files
  console.log('Example 7: Handling Large Files with Chunking');
  const largeFileContext = await contextManager.getContext(
    TaskType.DOCUMENT_CODE,
    'Document the main application entry point',
    {
      includePaths: ['src/main.ts'],
      maxChunkSize: 50 // Small chunk size for demonstration
    }
  );
  
  console.log(`Got ${largeFileContext.codebase?.files?.length} chunks for large file handling`);
  console.log('Chunks:');
  largeFileContext.codebase?.files?.forEach(file => {
    console.log(`- ${file.path} (${file.content.split('\n').length} lines)`);
  });
  
  console.log('\nEnhanced Context Bridge demonstration complete!');
}

// Execute the demonstration
demonstrateEnhancedContextBridge().catch(error => {
  console.error('Error demonstrating enhanced context bridge:', error);
  process.exit(1);
}); 
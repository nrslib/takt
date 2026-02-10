/**
 * Claude module public API
 *
 * This file exports all public types, functions, and classes
 * from the Claude integration module.
 */

// Classes
export { ClaudeClient } from './client.js';
export { ClaudeProcess } from './process.js';
export { QueryExecutor } from './executor.js';
export { QueryRegistry } from './query-manager.js';
export { SdkOptionsBuilder } from './options-builder.js';

// Main process and execution
export { executeClaudeCli } from './process.js';
export { executeClaudeQuery } from './executor.js';

// Query management
export {
  generateQueryId,
  hasActiveProcess,
  isQueryActive,
  getActiveQueryCount,
  registerQuery,
  unregisterQuery,
  interruptQuery,
  interruptAllQueries,
  interruptCurrentProcess,
} from './query-manager.js';

// Types
export type {
  StreamEvent,
  StreamCallback,
  PermissionRequest,
  PermissionHandler,
  AskUserQuestionInput,
  AskUserQuestionHandler,
  ClaudeResult,
  ClaudeResultWithQueryId,
  ClaudeCallOptions,
  ClaudeSpawnOptions,
  InitEventData,
  ToolUseEventData,
  ToolResultEventData,
  ToolOutputEventData,
  TextEventData,
  ThinkingEventData,
  ResultEventData,
  ErrorEventData,
} from './types.js';

// Stream conversion
export { sdkMessageToStreamEvent } from './stream-converter.js';

// Options building
export {
  createCanUseToolCallback,
  createAskUserQuestionHooks,
  buildSdkOptions,
} from './options-builder.js';

// Client functions
export {
  callClaude,
  callClaudeCustom,
  callClaudeAgent,
  callClaudeSkill,
  detectRuleIndex,
  isRegexSafe,
} from './client.js';


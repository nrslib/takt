/**
 * Claude Agent SDK wrapper
 *
 * Uses @anthropic-ai/claude-agent-sdk for native TypeScript integration
 * instead of spawning CLI processes.
 */

import {
  hasActiveProcess,
  interruptCurrentProcess,
} from './query-manager.js';
import { executeClaudeQuery } from './executor.js';
import type {
  ClaudeSpawnOptions,
  ClaudeResult,
} from './types.js';

export type {
  StreamEvent,
  StreamCallback,
  PermissionRequest,
  PermissionHandler,
  AskUserQuestionInput,
  AskUserQuestionHandler,
  ClaudeResult,
  ClaudeResultWithQueryId,
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

// Re-export query management functions
export {
  generateQueryId,
  hasActiveProcess,
  isQueryActive,
  getActiveQueryCount,
  interruptQuery,
  interruptAllQueries,
  interruptCurrentProcess,
} from './query-manager.js';

/**
 * Execute a Claude query using the Agent SDK.
 * Supports concurrent execution with query ID tracking.
 */
export async function executeClaudeCli(
  prompt: string,
  options: ClaudeSpawnOptions,
): Promise<ClaudeResult> {
  return executeClaudeQuery(prompt, options);
}

/**
 * ClaudeProcess class wrapping the SDK query function.
 * Wraps the SDK query function.
 */
export class ClaudeProcess {
  private options: ClaudeSpawnOptions;
  private currentSessionId?: string;

  constructor(options: ClaudeSpawnOptions) {
    this.options = options;
  }

  /** Execute a prompt */
  async execute(prompt: string): Promise<ClaudeResult> {
    const result = await executeClaudeCli(prompt, this.options);
    this.currentSessionId = result.sessionId;
    return result;
  }

  /** Interrupt the running query */
  kill(): void {
    interruptCurrentProcess();
  }

  /** Check if a query is running */
  isRunning(): boolean {
    return hasActiveProcess();
  }

  /** Get session ID */
  getSessionId(): string | undefined {
    return this.currentSessionId;
  }
}

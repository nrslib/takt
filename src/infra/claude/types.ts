/**
 * Type definitions for Claude SDK integration
 *
 * Contains stream event types, callback types, and result types
 * used throughout the Claude integration layer.
 */

import type { PermissionUpdate, AgentDefinition, SandboxSettings } from '@anthropic-ai/claude-agent-sdk';
import type { PermissionMode, McpServerConfig } from '../../core/models/index.js';

export type { SandboxSettings };
import type { PermissionResult } from '../../core/piece/index.js';

// Re-export PermissionResult for convenience
export type { PermissionResult, PermissionUpdate };

/** Stream event data types */
export interface InitEventData {
  model: string;
  sessionId: string;
}

export interface ToolUseEventData {
  tool: string;
  input: Record<string, unknown>;
  id: string;
}

export interface ToolResultEventData {
  content: string;
  isError: boolean;
}

export interface ToolOutputEventData {
  tool: string;
  output: string;
}

export interface TextEventData {
  text: string;
}

export interface ThinkingEventData {
  thinking: string;
}

export interface ResultEventData {
  result: string;
  sessionId: string;
  success: boolean;
  error?: string;
}

export interface ErrorEventData {
  message: string;
  raw?: string;
}

/** Stream event (discriminated union) */
export type StreamEvent =
  | { type: 'init'; data: InitEventData }
  | { type: 'tool_use'; data: ToolUseEventData }
  | { type: 'tool_result'; data: ToolResultEventData }
  | { type: 'tool_output'; data: ToolOutputEventData }
  | { type: 'text'; data: TextEventData }
  | { type: 'thinking'; data: ThinkingEventData }
  | { type: 'result'; data: ResultEventData }
  | { type: 'error'; data: ErrorEventData };

/** Callback for streaming events */
export type StreamCallback = (event: StreamEvent) => void;

/** Permission request info passed to handler */
export interface PermissionRequest {
  toolName: string;
  input: Record<string, unknown>;
  suggestions?: PermissionUpdate[];
  blockedPath?: string;
  decisionReason?: string;
}

/** Permission handler callback type */
export type PermissionHandler = (
  request: PermissionRequest
) => Promise<PermissionResult>;

/** AskUserQuestion tool input */
export interface AskUserQuestionInput {
  questions: Array<{
    question: string;
    header?: string;
    options?: Array<{
      label: string;
      description?: string;
    }>;
    multiSelect?: boolean;
  }>;
}

/** AskUserQuestion handler callback type */
export type AskUserQuestionHandler = (
  input: AskUserQuestionInput
) => Promise<Record<string, string>>;

/** Result from Claude execution */
export interface ClaudeResult {
  success: boolean;
  content: string;
  sessionId?: string;
  error?: string;
  interrupted?: boolean;
  /** All assistant text accumulated during execution (for status detection) */
  fullContent?: string;
  /** Structured output returned by Claude SDK */
  structuredOutput?: Record<string, unknown>;
}

/** Extended result with query ID for concurrent execution */
export interface ClaudeResultWithQueryId extends ClaudeResult {
  queryId: string;
}

/** Options for calling Claude (high-level, used by client/providers/agents) */
export interface ClaudeCallOptions {
  cwd: string;
  abortSignal?: AbortSignal;
  sessionId?: string;
  allowedTools?: string[];
  /** MCP servers configuration */
  mcpServers?: Record<string, McpServerConfig>;
  model?: string;
  maxTurns?: number;
  systemPrompt?: string;
  /** SDK agents to register for sub-agent execution */
  agents?: Record<string, AgentDefinition>;
  /** Permission mode for tool execution (from piece step) */
  permissionMode?: PermissionMode;
  /** Enable streaming mode with callback for real-time output */
  onStream?: StreamCallback;
  /** Custom permission handler for interactive permission prompts */
  onPermissionRequest?: PermissionHandler;
  /** Custom handler for AskUserQuestion tool */
  onAskUserQuestion?: AskUserQuestionHandler;
  /** Bypass all permission checks (sacrifice-my-pc mode) */
  bypassPermissions?: boolean;
  /** Anthropic API key to inject via env (bypasses CLI auth) */
  anthropicApiKey?: string;
  /** JSON Schema for structured output */
  outputSchema?: Record<string, unknown>;
  /** Sandbox settings for Claude SDK */
  sandbox?: SandboxSettings;
}

/** Options for spawning a Claude SDK query (low-level, used by executor/process) */
export interface ClaudeSpawnOptions {
  cwd: string;
  abortSignal?: AbortSignal;
  sessionId?: string;
  allowedTools?: string[];
  /** MCP servers configuration */
  mcpServers?: Record<string, McpServerConfig>;
  model?: string;
  maxTurns?: number;
  systemPrompt?: string;
  /** Enable streaming mode with callback */
  onStream?: StreamCallback;
  /** Custom agents to register */
  agents?: Record<string, AgentDefinition>;
  /** Permission mode for tool execution (TAKT abstract value, mapped to SDK value in SdkOptionsBuilder) */
  permissionMode?: PermissionMode;
  /** Custom permission handler for interactive permission prompts */
  onPermissionRequest?: PermissionHandler;
  /** Custom handler for AskUserQuestion tool */
  onAskUserQuestion?: AskUserQuestionHandler;
  /** Bypass all permission checks (sacrifice-my-pc mode) */
  bypassPermissions?: boolean;
  /** Anthropic API key to inject via env (bypasses CLI auth) */
  anthropicApiKey?: string;
  /** JSON Schema for structured output */
  outputSchema?: Record<string, unknown>;
  /** Callback for stderr output from the Claude Code process */
  onStderr?: (data: string) => void;
  /** Sandbox settings for Claude SDK */
  sandbox?: SandboxSettings;
}

/**
 * Type definitions for Claude SDK integration
 *
 * Contains stream event types, callback types, and result types
 * used throughout the Claude integration layer.
 */

import type { PermissionUpdate, AgentDefinition, SandboxSettings } from '@anthropic-ai/claude-agent-sdk';
import type { PermissionMode, McpServerConfig } from '../../core/models/index.js';
import type { ClaudeEffort } from '../../core/models/workflow-types.js';
import type { AgentErrorKind, ProviderUsageSnapshot } from '../../core/models/response.js';
import type {
  StreamEvent as SharedStreamEvent,
  StreamCallback as SharedStreamCallback,
  StreamInitEventData as SharedInitEventData,
  StreamToolUseEventData as SharedToolUseEventData,
  StreamToolResultEventData as SharedToolResultEventData,
  StreamToolOutputEventData as SharedToolOutputEventData,
  StreamTextEventData as SharedTextEventData,
  StreamThinkingEventData as SharedThinkingEventData,
  StreamResultEventData as SharedResultEventData,
  StreamErrorEventData as SharedErrorEventData,
  StreamAssistantErrorEventData as SharedAssistantErrorEventData,
  StreamRateLimitEventData as SharedRateLimitEventData,
} from '../../shared/types/provider.js';

export type { SandboxSettings };
import type { PermissionResult } from '../../core/workflow/index.js';

// Re-export PermissionResult for convenience
export type { PermissionResult, PermissionUpdate };

export type InitEventData = SharedInitEventData;
export type ToolUseEventData = SharedToolUseEventData;
export type ToolResultEventData = SharedToolResultEventData;
export type ToolOutputEventData = SharedToolOutputEventData;
export type TextEventData = SharedTextEventData;
export type ThinkingEventData = SharedThinkingEventData;
export type ResultEventData = SharedResultEventData;
export type ErrorEventData = SharedErrorEventData;
export type AssistantErrorEventData = SharedAssistantErrorEventData;
export type RateLimitEventData = SharedRateLimitEventData;
export type StreamEvent = SharedStreamEvent;
export type StreamCallback = SharedStreamCallback;

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
  errorKind?: AgentErrorKind;
  interrupted?: boolean;
  /** All assistant text accumulated during execution (for status detection) */
  fullContent?: string;
  /** Structured output returned by Claude SDK */
  structuredOutput?: Record<string, unknown>;
  /** Provider-native usage payload normalized for TAKT observability */
  providerUsage?: ProviderUsageSnapshot;
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
  effort?: ClaudeEffort;
  maxTurns?: number;
  systemPrompt?: string;
  /** SDK agents to register for sub-agent execution */
  agents?: Record<string, AgentDefinition>;
  /** Permission mode for tool execution (from workflow step) */
  permissionMode?: PermissionMode;
  /** Enable streaming mode with callback for real-time output */
  onStream?: StreamCallback;
  /** Custom permission handler for interactive permission prompts */
  onPermissionRequest?: PermissionHandler;
  /** Custom handler for AskUserQuestion tool */
  onAskUserQuestion?: AskUserQuestionHandler;
  /** Bypass all permission checks */
  bypassPermissions?: boolean;
  /** Anthropic API key to inject via env (bypasses CLI auth) */
  anthropicApiKey?: string;
  /** JSON Schema for structured output */
  outputSchema?: Record<string, unknown>;
  /** Sandbox settings for Claude SDK */
  sandbox?: SandboxSettings;
  /** Custom path to Claude Code executable */
  pathToClaudeCodeExecutable?: string;
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
  effort?: ClaudeEffort;
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
  /** Bypass all permission checks */
  bypassPermissions?: boolean;
  /** Anthropic API key to inject via env (bypasses CLI auth) */
  anthropicApiKey?: string;
  /** JSON Schema for structured output */
  outputSchema?: Record<string, unknown>;
  /** Callback for stderr output from the Claude Code process */
  onStderr?: (data: string) => void;
  /** Sandbox settings for Claude SDK */
  sandbox?: SandboxSettings;
  /** Custom path to Claude Code executable */
  pathToClaudeCodeExecutable?: string;
}

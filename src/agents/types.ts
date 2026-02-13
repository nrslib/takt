/**
 * Type definitions for agent execution
 */

import type { StreamCallback, PermissionHandler, AskUserQuestionHandler } from '../infra/claude/types.js';
import type { PermissionMode, Language, McpServerConfig, MovementProviderOptions } from '../core/models/index.js';

export type { StreamCallback };

/** Common options for running agents */
export interface RunAgentOptions {
  cwd: string;
  abortSignal?: AbortSignal;
  sessionId?: string;
  model?: string;
  provider?: 'claude' | 'codex' | 'opencode' | 'mock';
  /** Resolved path to persona prompt file */
  personaPath?: string;
  /** Allowed tools for this agent run */
  allowedTools?: string[];
  /** MCP servers for this agent run */
  mcpServers?: Record<string, McpServerConfig>;
  /** Maximum number of agentic turns */
  maxTurns?: number;
  /** Permission mode for tool execution (from piece step) */
  permissionMode?: PermissionMode;
  /** Provider-specific movement options */
  providerOptions?: MovementProviderOptions;
  onStream?: StreamCallback;
  onPermissionRequest?: PermissionHandler;
  onAskUserQuestion?: AskUserQuestionHandler;
  /** Bypass all permission checks (sacrifice-my-pc mode) */
  bypassPermissions?: boolean;
  /** Language for template resolution */
  language?: Language;
  /** Piece meta information for system prompt template */
  pieceMeta?: {
    pieceName: string;
    pieceDescription?: string;
    currentMovement: string;
    movementsList: ReadonlyArray<{ name: string; description?: string }>;
    currentPosition: string;
  };
  /** JSON Schema for structured output */
  outputSchema?: Record<string, unknown>;
}

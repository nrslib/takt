/**
 * Type definitions for agent execution
 */

import type { StreamCallback, PermissionHandler, AskUserQuestionHandler } from '../infra/claude/index.js';
import type { PermissionMode, Language } from '../core/models/index.js';

export type { StreamCallback };

/** Common options for running agents */
export interface RunAgentOptions {
  cwd: string;
  sessionId?: string;
  model?: string;
  provider?: 'claude' | 'codex' | 'mock';
  /** Resolved path to agent prompt file */
  agentPath?: string;
  /** Allowed tools for this agent run */
  allowedTools?: string[];
  /** Maximum number of agentic turns */
  maxTurns?: number;
  /** Permission mode for tool execution (from piece step) */
  permissionMode?: PermissionMode;
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
}

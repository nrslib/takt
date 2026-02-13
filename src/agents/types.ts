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
  stepModel?: string;
  stepProvider?: 'claude' | 'codex' | 'opencode' | 'mock';
  personaPath?: string;
  allowedTools?: string[];
  mcpServers?: Record<string, McpServerConfig>;
  maxTurns?: number;
  permissionMode?: PermissionMode;
  providerOptions?: MovementProviderOptions;
  onStream?: StreamCallback;
  onPermissionRequest?: PermissionHandler;
  onAskUserQuestion?: AskUserQuestionHandler;
  bypassPermissions?: boolean;
  language?: Language;
  pieceMeta?: {
    pieceName: string;
    pieceDescription?: string;
    currentMovement: string;
    movementsList: ReadonlyArray<{ name: string; description?: string }>;
    currentPosition: string;
  };
  outputSchema?: Record<string, unknown>;
}

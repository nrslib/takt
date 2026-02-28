/**
 * Type definitions for Cursor Agent CLI integration
 */

import type { StreamCallback } from '../claude/index.js';
import type { PermissionMode } from '../../core/models/index.js';

/** Options for calling Cursor Agent CLI */
export interface CursorCallOptions {
  cwd: string;
  abortSignal?: AbortSignal;
  sessionId?: string;
  model?: string;
  systemPrompt?: string;
  permissionMode?: PermissionMode;
  onStream?: StreamCallback;
  cursorApiKey?: string;
  /** Custom path to cursor-agent executable */
  cursorCliPath?: string;
}

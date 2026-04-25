/**
 * Type definitions for Cursor Agent CLI integration
 */

import type { PermissionMode } from '../../core/models/index.js';
import type { StreamCallback } from '../../shared/types/provider.js';

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

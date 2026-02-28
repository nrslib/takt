/**
 * Type definitions for GitHub Copilot CLI integration
 */

import type { StreamCallback } from '../claude/index.js';
import type { PermissionMode } from '../../core/models/index.js';

/** Options for calling GitHub Copilot CLI */
export interface CopilotCallOptions {
  cwd: string;
  abortSignal?: AbortSignal;
  sessionId?: string;
  model?: string;
  systemPrompt?: string;
  permissionMode?: PermissionMode;
  onStream?: StreamCallback;
  /** GitHub token for Copilot authentication */
  copilotGithubToken?: string;
  /** Custom path to copilot executable */
  copilotCliPath?: string;
}

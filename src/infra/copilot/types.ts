/**
 * Type definitions for GitHub Copilot CLI integration
 */

import type { CopilotEffort } from '../../core/models/workflow-types.js';
import type { PermissionMode } from '../../core/models/index.js';
import type { StreamCallback } from '../../shared/types/provider.js';

/** Options for calling GitHub Copilot CLI */
export interface CopilotCallOptions {
  cwd: string;
  abortSignal?: AbortSignal;
  sessionId?: string;
  model?: string;
  effort?: CopilotEffort;
  systemPrompt?: string;
  permissionMode?: PermissionMode;
  onStream?: StreamCallback;
  /** GitHub token for Copilot authentication */
  copilotGithubToken?: string;
  /** Custom path to copilot executable */
  copilotCliPath?: string;
}

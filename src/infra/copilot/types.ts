/**
 * Type definitions for GitHub Copilot CLI integration
 */

import type { PermissionMode } from '../../core/models/index.js';
import type { InternalAgentIsolation, ProviderActivityCallback, StreamCallback } from '../../shared/types/provider.js';

/** Options for calling GitHub Copilot CLI */
export interface CopilotCallOptions {
  cwd: string;
  abortSignal?: AbortSignal;
  sessionId?: string;
  model?: string;
  effort?: string;
  systemPrompt?: string;
  permissionMode?: PermissionMode;
  internalAgentIsolation?: InternalAgentIsolation;
  onStream?: StreamCallback;
  onActivity?: ProviderActivityCallback;
  /** GitHub token for Copilot authentication */
  copilotGithubToken?: string;
  /** Custom path to copilot executable */
  copilotCliPath?: string;
  childProcessEnv?: Readonly<Record<string, string>>;
  /** Provider-prepared MCP material (issue #1137). */
  preparedMcp?: import('../providers/mcp/types.js').PreparedProviderMcp;
}

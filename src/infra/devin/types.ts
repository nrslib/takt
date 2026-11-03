import type { PermissionMode } from '../../core/models/index.js';
import type { ProviderActivityCallback, StreamCallback } from '../../shared/types/provider.js';
import type { InternalAgentIsolation } from '../../shared/types/provider.js';

export interface DevinCallOptions {
  cwd: string;
  abortSignal?: AbortSignal;
  sessionId?: string;
  model?: string;
  systemPrompt?: string;
  permissionMode?: PermissionMode;
  internalAgentIsolation?: InternalAgentIsolation;
  onStream?: StreamCallback;
  onActivity?: ProviderActivityCallback;
  devinCliPath?: string;
  childProcessEnv?: Readonly<Record<string, string>>;
  /** Provider-prepared MCP material (issue #1137). */
  preparedMcp?: import('../providers/mcp/types.js').PreparedProviderMcp;
}

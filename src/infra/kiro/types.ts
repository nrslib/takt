import type { PermissionMode } from '../../core/models/index.js';
import type { ProviderActivityCallback, StreamCallback } from '../../shared/types/provider.js';

export interface KiroCallOptions {
  cwd: string;
  abortSignal?: AbortSignal;
  sessionId?: string;
  model?: string;
  systemPrompt?: string;
  permissionMode?: PermissionMode;
  onStream?: StreamCallback;
  onActivity?: ProviderActivityCallback;
  kiroApiKey?: string;
  kiroCliPath?: string;
  agent?: string;
  childProcessEnv?: Readonly<Record<string, string>>;
  /** Provider-prepared MCP material (issue #1137). */
  preparedMcp?: import('../providers/mcp/types.js').PreparedProviderMcp;
}

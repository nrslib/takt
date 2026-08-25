import type { McpServerConfig, PermissionMode } from '../../core/models/index.js';
import type { ClaudeSandboxSettings } from '../../core/models/workflow-types.js';
import type {
  InternalAgentIsolation,
  ProviderActivityCallback,
  StreamCallback,
} from '../../shared/types/provider.js';

export interface ClaudeHeadlessCallOptions {
  cwd: string;
  abortSignal?: AbortSignal;
  sessionId?: string;
  internalAgentIsolation?: InternalAgentIsolation;
  model?: string;
  anthropicApiKey?: string;
  /** Anthropic-compatible API base URL */
  baseUrl?: string;
  effort?: string;
  skillsEnabled?: boolean;
  allowedTools?: string[];
  mcpServers?: Record<string, McpServerConfig>;
  /** Provider-prepared MCP material (issue #1137). */
  preparedMcp?: import('../providers/mcp/types.js').PreparedProviderMcp;
  permissionMode?: PermissionMode;
  bypassPermissions?: boolean;
  sandbox?: ClaudeSandboxSettings;
  onStream?: StreamCallback;
  onActivity?: ProviderActivityCallback;
  claudeCliPath?: string;
  systemPrompt?: string;
  outputSchema?: Record<string, unknown>;
  childProcessEnv?: Readonly<Record<string, string>>;
}

import type { McpServerConfig, PermissionMode } from '../../core/models/index.js';
import type { ClaudeEffort, ClaudeSandboxSettings } from '../../core/models/workflow-types.js';
import type { InternalAgentIsolation, StreamCallback } from '../../shared/types/provider.js';

export interface ClaudeHeadlessCallOptions {
  cwd: string;
  abortSignal?: AbortSignal;
  sessionId?: string;
  internalAgentIsolation?: InternalAgentIsolation;
  model?: string;
  anthropicApiKey?: string;
  /** Anthropic-compatible API base URL */
  baseUrl?: string;
  effort?: ClaudeEffort;
  skillsEnabled?: boolean;
  allowedTools?: string[];
  mcpServers?: Record<string, McpServerConfig>;
  permissionMode?: PermissionMode;
  bypassPermissions?: boolean;
  sandbox?: ClaudeSandboxSettings;
  onStream?: StreamCallback;
  claudeCliPath?: string;
  systemPrompt?: string;
  outputSchema?: Record<string, unknown>;
  childProcessEnv?: Readonly<Record<string, string>>;
}

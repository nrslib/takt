import type { McpServerConfig, PermissionMode } from '../../core/models/index.js';
import type { ClaudeEffort, ClaudeSandboxSettings } from '../../core/models/workflow-types.js';
import type { StreamCallback } from '../../shared/types/provider.js';

export interface ClaudeHeadlessCallOptions {
  cwd: string;
  abortSignal?: AbortSignal;
  sessionId?: string;
  model?: string;
  anthropicApiKey?: string;
  effort?: ClaudeEffort;
  allowedTools?: string[];
  mcpServers?: Record<string, McpServerConfig>;
  permissionMode?: PermissionMode;
  bypassPermissions?: boolean;
  sandbox?: ClaudeSandboxSettings;
  onStream?: StreamCallback;
  claudeCliPath?: string;
  systemPrompt?: string;
  outputSchema?: Record<string, unknown>;
}

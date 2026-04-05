import type { StreamCallback, PermissionHandler, AskUserQuestionHandler } from '../claude/index.js';
import type { AgentResponse, PermissionMode, McpServerConfig, MovementProviderOptions } from '../../core/models/index.js';
import type { ProviderType as SharedProviderType } from '../../shared/types/provider.js';

export interface AgentSetup {
  name: string;
  systemPrompt?: string;
}

export interface ProviderCallOptions {
  cwd: string;
  abortSignal?: AbortSignal;
  sessionId?: string;
  model?: string;
  allowedTools?: string[];
  mcpServers?: Record<string, McpServerConfig>;
  maxTurns?: number;
  permissionMode?: PermissionMode;
  providerOptions?: MovementProviderOptions;
  onStream?: StreamCallback;
  onPermissionRequest?: PermissionHandler;
  onAskUserQuestion?: AskUserQuestionHandler;
  bypassPermissions?: boolean;
  anthropicApiKey?: string;
  openaiApiKey?: string;
  opencodeApiKey?: string;
  cursorApiKey?: string;
  copilotGithubToken?: string;
  outputSchema?: Record<string, unknown>;
}

export interface ProviderAgent {
  call(prompt: string, options: ProviderCallOptions): Promise<AgentResponse>;
}

export interface Provider {
  supportsStructuredOutput: boolean;
  setup(config: AgentSetup): ProviderAgent;
}

export type ProviderType = SharedProviderType;

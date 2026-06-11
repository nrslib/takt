import type { AgentResponse, PermissionMode, McpServerConfig, StepProviderOptions } from '../../core/models/index.js';
import type { ProviderType as SharedProviderType } from '../../shared/types/provider.js';
import type { StreamCallback } from '../../shared/types/provider.js';
import type { PermissionHandler, AskUserQuestionHandler } from '../../core/workflow/types.js';

export interface AgentSetup {
  name: string;
  systemPrompt?: string;
}

export interface ProviderImageAttachment {
  placeholder: string;
  path: string;
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
  providerOptions?: StepProviderOptions;
  onStream?: StreamCallback;
  onPermissionRequest?: PermissionHandler;
  onAskUserQuestion?: AskUserQuestionHandler;
  bypassPermissions?: boolean;
  anthropicApiKey?: string;
  openaiApiKey?: string;
  opencodeApiKey?: string;
  cursorApiKey?: string;
  copilotGithubToken?: string;
  kiroApiKey?: string;
  outputSchema?: Record<string, unknown>;
  imageAttachments?: ProviderImageAttachment[];
}

export interface ProviderAgent {
  call(prompt: string, options: ProviderCallOptions): Promise<AgentResponse>;
}

export interface Provider {
  supportsStructuredOutput: boolean;
  supportsNativeImageInput: boolean;
  getRuntimeInstructions(): string | null;
  keepsAllowedToolWithoutEdit(tool: string): boolean;
  setup(config: AgentSetup): ProviderAgent;
}

export type ProviderType = SharedProviderType;

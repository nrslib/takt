import type { AgentResponse, Language, PermissionMode, McpServerConfig, StepProviderOptions } from '../../core/models/index.js';
import type { ProviderType as SharedProviderType } from '../../shared/types/provider.js';
import type { InternalAgentIsolation, StreamCallback } from '../../shared/types/provider.js';
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
  internalAgentIsolation?: InternalAgentIsolation;
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
  language?: Language;
  imageAttachments?: ProviderImageAttachment[];
  /** Directory for full Codex failure text; when omitted, oversized failures are truncated without persistence. */
  failureDir?: string;
  childProcessEnv?: Readonly<Record<string, string>>;
}

export interface ProviderCompactSessionOptions {
  cwd: string;
  sessionId: string;
  model?: string;
  abortSignal?: AbortSignal;
  childProcessEnv?: Readonly<Record<string, string>>;
}

export interface ProviderAgent {
  call(prompt: string, options: ProviderCallOptions): Promise<AgentResponse>;
}

export interface Provider {
  supportsStructuredOutput: boolean;
  /** Pre-check flag for isolated structured execution; the implementation itself lives in setupIsolatedStructured. */
  supportsIsolatedStructuredExecution: boolean;
  supportsNativeImageInput: boolean;
  supportsStrictInternalAgentIsolation: boolean;
  getRuntimeInstructions(allowedTools?: string[], permissionMode?: import('../../core/models/index.js').PermissionMode, networkAccess?: boolean): string | null;
  keepsAllowedToolWithoutEdit(tool: string): boolean;
  getDefaultAllowedToolsWithoutEdit?(): readonly string[];
  setup(config: AgentSetup): ProviderAgent;
  setupIsolatedStructured(config: AgentSetup): ProviderAgent;
  compactSession?(options: ProviderCompactSessionOptions): Promise<void>;
}

export type ProviderType = SharedProviderType;

export function assertOutputSchema(
  schema: Record<string, unknown> | undefined,
  provider: string,
): Record<string, unknown> {
  if (schema === undefined) {
    throw new Error(
      `Provider "${provider}" cannot run isolated structured execution without an output schema`,
    );
  }
  return schema;
}

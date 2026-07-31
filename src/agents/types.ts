/**
 * Type definitions for agent execution
 */

import type { StreamCallback, PermissionHandler, AskUserQuestionHandler } from '../infra/claude/types.js';
import type {
  PermissionMode,
  Language,
  McpServerConfig,
  StepProviderOptions,
  ProviderPermissionProfiles,
} from '../core/models/index.js';
import type { InternalAgentIsolation, ProviderType } from '../shared/types/provider.js';
import type { ProviderExecutionProfile } from '../infra/providers/types.js';

export type { StreamCallback };

export interface WorkflowProcessSafetyMeta {
  protectedParentRunPid: number;
}

export interface WorkflowMeta {
  workflowName: string;
  workflowDescription?: string;
  currentStep: string;
  stepsList: ReadonlyArray<{ name: string; description?: string }>;
  currentPosition: string;
  processSafety?: WorkflowProcessSafetyMeta;
}

export interface ResolvedAgentExecution {
  readonly provider: ProviderType;
  readonly model: string | undefined;
  readonly providerOptions: StepProviderOptions;
  readonly permissionMode: PermissionMode;
}

/** Common options for running agents */
export interface RunAgentOptions {
  cwd: string;
  executionProfile?: ProviderExecutionProfile;
  projectCwd?: string;
  abortSignal?: AbortSignal;
  sessionId?: string;
  model?: string;
  provider?: ProviderType;
  resolvedModel?: string;
  resolvedProvider?: ProviderType;
  personaPath?: string;
  internalSystemPrompt?: string;
  internalAgentIsolation?: InternalAgentIsolation;
  allowedTools?: string[];
  mcpServers?: Record<string, McpServerConfig>;
  maxTurns?: number;
  permissionMode?: PermissionMode;
  permissionResolution?: {
    stepName: string;
    requiredPermissionMode?: PermissionMode;
    providerProfiles?: ProviderPermissionProfiles;
  };
  providerOptions?: StepProviderOptions;
  /** Fully resolved provider options; bypasses project/global/persona option inheritance. */
  resolvedProviderOptions?: StepProviderOptions | null;
  resolvedExecution?: ResolvedAgentExecution;
  onStream?: StreamCallback;
  onPermissionRequest?: PermissionHandler;
  onAskUserQuestion?: AskUserQuestionHandler;
  onDispatch?: (permissionMode: PermissionMode | undefined) => void;
  bypassPermissions?: boolean;
  language?: Language;
  workflowMeta?: WorkflowMeta;
  outputSchema?: Record<string, unknown>;
  childProcessEnv?: Readonly<Record<string, string>>;
  onPromptResolved?: (promptParts: {
    systemPrompt: string;
    userInstruction: string;
  }) => void;
}

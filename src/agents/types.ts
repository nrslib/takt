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
import type {
  InternalAgentIsolation,
  ProviderActivityCallback,
  ProviderType,
} from '../shared/types/provider.js';
import type { McpAssignmentSection } from '../infra/config/runtime-provider/mcp-assignment.js';

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
  readonly providerOptions: StepProviderOptions | undefined;
  readonly permissionMode: PermissionMode | undefined;
}

/** Common options for running agents */
export interface RunAgentOptions {
  cwd: string;
  executionProfile?: 'isolated-structured';
  projectCwd?: string;
  abortSignal?: AbortSignal;
  sessionId?: string;
  model?: string;
  provider?: ProviderType;
  resolvedModel?: string;
  resolvedProvider?: ProviderType;
  personaPath?: string;
  workflowBundleResourceRoot?: string;
  internalSystemPrompt?: string;
  internalAgentName?: string;
  internalAgentIsolation?: InternalAgentIsolation;
  allowedTools?: string[];
  mcpServers?: Record<string, McpServerConfig>;
  /**
   * Runtime MCP assignment section (runtime-v1). When set, runtime MCP mode
   * is active and the runner boundary resolves whether to invoke the provider
   * MCP adapter even for an empty server set (e.g. Claude系 providers emit
   * `strictMcpConfig`/`--strict-mcp-config` to suppress ambient MCP config,
   * order.md:160,166,172). When unset, legacy mode applies and an empty
   * server set skips adapter preparation entirely (order.md:152).
   */
  mcpAssignment?: McpAssignmentSection;
  /**
   * Deterministic identity for the resolved MCP server set, computed by
   * `OptionsBuilder` from the runtime MCP assignment. Propagated to the
   * runner so the OpenCode shared server pool keys differ for different
   * server sets, preventing silent server drops (order.md:191-195,269,333).
   * When unset, the runner computes a fallback identity from `mcpServers`.
   */
  mcpServerIdentity?: string;
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
  onActivity?: ProviderActivityCallback;
  onPermissionRequest?: PermissionHandler;
  onAskUserQuestion?: AskUserQuestionHandler;
  onDispatch?: (permissionMode: PermissionMode | undefined) => void;
  bypassPermissions?: boolean;
  language?: Language;
  workflowMeta?: WorkflowMeta;
  outputSchema?: Record<string, unknown>;
  failureDir?: string;
  childProcessEnv?: Readonly<Record<string, string>>;
  onPromptResolved?: (promptParts: {
    systemPrompt: string;
    userInstruction: string;
  }) => void;
}

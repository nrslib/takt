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
import type { ProviderType } from '../shared/types/provider.js';

export type { StreamCallback };

/** Common options for running agents */
export interface RunAgentOptions {
  cwd: string;
  projectCwd?: string;
  abortSignal?: AbortSignal;
  sessionId?: string;
  model?: string;
  provider?: ProviderType;
  resolvedModel?: string;
  resolvedProvider?: ProviderType;
  personaPath?: string;
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
  onStream?: StreamCallback;
  onPermissionRequest?: PermissionHandler;
  onAskUserQuestion?: AskUserQuestionHandler;
  bypassPermissions?: boolean;
  language?: Language;
  workflowMeta?: {
    workflowName: string;
    workflowDescription?: string;
    currentStep: string;
    stepsList: ReadonlyArray<{ name: string; description?: string }>;
    currentPosition: string;
  };
  outputSchema?: Record<string, unknown>;
  onPromptResolved?: (promptParts: {
    systemPrompt: string;
    userInstruction: string;
  }) => void;
}

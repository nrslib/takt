import type { ProviderType } from '../../shared/types/provider.js';

export interface McpStdioServerConfig {
  type?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpSseServerConfig {
  type: 'sse';
  url: string;
  headers?: Record<string, string>;
}

export interface McpHttpServerConfig {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
}

export type McpServerConfig = McpStdioServerConfig | McpSseServerConfig | McpHttpServerConfig;

export interface CodexProviderOptions {
  networkAccess?: boolean;
  reasoningEffort?: CodexReasoningEffort;
}

export interface OpenCodeProviderOptions {
  networkAccess?: boolean;
}

export const RUNTIME_PREPARE_PRESETS = ['gradle', 'node'] as const;
export type RuntimePreparePreset = (typeof RUNTIME_PREPARE_PRESETS)[number];
export const CODEX_REASONING_EFFORT_VALUES = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const;
export type CodexReasoningEffort = (typeof CODEX_REASONING_EFFORT_VALUES)[number];
export const CLAUDE_EFFORT_VALUES = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ClaudeEffort = (typeof CLAUDE_EFFORT_VALUES)[number];
export const COPILOT_EFFORT_VALUES = ['low', 'medium', 'high', 'xhigh'] as const;
export type CopilotEffort = (typeof COPILOT_EFFORT_VALUES)[number];
const RUNTIME_PREPARE_PRESET_SET: ReadonlySet<string> = new Set(RUNTIME_PREPARE_PRESETS);

export function isRuntimePreparePreset(entry: string): entry is RuntimePreparePreset {
  return RUNTIME_PREPARE_PRESET_SET.has(entry);
}

export type RuntimePrepareEntry = RuntimePreparePreset | string;

export interface WorkflowRuntimeConfig {
  prepare?: RuntimePrepareEntry[];
}

export interface ClaudeSandboxSettings {
  allowUnsandboxedCommands?: boolean;
  excludedCommands?: string[];
}

export interface ClaudeProviderOptions {
  allowedTools?: string[];
  effort?: ClaudeEffort;
  sandbox?: ClaudeSandboxSettings;
}

export interface CopilotProviderOptions {
  effort?: CopilotEffort;
}

export interface StepProviderOptions {
  codex?: CodexProviderOptions;
  opencode?: OpenCodeProviderOptions;
  claude?: ClaudeProviderOptions;
  copilot?: CopilotProviderOptions;
}

export type WorkflowStepKind = 'agent' | 'system' | 'workflow_call';

export interface WorkflowCallOverrides {
  provider?: ProviderType;
  model?: string;
  providerOptions?: StepProviderOptions;
}

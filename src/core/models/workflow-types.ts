import type { ProviderType } from '../../shared/types/provider.js';
import type { PermissionMode } from './status.js';
import type { AgentResponse } from './response.js';
import type { InteractiveMode } from './interactive-mode.js';
import type { TeamLeaderConfig } from './part.js';

export interface WorkflowRule {
  condition: string;
  next?: string;
  appendix?: string;
  requiresUserInput?: boolean;
  interactiveOnly?: boolean;
  isAiCondition?: boolean;
  aiConditionText?: string;
  isAggregateCondition?: boolean;
  aggregateType?: 'all' | 'any';
  aggregateConditionText?: string | string[];
}

export interface WorkflowStructuredOutput {
  schemaRef: string;
  schema: Record<string, unknown>;
}

interface WorkflowSystemBinding {
  as: string;
}

export type WorkflowSystemInput =
  | (WorkflowSystemBinding & {
    type: 'task_context';
    source: 'current_task';
  })
  | (WorkflowSystemBinding & {
    type: 'branch_context';
    source: 'current_task';
  })
  | (WorkflowSystemBinding & {
    type: 'pr_context';
    source: 'current_branch';
  })
  | (WorkflowSystemBinding & {
    type: 'issue_context';
    source: 'current_task';
  })
  | (WorkflowSystemBinding & {
    type: 'task_queue_context';
    source: 'current_project';
  });

export interface WorkflowEnqueueIssueConfig {
  create?: boolean;
  labels?: string[];
}

export interface WorkflowEnqueueWorktreeConfig {
  enabled?: boolean;
  auto_pr?: boolean;
  draft_pr?: boolean;
}

type WorkflowContextTemplateReference = `{context:${string}}`;
type WorkflowStructuredTemplateReference = `{structured:${string}}`;
type WorkflowEffectTemplateReference = `{effect:${string}}`;

// The parser/schema enforce the exact DSL shape. Keep the public type broad enough
// that valid nested template paths are not rejected at compile time.
export type WorkflowTemplateReference =
  | WorkflowContextTemplateReference
  | WorkflowStructuredTemplateReference
  | WorkflowEffectTemplateReference;

export type WorkflowEffectScalarReference = WorkflowTemplateReference | number;

export type WorkflowEffect =
  | {
    type: 'enqueue_task';
    mode: 'new' | 'from_pr';
    workflow: string;
    task: string;
    pr?: WorkflowEffectScalarReference;
    issue?: WorkflowEnqueueIssueConfig | WorkflowTemplateReference;
    base_branch?: string;
    worktree?: WorkflowEnqueueWorktreeConfig;
  }
  | {
    type: 'comment_pr';
    pr: WorkflowEffectScalarReference;
    body: string;
  }
  | {
    type: 'sync_with_root';
    pr: WorkflowEffectScalarReference;
  }
  | {
    type: 'resolve_conflicts_with_ai';
    pr: WorkflowEffectScalarReference;
  }
  | {
    type: 'merge_pr';
    pr: WorkflowEffectScalarReference;
  };

export interface OutputContractItem {
  name: string;
  format: string;
  useJudge?: boolean;
  order?: string;
}

export type OutputContractEntry = OutputContractItem;

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
export const CLAUDE_EFFORT_VALUES = ['low', 'medium', 'high', 'max'] as const;
export type ClaudeEffort = (typeof CLAUDE_EFFORT_VALUES)[number];
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

export interface StepProviderOptions {
  codex?: CodexProviderOptions;
  opencode?: OpenCodeProviderOptions;
  claude?: ClaudeProviderOptions;
}

export interface WorkflowStep {
  name: string;
  description?: string;
  mode?: 'agent' | 'system';
  persona?: string;
  session?: 'continue' | 'refresh';
  personaDisplayName: string;
  mcpServers?: Record<string, McpServerConfig>;
  personaPath?: string;
  provider?: ProviderType;
  model?: string;
  requiredPermissionMode?: PermissionMode;
  providerOptions?: StepProviderOptions;
  edit?: boolean;
  instruction: string;
  delayBeforeMs?: number;
  structuredOutput?: WorkflowStructuredOutput;
  systemInputs?: WorkflowSystemInput[];
  effects?: WorkflowEffect[];
  rules?: WorkflowRule[];
  outputContracts?: OutputContractEntry[];
  qualityGates?: string[];
  passPreviousResponse: boolean;
  parallel?: WorkflowStep[];
  concurrency?: number;
  arpeggio?: ArpeggioStepConfig;
  teamLeader?: TeamLeaderConfig;
  policyContents?: string[];
  knowledgeContents?: string[];
}

export interface ArpeggioMergeStepConfig {
  readonly strategy: 'concat' | 'custom';
  readonly separator?: string;
  readonly inlineJs?: string;
  readonly file?: string;
}

export interface ArpeggioStepConfig {
  readonly source: string;
  readonly sourcePath: string;
  readonly batchSize: number;
  readonly concurrency: number;
  readonly templatePath: string;
  readonly merge: ArpeggioMergeStepConfig;
  readonly maxRetries: number;
  readonly retryDelayMs: number;
  readonly outputPath?: string;
}

export interface LoopDetectionConfig {
  maxConsecutiveSameStep?: number;
  action?: 'abort' | 'warn' | 'ignore';
}

export interface LoopMonitorRule {
  condition: string;
  next: string;
}

export interface LoopMonitorJudge {
  persona?: string;
  personaPath?: string;
  provider?: ProviderType;
  model?: string;
  providerOptions?: StepProviderOptions;
  instruction?: string;
  rules: LoopMonitorRule[];
}

export interface LoopMonitorConfig {
  cycle: string[];
  threshold: number;
  judge: LoopMonitorJudge;
}

export interface WorkflowConfig {
  name: string;
  description?: string;
  schemas?: Record<string, string>;
  providerOptions?: StepProviderOptions;
  runtime?: WorkflowRuntimeConfig;
  personas?: Record<string, string>;
  policies?: Record<string, string>;
  knowledge?: Record<string, string>;
  instructions?: Record<string, string>;
  reportFormats?: Record<string, string>;
  steps: WorkflowStep[];
  initialStep: string;
  maxSteps: number;
  loopDetection?: LoopDetectionConfig;
  loopMonitors?: LoopMonitorConfig[];
  interactiveMode?: InteractiveMode;
}

export interface WorkflowState {
  workflowName: string;
  currentStep: string;
  iteration: number;
  stepOutputs: Map<string, AgentResponse>;
  structuredOutputs: Map<string, Record<string, unknown>>;
  systemContexts: Map<string, Record<string, unknown>>;
  effectResults: Map<string, Record<string, unknown>>;
  lastOutput?: AgentResponse;
  previousResponseSourcePath?: string;
  userInputs: string[];
  personaSessions: Map<string, string>;
  stepIterations: Map<string, number>;
  status: 'running' | 'completed' | 'aborted';
}

import type { ProviderType } from '../../shared/types/provider.js';
import type { PermissionMode } from './status.js';
import type { AgentResponse } from './response.js';
import type { InteractiveMode } from './interactive-mode.js';
import type { TeamLeaderConfig } from './part.js';
import type {
  McpServerConfig,
  StepProviderOptions,
  WorkflowCallOverrides,
  WorkflowRuntimeConfig,
  WorkflowStepKind,
} from './workflow-provider-options.js';
import type {
  WorkflowEffect,
  WorkflowSystemInput,
} from './workflow-system-input-types.js';

export type {
  WorkflowPrListWhere,
  WorkflowSystemInput,
  WorkflowEffect,
  WorkflowEnqueueIssueConfig,
  WorkflowEnqueueWorktreeConfig,
  WorkflowTemplateReference,
  WorkflowEffectScalarReference,
} from './workflow-system-input-types.js';
export {
  normalizeWorkflowPrListWhere,
  workflowPrListWhereEquals,
  stringifyWorkflowPrListWhere,
} from './workflow-system-input-types.js';
export type {
  McpServerConfig,
  RuntimePreparePreset,
  RuntimePrepareEntry,
  WorkflowRuntimeConfig,
  CodexReasoningEffort,
  ClaudeEffort,
  CopilotEffort,
  ClaudeSandboxSettings,
  CodexProviderOptions,
  OpenCodeProviderOptions,
  ClaudeProviderOptions,
  CopilotProviderOptions,
  StepProviderOptions,
  WorkflowStepKind,
  WorkflowCallOverrides,
} from './workflow-provider-options.js';
export {
  RUNTIME_PREPARE_PRESETS,
  CODEX_REASONING_EFFORT_VALUES,
  CLAUDE_EFFORT_VALUES,
  COPILOT_EFFORT_VALUES,
  isRuntimePreparePreset,
} from './workflow-provider-options.js';

export interface WorkflowRule {
  condition: string;
  next?: string;
  returnValue?: string;
  appendix?: string;
  requiresUserInput?: boolean;
  interactiveOnly?: boolean;
  isAiCondition?: boolean;
  aiConditionText?: string;
  isAggregateCondition?: boolean;
  aggregateType?: 'all' | 'any';
  aggregateConditionText?: string | string[];
}

export type WorkflowMaxSteps = number | 'infinite';

export interface WorkflowStructuredOutput {
  schemaRef: string;
  schema: Record<string, unknown>;
}

export interface OutputContractItem {
  name: string;
  format: string;
  useJudge?: boolean;
  order?: string;
}

export type OutputContractEntry = OutputContractItem;

export type WorkflowParamType = 'facet_ref' | 'facet_ref[]';
export type WorkflowParamFacetKind = 'knowledge' | 'policy' | 'instruction' | 'report_format';
export type WorkflowCallArgValue = string | string[];

export interface WorkflowSubworkflowParamConfig {
  type: WorkflowParamType;
  facetKind: WorkflowParamFacetKind;
  default?: WorkflowCallArgValue;
}

export interface WorkflowSubworkflowConfig {
  callable?: boolean;
  visibility?: 'internal';
  returns?: string[];
  params?: Record<string, WorkflowSubworkflowParamConfig>;
}

export interface WorkflowResumePointEntry {
  workflow: string;
  workflow_ref?: string;
  step: string;
  kind: WorkflowStepKind;
}

export interface WorkflowResumePoint {
  version: 1;
  stack: WorkflowResumePointEntry[];
  iteration: number;
  elapsed_ms: number;
}

interface WorkflowStepBase {
  name: string;
  description?: string;
  personaDisplayName: string;
  instruction: string;
  delayBeforeMs?: number;
  rules?: WorkflowRule[];
  passPreviousResponse?: boolean;
}

export interface AgentWorkflowStep extends WorkflowStepBase {
  kind?: 'agent';
  mode?: never;
  call?: never;
  overrides?: never;
  persona?: string;
  session?: 'continue' | 'refresh';
  mcpServers?: Record<string, McpServerConfig>;
  personaPath?: string;
  provider?: ProviderType;
  model?: string;
  requiredPermissionMode?: PermissionMode;
  providerOptions?: StepProviderOptions;
  edit?: boolean;
  structuredOutput?: WorkflowStructuredOutput;
  systemInputs?: never;
  effects?: never;
  outputContracts?: OutputContractEntry[];
  qualityGates?: string[];
  parallel?: AgentWorkflowStep[];
  concurrency?: number;
  arpeggio?: ArpeggioStepConfig;
  teamLeader?: TeamLeaderConfig;
  policyContents?: string[];
  knowledgeContents?: string[];
}

export interface SystemWorkflowStep extends WorkflowStepBase {
  kind: 'system';
  mode?: never;
  call?: never;
  overrides?: never;
  persona?: never;
  session?: 'continue' | 'refresh';
  mcpServers?: never;
  personaPath?: never;
  provider?: never;
  model?: never;
  requiredPermissionMode?: never;
  providerOptions?: never;
  edit?: never;
  structuredOutput?: never;
  systemInputs?: WorkflowSystemInput[];
  effects?: WorkflowEffect[];
  outputContracts?: never;
  qualityGates?: never;
  parallel?: never;
  concurrency?: never;
  arpeggio?: never;
  teamLeader?: never;
  policyContents?: never;
  knowledgeContents?: never;
}

export interface WorkflowCallStep extends WorkflowStepBase {
  kind: 'workflow_call';
  mode?: never;
  call: string;
  overrides?: WorkflowCallOverrides;
  args?: Record<string, WorkflowCallArgValue>;
  persona?: never;
  session?: never;
  mcpServers?: never;
  personaPath?: never;
  provider?: never;
  model?: never;
  requiredPermissionMode?: never;
  providerOptions?: never;
  edit?: never;
  structuredOutput?: never;
  systemInputs?: never;
  effects?: never;
  outputContracts?: never;
  qualityGates?: never;
  parallel?: never;
  concurrency?: never;
  arpeggio?: never;
  teamLeader?: never;
  policyContents?: never;
  knowledgeContents?: never;
}

export type WorkflowStep = AgentWorkflowStep | SystemWorkflowStep | WorkflowCallStep;

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
  subworkflow?: WorkflowSubworkflowConfig;
  schemas?: Record<string, string>;
  provider?: ProviderType;
  model?: string;
  providerOptions?: StepProviderOptions;
  runtime?: WorkflowRuntimeConfig;
  personas?: Record<string, string>;
  policies?: Record<string, string>;
  knowledge?: Record<string, string>;
  instructions?: Record<string, string>;
  reportFormats?: Record<string, string>;
  steps: WorkflowStep[];
  initialStep: string;
  maxSteps: WorkflowMaxSteps;
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

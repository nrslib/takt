import type { ProviderType } from '../../shared/types/provider.js';
import type { AutoRoutingConfig } from './config-types.js';
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
import type { FindingContractConfig, FindingsRuleContext } from './finding-types.js';

export const WORKFLOW_SESSION_MODES = ['continue', 'refresh', 'compact'] as const;
export type WorkflowSessionMode = typeof WORKFLOW_SESSION_MODES[number];

export type {
  WorkflowPrListWhere,
  WorkflowSystemInput,
  WorkflowEffect,
  WorkflowEnqueueBaseBranchConfig,
  WorkflowEnqueueIssueConfig,
  WorkflowEnqueueWorktreeConfig,
  WorkflowTemplateReference,
  WorkflowEffectScalarReference,
} from './workflow-system-input-types.js';
export type { FindingContractConfig, FindingLedger, FindingsRuleContext } from './finding-types.js';
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
  ClaudeTerminalProviderOptions,
  CopilotProviderOptions,
  KiroProviderOptions,
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
  aggregateGuardCondition?: string;
  /**
   * Deterministic guard split from a plain-rule compound condition
   * ("<tag text> && findings...."). The tag part stays in `condition`;
   * this guard must also hold for the rule to match.
   */
  guardCondition?: string;
}

export type WorkflowMaxSteps = number | 'infinite';

export interface WorkflowStructuredOutput {
  schemaRef: string;
  /**
   * provider-facing schema（native structured output の生成拘束に使う）。
   * OpenAI/Codex 系の strict 様式（全 properties が required、optional
   * プロパティ禁止）を満たす形を保つこと。provider へはこちらだけを渡す。
   */
  schema: Record<string, unknown>;
  /**
   * post-hoc 検証専用の寛容版 schema（任意）。schema が生成を拘束しない
   * formless/劣化経路（providerSupportsStructuredOutput === false の provider や
   * プロンプト埋め込み fallback）の出力検証にはこちらを使う。未指定なら
   * `schema` で検証する。provider へ渡してはならない（strict 様式に違反し、
   * native 経路では生成前に schema 自体が拒否される）。
   */
  validationSchema?: Record<string, unknown>;
}

export interface OutputContractItem {
  name: string;
  format: string;
  /**
   * 解決前の format 参照名（facet ref）。`format` は facet 本文へ解決済みの
   * テキストになるため、"*-finding-contract" 命名規約を検証したい呼び出し元
   * （WorkflowValidator の fail-fast チェックなど）はこちらを見る。
   */
  formatRef?: string;
  useJudge?: boolean;
  order?: string;
}

export type OutputContractEntry = OutputContractItem;

export interface CommandQualityGate {
  type: 'command';
  name?: string;
  command: string;
  cwd?: string;
  timeoutMs?: number;
}

export type QualityGate = string | CommandQualityGate;

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
  requiresFindingContract?: true;
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

export interface WorkflowPromotionEntry {
  at?: number;
  condition?: string;
  aiConditionText?: string;
  provider?: ProviderType;
  providerSpecified?: boolean;
  model?: string;
  providerOptions?: StepProviderOptions;
}

interface WorkflowStepBase {
  name: string;
  description?: string;
  personaDisplayName: string;
  providerRoutingPersonaKey?: string;
  tags?: string[];
  instruction: string;
  delayBeforeMs?: number;
  rules?: WorkflowRule[];
  passPreviousResponse?: boolean;
  /** Internal-only marker for Team Leader planning steps that need lossless state output. */
  preserveFullPreviousResponse?: true;
  /**
   * Set only by the engine when it synthesizes a step (e.g. the
   * finding-conflict-adjudication step injected into config.steps). Never
   * settable from workflow YAML (the raw schema has no such field), which is
   * how WorkflowValidator distinguishes a user-authored step that squats on a
   * reserved synthetic name (configuration error) from the engine's own
   * injection (allowed).
   */
  engineSynthesized?: true;
}

interface AgentWorkflowStepBase extends WorkflowStepBase {
  kind?: 'agent';
  mode?: never;
  call?: never;
  overrides?: never;
  sessionKey?: string;
  requiresUserInput?: boolean;
  persona?: string;
  allowGitCommit?: boolean;
  mcpServers?: Record<string, McpServerConfig>;
  personaPath?: string;
  provider?: ProviderType;
  providerSpecified?: boolean;
  model?: string;
  modelSpecified?: boolean;
  promotion?: WorkflowPromotionEntry[];
  requiredPermissionMode?: PermissionMode;
  providerOptions?: StepProviderOptions;
  directProviderOptions?: StepProviderOptions;
  workflowProviderOptions?: StepProviderOptions;
  edit?: boolean;
  qualityGates?: QualityGate[];
  structuredOutput?: WorkflowStructuredOutput;
  systemInputs?: never;
  effects?: never;
  outputContracts?: OutputContractEntry[];
  parallel?: WorkflowStep[];
  concurrency?: number;
  arpeggio?: ArpeggioStepConfig;
  teamLeader?: TeamLeaderConfig;
  policyContents?: string[];
  knowledgeContents?: string[];
}

export interface NormalAgentWorkflowStep extends AgentWorkflowStepBase {
  session?: WorkflowSessionMode;
  parallel?: never;
  concurrency?: never;
  arpeggio?: never;
  teamLeader?: never;
}

export interface ParallelWorkflowStep extends AgentWorkflowStepBase {
  session?: never;
  parallel: WorkflowStep[];
  concurrency?: number;
  arpeggio?: never;
  teamLeader?: never;
}

export interface ArpeggioWorkflowStep extends AgentWorkflowStepBase {
  session?: never;
  parallel?: never;
  concurrency?: never;
  arpeggio: ArpeggioStepConfig;
  teamLeader?: never;
}

export interface TeamLeaderWorkflowStep extends AgentWorkflowStepBase {
  session?: never;
  parallel?: never;
  concurrency?: never;
  arpeggio?: never;
  teamLeader: TeamLeaderConfig;
}

export type AgentWorkflowStep =
  | NormalAgentWorkflowStep
  | ParallelWorkflowStep
  | ArpeggioWorkflowStep
  | TeamLeaderWorkflowStep;

export interface SystemWorkflowStep extends WorkflowStepBase {
  kind: 'system';
  mode?: never;
  call?: never;
  overrides?: never;
  sessionKey?: never;
  requiresUserInput?: never;
  persona?: never;
  tags?: never;
  allowGitCommit?: never;
  session?: never;
  mcpServers?: never;
  personaPath?: never;
  provider?: never;
  model?: never;
  promotion?: never;
  requiredPermissionMode?: never;
  providerOptions?: never;
  edit?: never;
  qualityGates?: never;
  structuredOutput?: never;
  systemInputs?: WorkflowSystemInput[];
  effects?: WorkflowEffect[];
  outputContracts?: never;
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
  sessionKey?: never;
  requiresUserInput?: never;
  persona?: never;
  tags?: never;
  allowGitCommit?: never;
  session?: never;
  mcpServers?: never;
  personaPath?: never;
  provider?: never;
  model?: never;
  promotion?: never;
  requiredPermissionMode?: never;
  providerOptions?: never;
  edit?: never;
  qualityGates?: never;
  structuredOutput?: never;
  systemInputs?: never;
  effects?: never;
  outputContracts?: never;
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
  sessionKey?: string;
  persona?: string;
  personaPath?: string;
  provider?: ProviderType;
  model?: string;
  modelSpecified?: boolean;
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
  findingContract?: FindingContractConfig;
  schemas?: Record<string, string>;
  provider?: ProviderType;
  model?: string;
  providerOptions?: StepProviderOptions;
  autoRouting?: AutoRoutingConfig;
  rateLimitFallback?: RateLimitFallbackConfig;
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

export interface RateLimitFallbackProvider {
  provider: ProviderType;
  model?: string;
}

export interface RateLimitFallbackConfig {
  switchChain: RateLimitFallbackProvider[];
}

export interface FallbackContext {
  reason: 'rate_limited';
  reasonDetail: string;
  originalIteration: number;
  previousProvider: ProviderType;
  previousModel?: string;
  currentProvider: ProviderType;
  currentModel?: string;
  stepName: string;
  reportDir: string;
}

export interface WorkflowState {
  workflowName: string;
  currentStep: string;
  /**
   * Name of the step the state machine advanced FROM into currentStep
   * (updated in WorkflowRunLoop's advanceActiveStep). Used by the
   * finding-conflict-adjudication synthetic step to resolve its dynamic
   * return-to-origin transition; undefined at workflow start and after a
   * resume that begins directly at a step.
   */
  previousStep?: string;
  iteration: number;
  findings?: FindingsRuleContext;
  stepOutputs: Map<string, AgentResponse>;
  structuredOutputs: Map<string, Record<string, unknown>>;
  systemContexts: Map<string, Record<string, unknown>>;
  effectResults: Map<string, Record<string, unknown>>;
  lastOutput?: AgentResponse;
  previousResponseSourcePath?: string;
  userInputs: string[];
  personaSessions: Map<string, string>;
  stepIterations: Map<string, number>;
  pendingFallback?: FallbackContext;
  rateLimitFallbackAttempts?: RateLimitFallbackProvider[];
  status: 'running' | 'completed' | 'aborted';
}

import type { ProviderType } from '../../shared/types/provider.js';
import type {
  CanonicalWorkflowResumeFrame,
} from '../../shared/types/workflow-resume.js';
import type { PermissionMode } from './status.js';
import type { AgentResponse } from './response.js';
import type { InteractiveMode } from './interactive-mode.js';
import type { TeamLeaderConfig } from './part.js';
import type {
  McpServerConfig,
  StepProviderOptions,
  WorkflowRuntimeConfig,
  WorkflowStepKind,
} from './workflow-provider-options.js';
import type {
  WorkflowEffect,
  WorkflowSystemInput,
} from './workflow-system-input-types.js';
import type { WorkflowRuleCondition } from './workflow-rule-condition.js';
import type {
  CompanionSelection,
  CompanionWorkflowState,
  ResolvedCompanionDefinition,
} from './companion-types.js';

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
export type { WorkflowResumeFrameKind } from '../../shared/types/workflow-resume.js';
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
  ProviderGuardOptions,
  CodexProviderOptions,
  CodexPermissionControl,
  OpenCodeGuardOptions,
  OpenCodeGuardProfile,
  OpenCodeProviderOptions,
  ClaudeProviderOptions,
  ClaudeTerminalProviderOptions,
  CursorProviderOptions,
  CopilotProviderOptions,
  KiroProviderOptions,
  DeepSeekHarnessProviderOptions,
  PiProviderOptions,
  StepProviderOptions,
  WorkflowStepKind,
} from './workflow-provider-options.js';
export {
  RUNTIME_PREPARE_PRESETS,
  OPENCODE_GUARD_PROFILES,
  isRuntimePreparePreset,
} from './workflow-provider-options.js';

export interface WorkflowRule {
  condition: import('./workflow-rule-condition.js').WorkflowRuleCondition;
  next?: string;
  returnValue?: string;
  appendix?: string;
  requiresUserInput?: boolean;
  interactiveOnly?: boolean;
  commandGates?: 'required' | 'skip';
}

export interface WorkflowWideRule {
  readonly ref: string;
  readonly position: 'after_execution_rules' | 'before_instruction';
  readonly content: string;
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
  /** 解決前の format 参照名（facet ref）。 */
  formatRef?: string;
  useJudge?: boolean;
  order?: string;
  /** 解決前の order 参照名（facet ref）。 */
  orderRef?: string;
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

export type WorkflowParamType =
  | 'facet_ref'
  | 'facet_ref[]'
  | 'workflow_ref'
  | 'facet_pool_ref'
  | 'companion_ref[]';
export type WorkflowParamFacetKind = 'knowledge' | 'policy' | 'instruction' | 'persona' | 'report_format';
export type WorkflowCallArgValue = string | string[] | CompanionSelection;
export type WorkflowCallVariableValue = string | number | boolean;

interface WorkflowFacetSubworkflowParamConfig {
  type: 'facet_ref' | 'facet_ref[]';
  facetKind: WorkflowParamFacetKind;
  default?: string | string[];
}

interface WorkflowReferenceSubworkflowParamConfig {
  type: 'workflow_ref';
  default?: string;
}

interface WorkflowFacetPoolSubworkflowParamConfig {
  type: 'facet_pool_ref';
  default?: string;
}

interface WorkflowCompanionSubworkflowParamConfig {
  type: 'companion_ref[]';
  default?: string[] | CompanionSelection;
}

export type WorkflowSubworkflowParamConfig =
  | WorkflowFacetSubworkflowParamConfig
  | WorkflowReferenceSubworkflowParamConfig
  | WorkflowFacetPoolSubworkflowParamConfig
  | WorkflowCompanionSubworkflowParamConfig;

export interface WorkflowSubworkflowConfig {
  callable?: boolean;
  visibility?: 'internal';
  returns?: string[];
  params?: Record<string, WorkflowSubworkflowParamConfig>;
}

export interface WorkflowResumePointEntry extends CanonicalWorkflowResumeFrame {
  step_iterations?: Record<string, number>;
  call_instance?: number;
}

export type WorkflowRestartPointEntry = Omit<
  WorkflowResumePointEntry,
  'workflow_ref' | 'occurrence' | 'kind' | 'step_iterations' | 'call_instance'
> & {
  workflow_ref: string;
  kind: WorkflowStepKind;
  call_instance?: 1;
};

export interface WorkflowRestartPoint {
  stack: WorkflowRestartPointEntry[];
}

export interface WorkflowResumePoint {
  version: 2;
  stack: WorkflowResumePointEntry[];
  iteration: number;
  elapsed_ms: number;
  workflow_call_invocations: Record<string, WorkflowCallInvocationRecord>;
  workflow_step_participations: Record<string, WorkflowStepParticipationRecord>;
}

export interface WorkflowStepParticipationRecord {
  report_names: string[];
}

export interface WorkflowCallInvocationRecord {
  call_instance: number;
  report_namespace_segment: string;
}

export interface DynamicParallelSelectionSnapshot {
  identity: string;
  step_name: string;
  round: number;
  selected_pool_ids: string[];
  effective_selection_ids: string[];
}

export interface ResolvedFacetContent {
  readonly content: string;
  readonly sourcePath?: string;
  readonly refName?: string;
  readonly literalContent?: true;
}

export interface ResolvedFacetPoolCandidate {
  readonly id: string;
  readonly description: string;
  readonly policyRefs: readonly string[];
  readonly knowledgeRefs: readonly string[];
  readonly resolvedPolicyContents: readonly ResolvedFacetContent[];
  readonly resolvedKnowledgeContents: readonly ResolvedFacetContent[];
}

export interface ResolvedFacetPool {
  readonly name: string;
  readonly source: 'inline' | 'external';
  readonly candidates: readonly ResolvedFacetPoolCandidate[];
}

export interface DynamicFacetsConfig {
  readonly pool: string;
  readonly maxSelected?: number;
  readonly selector?: SelectorGuidance;
}

export interface SelectorGuidance {
  readonly persona?: string;
  readonly personaPath?: string;
  readonly personaRef?: string;
  readonly instruction: string;
  readonly instructionRef?: string;
}

export const MAX_COMPLETION_RETRY = 4;

export interface CompletionRetryConfig {
  readonly minRetry: number;
  readonly maxRetry: number;
  readonly retryInstruction: string;
  readonly retryInstructionRef?: string;
}

export interface DynamicFacetSelectionSnapshot {
  identity: string;
  step_name: string;
  round: number;
  selected_ids: string[];
  selected_policy_refs: string[];
  selected_knowledge_refs: string[];
  rationale: string;
}

export interface WorkflowPromotionEntry {
  at: number;
}

interface WorkflowStepBase {
  name: string;
  description?: string;
  personaDisplayName: string;
  providerRoutingPersonaKey?: string;
  tags?: string[];
  instruction: string;
  /** Loader-preserved instruction reference or inline declaration before facet resolution. */
  instructionRef?: string | string[];
  delayBeforeMs?: number;
  rules?: WorkflowRule[];
  passPreviousResponse?: boolean;
  /** Internal-only marker for Team Leader planning steps that need lossless state output. */
  preserveFullPreviousResponse?: true;
  /**
   * Set only by the engine when it synthesizes an internal step, such as a
   * loop-monitor judge. Never settable from workflow YAML because the raw
   * schema has no such field.
   */
  engineSynthesized?: true;
  /** Engine-owned provider identity. Workflow YAML cannot set these fields. */
  provider?: ProviderType;
  providerSpecified?: boolean;
  model?: string;
  modelSpecified?: boolean;
  providerOptions?: StepProviderOptions;
  /** Engine-owned agent whose Phase 1 must use the shared fresh-session transport. */
  internalFreshSession?: true;
  /** Runtime-profile options tied to this synthesized step's direct provider identity. */
  internalProviderOptions?: StepProviderOptions;
  /** Runtime-profile permission tied to this synthesized step's direct provider identity. */
  internalPermissionMode?: PermissionMode;
}

interface AgentWorkflowStepBase extends WorkflowStepBase {
  kind?: 'agent';
  mode?: never;
  call?: never;
  vars?: never;
  overrides?: never;
  sessionKey?: string;
  requiresUserInput?: boolean;
  persona?: string;
  allowGitCommit?: boolean;
  mcpServers?: Record<string, McpServerConfig>;
  personaPath?: string;
  promotion?: WorkflowPromotionEntry[];
  requiredPermissionMode?: PermissionMode;
  capabilityProviderOptions?: StepProviderOptions;
  edit?: boolean;
  qualityGates?: QualityGate[];
  structuredOutput?: WorkflowStructuredOutput;
  systemInputs?: never;
  effects?: never;
  outputContracts?: OutputContractEntry[];
  parallel?: ParallelSubSteps;
  concurrency?: number;
  arpeggio?: ArpeggioStepConfig;
  teamLeader?: TeamLeaderConfig;
  policyContents?: readonly ResolvedFacetContent[];
  knowledgeContents?: readonly ResolvedFacetContent[];
  completionRetry?: CompletionRetryConfig;
}

export interface NormalAgentWorkflowStep extends AgentWorkflowStepBase {
  session?: WorkflowSessionMode;
  parallel?: never;
  concurrency?: never;
  arpeggio?: never;
  teamLeader?: never;
  dynamicFacets?: DynamicFacetsConfig;
  companion?: CompanionSelection;
}

export interface ParallelWorkflowStep extends AgentWorkflowStepBase {
  session?: never;
  parallel: ParallelSubSteps;
  concurrency?: number;
  arpeggio?: never;
  teamLeader?: never;
  dynamicFacets?: never;
}

export type DynamicParallelSelectionMode = 'replace' | 'cumulative';

export type DynamicParallelFixedSubStep = NormalAgentWorkflowStep;

export interface DynamicParallelPoolSubStep extends NormalAgentWorkflowStep {
  readonly description: string;
}

export interface DynamicParallelSubSteps {
  readonly kind: 'dynamic';
  readonly fixed: readonly DynamicParallelFixedSubStep[];
  readonly pool: readonly DynamicParallelPoolSubStep[];
  readonly selection: {
    readonly mode: DynamicParallelSelectionMode;
    readonly reports?: readonly string[];
    readonly selector?: SelectorGuidance;
  };
}

export type ParallelSubSteps = WorkflowStep[] | DynamicParallelSubSteps;

export function isDynamicParallelSubSteps(
  parallel: ParallelSubSteps,
): parallel is DynamicParallelSubSteps {
  return !Array.isArray(parallel) && parallel.kind === 'dynamic';
}

export function getAllParallelSubSteps(parallel: ParallelSubSteps): readonly WorkflowStep[] {
  return isDynamicParallelSubSteps(parallel)
    ? [...parallel.fixed, ...parallel.pool]
    : parallel;
}

export interface ArpeggioWorkflowStep extends AgentWorkflowStepBase {
  session?: never;
  parallel?: never;
  concurrency?: never;
  arpeggio: ArpeggioStepConfig;
  teamLeader?: never;
  dynamicFacets?: never;
}

export interface TeamLeaderWorkflowStep extends AgentWorkflowStepBase {
  session?: never;
  parallel?: never;
  concurrency?: never;
  arpeggio?: never;
  teamLeader: TeamLeaderConfig;
  dynamicFacets?: DynamicFacetsConfig;
  companion?: CompanionSelection;
}

export type AgentWorkflowStep =
  | NormalAgentWorkflowStep
  | ParallelWorkflowStep
  | ArpeggioWorkflowStep
  | TeamLeaderWorkflowStep;

export type NormalOrTeamLeaderWorkflowStep = NormalAgentWorkflowStep | TeamLeaderWorkflowStep;

export interface SystemWorkflowStep extends WorkflowStepBase {
  kind: 'system';
  mode?: never;
  call?: never;
  vars?: never;
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
  completionRetry?: never;
}

export interface WorkflowCallStep extends WorkflowStepBase {
  kind: 'workflow_call';
  passPreviousResponse?: never;
  mode?: never;
  call: string;
  vars?: Record<string, WorkflowCallVariableValue>;
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
  completionRetry?: never;
}

export type WorkflowStep = AgentWorkflowStep | SystemWorkflowStep | WorkflowCallStep;

export function isNormalAgentWorkflowStep(step: WorkflowStep): step is NormalAgentWorkflowStep {
  return (
    (step.kind === undefined || step.kind === 'agent')
    && step.parallel === undefined
    && step.arpeggio === undefined
    && step.teamLeader === undefined
  );
}

export function isNormalOrTeamLeaderWorkflowStep(
  step: WorkflowStep,
): step is NormalOrTeamLeaderWorkflowStep {
  return isNormalAgentWorkflowStep(step) || step.teamLeader !== undefined;
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
  condition: WorkflowRuleCondition;
  next: string;
}

export interface LoopMonitorJudge {
  persona?: string;
  personaPath?: string;
  personaRef?: string;
  instruction?: string;
  instructionRef?: string;
  rules: LoopMonitorRule[];
}

export interface LoopMonitorConfig {
  cycle: string[];
  ignoreSteps?: string[];
  threshold: number;
  judge: LoopMonitorJudge;
}

export interface WorkflowConfig {
  name: string;
  description?: string;
  subworkflow?: WorkflowSubworkflowConfig;
  schemas?: Record<string, string>;
  runtime?: WorkflowRuntimeConfig;
  personas?: Record<string, string>;
  policies?: Record<string, string>;
  knowledge?: Record<string, string>;
  instructions?: Record<string, string>;
  reportFormats?: Record<string, string>;
  allStepsRules?: readonly WorkflowWideRule[];
  steps: WorkflowStep[];
  initialStep: string;
  maxSteps: WorkflowMaxSteps;
  loopDetection?: LoopDetectionConfig;
  loopMonitors?: LoopMonitorConfig[];
  interactiveMode?: InteractiveMode;
  facetPools?: Record<string, ResolvedFacetPool>;
  companions?: Record<string, ResolvedCompanionDefinition>;
}

export interface RateLimitFallbackProvider {
  provider: ProviderType;
  model?: string;
}

export interface RateLimitFallbackConfig {
  switchChain: RateLimitFallbackProvider[];
}

export type FallbackOperationStage = 'reviewer';

export interface FallbackOperationOrigin {
  readonly stage: FallbackOperationStage;
  readonly reviewerStepName: string;
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
  origin: FallbackOperationOrigin;
}

export interface RateLimitFallbackState {
  readonly origin: FallbackOperationOrigin;
  readonly attempts: readonly RateLimitFallbackProvider[];
}

export interface WorkflowState {
  workflowName: string;
  currentStep: string;
  iteration: number;
  companion?: CompanionWorkflowState;
  stepOutputs: Map<string, AgentResponse>;
  structuredOutputs: Map<string, Record<string, unknown>>;
  systemContexts: Map<string, Record<string, unknown>>;
  effectResults: Map<string, Record<string, unknown>>;
  lastOutput?: AgentResponse;
  previousResponseSourcePath?: string;
  userInputs: string[];
  personaSessions: Map<string, string>;
  stepIterations: Map<string, number>;
  restoredStepIterationNames: Set<string>;
  dynamicParallelSelections: Map<string, DynamicParallelSelectionSnapshot>;
  activeDynamicParallelSelectionIdentity?: string;
  dynamicFacetSelections: Map<string, DynamicFacetSelectionSnapshot>;
  activeDynamicFacetSelectionIdentity?: string;
  pendingFallback?: FallbackContext;
  rateLimitFallbackState?: RateLimitFallbackState;
  status: 'running' | 'completed' | 'aborted';
}

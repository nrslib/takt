import type { PermissionResult, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import type {
  WorkflowStep,
  AgentResponse,
  WorkflowState,
  Language,
  LoopMonitorConfig,
  WorkflowConfig,
  WorkflowWideRule,
  WorkflowCallStep,
  WorkflowMaxSteps,
  WorkflowRestartPoint,
  WorkflowResumePoint,
  WorkflowResumePointEntry,
  RateLimitFallbackConfig,
  FallbackContext,
  FallbackOperationOrigin,
  McpServerConfig,
  PermissionMode,
} from '../models/types.js';
import type {
  AutoRoutingConfig,
  AutoRoutingStrategy,
  InternalAgentSeats,
  PersonaProviderEntry,
  ProviderRoutingEntry,
  ProviderEscalationTarget,
  ProviderLadderConfig,
  ProviderRoutingConfig,
  ResolvedObservabilityConfig,
  TagRoutingConflictPolicy,
} from '../models/config-types.js';
import type { ProviderPermissionProfiles } from '../models/provider-profiles.js';
import type { ProviderUsageSnapshot } from '../models/response.js';
import type { StepProviderOptions } from '../models/workflow-types.js';
import type { StructuredCaller } from '../../agents/structured-caller.js';
import type { WorkRequirementEstimator } from './auto-routing/contracts.js';
import type { RoutingRuntime } from './auto-routing/runtime.js';
import type { SystemStepServicesFactory } from './system/system-step-services.js';
import type { StructuredOutputNormalizerRegistry } from './engine/structured-output-normalizer.js';
import type { ProviderOptionsOriginResolver, ProviderOptionsSource, ProviderResolutionSource } from './provider-options-trace.js';
import type { RunResumeSource } from './run/run-meta.js';
import type { OperationJournalStore } from './operations/operation-journal-types.js';
import type { PullRequestContext } from './pr-context.js';
import type { DynamicParallelSelectionStore } from './dynamic-parallel/selection-store.js';
import type { WorkflowCallInvocationEvidence } from './workflow-call-invocation-index.js';
import type { WorkflowStepParticipationIndex } from './workflow-step-participation-index.js';
import type { SelectorGitCommandRunner } from './dynamic-parallel/selector-git-command-runner.js';
import type { CompanionDiffReader } from './companion/diff-reader.js';

import type { ProviderType, StreamCallback, StreamEvent } from '../../shared/types/provider.js';
import type { AgentFailureCategory } from '../../shared/types/agent-failure.js';

export interface WorkflowOperationJournalContext {
  readonly store: OperationJournalStore;
  readonly journalRunSlug: string;
  readonly claimToken: string;
  readonly sourceClaimTokens?: ReadonlySet<string>;
}
export type {
  ProviderType,
  StreamEvent,
  StreamCallback,
  StreamInitEventData,
  StreamToolUseEventData,
  StreamToolResultEventData,
  StreamToolOutputEventData,
  StreamTextEventData,
  StreamThinkingEventData,
  StreamResultEventData,
  StreamErrorEventData,
} from '../../shared/types/provider.js';
export interface PermissionRequest {
  toolName: string;
  input: Record<string, unknown>;
  suggestions?: PermissionUpdate[];
  blockedPath?: string;
  decisionReason?: string;
}

export type { PermissionResult, PermissionUpdate };

export type PermissionHandler = (request: PermissionRequest) => Promise<PermissionResult>;

export interface AskUserQuestionInput {
  questions: Array<{
    question: string;
    header?: string;
    options?: Array<{
      label: string;
      description?: string;
    }>;
    multiSelect?: boolean;
  }>;
}

export type AskUserQuestionHandler = (
  input: AskUserQuestionInput
) => Promise<Record<string, string>>;

export type PhaseName = 'execute' | 'report' | 'judge';

export interface PhasePromptParts {
  systemPrompt: string;
  userInstruction: string;
}

export interface JudgeStageEntry {
  stage: 1 | 2 | 3;
  method: 'structured_output' | 'phase3_tag' | 'ai_judge';
  status: 'done' | 'error' | 'skipped';
  instruction: string;
  response: string;
  providerUsage?: ProviderUsageSnapshot;
}

export interface StepProviderInfo {
  provider: ProviderType | undefined;
  model: string | undefined;
  providerSource?: ProviderResolutionSource;
  modelSource?: ProviderResolutionSource;
  providerOptions?: StepProviderOptions;
  providerOptionsSources?: Readonly<Record<string, ProviderResolutionSource>>;
  /** Permission mode from the same winning runtime profile as provider/model/options. */
  permissionMode?: PermissionMode;
  /**
   * `escalate` target of the runtime.yaml profile this step resolved to. Present only when a
   * profile-backed layer supplied the provider; consumers treat its presence as the opt-in.
   */
  escalation?: ProviderEscalationTarget;
  autoRoutingDecision?: {
    candidateName: string;
    routingTier: 'high' | 'medium' | 'low';
    strategy: AutoRoutingStrategy;
    candidateCount: number;
    requiredTier?: 'high' | 'medium' | 'low';
    reasonCodes?: string[];
    fallbackReason?: string;
    fingerprintChanged?: boolean;
    retryReason?: 'failed-without-progress' | 'no-progress';
    estimatorDurationMs?: number;
    inputTokenBucket?: 'small' | 'medium' | 'large';
  };
}

export interface SelectorProviderInfo extends StepProviderInfo {
  provider: ProviderType;
}

export interface ProviderStreamContext {
  readonly step: string;
  readonly provider: ProviderType;
  readonly providerModel: string;
}

export interface DelegatedAgentUsageContext extends ProviderStreamContext {
  /** 'normal' は実行ループ外の合成ステップの直接呼び出し。 */
  readonly stepType: 'parallel' | 'team_leader' | 'normal';
}

export interface DelegatedAgentUsageResult {
  readonly success: boolean;
  readonly usage?: ProviderUsageSnapshot;
}

export interface StepRunResult {
  response: AgentResponse;
  instruction: string;
  providerInfo?: StepProviderInfo;
  workflowCallFailure?: WorkflowStepFailureSummary;
  terminalOperation?: {
    readonly origin: FallbackOperationOrigin;
    readonly providerInfo: StepProviderInfo;
  };
  consumedStepIterations?: readonly string[];
  qualityGateFailure?: {
    response: AgentResponse;
    stepIteration: number;
  };
  commitTransition?: (receipt: StepTransitionReceipt) => void;
}

export type StepTransitionReceipt =
  | { readonly kind: 'next_step'; readonly nextStep: string }
  | { readonly kind: 'return'; readonly returnValue: string };

export interface TeamLeaderPartRuntimeResolution {
  partAllowedTools?: string[];
  processSafety?: { protectedParentRunPid: number };
}

export interface RuntimeStepResolution {
  providerInfo?: StepProviderInfo;
  providerInfoResolution?: 'fully_resolved';
  fallback?: FallbackContext;
  teamLeaderPart?: TeamLeaderPartRuntimeResolution;
}

export interface WorkflowSharedRuntimeState {
  startedAtMs: number;
  activeResumePoint?: WorkflowResumePoint;
  maxSteps?: WorkflowMaxSteps;
  restartNavigator?: import('./engine/WorkflowRestartNavigator.js').WorkflowRestartNavigator;
  dynamicParallelSelectionStore?: DynamicParallelSelectionStore;
  dynamicFacetSelectionStore?: import('./dynamic-facets/dynamicFacetSelectionStore.js').DynamicFacetSelectionStore;
  workflowCallInvocationEvidence?: WorkflowCallInvocationEvidence;
  workflowStepParticipationIndex?: WorkflowStepParticipationIndex;
  resumeArtifactOccurrenceIndex?: import('./run/resume-artifact-occurrence-index.js').ResumeArtifactOccurrenceIndex;
}

export type WorkflowAbortKind =
  | 'interrupt'
  | 'iteration_limit'
  | 'loop_detected'
  | 'blocked'
  | 'step_error'
  | 'rate_limited'
  | 'user_input_required'
  | 'user_input_cancelled'
  | 'step_transition'
  | 'runtime_error'
  | 'rule_no_match'
  /**
   * COMPLETE への遷移時に open な provisional finding（意味を確定できなかった
   * 観測）が残っていた。エンジン最終不変条件のバックストップ発火 = workflow の
   * rules が findings.provisional.count を処理する記述を欠いている設定不備で、
   * 「ルールはあるが何もマッチしない」と同じクラスの fail-fast。
   */
  | 'provisional_findings'
  | 'review_integrity_unresolved';

export type ReviewIntegrityFailureCode =
  | 'restatement_exhausted_claim_bearing'
  | 'review_integrity_unresolved_unpresented';

export interface ReviewIntegrityFailureDetails {
  code: ReviewIntegrityFailureCode;
  anomalyIds: string[];
  unpresentedIds: string[];
  classificationAuthorityIds: string[];
  publicationIds: string[];
}

export interface WorkflowStepFailureSummary {
  kind: WorkflowAbortKind;
  step: string;
  reason: string;
  error: string;
  failureCategory?: AgentFailureCategory;
  details?: {
    reviewIntegrity?: ReviewIntegrityFailureDetails;
  };
}

export interface WorkflowAbortResult {
  kind: WorkflowAbortKind;
  reason: string;
  failure: WorkflowStepFailureSummary;
}

export interface WorkflowRunResult {
  state: WorkflowState;
  abort?: WorkflowAbortResult;
  returnValue?: string;
}

export interface WorkflowCallChildEngine {
  on: (event: string, listener: (...args: unknown[]) => void) => void;
  runWithResult: () => Promise<WorkflowRunResult>;
}

export interface WorkflowCallResolutionRequest {
  parentWorkflow: WorkflowConfig;
  step: WorkflowCallStep;
  projectCwd: string;
  lookupCwd: string;
}

export type WorkflowCallResolver = (request: WorkflowCallResolutionRequest) => WorkflowConfig | null;

export interface WorkflowStepExecutionEventContext {
  readonly iteration: number;
  readonly workflowName: string;
  readonly resumeStepName: string;
  readonly stepIteration: number;
  readonly providerInfo: StepProviderInfo;
  readonly provider: ProviderType;
  readonly model: string;
  readonly workflowStack: WorkflowResumePointEntry[];
}

export interface WorkflowCallLifecycle {
  parentWorkflow: string;
  step: string;
  childWorkflow: string;
  callInstance: number;
  stack: WorkflowResumePointEntry[];
}

export interface WorkflowCallCompleteLifecycle extends WorkflowCallLifecycle {
  result:
    | { status: 'completed'; returnValue?: string }
    | { status: 'aborted'; abortKind?: WorkflowAbortKind; abortReason?: string }
    | { status: 'failed'; reason: string };
}

/** Events emitted by workflow engine */
export type CompanionReviewTrigger = 'quiet' | 'forced' | 'completion' | 'commit';

export interface CompanionQueueAuditEntry {
  readonly trigger: CompanionReviewTrigger;
  readonly digest: string;
  readonly changedLines: number;
  readonly observedGeneration: number;
}

export type CompanionCallPurpose = 'selector' | 'reviewer' | 'moderator';
export type CompanionCallStatus = 'completed' | 'failed';
export type CompanionReviewPhase = 'initial' | 'live' | 'fix' | 'completion';
export type CompanionReviewSkipReason =
  | 'companion_disabled'
  | 'companion_not_configured'
  | 'companion_runtime_unavailable'
  | 'selector_empty'
  | 'empty_diff'
  | 'unchanged_digest'
  | 'below_minimum_changed_lines';
export type CompanionReviewZeroReason =
  | 'reviewer_returned_no_findings'
  | 'moderator_rejected_all_findings';

export interface CompanionModeratorDecisionAudit {
  readonly action: 'accept' | 'reject';
  readonly sourceIndex: number;
}

export interface CompanionAcceptedFindingAudit {
  readonly severity: 'must_fix' | 'should_fix' | 'nit';
  readonly file: string;
  readonly line: number;
  readonly finding: string;
}

export interface CompanionModeratorAudit {
  readonly name: string;
  readonly invoked: boolean;
  readonly reason?: 'reviewer_result_empty' | 'not_configured';
  readonly decisions: readonly CompanionModeratorDecisionAudit[];
}

export interface WorkflowEvents {
  'workflow_call:start': (lifecycle: WorkflowCallLifecycle) => void;
  'workflow_call:complete': (lifecycle: WorkflowCallCompleteLifecycle) => void;
  'step:start': (
    step: WorkflowStep,
    iteration: number,
    instruction: string,
    providerInfo: StepProviderInfo,
    workflowName: string,
    resumeStepName: string,
    stepIteration: number,
    workflowStack: WorkflowResumePointEntry[],
  ) => void;
  'step:complete': (
    step: WorkflowStep,
    response: AgentResponse,
    instruction: string,
    resumeStepName: string,
    workflowStack: WorkflowResumePointEntry[],
  ) => void;
  'routing:decision': (
    step: WorkflowStep,
    response: AgentResponse,
    instruction: string,
    providerInfo: StepProviderInfo,
    stepType: 'normal' | 'parallel' | 'agent',
    durationMs: number,
    iteration: number,
    workflowName: string,
  ) => void;
  'step:report': (
    step: WorkflowStep,
    filePath: string,
    fileName: string,
    context: WorkflowStepExecutionEventContext,
  ) => void;
  'companion:start': (payload: {
    step: string;
    companion: string;
  }) => void;
  'companion:pool_selected': (payload: {
    step: string;
    selected: string[];
    rationale: string;
  }) => void;
  'companion:finding': (payload: {
    step: string;
    companion: string;
    severity: 'must_fix' | 'should_fix' | 'nit';
  }) => void;
  'companion:fix_round': (payload: {
    step: string;
    sequence: number;
    findingCount: number;
  }) => void;
  'companion:complete': (payload: {
    step: string;
    completionSettled: boolean;
    completionFailure: boolean;
    followUpRounds: number;
    reason?: string;
  }) => void;
  'companion:review_round': (payload: {
    step: string;
    companion: string;
    trigger: CompanionReviewTrigger;
    digest: string;
    changedLines: number;
    findingCount: number;
    reviewerFindings: readonly CompanionAcceptedFindingAudit[];
    moderator?: CompanionModeratorAudit;
    acceptedFindings: readonly CompanionAcceptedFindingAudit[];
    zeroReason?: CompanionReviewZeroReason;
    runPathNamespace?: string[];
  }) => void;
  'companion:queue_coalesced': (payload: {
    step: string;
    companion: string;
    replaced: CompanionQueueAuditEntry;
    replacement: CompanionQueueAuditEntry;
    runPathNamespace?: string[];
  }) => void;
  'companion:call': (payload: {
    step: string;
    agent: string;
    purpose: CompanionCallPurpose;
    attempt: number;
    status: CompanionCallStatus;
    provider: ProviderType;
    model?: string;
    systemPrompt?: string;
    prompt?: string;
    promptResolved: boolean;
    runPathNamespace?: string[];
    response?: AgentResponse;
    error?: string;
  }) => void;
  'companion:review_skipped': (payload: {
    step: string;
    companion?: string;
    phase: CompanionReviewPhase;
    reason: CompanionReviewSkipReason;
    fixRound?: number;
    observedGeneration?: number;
    runPathNamespace?: string[];
  }) => void;
  'review_completion:judge:start': (payload: {
    step: string;
    attempt: number;
    provider: string | undefined;
    model: string | undefined;
  }) => void;
  'review_completion:retry:start': (payload: {
    step: string;
    attempt: number;
  }) => void;
  'review_completion:retry:complete': (payload: {
    step: string;
    attempt: number;
    status: string;
    error?: string;
  }) => void;
  'review_completion:judge:complete': (payload: {
    step: string;
    attempt: number;
    status: string;
    complete?: boolean;
    gapCount?: number;
    error?: string;
  }) => void;
  'step:blocked': (step: WorkflowStep, response: AgentResponse) => void;
  'step:rate_limited': (step: WorkflowStep, response: AgentResponse, rateLimitInfo: AgentResponse['rateLimitInfo']) => void;
  'step:user_input': (step: WorkflowStep, userInput: string) => void;
  'phase:start': (
    step: WorkflowStep,
    phase: 1 | 2 | 3,
    phaseName: PhaseName,
    instruction: string,
    promptParts: PhasePromptParts,
    phaseExecutionId: string | undefined,
    iteration: number | undefined,
    workflowStack: WorkflowResumePointEntry[],
  ) => void;
  'phase:complete': (
    step: WorkflowStep,
    phase: 1 | 2 | 3,
    phaseName: PhaseName,
    content: string,
    status: string,
    error: string | undefined,
    phaseExecutionId: string | undefined,
    iteration: number | undefined,
    workflowStack: WorkflowResumePointEntry[],
  ) => void;
  'phase:judge_stage': (
    step: WorkflowStep,
    phase: 3,
    phaseName: 'judge',
    entry: JudgeStageEntry,
    phaseExecutionId: string | undefined,
    iteration: number | undefined,
    workflowStack: WorkflowResumePointEntry[],
  ) => void;
  'workflow:complete': (state: WorkflowState) => void;
  'workflow:abort': (
    state: WorkflowState,
    reason: string,
    kind: WorkflowAbortKind,
    failure: WorkflowStepFailureSummary,
  ) => void;
  'iteration:limit': (iteration: number, maxSteps: number) => void;
  'step:loop_detected': (step: WorkflowStep, consecutiveCount: number) => void;
  'step:cycle_detected': (monitor: LoopMonitorConfig, cycleCount: number) => void;
}

/** User input request for blocked state */
export interface UserInputRequest {
  /** The step that is blocked */
  step: WorkflowStep;
  /** The blocked response from the agent */
  response: AgentResponse;
  /** Prompt for the user (extracted from blocked message) */
  prompt: string;
}

/** Iteration limit request */
export interface IterationLimitRequest {
  /** Current iteration count */
  currentIteration: number;
  /** Current max steps */
  maxSteps: number;
  /** Current step name */
  currentStep: string;
}

/** Callback for session updates (when persona session IDs change or clear) */
export type SessionUpdateCallback = (persona: string, sessionId: string | undefined) => void;

/**
 * Callback for iteration limit reached.
 * Returns the number of additional iterations to continue, or null to stop.
 */
export type IterationLimitCallback = (request: IterationLimitRequest) => Promise<number | null>;

export type AutoRoutingEstimatorSource = 'injected' | 'engine-default' | 'absent';

/** Options for workflow engine */
export interface WorkflowEngineOptions {
  abortSignal?: AbortSignal;
  /** Emits user-visible workflow warnings at the application boundary. */
  onWarning?: (message: string) => void;
  /** Callback for streaming real-time output */
  onStream?: StreamCallback;
  onProviderStream?: (context: ProviderStreamContext, event: StreamEvent) => void;
  onDelegatedAgentUsage?: (
    context: DelegatedAgentUsageContext,
    result: DelegatedAgentUsageResult,
  ) => void;
  /** Callback for requesting user input when an agent is blocked */
  onUserInput?: (request: UserInputRequest) => Promise<string | null>;
  /** Initial agent sessions to restore (agent name -> session ID) */
  initialSessions?: Record<string, string>;
  /** Callback when agent session ID is updated */
  onSessionUpdate?: SessionUpdateCallback;
  /** Custom permission handler for interactive permission prompts */
  onPermissionRequest?: PermissionHandler;
  /** Initial user inputs to share with all agents */
  initialUserInputs?: string[];
  /** Custom handler for AskUserQuestion tool */
  onAskUserQuestion?: AskUserQuestionHandler;
  /** MCP servers supplied by the application boundary for every phase-1 agent step. */
  mcpServers?: Record<string, McpServerConfig>;
  /** Callback when iteration limit is reached - returns additional iterations or null to stop */
  onIterationLimit?: IterationLimitCallback;
  /** Ignore workflow maxSteps and keep running */
  ignoreIterationLimit?: boolean;
  /** Bypass all permission checks */
  bypassPermissions?: boolean;
  /** Project root directory (where .takt/ lives). */
  projectCwd: string;
  /** Resolved observability opt-in config for workflow instrumentation. */
  observability?: ResolvedObservabilityConfig;
  /** Run-local identifier used to route observability artifacts in the shared SDK. */
  observabilityRunId?: string;
  /** Redacts text before it is attached to observability spans. */
  sanitizeObservabilityText?: (text: string) => string;
  /** Run-local environment values passed to trusted child processes. */
  childProcessEnv?: Readonly<Record<string, string>>;
  /** Language for instruction metadata. Defaults to 'en'. */
  language?: Language;
  provider?: ProviderType;
  providerSource?: ProviderResolutionSource;
  model?: string;
  modelSource?: ProviderResolutionSource;
  /** Provider/model used only for report phase fallback after OpenCode report retries fail. */
  reportFallbackProvider?: StepProviderInfo;
  /** Resolved rate limit fallback provider switch chain */
  rateLimitFallback?: RateLimitFallbackConfig;
  /** Resolved provider options */
  providerOptions?: StepProviderOptions;
  /** Provider source whose runtime profile supplied providerOptions; absent for shared config options. */
  providerOptionsProviderSource?: ProviderResolutionSource;
  /** Explicit workflow_call provider_options inherited by every child step. */
  workflowCallProviderOptions?: StepProviderOptions;
  /** Permission mode from the runtime defaults profile. */
  providerPermissionMode?: PermissionMode;
  selectorProvider?: SelectorProviderInfo;
  /** Reads the current working-tree evidence required by a dynamic selector. */
  selectorGitCommandRunner?: SelectorGitCommandRunner;
  /** Resolved automatic provider/model routing configuration */
  autoRouting?: AutoRoutingConfig;
  /** Run-scoped strategy override for automatic provider/model routing. */
  autoStrategyOverride?: AutoRoutingStrategy;
  onEffectiveAutoRoutingReached?: () => void;
  /** Run-scoped AI router for automatic provider/model routing. */
  autoRoutingEstimator?: WorkRequirementEstimator;
  /** Origin of the run-scoped AI router, propagated to child workflow engines. */
  autoRoutingEstimatorSource?: AutoRoutingEstimatorSource;
  routingRuntime?: RoutingRuntime;
  /** Repository identifiers and other run-local values redacted from routing model input. */
  routingSensitiveValues?: readonly string[];
  /** Source layer for resolved provider options */
  providerOptionsSource?: ProviderOptionsSource;
  /** Nested origin resolver for provider options traced-config values */
  providerOptionsOriginResolver?: ProviderOptionsOriginResolver;
  /** Per-persona provider and model overrides (e.g., { coder: { provider: 'codex', model: 'o3-mini' } }) */
  personaProviders?: Record<string, PersonaProviderEntry>;
  /** Provider routing by raw persona key, workflow step tag, and workflow step name */
  providerRouting?: ProviderRoutingConfig;
  /** `escalate` target of the runtime.yaml profile behind the engine-level provider/model. */
  providerEscalation?: ProviderEscalationTarget;
  /** runtime.yaml `provider.targets.internal_agents` の解決済み seat。 */
  internalAgentSeats?: InternalAgentSeats;
  /** runtime.yaml から解決済みの companion ごとの実行環境。 */
  companionEnabled?: boolean;
  companionProviders?: Readonly<Record<string, ProviderRoutingEntry>>;
  companionDiffReader?: CompanionDiffReader;
  /**
   * Ordered provider ladders (issue #1208) resolved from runtime.yaml `ladder` assignments. The
   * promotion seam advances a matched target-less `{at:N}` to a later stage of the governing
   * ladder; stage 0 is already reflected in provider/model/personaProviders/providerRouting.
   */
  providerLadders?: ProviderLadderConfig;
  /**
   * How to resolve same-priority tag routing conflicts. `fail-fast` (runtime-v1) throws
   * before the agent runs; `last-wins` (legacy, the default) merges in tag order.
   */
  providerRoutingTagConflictPolicy?: TagRoutingConflictPolicy;
  /** Resolved provider permission profiles */
  providerProfiles?: ProviderPermissionProfiles;
  /** Enable interactive-only rules and user-input transitions */
  interactive?: boolean;
  /** Structured caller (required for rule evaluation and status/decomposition flows) */
  structuredCaller?: StructuredCaller;
  /** Structured output normalizers supplied by the composition root. */
  structuredOutputNormalizers?: StructuredOutputNormalizerRegistry;
  /** Override initial step (default: workflow config's initialStep) */
  startStep?: string;
  /** Retry note explaining why task is being retried */
  retryNote?: string;
  /** Resume point for workflow_call-aware retries */
  resumePoint?: WorkflowResumePoint;
  /** Stateless authored path for retrying from a new nested position. */
  restartPoint?: WorkflowRestartPoint;
  resumeSource?: RunResumeSource;
  operationJournal?: WorkflowOperationJournalContext;
  /** Override report directory name (without parent path). */
  reportDirName?: string;
  /** Namespace appended under the shared run directories for nested workflow execution. */
  runPathNamespace?: string[];
  /** Task name prefix for parallel task execution output */
  taskPrefix?: string;
  /** Color index for task prefix (cycled across tasks) */
  taskColorIndex?: number;
  /** Initial iteration count (for resuming exceeded tasks) */
  initialIteration?: number;
  /** Override workflow maxSteps for the current engine instance. */
  maxStepsOverride?: WorkflowMaxSteps;
  /** Current task metadata for system-step context resolution */
  currentTask?: {
    issueNumber?: number;
    runSlug?: string;
  };
  /** Task metadata used only for trace discovery attributes. */
  traceTaskMetadata?: WorkflowTraceTaskMetadata;
  /** Structured PR context used for all Phase 1 instructions. */
  prContext?: PullRequestContext;
  phase1ProcessSafetyByStep?: Record<string, { protectedParentRunPid: number }>;
  systemStepServicesFactory?: SystemStepServicesFactory;
  sharedRuntime?: WorkflowSharedRuntimeState;
  resumeStackPrefix?: WorkflowResumePointEntry[];
  workflowCallResolver?: WorkflowCallResolver;
  /** Workflow-wide rules inherited from the caller workflow. */
  inheritedWorkflowRules?: readonly WorkflowWideRule[];
  /** Scalar execution context inherited through nested workflow_call boundaries. */
  workflowCallVars?: Readonly<Record<string, string | number | boolean>>;
  /** Exact verified resource root for the run's workflow execution bundle. */
  workflowBundleResourceRoot?: string;
  /** Full resume-stack-derived identity for the workflow_call that owns this engine. */
  workflowCallSiteIdentity?: string;
}

export interface WorkflowTraceTaskMetadata {
  taskName?: string | undefined;
  taskSlug?: string | undefined;
  taskSummary?: string | undefined;
  taskSource?: 'issue' | 'pr_review' | 'manual' | undefined;
  issueNumber?: number | undefined;
  prNumber?: number | undefined;
  gitBranch?: string | undefined;
  gitBaseBranch?: string | undefined;
  worktreePath?: string | undefined;
  runDir?: string | undefined;
}

/** Loop detection result */
export interface LoopCheckResult {
  isLoop: boolean;
  count: number;
  shouldAbort: boolean;
  shouldWarn?: boolean;
}

import type { PermissionResult, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import type {
  WorkflowStep,
  AgentResponse,
  WorkflowState,
  Language,
  LoopMonitorConfig,
  WorkflowConfig,
  WorkflowCallStep,
  WorkflowMaxSteps,
  WorkflowResumePoint,
  WorkflowResumePointEntry,
  RateLimitFallbackConfig,
  FallbackContext,
  McpServerConfig,
} from '../models/types.js';
import type {
  AutoRoutingConfig,
  AutoRoutingStrategy,
  PersonaProviderEntry,
  ProviderRoutingConfig,
  ResolvedObservabilityConfig,
} from '../models/config-types.js';
import type { ProviderPermissionProfiles } from '../models/provider-profiles.js';
import type { ProviderUsageSnapshot } from '../models/response.js';
import type { StepProviderOptions } from '../models/workflow-types.js';
import type { StructuredCaller } from '../../agents/structured-caller.js';
import type { AutoRoutingAiRouter } from '../../agents/auto-routing-usecase.js';
import type { SystemStepServicesFactory } from './system/system-step-services.js';
import type { StructuredOutputNormalizerRegistry } from './engine/structured-output-normalizer.js';
import type { ProviderOptionsOriginResolver, ProviderOptionsSource, ProviderResolutionSource } from './provider-options-trace.js';
import type { FindingLedger } from '../models/finding-types.js';

import type { ProviderType, StreamCallback, StreamEvent } from '../../shared/types/provider.js';
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

export type RuleIndexDetector = (content: string, stepName: string) => number;

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
  autoRoutingDecision?: {
    candidateName: string;
    costTier: 'high' | 'medium' | 'low';
    strategy: AutoRoutingStrategy;
    candidateCount: number;
  };
}

export interface ProviderStreamContext {
  readonly step: string;
  readonly provider: ProviderType;
  readonly providerModel: string;
}

export interface DelegatedAgentUsageContext extends ProviderStreamContext {
  readonly stepType: 'parallel' | 'team_leader';
}

export interface DelegatedAgentUsageResult {
  readonly success: boolean;
  readonly usage?: ProviderUsageSnapshot;
}

export interface StepRunResult {
  response: AgentResponse;
  instruction: string;
  providerInfo?: StepProviderInfo;
  consumedStepIterations?: readonly string[];
  qualityGateFailure?: {
    response: AgentResponse;
    stepIteration: number;
  };
}

export interface TeamLeaderPartRuntimeResolution {
  partAllowedTools?: string[];
  processSafety?: { protectedParentRunPid: number };
}

export interface RuntimeStepResolution {
  providerInfo?: StepProviderInfo;
  fallback?: FallbackContext;
  teamLeaderPart?: TeamLeaderPartRuntimeResolution;
}

export interface WorkflowSharedRuntimeState {
  startedAtMs: number;
  activeResumePoint?: WorkflowResumePoint;
  maxSteps?: WorkflowMaxSteps;
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
  | 'runtime_error';

export interface WorkflowStepFailureSummary {
  kind: WorkflowAbortKind;
  step: string;
  reason: string;
}

export interface WorkflowAbortResult {
  kind: WorkflowAbortKind;
  reason: string;
  failure?: WorkflowStepFailureSummary;
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

/** Events emitted by workflow engine */
export interface WorkflowEvents {
  'step:start': (step: WorkflowStep, iteration: number, instruction: string, providerInfo: StepProviderInfo, workflowName: string) => void;
  'step:complete': (step: WorkflowStep, response: AgentResponse, instruction: string) => void;
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
  'step:report': (step: WorkflowStep, filePath: string, fileName: string) => void;
  'findings:ledger': (ledger: FindingLedger) => void;
  'step:blocked': (step: WorkflowStep, response: AgentResponse) => void;
  'step:rate_limited': (step: WorkflowStep, response: AgentResponse, rateLimitInfo: AgentResponse['rateLimitInfo']) => void;
  'step:user_input': (step: WorkflowStep, userInput: string) => void;
  'phase:start': (
    step: WorkflowStep,
    phase: 1 | 2 | 3,
    phaseName: PhaseName,
    instruction: string,
    promptParts: PhasePromptParts,
    phaseExecutionId?: string,
    iteration?: number,
  ) => void;
  'phase:complete': (
    step: WorkflowStep,
    phase: 1 | 2 | 3,
    phaseName: PhaseName,
    content: string,
    status: string,
    error?: string,
    phaseExecutionId?: string,
    iteration?: number,
  ) => void;
  'phase:judge_stage': (
    step: WorkflowStep,
    phase: 3,
    phaseName: 'judge',
    entry: JudgeStageEntry,
    phaseExecutionId?: string,
    iteration?: number,
  ) => void;
  'workflow:complete': (state: WorkflowState) => void;
  'workflow:abort': (state: WorkflowState, reason: string) => void;
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

/** Options for workflow engine */
export interface WorkflowEngineOptions {
  abortSignal?: AbortSignal;
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
  /** Resolved automatic provider/model routing configuration */
  autoRouting?: AutoRoutingConfig;
  /** Run-scoped strategy override for automatic provider/model routing. */
  autoStrategyOverride?: AutoRoutingStrategy;
  onEffectiveAutoRoutingReached?: () => void;
  /** Run-scoped AI router for automatic provider/model routing. */
  autoRoutingAiRouter?: AutoRoutingAiRouter;
  /** Source layer for resolved provider options */
  providerOptionsSource?: ProviderOptionsSource;
  /** Nested origin resolver for provider options traced-config values */
  providerOptionsOriginResolver?: ProviderOptionsOriginResolver;
  /** Per-persona provider and model overrides (e.g., { coder: { provider: 'codex', model: 'o3-mini' } }) */
  personaProviders?: Record<string, PersonaProviderEntry>;
  /** Provider routing by raw persona key, workflow step tag, and workflow step name */
  providerRouting?: ProviderRoutingConfig;
  /** Resolved provider permission profiles */
  providerProfiles?: ProviderPermissionProfiles;
  /** Enable interactive-only rules and user-input transitions */
  interactive?: boolean;
  /** Rule tag index detector (required for rules evaluation) */
  detectRuleIndex?: RuleIndexDetector;
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
  phase1ProcessSafetyByStep?: Record<string, { protectedParentRunPid: number }>;
  systemStepServicesFactory?: SystemStepServicesFactory;
  sharedRuntime?: WorkflowSharedRuntimeState;
  resumeStackPrefix?: WorkflowResumePointEntry[];
  workflowCallResolver?: WorkflowCallResolver;
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

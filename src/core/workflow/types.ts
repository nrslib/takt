/**
 * Workflow engine type definitions
 *
 * Contains types for workflow events, requests, and callbacks
 * used by the workflow execution engine.
 */

import type { PermissionResult, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import type {
  WorkflowStep,
  AgentResponse,
  WorkflowState,
  Language,
  LoopMonitorConfig,
  WorkflowConfig,
  WorkflowResumePoint,
  WorkflowResumePointEntry,
} from '../models/types.js';
import type { PersonaProviderEntry } from '../models/config-types.js';
import type { ProviderPermissionProfiles } from '../models/provider-profiles.js';
import type { StepProviderOptions } from '../models/workflow-types.js';
import type { StructuredCaller } from '../../agents/structured-caller.js';
import type { SystemStepServicesFactory } from './system/system-step-services.js';

// Re-export shared provider protocol types to maintain backward compatibility.
// The canonical definitions live in shared/types/provider.ts so that shared-layer
// modules (StreamDisplay, providerEventLogger) can import them without creating
// an upward shared → core dependency.
import type {
  ProviderType,
  StreamCallback,
} from '../../shared/types/provider.js';
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

export type ProviderOptionsSource = 'env' | 'project' | 'global' | 'default';
export type ProviderOptionsTraceOrigin = 'env' | 'cli' | 'local' | 'global' | 'default';
export type ProviderOptionsOriginResolver = (path: string) => ProviderOptionsTraceOrigin;

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
}

/** Provider and model info resolved for a step */
export interface StepProviderInfo {
  provider: ProviderType | undefined;
  model: string | undefined;
}

export interface TeamLeaderPartRuntimeResolution {
  partAllowedTools?: string[];
}

export interface RuntimeStepResolution {
  providerInfo?: StepProviderInfo;
  teamLeaderPart?: TeamLeaderPartRuntimeResolution;
}

export interface WorkflowSharedRuntimeState {
  startedAtMs: number;
  activeResumePoint?: WorkflowResumePoint;
  maxSteps?: number;
}

export type WorkflowAbortKind =
  | 'interrupt'
  | 'iteration_limit'
  | 'loop_detected'
  | 'blocked'
  | 'step_error'
  | 'user_input_required'
  | 'user_input_cancelled'
  | 'step_transition'
  | 'runtime_error';

export interface WorkflowAbortResult {
  kind: WorkflowAbortKind;
  reason: string;
}

export interface WorkflowRunResult {
  state: WorkflowState;
  abort?: WorkflowAbortResult;
}

export interface WorkflowCallChildEngine {
  on: (event: string, listener: (...args: unknown[]) => void) => void;
  runWithResult: () => Promise<WorkflowRunResult>;
}

export interface WorkflowCallResolutionRequest {
  parentWorkflow: WorkflowConfig;
  identifier: string;
  stepName: string;
  projectCwd: string;
  lookupCwd: string;
}

export type WorkflowCallResolver = (request: WorkflowCallResolutionRequest) => WorkflowConfig | null;

/** Events emitted by workflow engine */
export interface WorkflowEvents {
  'step:start': (step: WorkflowStep, iteration: number, instruction: string, providerInfo: StepProviderInfo) => void;
  'step:complete': (step: WorkflowStep, response: AgentResponse, instruction: string) => void;
  'step:report': (step: WorkflowStep, filePath: string, fileName: string) => void;
  'step:blocked': (step: WorkflowStep, response: AgentResponse) => void;
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

/** Callback for session updates (when persona session IDs change) */
export type SessionUpdateCallback = (persona: string, sessionId: string) => void;

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
  /** Callback when iteration limit is reached - returns additional iterations or null to stop */
  onIterationLimit?: IterationLimitCallback;
  /** Bypass all permission checks */
  bypassPermissions?: boolean;
  /** Project root directory (where .takt/ lives). */
  projectCwd: string;
  /** Language for instruction metadata. Defaults to 'en'. */
  language?: Language;
  provider?: ProviderType;
  model?: string;
  /** Resolved provider options */
  providerOptions?: StepProviderOptions;
  /** Source layer for resolved provider options */
  providerOptionsSource?: ProviderOptionsSource;
  /** Nested origin resolver for provider options traced-config values */
  providerOptionsOriginResolver?: ProviderOptionsOriginResolver;
  /** Per-persona provider and model overrides (e.g., { coder: { provider: 'codex', model: 'o3-mini' } }) */
  personaProviders?: Record<string, PersonaProviderEntry>;
  /** Resolved provider permission profiles */
  providerProfiles?: ProviderPermissionProfiles;
  /** Enable interactive-only rules and user-input transitions */
  interactive?: boolean;
  /** Rule tag index detector (required for rules evaluation) */
  detectRuleIndex?: RuleIndexDetector;
  /** Structured caller (required for rule evaluation and status/decomposition flows) */
  structuredCaller?: StructuredCaller;
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
  maxStepsOverride?: number;
  /** Current task metadata for system-step context resolution */
  currentTask?: {
    issueNumber?: number;
  };
  systemStepServicesFactory?: SystemStepServicesFactory;
  sharedRuntime?: WorkflowSharedRuntimeState;
  resumeStackPrefix?: WorkflowResumePointEntry[];
  workflowCallResolver?: WorkflowCallResolver;
}

/** Loop detection result */
export interface LoopCheckResult {
  isLoop: boolean;
  count: number;
  shouldAbort: boolean;
  shouldWarn?: boolean;
}

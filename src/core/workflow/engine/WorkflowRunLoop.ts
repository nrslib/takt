import { createLogger, getErrorMessage } from '../../../shared/utils/index.js';
import type {
  AgentResponse,
  FallbackContext,
  FallbackOperationOrigin,
  LoopMonitorConfig,
  RateLimitFallbackProvider,
  WorkflowMaxSteps,
  WorkflowState,
  WorkflowStep,
} from '../../models/types.js';
import { ABORT_STEP, COMPLETE_STEP, ERROR_MESSAGES } from '../constants.js';
import type {
  RuntimeStepResolution,
  StepProviderInfo,
  StepRunResult,
  WorkflowAbortKind,
  WorkflowAbortResult,
  WorkflowEngineOptions,
  WorkflowRunResult,
  WorkflowStepFailureSummary,
} from '../types.js';
import type { WorkflowRuleTransition } from './transitions.js';
import { decrementStepIteration } from './state-manager.js';
import { handleBlocked } from './blocked-handler.js';
import { getWorkflowStepKind, isDelegatedWorkflowStep } from '../step-kind.js';
import { resolvePromotionRuntime } from '../promotion/promotion-runtime.js';
import { createRoutingScope, resolveAutoRoutingRuntime } from '../auto-routing/resolver.js';
import { buildRoutingWorkSnapshot } from '../auto-routing/snapshot.js';
import { runWithStepSpan, type StepSpanParams } from '../observability/workflowSpans.js';
import type { QualityGateRunResult } from '../quality-gates/types.js';
import { RuleDetectionExhaustedError } from '../evaluation/RuleDetectionExhaustedError.js';
import type { PreparedNormalStepExecution } from './StepExecutor.js';
import type { WorkflowCallExecutionToken } from './WorkflowCallRunner.js';
import { requireWorkflowResumeStackSnapshot } from '../run/resume-point.js';
import { createRunFailure } from '../run/run-failure.js';
import {
  reviewerOperationOrigin,
  sameFallbackOperationOrigin,
} from './fallback-operation.js';
import {
  isAgentFailureError,
  isProviderStreamParseError,
} from '../../../shared/types/agent-failure.js';

const log = createLogger('workflow-run-loop');

interface SingleWorkflowIterationResult {
  response: AgentResponse;
  nextStep: string;
  isComplete: boolean;
  returnValue?: string;
  loopDetected?: boolean;
  abort?: WorkflowAbortResult;
}

interface WorkflowRunLoopDeps {
  state: WorkflowState;
  options: WorkflowEngineOptions;
  getWorkflowName: () => string;
  getTask: () => string;
  getCurrentWorkflowStack: () => StepSpanParams['workflowStack'];
  getCwd: () => string;
  getMaxSteps: () => WorkflowMaxSteps;
  getReportDir: () => string;
  abortRequested: () => boolean;
  getStep: (name: string) => WorkflowStep;
  applyRuntimeEnvironment: (stage: 'step') => void;
  loopDetectorCheck: (stepName: string) => { shouldWarn?: boolean; shouldAbort?: boolean; count: number; isLoop: boolean };
  cycleDetectorRecordAndCheck: (stepName: string, nextStep: string) => { triggered: boolean; monitor?: LoopMonitorConfig; cycleCount: number };
  resolveDoneTransition: (step: WorkflowStep, response: AgentResponse) => WorkflowRuleTransition;
  runLoopMonitorJudge: (
    monitor: LoopMonitorConfig,
    cycleCount: number,
    triggeringStep: WorkflowStep,
    triggeringRuntime: RuntimeStepResolution | undefined,
    fallbackNextStep: string,
  ) => Promise<string>;
  runStep: (
    step: WorkflowStep,
    prebuiltInstruction?: string,
    runtime?: RuntimeStepResolution,
    stepIteration?: number,
    preparedExecution?: PreparedNormalStepExecution,
    workflowCallExecution?: WorkflowCallExecutionToken,
  ) => Promise<StepRunResult>;
  runQualityGates: (options: {
    qualityGates: WorkflowStep['qualityGates'];
    projectRoot: string;
    step: WorkflowStep;
    childProcessEnv?: Readonly<Record<string, string>>;
  }) => Promise<QualityGateRunResult>;
  persistPreviousResponseSnapshot: (
    state: WorkflowState,
    stepName: string,
    stepIteration: number,
    content: string,
  ) => void;
  buildInstruction: (
    step: WorkflowStep,
    stepIteration: number,
    fallbackContext?: FallbackContext,
  ) => string;
  buildPhase1Instruction: (step: WorkflowStep, instruction: string, runtime?: RuntimeStepResolution) => string;
  /** Engine が通常 agent ステップに渡す、実行前に一度だけ確定した入力。 */
  prepareNormalStepExecution: (
    step: WorkflowStep,
    stepIteration: number,
    runtime?: RuntimeStepResolution,
  ) => Promise<PreparedNormalStepExecution | undefined>;
  resolveStepProviderModel: (step: WorkflowStep, runtime?: RuntimeStepResolution) => StepProviderInfo;
  /** auto-routing ルーター・promotion 評価への入力専用（補完前の解決）。 */
  resolveStepProviderModelBeforeAutoRouting: (step: WorkflowStep, runtime?: RuntimeStepResolution) => StepProviderInfo;
  resolveRuntimeForStep: (step: WorkflowStep) => RuntimeStepResolution | undefined;
  claimStepOccurrence: (step: WorkflowStep) => number;
  setActiveStep: (
    step: WorkflowStep,
    iteration: number,
    occurrence: number,
  ) => WorkflowCallExecutionToken | undefined;
  cancelPendingStepActivation: () => void;
  addUserInput: (input: string) => void;
  emit: (event: string, ...args: unknown[]) => void;
  updateMaxSteps: (maxSteps: number) => void;
}

async function resolveStepPromotionRuntime(
  deps: WorkflowRunLoopDeps,
  step: WorkflowStep,
  stepIteration: number | undefined,
  runtime: RuntimeStepResolution | undefined,
): Promise<RuntimeStepResolution | undefined> {
  return resolvePromotionRuntime({
    cwd: deps.getCwd(),
    previousResponseContent: deps.state.lastOutput?.content ?? '',
    structuredCaller: deps.options.structuredCaller,
    childProcessEnv: deps.options.childProcessEnv,
    resolveStepProviderModel: deps.resolveStepProviderModelBeforeAutoRouting,
    providerLadders: deps.options.providerLadders,
    providerRoutingTagConflictPolicy: deps.options.providerRoutingTagConflictPolicy,
  }, step, stepIteration, runtime);
}

async function resolveStepAutoRoutingRuntime(
  deps: WorkflowRunLoopDeps,
  step: WorkflowStep,
  runtime: RuntimeStepResolution | undefined,
  routingInstruction: string | undefined,
): Promise<RuntimeStepResolution | undefined> {
  if (
    !deps.options.autoRouting
    || runtime?.fallback
    || getWorkflowStepKind(step) !== 'agent'
    || (isDelegatedWorkflowStep(step) && step.arpeggio === undefined)
    || step.parallel
  ) {
    return runtime;
  }

  const currentProviderInfo = deps.resolveStepProviderModelBeforeAutoRouting(step, runtime);
  const autoRuntime = await resolveAutoRoutingRuntime({
    autoRouting: deps.options.autoRouting,
    scope: createRoutingScope({
      workflow: deps.getWorkflowName(),
      parentStep: step.name,
      workItem: step.name,
    }),
    step: {
      name: step.name,
      tags: step.tags,
      personaKey: step.providerRoutingPersonaKey,
      instruction: routingInstruction,
    },
    snapshot: buildRoutingWorkSnapshot({
      goal: deps.getTask(),
      userInputs: deps.state.userInputs,
      retryNote: deps.options.retryNote,
      step: {
        name: step.name,
        tags: step.tags ?? [],
        personaKey: step.providerRoutingPersonaKey,
        instruction: routingInstruction,
        stepType: 'normal',
        edit: step.edit,
        passPreviousResponse: step.passPreviousResponse === true,
      },
      lastOutput: deps.state.lastOutput?.content,
      sensitiveValues: deps.options.routingSensitiveValues,
    }),
    currentProviderInfo,
    estimator: deps.options.autoRoutingEstimator,
    runtime: deps.options.routingRuntime,
    logger: log,
    abortSignal: deps.options.abortSignal,
  });
  if (!autoRuntime) {
    return runtime;
  }
  return {
    ...runtime,
    ...autoRuntime,
  };
}

function emitNormalRoutingDecision(
  deps: WorkflowRunLoopDeps,
  step: WorkflowStep,
  response: AgentResponse,
  instruction: string,
  providerInfo: StepProviderInfo,
  durationMs: number,
  iteration: number,
): void {
  if (isDelegatedWorkflowStep(step) || providerInfo.autoRoutingDecision === undefined) {
    return;
  }
  deps.emit(
    'routing:decision',
    step,
    response,
    instruction,
    providerInfo,
    'normal',
    durationMs,
    iteration,
    deps.getWorkflowName(),
  );
}

function recordNormalRoutingResult(
  deps: WorkflowRunLoopDeps,
  step: WorkflowStep,
  providerInfo: StepProviderInfo,
  response: AgentResponse,
): void {
  if (providerInfo.autoRoutingDecision === undefined) {
    return;
  }
  const scope = createRoutingScope({
    workflow: deps.getWorkflowName(),
    parentStep: step.name,
    workItem: step.name,
  });
  if (!deps.options.routingRuntime?.hasResolution(scope)) {
    return;
  }
  deps.options.routingRuntime.recordExecutionResult({
    scope,
    status: response.status === 'done' ? 'done' : 'failed',
  });
}

function sameFallbackProvider(
  candidate: RateLimitFallbackProvider,
  current: { provider?: StepProviderInfo['provider']; model?: StepProviderInfo['model'] },
): boolean {
  if (candidate.provider !== current.provider) {
    return false;
  }
  if (candidate.model === undefined) {
    return true;
  }
  return candidate.model === current.model;
}

function pickNextFallbackProvider(
  switchChain: readonly RateLimitFallbackProvider[] | undefined,
  current: StepProviderInfo,
  attempted: readonly RateLimitFallbackProvider[],
): RateLimitFallbackProvider | undefined {
  if (!switchChain || switchChain.length === 0) {
    return undefined;
  }
  return switchChain.find((candidate) => (
    !sameFallbackProvider(candidate, current)
    && !attempted.some((tried) => sameFallbackProvider(candidate, tried))
  ));
}

function toFallbackProvider(providerInfo: StepProviderInfo): RateLimitFallbackProvider {
  if (!providerInfo.provider) {
    throw new Error('Resolved provider is required for rate limit fallback');
  }
  return {
    provider: providerInfo.provider,
    ...(providerInfo.model !== undefined ? { model: providerInfo.model } : {}),
  };
}

function appendFallbackAttempt(
  attempted: readonly RateLimitFallbackProvider[],
  providerInfo: StepProviderInfo,
): RateLimitFallbackProvider[] {
  const current = toFallbackProvider(providerInfo);
  if (attempted.some((tried) => sameFallbackProvider(current, tried))) {
    return [...attempted];
  }
  return [...attempted, current];
}

function buildFallbackContext(
  deps: WorkflowRunLoopDeps,
  step: WorkflowStep,
  response: AgentResponse,
  current: StepProviderInfo,
  fallback: RateLimitFallbackProvider,
  originalIteration: number,
  origin: FallbackOperationOrigin,
): FallbackContext {
  if (!current.provider) {
    throw new Error(`Step "${step.name}" has no resolved provider for rate limit fallback`);
  }
  return {
    reason: 'rate_limited',
    reasonDetail: response.error ?? 'Rate limit exceeded',
    originalIteration,
    previousProvider: current.provider,
    ...(current.model !== undefined ? { previousModel: current.model } : {}),
    currentProvider: fallback.provider,
    ...(fallback.model !== undefined ? { currentModel: fallback.model } : {}),
    stepName: step.name,
    reportDir: deps.getReportDir(),
    origin,
  };
}

function withFallbackRuntime(
  state: WorkflowState,
  step: WorkflowStep,
  runtime: RuntimeStepResolution | undefined,
): RuntimeStepResolution | undefined {
  if (!state.pendingFallback) {
    return runtime;
  }
  const fallback = state.pendingFallback;
  if (
    fallback.origin.stage === 'reviewer'
    && fallback.origin.reviewerStepName === step.name
  ) {
    return {
      ...runtime,
      providerInfo: {
        provider: fallback.currentProvider,
        model: fallback.currentModel,
        providerSource: 'step',
        modelSource: fallback.currentModel !== undefined ? 'step' : undefined,
      },
      fallback,
    };
  }
  return {
    ...runtime,
    fallback,
  };
}

function settleFallbackAttempt(
  state: WorkflowState,
  runtime: RuntimeStepResolution | undefined,
  status: AgentResponse['status'],
): void {
  if (runtime?.fallback === undefined) {
    return;
  }
  state.pendingFallback = undefined;
  if (status !== 'rate_limited') {
    state.rateLimitFallbackState = undefined;
  }
}

function advanceActiveStep(deps: WorkflowRunLoopDeps, nextStep: string, iteration: number): void {
  const resolvedStep = deps.getStep(nextStep);
  // The engine-synthesized finding-conflict-adjudication step resolves its
  // return-to-origin transition from this record (see
  // WorkflowEngineStepCoordinator.resolveTransitionFromDone).
  deps.state.previousStep = deps.state.currentStep;
  deps.state.currentStep = nextStep;
  const nextOccurrence = (deps.state.stepIterations.get(nextStep) ?? 0) + 1;
  deps.setActiveStep(resolvedStep, iteration, nextOccurrence);
}

function buildWorkflowAbortResult(
  kind: WorkflowAbortKind,
  stepName: string,
  reason: string,
  error: string,
  failureCategory?: AgentResponse['failureCategory'],
): WorkflowAbortResult {
  const failure = createRunFailure({
    kind,
    step: stepName,
    reason,
    error,
    ...(failureCategory === undefined ? {} : { failureCategory }),
  });
  return {
    kind,
    reason: failure.reason,
    failure,
  };
}

function abortWorkflow(
  deps: WorkflowRunLoopDeps,
  kind: WorkflowAbortKind,
  reason: string,
  options: {
    clearLastOutput?: boolean;
    failureError?: string;
    failureCategory?: AgentResponse['failureCategory'];
    failure?: WorkflowStepFailureSummary;
  } = {},
): WorkflowAbortResult {
  deps.state.status = 'aborted';
  if (options.clearLastOutput) {
    deps.state.lastOutput = undefined;
  }
  const failureError = options.failureError === undefined
    ? reason
    : options.failureError;
  const result = options.failure === undefined
    ? buildWorkflowAbortResult(
        kind,
        deps.state.currentStep,
        reason,
        failureError,
        options.failureCategory,
      )
    : {
        kind: options.failure.kind,
        reason: options.failure.reason,
        failure: options.failure,
      };
  deps.emit('workflow:abort', deps.state, result.reason, result.kind, result.failure);
  return result;
}

function abortWorkflowRuntimeError(deps: WorkflowRunLoopDeps, error: unknown): WorkflowAbortResult {
  if (workflowInterruptRequested(deps)) {
    return abortInterruptedWorkflow(deps);
  }
  if (error instanceof RuleDetectionExhaustedError) {
    const reason = 'rule_no_match';
    return abortWorkflow(deps, 'rule_no_match', reason, {
      clearLastOutput: true,
      failure: createRunFailure({
        kind: 'rule_no_match',
        step: error.stepName,
        reason,
        error: reason,
      }),
    });
  }
  if (isProviderStreamParseError(error)) {
    const failureError = error.message;
    return abortWorkflow(
      deps,
      'step_error',
      failureError,
      {
        clearLastOutput: true,
        failureError,
        failureCategory: error.failureCategory,
      },
    );
  }
  if (isAgentFailureError(error)) {
    return abortWorkflow(
      deps,
      'step_error',
      error.reason,
      {
        clearLastOutput: true,
        failureError: error.reason,
        failureCategory: error.failureCategory,
      },
    );
  }
  const errorMessage = getErrorMessage(error);
  return abortWorkflow(
    deps,
    'runtime_error',
    ERROR_MESSAGES.STEP_EXECUTION_FAILED(errorMessage),
    { clearLastOutput: true, failureError: errorMessage },
  );
}

function workflowInterruptRequested(deps: WorkflowRunLoopDeps): boolean {
  return workflowInterruptReason(deps) !== undefined;
}

function workflowInterruptReason(deps: WorkflowRunLoopDeps): string | undefined {
  if (deps.abortRequested()) {
    return 'Workflow interrupted by user (SIGINT)';
  }
  if (deps.options.abortSignal?.aborted === true) {
    return 'Workflow interrupted by external AbortSignal';
  }
  return undefined;
}

function abortInterruptedWorkflow(deps: WorkflowRunLoopDeps): WorkflowAbortResult {
  const reason = workflowInterruptReason(deps);
  if (reason === undefined) {
    throw new Error('Cannot abort workflow as interrupted without an interrupt request');
  }
  return abortWorkflow(deps, 'interrupt', reason, {
    clearLastOutput: true,
  });
}

function buildInterruptedIterationResult(
  deps: WorkflowRunLoopDeps,
  step: WorkflowStep,
  loopDetected?: boolean,
): SingleWorkflowIterationResult {
  const abort = abortInterruptedWorkflow(deps);
  return {
    response: {
      persona: step.persona ?? step.name,
      status: 'blocked',
      content: abort.reason,
      timestamp: new Date(),
    },
    nextStep: ABORT_STEP,
    isComplete: true,
    ...(loopDetected !== undefined ? { loopDetected } : {}),
    abort,
  };
}

function finalizeCompletion(deps: WorkflowRunLoopDeps): void {
  deps.state.status = 'completed';
}

type TerminalTransitionResult =
  | { handled: false }
  | {
      handled: true;
      transitionAccepted: boolean;
      abort?: WorkflowAbortResult;
    };

function abortStepTransition(
  deps: WorkflowRunLoopDeps,
  workflowCallFailure?: WorkflowStepFailureSummary,
): WorkflowAbortResult {
  if (workflowCallFailure === undefined) {
    return abortWorkflow(
      deps,
      'step_transition',
      'Workflow aborted by step transition',
    );
  }
  return abortWorkflow(
    deps,
    workflowCallFailure.kind,
    workflowCallFailure.reason,
    { failure: workflowCallFailure },
  );
}

function abortStepError(
  deps: WorkflowRunLoopDeps,
  step: WorkflowStep,
  result: StepRunResult,
): WorkflowAbortResult {
  if (result.workflowCallFailure !== undefined) {
    return abortWorkflow(
      deps,
      result.workflowCallFailure.kind,
      result.workflowCallFailure.reason,
      { failure: result.workflowCallFailure },
    );
  }
  const failureError = result.response.error ?? result.response.content;
  if (result.response.failureCategory !== undefined) {
    return abortWorkflow(
      deps,
      'step_error',
      failureError,
      { failureError, failureCategory: result.response.failureCategory },
    );
  }
  return abortWorkflow(
    deps,
    'step_error',
    `Step "${step.name}" failed: ${failureError}`,
    { failureError },
  );
}

function handleTerminalTransition(
  deps: WorkflowRunLoopDeps,
  nextStep: string,
  workflowCallFailure?: WorkflowStepFailureSummary,
): TerminalTransitionResult {
  if (nextStep === COMPLETE_STEP) {
    finalizeCompletion(deps);
    deps.emit('workflow:complete', deps.state);
    return { handled: true, transitionAccepted: true };
  }
  if (nextStep === ABORT_STEP) {
    return {
      handled: true,
      transitionAccepted: true,
      abort: abortStepTransition(deps, workflowCallFailure),
    };
  }
  return { handled: false };
}

function validateUserInputRuntime(
  deps: WorkflowRunLoopDeps,
  step: WorkflowStep,
): WorkflowAbortResult | undefined {
  if (step.requiresUserInput !== true) {
    return undefined;
  }
  if (deps.options.interactive !== true) {
    return abortWorkflow(
      deps,
      'user_input_required',
      `Step "${step.name}" requires interactive user input but workflow interactive mode is disabled`,
    );
  }
  if (!deps.options.onUserInput) {
    return abortWorkflow(
      deps,
      'user_input_required',
      `Step "${step.name}" requires user input but no handler is configured`,
    );
  }
  return undefined;
}

function prepareRateLimitFallback(
  deps: WorkflowRunLoopDeps,
  step: WorkflowStep,
  response: AgentResponse,
  currentProvider: StepProviderInfo,
  origin: FallbackOperationOrigin,
  activeIteration: number,
  consumedStepIterations: readonly string[],
): { queued: true } | { queued: false; abort: WorkflowAbortResult } {
  deps.emit('step:rate_limited', step, response, response.rateLimitInfo);
  const previousAttempts = deps.state.rateLimitFallbackState !== undefined
    && sameFallbackOperationOrigin(deps.state.rateLimitFallbackState.origin, origin)
    ? deps.state.rateLimitFallbackState.attempts
    : [];
  const currentAttempts = appendFallbackAttempt(previousAttempts, currentProvider);
  const fallback = pickNextFallbackProvider(
    deps.options.rateLimitFallback?.switchChain,
    currentProvider,
    currentAttempts,
  );
  if (!fallback) {
    deps.state.rateLimitFallbackState = undefined;
    return {
      queued: false,
      abort: abortWorkflow(deps, 'rate_limited', `Step "${step.name}" hit a rate limit and no fallback provider is configured`),
    };
  }

  deps.state.rateLimitFallbackState = {
    origin,
    attempts: [...currentAttempts, fallback],
  };
  deps.state.pendingFallback = buildFallbackContext(
    deps,
    step,
    response,
    currentProvider,
    fallback,
    activeIteration,
    origin,
  );
  deps.state.iteration--;
  for (const stepName of new Set(consumedStepIterations)) {
    decrementStepIteration(deps.state, stepName);
  }
  return { queued: true };
}

function requireNextStep(step: WorkflowStep, transition: WorkflowRuleTransition): string {
  if (transition.nextStep) {
    return transition.nextStep;
  }
  throw new Error(`Step "${step.name}" resolved to a return transition where a next step is required`);
}

function applyQualityGateFailure(
  deps: WorkflowRunLoopDeps,
  step: WorkflowStep,
  stepIteration: number,
  response: AgentResponse,
): void {
  deps.state.stepOutputs.set(step.name, response);
  deps.state.lastOutput = response;
  deps.state.currentStep = step.name;
  deps.persistPreviousResponseSnapshot(deps.state, step.name, stepIteration, response.content);
}

function resolveQualityGateSnapshotIteration(
  state: WorkflowState,
  step: WorkflowStep,
  stepIteration: number | undefined,
): number {
  if (stepIteration !== undefined) {
    return stepIteration;
  }
  const currentIteration = state.stepIterations.get(step.name);
  if (currentIteration !== undefined) {
    return currentIteration;
  }
  throw new Error(`Step "${step.name}" completed without a step iteration for quality gate feedback`);
}

export async function runWorkflowToCompletion(deps: WorkflowRunLoopDeps): Promise<WorkflowRunResult> {
  try {
    return await runWorkflowToCompletionCore(deps);
  } finally {
    deps.cancelPendingStepActivation();
  }
}

async function runWorkflowToCompletionCore(deps: WorkflowRunLoopDeps): Promise<WorkflowRunResult> {
  let abort: WorkflowAbortResult | undefined;
  let returnValue: string | undefined;

  while (deps.state.status === 'running') {
    if (workflowInterruptRequested(deps)) {
      abort = abortInterruptedWorkflow(deps);
      break;
    }

    const step = deps.getStep(deps.state.currentStep);
    const consumesIterationBudget = getWorkflowStepKind(step) !== 'workflow_call';
    const maxSteps = deps.getMaxSteps();
    if (
      consumesIterationBudget
      &&
      deps.options.ignoreIterationLimit !== true
      && typeof maxSteps === 'number'
      && deps.state.iteration >= maxSteps
    ) {
      deps.emit('iteration:limit', deps.state.iteration, maxSteps);

      if (deps.options.onIterationLimit) {
        const additionalIterations = await deps.options.onIterationLimit({
          currentIteration: deps.state.iteration,
          maxSteps,
          currentStep: deps.state.currentStep,
        });
        if (additionalIterations !== null && additionalIterations > 0) {
          deps.updateMaxSteps(maxSteps + additionalIterations);
          continue;
        }
      }

      abort = abortWorkflow(deps, 'iteration_limit', ERROR_MESSAGES.MAX_STEPS_REACHED);
      break;
    }

    const userInputRuntimeAbort = validateUserInputRuntime(deps, step);
    if (userInputRuntimeAbort) {
      abort = userInputRuntimeAbort;
      break;
    }
    deps.applyRuntimeEnvironment('step');
    const loopCheck = deps.loopDetectorCheck(step.name);

    if (loopCheck.shouldWarn) {
      deps.emit('step:loop_detected', step, loopCheck.count);
    }
    if (loopCheck.shouldAbort) {
      abort = abortWorkflow(deps, 'loop_detected', ERROR_MESSAGES.LOOP_DETECTED(step.name, loopCheck.count));
      break;
    }

    if (consumesIterationBudget) {
      deps.state.iteration++;
    }
    const isDelegated = isDelegatedWorkflowStep(step);
    const activeIteration = deps.state.iteration;
    const stepIteration = deps.claimStepOccurrence(step);
    let workflowCallExecution: WorkflowCallExecutionToken | undefined;
    try {
      workflowCallExecution = deps.setActiveStep(step, activeIteration, stepIteration);
    } catch (error) {
      abort = abortWorkflowRuntimeError(deps, error);
      break;
    }
    let stepRuntime: RuntimeStepResolution | undefined;
    let preparedExecution: PreparedNormalStepExecution | undefined;
    let executionStep: WorkflowStep;
    let prebuiltInstruction: string | undefined;
    let stepInstruction: string;
    let providerInfo: StepProviderInfo;
    let stepEventWorkflowStack: StepSpanParams['workflowStack'];
    try {
      const baseStepRuntime = deps.resolveRuntimeForStep(step);
      const promotedRuntime = await resolveStepPromotionRuntime(
        deps,
        step,
        isDelegated ? undefined : stepIteration,
        baseStepRuntime,
      );
      const fallbackRuntime = withFallbackRuntime(deps.state, step, promotedRuntime);
      stepRuntime = await resolveStepAutoRoutingRuntime(deps, step, fallbackRuntime, step.instruction);
      preparedExecution = await deps.prepareNormalStepExecution(step, stepIteration, stepRuntime);
      executionStep = preparedExecution?.executableStep ?? step;
      prebuiltInstruction = preparedExecution === undefined && !isDelegated
        ? deps.buildInstruction(step, stepIteration, stepRuntime?.fallback)
        : undefined;
      stepInstruction = preparedExecution?.phase1Instruction
        ?? (prebuiltInstruction
        ? deps.buildPhase1Instruction(step, prebuiltInstruction, stepRuntime)
        : '');
      providerInfo = deps.resolveStepProviderModel(executionStep, stepRuntime);
      stepEventWorkflowStack = requireWorkflowResumeStackSnapshot(
        deps.getCurrentWorkflowStack(),
      );
    } catch (error) {
      workflowCallExecution?.fail(error);
      if (workflowInterruptRequested(deps)) {
        abort = abortInterruptedWorkflow(deps);
        break;
      }
      abort = abortWorkflowRuntimeError(deps, error);
      break;
    }
    if (workflowInterruptRequested(deps)) {
      workflowCallExecution?.cancel();
      abort = abortInterruptedWorkflow(deps);
      break;
    }
    if (consumesIterationBudget) {
      deps.emit(
        'step:start',
        executionStep,
        activeIteration,
        stepInstruction,
        providerInfo,
        deps.getWorkflowName(),
        step.name,
        stepIteration,
        stepEventWorkflowStack,
      );
    }

    try {
      const startedAt = Date.now();
      const executeStep = () => deps.runStep(
        step,
        prebuiltInstruction,
        stepRuntime,
        stepIteration,
        preparedExecution,
        workflowCallExecution,
      );
      const result = consumesIterationBudget
        ? await runWithStepSpan({
            enabled: deps.options.observability?.enabled === true,
            runId: deps.options.observabilityRunId,
            workflowName: deps.getWorkflowName(),
            step: executionStep,
            iteration: activeIteration,
            stepIteration,
            instruction: stepInstruction,
            workflowStack: stepEventWorkflowStack,
            sanitizeText: deps.options.sanitizeObservabilityText,
            providerInfo,
            getFinalStepIteration: () => deps.state.stepIterations.get(step.name),
            traceTaskMetadata: deps.options.traceTaskMetadata,
          }, executeStep)
        : await executeStep();
      if (workflowInterruptRequested(deps)) {
        abort = abortInterruptedWorkflow(deps);
        break;
      }
      const { response, instruction, providerInfo: resultProviderInfo } = result;
      const completedProviderInfo = resultProviderInfo ?? providerInfo;
      if (consumesIterationBudget) {
        recordNormalRoutingResult(deps, step, completedProviderInfo, response);
        emitNormalRoutingDecision(
          deps,
          step,
          response,
          instruction,
          completedProviderInfo,
          Math.max(0, Date.now() - startedAt),
          activeIteration,
        );
        settleFallbackAttempt(deps.state, stepRuntime, response.status);
        deps.emit(
          'step:complete',
          executionStep,
          response,
          instruction,
          step.name,
          stepEventWorkflowStack,
        );
      }

      if (response.status === 'rate_limited') {
        const terminalOperation = result.terminalOperation ?? {
          origin: reviewerOperationOrigin(step.name),
          providerInfo: completedProviderInfo,
        };
        const consumedStepIterations = result.consumedStepIterations ?? [step.name];
        const fallbackResult = prepareRateLimitFallback(
          deps,
          step,
          response,
          terminalOperation.providerInfo,
          terminalOperation.origin,
          activeIteration,
          consumedStepIterations,
        );
        if (!fallbackResult.queued) {
          abort = fallbackResult.abort;
          break;
        }
        continue;
      }

      if (result.qualityGateFailure) {
        applyQualityGateFailure(
          deps,
          step,
          result.qualityGateFailure.stepIteration,
          result.qualityGateFailure.response,
        );
        continue;
      }

      if (response.status === 'blocked') {
        deps.emit('step:blocked', step, response);
        const result = await handleBlocked(step, response, deps.options);
        if (result.kind === 'continued') {
          deps.addUserInput(result.userInput);
          deps.emit('step:user_input', step, result.userInput);
          continue;
        }
        abort = result.kind === 'cancelled'
          ? abortWorkflow(deps, 'user_input_cancelled', 'User input cancelled')
          : abortWorkflow(
              deps,
              'blocked',
              'Workflow blocked and no user input provided',
            );
        break;
      }

      if (response.status === 'error') {
        abort = abortStepError(deps, step, result);
        break;
      }

      const qualityGateResult = await deps.runQualityGates({
        qualityGates: step.qualityGates,
        projectRoot: deps.getCwd(),
        step,
        childProcessEnv: deps.options.childProcessEnv,
      });
      if (!qualityGateResult.ok) {
        applyQualityGateFailure(
          deps,
          step,
          resolveQualityGateSnapshotIteration(deps.state, step, stepIteration),
          qualityGateResult.response,
        );
        continue;
      }

      const transition = deps.resolveDoneTransition(step, response);
      if (transition.requiresUserInput) {
        if (!deps.options.onUserInput) {
          abort = abortWorkflow(deps, 'user_input_required', 'User input required but no handler is configured');
          break;
        }
        const userInput = await deps.options.onUserInput({ step, response, prompt: response.content });
        if (userInput === null) {
          abort = abortWorkflow(deps, 'user_input_cancelled', 'User input cancelled');
          break;
        }
        deps.addUserInput(userInput);
        deps.emit('step:user_input', step, userInput);
        deps.state.currentStep = step.name;
        continue;
      }

      if (transition.returnValue !== undefined) {
        finalizeCompletion(deps);
        result.commitTransition?.({
          kind: 'return',
          returnValue: transition.returnValue,
        });
        returnValue = transition.returnValue;
        deps.emit('workflow:complete', deps.state);
        break;
      }

      let nextStep = requireNextStep(step, transition);
      log.debug('Step transition', {
        from: step.name,
        status: response.status,
        matchedRuleIndex: response.matchedRuleIndex,
        nextStep,
      });

      const naturalTerminal = handleTerminalTransition(
        deps,
        nextStep,
        result.workflowCallFailure,
      );
      if (naturalTerminal.handled) {
        if (naturalTerminal.transitionAccepted) {
          result.commitTransition?.({ kind: 'next_step', nextStep });
        }
        abort = naturalTerminal.abort;
        break;
      }

      const cycleCheck = deps.cycleDetectorRecordAndCheck(step.name, nextStep);
      if (cycleCheck.triggered && cycleCheck.monitor) {
        log.info('Loop monitor cycle threshold reached', {
          cycle: cycleCheck.monitor.cycle,
          cycleCount: cycleCheck.cycleCount,
          threshold: cycleCheck.monitor.threshold,
        });
        deps.emit('step:cycle_detected', cycleCheck.monitor, cycleCheck.cycleCount);
        nextStep = await deps.runLoopMonitorJudge(cycleCheck.monitor, cycleCheck.cycleCount, step, stepRuntime, nextStep);
      }

      const monitoredTerminal = handleTerminalTransition(deps, nextStep);
      if (monitoredTerminal.handled) {
        if (monitoredTerminal.transitionAccepted) {
          result.commitTransition?.({ kind: 'next_step', nextStep });
        }
        abort = monitoredTerminal.abort;
        break;
      }
      result.commitTransition?.({ kind: 'next_step', nextStep });
      advanceActiveStep(deps, nextStep, deps.state.iteration);
    } catch (error) {
      workflowCallExecution?.fail(error);
      abort = abortWorkflowRuntimeError(deps, error);
      break;
    } finally {
      workflowCallExecution?.cancel();
    }
  }

  return abort
    ? { state: deps.state, abort }
    : { state: deps.state, ...(returnValue !== undefined ? { returnValue } : {}) };
}

export async function runSingleWorkflowIteration(deps: WorkflowRunLoopDeps): Promise<SingleWorkflowIterationResult> {
  const step = deps.getStep(deps.state.currentStep);
  try {
    const result = await runSingleWorkflowIterationCore(deps);
    if (result.isComplete || result.abort !== undefined) {
      deps.cancelPendingStepActivation();
    }
    return result;
  } catch (error) {
    deps.cancelPendingStepActivation();
    if (
      !workflowInterruptRequested(deps)
      && !(error instanceof RuleDetectionExhaustedError)
    ) {
      throw error;
    }
    const abort = abortWorkflowRuntimeError(deps, error);
    return {
      response: {
        persona: step.persona ?? step.name,
        status: 'blocked',
        content: abort.reason,
        timestamp: new Date(),
      },
      nextStep: ABORT_STEP,
      isComplete: true,
      abort,
    };
  }
}

async function runSingleWorkflowIterationCore(deps: WorkflowRunLoopDeps): Promise<SingleWorkflowIterationResult> {
  const step = deps.getStep(deps.state.currentStep);
  if (workflowInterruptRequested(deps)) {
    return buildInterruptedIterationResult(deps, step);
  }
  const userInputRuntimeAbort = validateUserInputRuntime(deps, step);
  if (userInputRuntimeAbort) {
    return {
      response: {
        persona: step.persona ?? step.name,
        status: 'blocked',
        content: userInputRuntimeAbort.reason,
        timestamp: new Date(),
      },
      nextStep: ABORT_STEP,
      isComplete: true,
      abort: userInputRuntimeAbort,
    };
  }
  deps.applyRuntimeEnvironment('step');
  const loopCheck = deps.loopDetectorCheck(step.name);

  if (loopCheck.shouldAbort) {
    const abort = abortWorkflow(deps, 'loop_detected', ERROR_MESSAGES.LOOP_DETECTED(step.name, loopCheck.count));
    return {
      response: {
        persona: step.persona ?? step.name,
        status: 'blocked',
        content: abort.reason,
        timestamp: new Date(),
      },
      nextStep: ABORT_STEP,
      isComplete: true,
      loopDetected: true,
      abort,
    };
  }

  if (getWorkflowStepKind(step) !== 'workflow_call') {
    deps.state.iteration++;
  }
  const activeIteration = deps.state.iteration;
  const isDelegated = isDelegatedWorkflowStep(step);
  const stepIteration = deps.claimStepOccurrence(step);
  const workflowCallExecution = deps.setActiveStep(step, activeIteration, stepIteration);
  try {
  const baseStepRuntime = deps.resolveRuntimeForStep(step);
  const promotedRuntime = await resolveStepPromotionRuntime(
    deps,
    step,
    isDelegated ? undefined : stepIteration,
    baseStepRuntime,
  );
  const fallbackRuntime = withFallbackRuntime(deps.state, step, promotedRuntime);
  let stepRuntime: RuntimeStepResolution | undefined;
  try {
    stepRuntime = await resolveStepAutoRoutingRuntime(deps, step, fallbackRuntime, step.instruction);
  } catch (error) {
    if (workflowInterruptRequested(deps)) {
      return buildInterruptedIterationResult(deps, step, loopCheck.isLoop);
    }
    throw error;
  }
  if (workflowInterruptRequested(deps)) {
    return buildInterruptedIterationResult(deps, step, loopCheck.isLoop);
  }
  const preparedExecution = await deps.prepareNormalStepExecution(step, stepIteration, stepRuntime);
  const executionStep = preparedExecution?.executableStep ?? step;
  const prebuiltInstruction = preparedExecution === undefined && !isDelegated
    ? deps.buildInstruction(step, stepIteration, stepRuntime?.fallback)
    : undefined;
  const stepInstruction = preparedExecution?.phase1Instruction
    ?? (deps.options.observability?.enabled === true && prebuiltInstruction
      ? deps.buildPhase1Instruction(step, prebuiltInstruction, stepRuntime)
      : '');
  const providerInfo = deps.resolveStepProviderModel(executionStep, stepRuntime);
  const startedAt = Date.now();
  const executeStep = () => deps.runStep(
    step,
    prebuiltInstruction,
    stepRuntime,
    stepIteration,
    preparedExecution,
    workflowCallExecution,
  );
  const result = getWorkflowStepKind(step) === 'workflow_call'
    ? await executeStep()
    : await runWithStepSpan({
        enabled: deps.options.observability?.enabled === true,
        runId: deps.options.observabilityRunId,
        workflowName: deps.getWorkflowName(),
        step: executionStep,
        iteration: activeIteration,
        stepIteration,
        instruction: stepInstruction,
        workflowStack: deps.getCurrentWorkflowStack(),
        sanitizeText: deps.options.sanitizeObservabilityText,
        providerInfo,
        getFinalStepIteration: () => deps.state.stepIterations.get(step.name),
        traceTaskMetadata: deps.options.traceTaskMetadata,
      }, executeStep);
  if (workflowInterruptRequested(deps)) {
    return buildInterruptedIterationResult(deps, step, loopCheck.isLoop);
  }
  const { response, providerInfo: resultProviderInfo } = result;
  const completedProviderInfo = resultProviderInfo ?? providerInfo;
  if (getWorkflowStepKind(step) !== 'workflow_call') {
    recordNormalRoutingResult(deps, step, completedProviderInfo, response);
    emitNormalRoutingDecision(
      deps,
      step,
      response,
      result.instruction,
      completedProviderInfo,
      Math.max(0, Date.now() - startedAt),
      activeIteration,
    );
    settleFallbackAttempt(deps.state, stepRuntime, response.status);
  }

  if (response.status === 'blocked') {
    const abort = abortWorkflow(deps, 'blocked', 'Workflow blocked and no user input provided');
    return { response, nextStep: ABORT_STEP, isComplete: true, loopDetected: loopCheck.isLoop, abort };
  }
  if (response.status === 'rate_limited') {
    const terminalOperation = result.terminalOperation ?? {
      origin: reviewerOperationOrigin(step.name),
      providerInfo: completedProviderInfo,
    };
    const consumedStepIterations = result.consumedStepIterations ?? [step.name];
    const fallbackResult = prepareRateLimitFallback(
      deps,
      step,
      response,
      terminalOperation.providerInfo,
      terminalOperation.origin,
      activeIteration,
      consumedStepIterations,
    );
    if (fallbackResult.queued) {
      return { response, nextStep: step.name, isComplete: false, loopDetected: loopCheck.isLoop };
    }
    return {
      response,
      nextStep: ABORT_STEP,
      isComplete: true,
      loopDetected: loopCheck.isLoop,
      abort: fallbackResult.abort,
    };
  }
  if (response.status === 'error') {
    const abort = abortStepError(deps, step, result);
    return { response, nextStep: ABORT_STEP, isComplete: true, loopDetected: loopCheck.isLoop, abort };
  }

  if (result.qualityGateFailure) {
    applyQualityGateFailure(
      deps,
      step,
      result.qualityGateFailure.stepIteration,
      result.qualityGateFailure.response,
    );
    return {
      response: result.qualityGateFailure.response,
      nextStep: step.name,
      isComplete: false,
      loopDetected: loopCheck.isLoop,
    };
  }

  const qualityGateResult = await deps.runQualityGates({
    qualityGates: step.qualityGates,
    projectRoot: deps.getCwd(),
    step,
    childProcessEnv: deps.options.childProcessEnv,
  });
  if (!qualityGateResult.ok) {
    applyQualityGateFailure(
      deps,
      step,
      resolveQualityGateSnapshotIteration(deps.state, step, stepIteration),
      qualityGateResult.response,
    );
    return {
      response: qualityGateResult.response,
      nextStep: step.name,
      isComplete: false,
      loopDetected: loopCheck.isLoop,
    };
  }

  const transition = deps.resolveDoneTransition(step, response);
  if (transition.requiresUserInput) {
    if (!deps.options.onUserInput) {
      const abort = abortWorkflow(deps, 'user_input_required', 'User input required but no handler is configured');
      return { response, nextStep: ABORT_STEP, isComplete: true, loopDetected: loopCheck.isLoop, abort };
    }
    const userInput = await deps.options.onUserInput({ step, response, prompt: response.content });
    if (userInput === null) {
      const abort = abortWorkflow(deps, 'user_input_cancelled', 'User input cancelled');
      return { response, nextStep: ABORT_STEP, isComplete: true, loopDetected: loopCheck.isLoop, abort };
    }
    deps.addUserInput(userInput);
    deps.emit('step:user_input', step, userInput);
    deps.state.currentStep = step.name;
    return { response, nextStep: step.name, isComplete: false, loopDetected: loopCheck.isLoop };
  }

  if (transition.returnValue !== undefined) {
    finalizeCompletion(deps);
    result.commitTransition?.({
      kind: 'return',
      returnValue: transition.returnValue,
    });
    return {
      response,
      nextStep: COMPLETE_STEP,
      isComplete: true,
      returnValue: transition.returnValue,
      loopDetected: loopCheck.isLoop,
    };
  }

  const nextStep = requireNextStep(step, transition);
  const isComplete = nextStep === COMPLETE_STEP || nextStep === ABORT_STEP;

  if (!isComplete) {
    result.commitTransition?.({ kind: 'next_step', nextStep });
    advanceActiveStep(deps, nextStep, deps.state.iteration);
  } else if (nextStep === COMPLETE_STEP) {
    finalizeCompletion(deps);
    result.commitTransition?.({ kind: 'next_step', nextStep });
  } else {
    result.commitTransition?.({ kind: 'next_step', nextStep });
  }

  if (nextStep === ABORT_STEP) {
    const abort = abortStepTransition(deps, result.workflowCallFailure);
    return { response, nextStep, isComplete, loopDetected: loopCheck.isLoop, abort };
  }

  return { response, nextStep, isComplete, loopDetected: loopCheck.isLoop };
  } catch (error) {
    workflowCallExecution?.fail(error);
    throw error;
  } finally {
    workflowCallExecution?.cancel();
  }
}

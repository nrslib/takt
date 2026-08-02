import { createLogger, getErrorMessage } from '../../../shared/utils/index.js';
import type { AgentResponse, LoopMonitorConfig, WorkflowState, WorkflowStep } from '../../models/types.js';
import { ABORT_STEP, COMPLETE_STEP, ERROR_MESSAGES } from '../constants.js';
import type {
  RuntimeStepResolution,
  StepProviderInfo,
  StepRunResult,
  WorkflowAbortKind,
  WorkflowAbortResult,
  WorkflowEngineOptions,
  WorkflowRunResult,
} from '../types.js';
import type { WorkflowRuleTransition } from './transitions.js';
import { handleBlocked } from './blocked-handler.js';
import {
  getWorkflowStepKind,
  isCountableWorkflowStep,
  isDelegatedWorkflowStep,
  isProviderBackedWorkflowStep,
} from '../step-kind.js';
import { resolvePromotionRuntime } from '../promotion/promotion-runtime.js';
import { createRoutingScope, resolveAutoRoutingRuntime } from '../auto-routing/resolver.js';
import { buildRoutingWorkSnapshot, type RoutingFindings } from '../auto-routing/snapshot.js';
import { runWithStepSpan, type StepSpanParams } from '../observability/workflowSpans.js';
import type { QualityGateRunResult } from '../quality-gates/types.js';
import { RuleDetectionExhaustedError } from '../evaluation/RuleDetectionExhaustedError.js';
import type { PreparedNormalStepExecution } from './StepExecutor.js';
import type { WorkflowStepExecutionPlan } from './WorkflowEngineStepCoordinator.js';
import type { WorkflowStepBudget } from '../workflow-step-budget.js';
import type { LoopMonitorJudgeRunResult } from './LoopMonitorJudgeRunner.js';
import { WorkflowCallLoopDetectedError } from '../workflow-call-progress-tracker.js';
import {
  snapshotWorkflowExecutionScope,
  type WorkflowExecutionScope,
} from '../workflow-execution-scope.js';
import {
  appendFallbackAttempt,
  buildRateLimitFallbackContext,
  pickNextFallbackProvider,
} from '../rate-limit-fallback.js';
import {
  commitCountableStepStart,
  commitFallbackRollback,
  completeFallback,
  requeueFallbackAfterTerminalResponse,
} from './execution-checkpoint.js';

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
  getRoutingFindings: () => RoutingFindings;
  getCurrentWorkflowStack: () => StepSpanParams['workflowStack'];
  buildStepExecutionScope: (step: WorkflowStep, iteration: number) => WorkflowExecutionScope;
  getCwd: () => string;
  stepBudget: WorkflowStepBudget;
  recordCountableProgress: () => void;
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
    resumedStart?: import('../../models/types.js').WorkflowPendingLoopJudgeStarted,
  ) => Promise<LoopMonitorJudgeRunResult>;
  getPendingLoopJudge: () => {
    monitor: LoopMonitorConfig;
    cycleCount: number;
    triggeringStep: WorkflowStep;
    fallbackNextStep: string;
    resumedStart?: import('../../models/types.js').WorkflowPendingLoopJudgeStarted;
  } | undefined;
  runStep: (
    step: WorkflowStep,
    plan: WorkflowStepExecutionPlan,
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
  /** Engine が通常 agent ステップに渡す、実行前に一度だけ確定した入力。 */
  prepareNormalStepExecution: (
    step: WorkflowStep,
    stepIteration: number,
    runtime?: RuntimeStepResolution,
  ) => PreparedNormalStepExecution;
  resolveStepProviderModel: (step: WorkflowStep, runtime?: RuntimeStepResolution) => StepProviderInfo;
  /** auto-routing ルーター・promotion 評価への入力専用（補完前の解決）。 */
  resolveStepProviderModelBeforeAutoRouting: (step: WorkflowStep, runtime?: RuntimeStepResolution) => StepProviderInfo;
  setActiveStep: (step: WorkflowStep, iteration: number) => void;
  syncMaxSteps: (maxSteps: import('../../models/types.js').WorkflowMaxSteps) => void;
  addUserInput: (input: string) => void;
  emit: (event: string, ...args: unknown[]) => void;
  /**
   * COMPLETE 遷移直前のエンジン最終不変条件: open な
   * provisional finding が1件でもあれば COMPLETE を拒否する。バックストップ
   * 発火は「workflow rules が findings.provisional.count を処理していない」
   * 設定不備なので fail-fast abort（house の「マッチなしは黙ってデフォルトを
   * 選ばず fail-fast」と同じ扱い）。violation.reason には provisional の
   * id / kind / reason と修正ガイダンスを含める。
   */
  checkCompletionGate: () => { ok: true } | { ok: false; reason: string };
  /**
   * returnValue 終端（`return: X`）の gate。自前の Finding Contract を持つ
   * workflow では review-integrity を検証する。親から契約を継承した callable
   * workflow では、return は最終完了ではなく契約所有者への制御返却なので通し、
   * 最終的な COMPLETE は親の completion gate が検証する。
   */
  checkReturnValueGate: () => { ok: true } | { ok: false; reason: string };
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
      findings: deps.getRoutingFindings(),
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
  scope: WorkflowExecutionScope,
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
    scope,
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

function withFallbackRuntime(
  state: WorkflowState,
  runtime: RuntimeStepResolution | undefined,
): RuntimeStepResolution | undefined {
  if (!state.pendingFallback) {
    return runtime;
  }
  return {
    ...runtime,
    providerInfo: {
      provider: state.pendingFallback.currentProvider,
      model: state.pendingFallback.currentModel,
      providerSource: 'step',
      modelSource: state.pendingFallback.currentModel !== undefined ? 'step' : undefined,
    },
    fallback: state.pendingFallback,
  };
}

function advanceActiveStep(deps: WorkflowRunLoopDeps, nextStep: string, iteration: number): void {
  const resolvedStep = deps.getStep(nextStep);
  // The engine-synthesized finding-conflict-adjudication step resolves its
  // return-to-origin transition from this record (see
  // WorkflowEngineStepCoordinator.resolveTransitionFromDone).
  deps.state.previousStep = deps.state.currentStep;
  deps.state.currentStep = nextStep;
  deps.setActiveStep(resolvedStep, iteration);
}

function buildWorkflowAbortResult(kind: WorkflowAbortKind, stepName: string, reason: string): WorkflowAbortResult {
  return {
    kind,
    reason,
    failure: {
      kind,
      step: stepName,
      reason,
    },
  };
}

function abortWorkflow(
  deps: WorkflowRunLoopDeps,
  kind: WorkflowAbortKind,
  reason: string,
  options: { clearLastOutput?: boolean } = {},
): WorkflowAbortResult {
  deps.state.status = 'aborted';
  if (options.clearLastOutput) {
    deps.state.lastOutput = undefined;
  }
  deps.emit('workflow:abort', deps.state, reason, kind);
  return buildWorkflowAbortResult(kind, deps.state.currentStep, reason);
}

function abortWorkflowRuntimeError(deps: WorkflowRunLoopDeps, error: unknown): WorkflowAbortResult {
  if (workflowInterruptRequested(deps)) {
    return abortInterruptedWorkflow(deps);
  }
  if (error instanceof RuleDetectionExhaustedError) {
    return abortWorkflow(deps, 'rule_no_match', 'rule_no_match', { clearLastOutput: true });
  }
  if (error instanceof WorkflowCallLoopDetectedError) {
    return abortWorkflow(
      deps,
      'loop_detected',
      ERROR_MESSAGES.LOOP_DETECTED(error.stepName, 2),
    );
  }
  return abortWorkflow(
    deps,
    'runtime_error',
    ERROR_MESSAGES.STEP_EXECUTION_FAILED(getErrorMessage(error)),
    { clearLastOutput: true },
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

/**
 * 全ての完了経路（COMPLETE 遷移・returnValue 終端）が必ず通る fail-closed の
 * 一元判定（review-integrity requirement）。渡された gate 結果を評価し、通れば state.status を
 * 'completed' にして undefined を返す。塞がっていれば完了させず abort を返す。
 * どの完了終端もこの関数だけで status='completed' を確定させることで、gate を
 * 迂回する完了経路（かつて returnValue 終端が gate を呼ばず直接 completed にして
 * いた穴）を構造的に無くす。
 *
 * gate 結果は呼び出し元が選ぶ:
 *   - COMPLETE 遷移 → checkCompletionGate（product gate + review-integrity gate）
 *   - returnValue 終端 → checkReturnValueGate（自前契約なら review-integrity を検証し、
 *     継承契約なら契約所有者への制御返却として許可する）
 */
function finalizeCompletionOrAbort(
  deps: WorkflowRunLoopDeps,
  gate: { ok: true } | { ok: false; reason: string },
): WorkflowAbortResult | undefined {
  if (!gate.ok) {
    return abortWorkflow(deps, 'provisional_findings', gate.reason);
  }
  deps.state.status = 'completed';
  return undefined;
}

type TerminalTransitionResult =
  | { handled: false }
  | {
      handled: true;
      transitionAccepted: boolean;
      abort?: WorkflowAbortResult;
    };

function handleTerminalTransition(
  deps: WorkflowRunLoopDeps,
  nextStep: string,
): TerminalTransitionResult {
  if (nextStep === COMPLETE_STEP) {
    const gateAbort = finalizeCompletionOrAbort(deps, deps.checkCompletionGate());
    if (gateAbort) {
      return { handled: true, transitionAccepted: false, abort: gateAbort };
    }
    deps.emit('workflow:complete', deps.state);
    return { handled: true, transitionAccepted: true };
  }
  if (nextStep === ABORT_STEP) {
    return {
      handled: true,
      transitionAccepted: true,
      abort: abortWorkflow(deps, 'step_transition', 'Workflow aborted by step transition'),
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
  activeIteration: number,
  consumedStepIterations: readonly string[],
): { queued: true } | { queued: false; abort: WorkflowAbortResult } {
  deps.emit('step:rate_limited', step, response, response.rateLimitInfo);
  const previousAttempts = deps.state.rateLimitFallbackAttempts ?? [];
  const currentAttempts = appendFallbackAttempt(previousAttempts, currentProvider);
  const fallback = pickNextFallbackProvider(
    deps.options.rateLimitFallback?.switchChain,
    currentProvider,
    currentAttempts,
  );
  if (!fallback) {
    return {
      queued: false,
      abort: abortWorkflow(deps, 'rate_limited', `Step "${step.name}" hit a rate limit and no fallback provider is configured`),
    };
  }

  const attempts = [...currentAttempts, fallback];
  const context = buildRateLimitFallbackContext({
    step,
    response,
    current: currentProvider,
    fallback,
    originalIteration: activeIteration,
    reportDir: deps.getReportDir(),
  });
  commitFallbackRollback({
    state: deps.state,
    context,
    attempts,
    consumedStepIterations,
    persist: () => deps.setActiveStep(step, deps.state.iteration),
  });
  return { queued: true };
}

function preserveTerminalFallbackAttempt(
  deps: WorkflowRunLoopDeps,
  step: WorkflowStep,
  result: StepRunResult,
): void {
  requeueFallbackAfterTerminalResponse(
    deps.state,
    result.consumedStepIterations ?? [step.name],
    () => deps.setActiveStep(step, deps.state.iteration),
  );
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

function nextStepIteration(state: WorkflowState, stepName: string): number {
  return (state.stepIterations.get(stepName) ?? 0) + 1;
}

interface CountableStepExecutionPlan {
  readonly activeIteration: number;
  readonly stepIteration: number;
  readonly runtime: RuntimeStepResolution | undefined;
  readonly providerInfo: StepProviderInfo | undefined;
  readonly eventStep: WorkflowStep;
  readonly instruction: string;
  readonly rollback: () => void;
  readonly commit: () => {
    readonly scope: WorkflowExecutionScope;
    readonly execute: () => Promise<StepRunResult>;
  };
}

type CountableStepPlanKind = Exclude<WorkflowStepExecutionPlan['kind'], 'workflow_call'>;

function resolveCountableStepPlanKind(step: WorkflowStep): CountableStepPlanKind {
  if (step.engineSynthesized === true) {
    return 'engine_synthesized';
  }
  if (step.parallel !== undefined) {
    return 'parallel';
  }
  if (step.arpeggio !== undefined) {
    return 'arpeggio';
  }
  if (step.teamLeader !== undefined) {
    return 'team_leader';
  }
  if (getWorkflowStepKind(step) === 'system') {
    return 'system';
  }
  return 'normal';
}

async function runPendingLoopJudge(
  deps: WorkflowRunLoopDeps,
): Promise<LoopMonitorJudgeRunResult | undefined> {
  const pending = deps.getPendingLoopJudge();
  if (pending === undefined) {
    return undefined;
  }
  return deps.runLoopMonitorJudge(
    pending.monitor,
    pending.cycleCount,
    pending.triggeringStep,
    undefined,
    pending.fallbackNextStep,
    pending.resumedStart,
  );
}

async function enforceIterationLimit(
  deps: WorkflowRunLoopDeps,
  step: WorkflowStep,
): Promise<WorkflowAbortResult | undefined> {
  if (!isCountableWorkflowStep(step)) {
    return undefined;
  }

  const limitScope = deps.buildStepExecutionScope(step, deps.state.iteration);
  const result = await deps.stepBudget.check({
    request: {
      currentIteration: deps.state.iteration,
      currentStep: step.name,
      scope: limitScope,
    },
    ignoreLimit: deps.options.ignoreIterationLimit === true,
    onLimitReached: (maxSteps) => {
      deps.setActiveStep(step, deps.state.iteration);
      deps.emit('iteration:limit', deps.state.iteration, maxSteps, step.name, limitScope);
    },
    onMaxStepsExtended: deps.syncMaxSteps,
    requestExtension: deps.options.onIterationLimit,
  });
  if (result.allowed) {
    return undefined;
  }
  deps.setActiveStep(step, deps.state.iteration);
  return abortWorkflow(deps, 'iteration_limit', ERROR_MESSAGES.MAX_STEPS_REACHED);
}

async function prepareCountableStepExecution(
  deps: WorkflowRunLoopDeps,
  step: WorkflowStep,
): Promise<CountableStepExecutionPlan> {
  const pendingIteration = deps.state.iteration + 1;
  const pendingStepIteration = nextStepIteration(deps.state, step.name);
  const promotedRuntime = await resolveStepPromotionRuntime(
    deps,
    step,
    isDelegatedWorkflowStep(step) ? undefined : pendingStepIteration,
    undefined,
  );
  const fallbackRuntime = withFallbackRuntime(deps.state, promotedRuntime);
  const runtime = await resolveStepAutoRoutingRuntime(deps, step, fallbackRuntime, step.instruction);
  const kind = resolveCountableStepPlanKind(step);
  const preparedExecution = kind === 'normal'
    ? deps.prepareNormalStepExecution(step, pendingStepIteration, runtime)
    : undefined;
  const providerInfo = isProviderBackedWorkflowStep(step)
    ? deps.resolveStepProviderModel(step, runtime)
    : undefined;
  if (providerInfo !== undefined && providerInfo.provider === undefined) {
    preparedExecution?.rollbackPreparation();
    throw new Error(`Step "${step.name}" has no resolved provider`);
  }
  const eventStep = preparedExecution?.executableStep ?? step;
  const instruction = preparedExecution?.phase1Instruction ?? '';

  return {
    activeIteration: pendingIteration,
    stepIteration: pendingStepIteration,
    runtime,
    providerInfo,
    eventStep,
    instruction,
    rollback: () => preparedExecution?.rollbackPreparation(),
    commit: () => {
      const stepIteration = commitCountableStepStart({
        state: deps.state,
        stepName: step.name,
        iteration: pendingIteration,
        expectedStepIteration: pendingStepIteration,
        recordProgress: deps.recordCountableProgress,
        persist: () => deps.setActiveStep(step, pendingIteration),
      });
      const scope = snapshotWorkflowExecutionScope(deps.getCurrentWorkflowStack());
      const eventAttribution = { iteration: pendingIteration, scope } as const;
      let executionPlan: WorkflowStepExecutionPlan;
      if (kind === 'normal') {
        if (preparedExecution === undefined) {
          throw new Error(`Normal agent step "${step.name}" is missing prepared execution`);
        }
        executionPlan = {
          kind,
          runtime,
          stepIteration,
          preparedExecution,
          eventAttribution,
        };
      } else {
        executionPlan = {
          kind,
          runtime,
          stepIteration,
          eventAttribution,
        };
      }
      return {
        scope,
        execute: () => runWithStepSpan({
          enabled: deps.options.observability?.enabled === true,
          runId: deps.options.observabilityRunId,
          workflowName: deps.getWorkflowName(),
          step: eventStep,
          iteration: pendingIteration,
          stepIteration,
          instruction,
          workflowStack: [...scope.stack],
          sanitizeText: deps.options.sanitizeObservabilityText,
          providerInfo,
          getFinalStepIteration: () => deps.state.stepIterations.get(step.name),
          traceTaskMetadata: deps.options.traceTaskMetadata,
        }, () => deps.runStep(step, executionPlan)),
      };
    },
  };
}

export async function runWorkflowToCompletion(deps: WorkflowRunLoopDeps): Promise<WorkflowRunResult> {
  let abort: WorkflowAbortResult | undefined;
  let returnValue: string | undefined;

  if (workflowInterruptRequested(deps)) {
    abort = abortInterruptedWorkflow(deps);
  } else {
    try {
      const judgeResult = await runPendingLoopJudge(deps);
      if (judgeResult !== undefined) {
        if ('iterationLimitReached' in judgeResult) {
          abort = abortWorkflow(deps, 'iteration_limit', ERROR_MESSAGES.MAX_STEPS_REACHED);
        } else {
          const terminal = handleTerminalTransition(deps, judgeResult.nextStep);
          if (terminal.handled) {
            abort = terminal.abort;
          } else {
            advanceActiveStep(deps, judgeResult.nextStep, deps.state.iteration);
          }
        }
      }
    } catch (error) {
      abort = abortWorkflowRuntimeError(deps, error);
    }
  }

  while (abort === undefined && deps.state.status === 'running') {
    if (workflowInterruptRequested(deps)) {
      abort = abortInterruptedWorkflow(deps);
      break;
    }

    const step = deps.getStep(deps.state.currentStep);
    const isCountable = isCountableWorkflowStep(step);
    const iterationLimitAbort = await enforceIterationLimit(deps, step);
    if (iterationLimitAbort) {
      abort = iterationLimitAbort;
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

    let activeIteration = deps.state.iteration;
    let stepIteration: number;
    let stepRuntime: RuntimeStepResolution | undefined;
    let providerInfo: StepProviderInfo | undefined;
    let executionScope: WorkflowExecutionScope | undefined;
    let eventStep = step;
    let executeStep: () => Promise<StepRunResult>;
    if (!isCountable) {
      stepIteration = deps.state.stepIterations.get(step.name) ?? 0;
      executeStep = async () => {
        const result = await deps.runStep(step, { kind: 'workflow_call' });
        stepIteration = deps.state.stepIterations.get(step.name) ?? 0;
        return result;
      };
    } else {
      let plan: CountableStepExecutionPlan;
      try {
        plan = await prepareCountableStepExecution(deps, step);
      } catch (error) {
        if (workflowInterruptRequested(deps)) {
          abort = abortInterruptedWorkflow(deps);
          break;
        }
        throw error;
      }
      if (workflowInterruptRequested(deps)) {
        plan.rollback();
        abort = abortInterruptedWorkflow(deps);
        break;
      }
      const committed = plan.commit();
      activeIteration = plan.activeIteration;
      stepIteration = plan.stepIteration;
      stepRuntime = plan.runtime;
      eventStep = plan.eventStep;
      providerInfo = plan.providerInfo;
      executionScope = committed.scope;
      deps.emit(
        'step:start',
        plan.eventStep,
        activeIteration,
        plan.instruction,
        plan.providerInfo,
        deps.getWorkflowName(),
        step.name,
        stepIteration,
        deps.stepBudget.currentMaxSteps(),
        committed.scope,
      );
      executeStep = committed.execute;
    }

    try {
      const startedAt = Date.now();
      const result = await executeStep();
      if (workflowInterruptRequested(deps)) {
        abort = abortInterruptedWorkflow(deps);
        break;
      }
      const { response, instruction, providerInfo: resultProviderInfo } = result;
      const completedProviderInfo = resultProviderInfo ?? providerInfo;
      if (isCountable) {
        if (executionScope === undefined) {
          throw new Error(`Step "${step.name}" completed without an execution scope`);
        }
        if (isProviderBackedWorkflowStep(eventStep) && completedProviderInfo === undefined) {
          throw new Error(`Step "${step.name}" completed without provider information`);
        }
        if (completedProviderInfo !== undefined) {
          recordNormalRoutingResult(deps, step, completedProviderInfo, response);
          emitNormalRoutingDecision(
            deps,
            step,
            response,
            instruction,
            completedProviderInfo,
            Math.max(0, Date.now() - startedAt),
            activeIteration,
            executionScope,
          );
        }
        deps.emit('step:complete', eventStep, response, instruction, step.name, executionScope);
      }

      if (response.status === 'rate_limited') {
        if (completedProviderInfo === undefined) {
          throw new Error(`Rate-limited step "${step.name}" is missing provider information`);
        }
        if (result.rateLimitFallbackHandled === true) {
          deps.emit('step:rate_limited', step, response, response.rateLimitInfo);
          abort = abortWorkflow(
            deps,
            'rate_limited',
            `Step "${step.name}" hit a rate limit and no fallback provider is configured`,
          );
          break;
        }
        const currentProvider = completedProviderInfo;
        const consumedStepIterations = result.consumedStepIterations ?? [step.name];
        const fallbackResult = prepareRateLimitFallback(
          deps,
          step,
          response,
          currentProvider,
          activeIteration,
          consumedStepIterations,
        );
        if (!fallbackResult.queued) {
          abort = fallbackResult.abort;
          break;
        }
        continue;
      }

      if (stepRuntime?.fallback) {
        if (response.status === 'error' || response.status === 'blocked') {
          preserveTerminalFallbackAttempt(deps, step, result);
        } else {
          completeFallback(deps.state, () => deps.setActiveStep(step, deps.state.iteration));
        }
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
        if (result.shouldContinue && result.userInput) {
          deps.addUserInput(result.userInput);
          deps.emit('step:user_input', step, result.userInput);
          continue;
        }
        abort = abortWorkflow(deps, 'blocked', 'Workflow blocked and no user input provided');
        break;
      }

      if (response.status === 'error') {
        abort = abortWorkflow(
          deps,
          'step_error',
          `Step "${step.name}" failed: ${response.error ?? response.content}`,
        );
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
        const gateAbort = finalizeCompletionOrAbort(deps, deps.checkReturnValueGate());
        if (gateAbort) {
          abort = gateAbort;
          break;
        }
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

      const naturalTerminal = handleTerminalTransition(deps, nextStep);
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
        if (workflowInterruptRequested(deps)) {
          abort = abortInterruptedWorkflow(deps);
          break;
        }
        const judgeResult = await deps.runLoopMonitorJudge(
          cycleCheck.monitor,
          cycleCheck.cycleCount,
          step,
          completedProviderInfo === undefined
            ? stepRuntime
            : { ...stepRuntime, providerInfo: completedProviderInfo },
          nextStep,
        );
        if ('iterationLimitReached' in judgeResult) {
          abort = abortWorkflow(deps, 'iteration_limit', ERROR_MESSAGES.MAX_STEPS_REACHED);
          break;
        }
        nextStep = judgeResult.nextStep;
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
      abort = abortWorkflowRuntimeError(deps, error);
      break;
    }
  }

  return abort
    ? { state: deps.state, abort }
    : { state: deps.state, ...(returnValue !== undefined ? { returnValue } : {}) };
}

export async function runSingleWorkflowIteration(deps: WorkflowRunLoopDeps): Promise<SingleWorkflowIterationResult> {
  const step = deps.getStep(deps.state.currentStep);
  if (workflowInterruptRequested(deps)) {
    return buildInterruptedIterationResult(deps, step);
  }
  try {
    const pendingJudgeResult = await runPendingLoopJudge(deps);
    if (pendingJudgeResult !== undefined) {
      return completeSinglePendingLoopJudgeIteration(deps, step, pendingJudgeResult);
    }
    return await runSingleWorkflowIterationCore(deps);
  } catch (error) {
    if (
      !workflowInterruptRequested(deps)
      && !(error instanceof RuleDetectionExhaustedError)
      && !(error instanceof WorkflowCallLoopDetectedError)
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

function completeSinglePendingLoopJudgeIteration(
  deps: WorkflowRunLoopDeps,
  triggeringStep: WorkflowStep,
  judgeResult: LoopMonitorJudgeRunResult,
): SingleWorkflowIterationResult {
  if ('iterationLimitReached' in judgeResult) {
    const abort = abortWorkflow(deps, 'iteration_limit', ERROR_MESSAGES.MAX_STEPS_REACHED);
    return {
      response: {
        persona: triggeringStep.persona ?? triggeringStep.name,
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

  const terminal = handleTerminalTransition(deps, judgeResult.nextStep);
  if (terminal.handled) {
    return {
      response: judgeResult.response,
      nextStep: terminal.abort === undefined ? judgeResult.nextStep : ABORT_STEP,
      isComplete: true,
      loopDetected: true,
      ...(terminal.abort === undefined ? {} : { abort: terminal.abort }),
    };
  }

  advanceActiveStep(deps, judgeResult.nextStep, deps.state.iteration);
  return {
    response: judgeResult.response,
    nextStep: judgeResult.nextStep,
    isComplete: false,
    loopDetected: true,
  };
}

async function runSingleWorkflowIterationCore(deps: WorkflowRunLoopDeps): Promise<SingleWorkflowIterationResult> {
  const step = deps.getStep(deps.state.currentStep);
  if (workflowInterruptRequested(deps)) {
    return buildInterruptedIterationResult(deps, step);
  }
  const iterationLimitAbort = await enforceIterationLimit(deps, step);
  if (iterationLimitAbort) {
    return {
      response: {
        persona: step.persona ?? step.name,
        status: 'blocked',
        content: iterationLimitAbort.reason,
        timestamp: new Date(),
      },
      nextStep: ABORT_STEP,
      isComplete: true,
      abort: iterationLimitAbort,
    };
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

  const isCountable = isCountableWorkflowStep(step);
  let activeIteration = deps.state.iteration;
  let stepIteration: number;
  let stepRuntime: RuntimeStepResolution | undefined;
  const startedAt = Date.now();
  let providerInfo: StepProviderInfo | undefined;
  let executionScope: WorkflowExecutionScope | undefined;
  let result: StepRunResult;
  if (!isCountable) {
    result = await deps.runStep(step, { kind: 'workflow_call' });
    stepIteration = deps.state.stepIterations.get(step.name) ?? 0;
  } else {
    let plan: CountableStepExecutionPlan;
    try {
      plan = await prepareCountableStepExecution(deps, step);
    } catch (error) {
      if (workflowInterruptRequested(deps)) {
        return buildInterruptedIterationResult(deps, step, loopCheck.isLoop);
      }
      throw error;
    }
    if (workflowInterruptRequested(deps)) {
      plan.rollback();
      return buildInterruptedIterationResult(deps, step, loopCheck.isLoop);
    }
    const committed = plan.commit();
    activeIteration = plan.activeIteration;
    stepIteration = plan.stepIteration;
    stepRuntime = plan.runtime;
    providerInfo = plan.providerInfo;
    executionScope = committed.scope;
    result = await committed.execute();
  }
  if (workflowInterruptRequested(deps)) {
    return buildInterruptedIterationResult(deps, step, loopCheck.isLoop);
  }
  const { response, providerInfo: resultProviderInfo } = result;
  const completedProviderInfo = resultProviderInfo ?? providerInfo;
  if (isCountable) {
    if (executionScope === undefined) {
      throw new Error(`Step "${step.name}" completed without an execution scope`);
    }
    if (isProviderBackedWorkflowStep(step) && completedProviderInfo === undefined) {
      throw new Error(`Step "${step.name}" completed without provider information`);
    }
    if (completedProviderInfo !== undefined) {
      recordNormalRoutingResult(deps, step, completedProviderInfo, response);
      emitNormalRoutingDecision(
        deps,
        step,
        response,
        result.instruction,
        completedProviderInfo,
        Math.max(0, Date.now() - startedAt),
        activeIteration,
        executionScope,
      );
    }
  }

  if (response.status === 'blocked') {
    if (stepRuntime?.fallback) {
      preserveTerminalFallbackAttempt(deps, step, result);
    }
    const abort = abortWorkflow(deps, 'blocked', 'Workflow blocked and no user input provided');
    return { response, nextStep: ABORT_STEP, isComplete: true, loopDetected: loopCheck.isLoop, abort };
  }
  if (response.status === 'rate_limited') {
    if (completedProviderInfo === undefined) {
      throw new Error(`Rate-limited step "${step.name}" is missing provider information`);
    }
    if (result.rateLimitFallbackHandled === true) {
      deps.emit('step:rate_limited', step, response, response.rateLimitInfo);
      return {
        response,
        nextStep: ABORT_STEP,
        isComplete: true,
        loopDetected: loopCheck.isLoop,
        abort: abortWorkflow(
          deps,
          'rate_limited',
          `Step "${step.name}" hit a rate limit and no fallback provider is configured`,
        ),
      };
    }
    const currentProvider = completedProviderInfo;
    const consumedStepIterations = result.consumedStepIterations ?? [step.name];
    const fallbackResult = prepareRateLimitFallback(
      deps,
      step,
      response,
      currentProvider,
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
  if (stepRuntime?.fallback && response.status === 'error') {
    preserveTerminalFallbackAttempt(deps, step, result);
  } else if (stepRuntime?.fallback) {
    completeFallback(deps.state, () => deps.setActiveStep(step, deps.state.iteration));
  }
  if (response.status === 'error') {
    const abort = abortWorkflow(
      deps,
      'step_error',
      `Step "${step.name}" failed: ${response.error ?? response.content}`,
    );
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
    const gateAbort = finalizeCompletionOrAbort(deps, deps.checkReturnValueGate());
    if (gateAbort) {
      return { response, nextStep: ABORT_STEP, isComplete: true, loopDetected: loopCheck.isLoop, abort: gateAbort };
    }
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
    const gateAbort = finalizeCompletionOrAbort(deps, deps.checkCompletionGate());
    if (gateAbort) {
      return { response, nextStep: ABORT_STEP, isComplete: true, loopDetected: loopCheck.isLoop, abort: gateAbort };
    }
    result.commitTransition?.({ kind: 'next_step', nextStep });
  } else {
    result.commitTransition?.({ kind: 'next_step', nextStep });
  }

  if (nextStep === ABORT_STEP) {
    const abort = abortWorkflow(deps, 'step_transition', 'Workflow aborted by step transition');
    return { response, nextStep, isComplete, loopDetected: loopCheck.isLoop, abort };
  }

  return { response, nextStep, isComplete, loopDetected: loopCheck.isLoop };
}

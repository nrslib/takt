import { createLogger, getErrorMessage } from '../../../shared/utils/index.js';
import type { AgentResponse, FallbackContext, LoopMonitorConfig, RateLimitFallbackProvider, WorkflowMaxSteps, WorkflowState, WorkflowStep } from '../../models/types.js';
import { ABORT_STEP, COMPLETE_STEP, ERROR_MESSAGES, NEEDS_ADJUDICATION_STEP } from '../constants.js';
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
import { decrementStepIteration, incrementStepIteration } from './state-manager.js';
import { handleBlocked } from './blocked-handler.js';
import { getWorkflowStepKind, isDelegatedWorkflowStep } from '../step-kind.js';
import { resolvePromotionRuntime } from '../promotion/promotion-runtime.js';
import { resolveAutoRoutingRuntime } from '../auto-routing/resolver.js';
import { runWithStepSpan, type StepSpanParams } from '../observability/workflowSpans.js';
import type { QualityGateRunResult } from '../quality-gates/types.js';

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
  getCurrentWorkflowStack: () => StepSpanParams['workflowStack'];
  getCwd: () => string;
  getMaxSteps: () => WorkflowMaxSteps;
  getReportDir: () => string;
  abortRequested: () => boolean;
  getStep: (name: string) => WorkflowStep;
  applyRuntimeEnvironment: (stage: 'step') => void;
  loopDetectorCheck: (stepName: string) => { shouldWarn?: boolean; shouldAbort?: boolean; count: number; isLoop: boolean };
  cycleDetectorRecordAndCheck: (stepName: string) => { triggered: boolean; monitor?: LoopMonitorConfig; cycleCount: number };
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
  buildInstruction: (step: WorkflowStep, stepIteration: number) => string;
  buildPhase1Instruction: (step: WorkflowStep, instruction: string, runtime?: RuntimeStepResolution) => string;
  resolveStepProviderModel: (step: WorkflowStep, runtime?: RuntimeStepResolution) => StepProviderInfo;
  /** auto-routing ルーター・promotion 評価への入力専用（補完前の解決）。 */
  resolveStepProviderModelBeforeAutoRouting: (step: WorkflowStep, runtime?: RuntimeStepResolution) => StepProviderInfo;
  resolveRuntimeForStep: (step: WorkflowStep) => RuntimeStepResolution | undefined;
  setActiveStep: (step: WorkflowStep, iteration: number) => void;
  addUserInput: (input: string) => void;
  emit: (event: string, ...args: unknown[]) => void;
  updateMaxSteps: (maxSteps: number) => void;
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
  /**
   * `next: NEEDS_ADJUDICATION` 到達時に
   * 呼ぶ。現在 open な provisional finding とその発生元を監査レポートへ永続化し
   * （FindingLedgerStore.saveNeedsAdjudicationReport）、人間可読な abort reason
   * 文字列を返す副作用込みの操作 — 純粋な "build" ではないため checkCompletionGate
   * と違う名前にしている。matchedCondition には「NEEDS_ADJUDICATION へ遷移させた
   * ルールの condition（事実）」を渡す（停止理由を台帳状態から推定させず、実際に
   * マッチした条件から分類させるため）。
   */
  recordNeedsAdjudication: (matchedCondition?: string) => string;
}

/**
 * NEEDS_ADJUDICATION へ遷移させたルールの condition を返す。step 自身のルールが
 * 直接 NEEDS_ADJUDICATION を指した場合（transition.nextStep）だけ、その matched
 * rule の condition を信頼する — loop-monitor judge override は nextStep を
 * NEEDS_ADJUDICATION に変え得るが response.matchedRuleIndex は step の元ルール
 * （非終端）を指したままなので、judge のルール condition は表に出ない。その場合は
 * undefined を返し、停止理由は 'unclassified' として記録される。
 */
function matchedNeedsAdjudicationCondition(
  step: WorkflowStep,
  response: AgentResponse,
  transition: WorkflowRuleTransition,
): string | undefined {
  if (transition.nextStep !== NEEDS_ADJUDICATION_STEP) {
    return undefined;
  }
  const index = response.matchedRuleIndex;
  if (index == null) {
    return undefined;
  }
  return step.rules?.[index]?.condition;
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
    step: {
      name: step.name,
      tags: step.tags,
      personaKey: step.providerRoutingPersonaKey,
      instruction: routingInstruction,
    },
    currentProviderInfo,
    routeWithAi: deps.options.autoRoutingAiRouter?.routeStep,
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
  };
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
  if (deps.abortRequested()) {
    return abortWorkflow(deps, 'interrupt', 'Workflow interrupted by user (SIGINT)', {
      clearLastOutput: true,
    });
  }
  return abortWorkflow(
    deps,
    'runtime_error',
    ERROR_MESSAGES.STEP_EXECUTION_FAILED(getErrorMessage(error)),
    { clearLastOutput: true },
  );
}

function workflowInterruptRequested(deps: WorkflowRunLoopDeps): boolean {
  return deps.abortRequested() || deps.options.abortSignal?.aborted === true;
}

function abortInterruptedWorkflow(deps: WorkflowRunLoopDeps): WorkflowAbortResult {
  return abortWorkflow(deps, 'interrupt', 'Workflow interrupted by user (SIGINT)', {
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
    deps.state.rateLimitFallbackAttempts = undefined;
    return {
      queued: false,
      abort: abortWorkflow(deps, 'rate_limited', `Step "${step.name}" hit a rate limit and no fallback provider is configured`),
    };
  }

  deps.state.rateLimitFallbackAttempts = [...currentAttempts, fallback];
  deps.state.pendingFallback = buildFallbackContext(deps, step, response, currentProvider, fallback, activeIteration);
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
  let abort: WorkflowAbortResult | undefined;
  let returnValue: string | undefined;

  while (deps.state.status === 'running') {
    if (deps.abortRequested()) {
      abort = abortWorkflow(deps, 'interrupt', 'Workflow interrupted by user (SIGINT)');
      break;
    }

    const maxSteps = deps.getMaxSteps();
    if (
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

    const step = deps.getStep(deps.state.currentStep);
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

    deps.state.iteration++;
    const isDelegated = isDelegatedWorkflowStep(step);
    const activeIteration = deps.state.iteration;
    const baseStepRuntime = deps.resolveRuntimeForStep(step);
    const stepIteration = isDelegated
      ? undefined
      : incrementStepIteration(deps.state, step.name);
    const promotedRuntime = await resolveStepPromotionRuntime(deps, step, stepIteration, baseStepRuntime);
    const fallbackRuntime = withFallbackRuntime(deps.state, promotedRuntime);
    const prebuiltInstruction = stepIteration !== undefined
      ? deps.buildInstruction(step, stepIteration)
      : undefined;
    let stepRuntime: RuntimeStepResolution | undefined;
    try {
      stepRuntime = await resolveStepAutoRoutingRuntime(deps, step, fallbackRuntime, step.instruction);
    } catch (error) {
      if (workflowInterruptRequested(deps)) {
        abort = abortInterruptedWorkflow(deps);
        break;
      }
      throw error;
    }
    if (workflowInterruptRequested(deps)) {
      abort = abortInterruptedWorkflow(deps);
      break;
    }
    const stepInstruction = prebuiltInstruction
      ? deps.buildPhase1Instruction(step, prebuiltInstruction, stepRuntime)
      : '';
    deps.setActiveStep(step, activeIteration);
    const providerInfo = deps.resolveStepProviderModel(step, stepRuntime);
    deps.emit(
      'step:start',
      step,
      activeIteration,
      stepInstruction,
      providerInfo,
      deps.getWorkflowName(),
      step.name,
    );

    try {
      const startedAt = Date.now();
      const result = await runWithStepSpan({
        enabled: deps.options.observability?.enabled === true,
        runId: deps.options.observabilityRunId,
        workflowName: deps.getWorkflowName(),
        step,
        iteration: activeIteration,
        stepIteration,
        instruction: stepInstruction,
        workflowStack: deps.getCurrentWorkflowStack(),
        sanitizeText: deps.options.sanitizeObservabilityText,
        providerInfo,
        getFinalStepIteration: () => deps.state.stepIterations.get(step.name),
        traceTaskMetadata: deps.options.traceTaskMetadata,
      }, () => deps.runStep(step, prebuiltInstruction, stepRuntime));
      const { response, instruction, providerInfo: resultProviderInfo } = result;
      const completedProviderInfo = resultProviderInfo ?? providerInfo;
      emitNormalRoutingDecision(
        deps,
        step,
        response,
        instruction,
        completedProviderInfo,
        Math.max(0, Date.now() - startedAt),
        activeIteration,
      );
      if (stepRuntime?.fallback) {
        deps.state.pendingFallback = undefined;
      }
      deps.emit('step:complete', step, response, instruction, step.name);

      if (result.terminalAbort !== undefined) {
        abort = abortWorkflow(deps, result.terminalAbort.kind, result.terminalAbort.reason);
        break;
      }

      if (response.status === 'rate_limited') {
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
        deps.state.rateLimitFallbackAttempts = undefined;
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

      const cycleCheck = deps.cycleDetectorRecordAndCheck(step.name);
      if (cycleCheck.triggered && cycleCheck.monitor) {
        log.info('Loop monitor cycle threshold reached', {
          cycle: cycleCheck.monitor.cycle,
          cycleCount: cycleCheck.cycleCount,
          threshold: cycleCheck.monitor.threshold,
        });
        deps.emit('step:cycle_detected', cycleCheck.monitor, cycleCheck.cycleCount);
        nextStep = await deps.runLoopMonitorJudge(cycleCheck.monitor, cycleCheck.cycleCount, step, stepRuntime, nextStep);
      }

      if (nextStep === COMPLETE_STEP) {
        const gateAbort = finalizeCompletionOrAbort(deps, deps.checkCompletionGate());
        if (gateAbort) {
          abort = gateAbort;
          break;
        }
        deps.emit('workflow:complete', deps.state);
        break;
      }
      if (nextStep === NEEDS_ADJUDICATION_STEP) {
        abort = abortWorkflow(
          deps,
          'needs_adjudication',
          deps.recordNeedsAdjudication(matchedNeedsAdjudicationCondition(step, response, transition)),
        );
        break;
      }
      if (nextStep === ABORT_STEP) {
        abort = abortWorkflow(deps, 'step_transition', 'Workflow aborted by step transition');
        break;
      }
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
  return runSingleWorkflowIterationCore(deps);
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

  deps.state.iteration++;
  const activeIteration = deps.state.iteration;
  deps.setActiveStep(step, activeIteration);
  const isDelegated = isDelegatedWorkflowStep(step);
  const baseStepRuntime = deps.resolveRuntimeForStep(step);
  let stepIteration: number | undefined;
  if (!isDelegated) {
    stepIteration = incrementStepIteration(deps.state, step.name);
  }
  const promotedRuntime = await resolveStepPromotionRuntime(deps, step, stepIteration, baseStepRuntime);
  const fallbackRuntime = withFallbackRuntime(deps.state, promotedRuntime);
  let prebuiltInstruction: string | undefined;
  if (!isDelegated && stepIteration !== undefined) {
    prebuiltInstruction = deps.buildInstruction(step, stepIteration);
  }
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
  const providerInfo = deps.resolveStepProviderModel(step, stepRuntime);
  const startedAt = Date.now();
  const result = await runWithStepSpan({
    enabled: deps.options.observability?.enabled === true,
    runId: deps.options.observabilityRunId,
    workflowName: deps.getWorkflowName(),
    step,
    iteration: activeIteration,
    stepIteration,
    instruction: deps.options.observability?.enabled === true && prebuiltInstruction
      ? deps.buildPhase1Instruction(step, prebuiltInstruction, stepRuntime)
      : '',
    workflowStack: deps.getCurrentWorkflowStack(),
    sanitizeText: deps.options.sanitizeObservabilityText,
    providerInfo,
    getFinalStepIteration: () => deps.state.stepIterations.get(step.name),
    traceTaskMetadata: deps.options.traceTaskMetadata,
  }, () => deps.runStep(step, prebuiltInstruction, stepRuntime));
  const { response, providerInfo: resultProviderInfo } = result;
  const completedProviderInfo = resultProviderInfo ?? providerInfo;
  emitNormalRoutingDecision(
    deps,
    step,
    response,
    result.instruction,
    completedProviderInfo,
    Math.max(0, Date.now() - startedAt),
    activeIteration,
  );
  if (stepRuntime?.fallback) {
    deps.state.pendingFallback = undefined;
  }

  if (result.terminalAbort !== undefined) {
    const abort = abortWorkflow(deps, result.terminalAbort.kind, result.terminalAbort.reason);
    return { response, nextStep: ABORT_STEP, isComplete: true, loopDetected: loopCheck.isLoop, abort };
  }

  if (response.status === 'blocked') {
    const abort = abortWorkflow(deps, 'blocked', 'Workflow blocked and no user input provided');
    return { response, nextStep: ABORT_STEP, isComplete: true, loopDetected: loopCheck.isLoop, abort };
  }
  if (response.status === 'rate_limited') {
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
  if (response.status === 'error') {
    const abort = abortWorkflow(
      deps,
      'step_error',
      `Step "${step.name}" failed: ${response.error ?? response.content}`,
    );
    return { response, nextStep: ABORT_STEP, isComplete: true, loopDetected: loopCheck.isLoop, abort };
  }

  if (stepRuntime?.fallback) {
    deps.state.rateLimitFallbackAttempts = undefined;
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
    return {
      response,
      nextStep: COMPLETE_STEP,
      isComplete: true,
      returnValue: transition.returnValue,
      loopDetected: loopCheck.isLoop,
    };
  }

  const nextStep = requireNextStep(step, transition);
  const isComplete = nextStep === COMPLETE_STEP || nextStep === ABORT_STEP || nextStep === NEEDS_ADJUDICATION_STEP;

  if (!isComplete) {
    advanceActiveStep(deps, nextStep, deps.state.iteration);
  } else if (nextStep === COMPLETE_STEP) {
    const gateAbort = finalizeCompletionOrAbort(deps, deps.checkCompletionGate());
    if (gateAbort) {
      return { response, nextStep: ABORT_STEP, isComplete: true, loopDetected: loopCheck.isLoop, abort: gateAbort };
    }
  } else if (nextStep === NEEDS_ADJUDICATION_STEP) {
    const abort = abortWorkflow(
      deps,
      'needs_adjudication',
      deps.recordNeedsAdjudication(matchedNeedsAdjudicationCondition(step, response, transition)),
    );
    return { response, nextStep: ABORT_STEP, isComplete: true, loopDetected: loopCheck.isLoop, abort };
  }

  if (nextStep === ABORT_STEP) {
    const abort = abortWorkflow(deps, 'step_transition', 'Workflow aborted by step transition');
    return { response, nextStep, isComplete, loopDetected: loopCheck.isLoop, abort };
  }

  return { response, nextStep, isComplete, loopDetected: loopCheck.isLoop };
}

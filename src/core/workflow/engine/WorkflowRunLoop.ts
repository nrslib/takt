import { createLogger, getErrorMessage } from '../../../shared/utils/index.js';
import type { AgentResponse, FallbackContext, LoopMonitorConfig, RateLimitFallbackProvider, WorkflowMaxSteps, WorkflowState, WorkflowStep } from '../../models/types.js';
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
import { decrementStepIteration, incrementStepIteration } from './state-manager.js';
import { handleBlocked } from './blocked-handler.js';
import { isDelegatedWorkflowStep } from '../step-kind.js';
import { resolvePromotionRuntime } from '../promotion/promotion-runtime.js';

const log = createLogger('workflow-run-loop');

interface WorkflowRunLoopDeps {
  state: WorkflowState;
  options: WorkflowEngineOptions;
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
    triggeringRuntime?: RuntimeStepResolution,
  ) => Promise<string>;
  runStep: (
    step: WorkflowStep,
    prebuiltInstruction?: string,
    runtime?: RuntimeStepResolution,
  ) => Promise<StepRunResult>;
  buildInstruction: (step: WorkflowStep, stepIteration: number) => string;
  buildPhase1Instruction: (step: WorkflowStep, instruction: string, runtime?: RuntimeStepResolution) => string;
  resolveStepProviderModel: (step: WorkflowStep, runtime?: RuntimeStepResolution) => StepProviderInfo;
  resolveRuntimeForStep: (step: WorkflowStep) => RuntimeStepResolution | undefined;
  setActiveStep: (step: WorkflowStep, iteration: number) => void;
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
    resolveStepProviderModel: deps.resolveStepProviderModel,
  }, step, stepIteration, runtime);
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
  deps.state.currentStep = nextStep;
  deps.setActiveStep(resolvedStep, iteration);
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
  deps.emit('workflow:abort', deps.state, reason);
  return { kind, reason };
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
    let stepIteration: number | undefined;
    if (!isDelegated) {
      stepIteration = incrementStepIteration(deps.state, step.name);
    }
    const promotedRuntime = await resolveStepPromotionRuntime(deps, step, stepIteration, baseStepRuntime);
    const stepRuntime = withFallbackRuntime(deps.state, promotedRuntime);
    let prebuiltInstruction: string | undefined;
    if (!isDelegated && stepIteration !== undefined) {
      prebuiltInstruction = deps.buildInstruction(step, stepIteration);
    }
    const stepInstruction = prebuiltInstruction
      ? deps.buildPhase1Instruction(step, prebuiltInstruction, stepRuntime)
      : '';
    deps.setActiveStep(step, activeIteration);
    deps.emit('step:start', step, activeIteration, stepInstruction, deps.resolveStepProviderModel(step, stepRuntime));

    try {
      const result = await deps.runStep(step, prebuiltInstruction, stepRuntime);
      const { response, instruction, providerInfo } = result;
      if (stepRuntime?.fallback) {
        deps.state.pendingFallback = undefined;
      }
      deps.emit('step:complete', step, response, instruction);

      if (response.status === 'rate_limited') {
        const currentProvider = providerInfo ?? deps.resolveStepProviderModel(step, stepRuntime);
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
        returnValue = transition.returnValue;
        deps.state.status = 'completed';
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
        nextStep = await deps.runLoopMonitorJudge(cycleCheck.monitor, cycleCheck.cycleCount, step, stepRuntime);
      }

      if (nextStep === COMPLETE_STEP) {
        deps.state.status = 'completed';
        deps.emit('workflow:complete', deps.state);
        break;
      }
      if (nextStep === ABORT_STEP) {
        abort = abortWorkflow(deps, 'step_transition', 'Workflow aborted by step transition');
        break;
      }
      advanceActiveStep(deps, nextStep, deps.state.iteration);
    } catch (error) {
      if (deps.abortRequested()) {
        abort = abortWorkflow(deps, 'interrupt', 'Workflow interrupted by user (SIGINT)', {
          clearLastOutput: true,
        });
      } else {
        abort = abortWorkflow(
          deps,
          'runtime_error',
          ERROR_MESSAGES.STEP_EXECUTION_FAILED(getErrorMessage(error)),
          { clearLastOutput: true },
        );
      }
      break;
    }
  }

  return abort
    ? { state: deps.state, abort }
    : { state: deps.state, ...(returnValue !== undefined ? { returnValue } : {}) };
}

export async function runSingleWorkflowIteration(deps: WorkflowRunLoopDeps): Promise<{
  response: AgentResponse;
  nextStep: string;
  isComplete: boolean;
  loopDetected?: boolean;
}> {
  const step = deps.getStep(deps.state.currentStep);
  deps.applyRuntimeEnvironment('step');
  const loopCheck = deps.loopDetectorCheck(step.name);

  if (loopCheck.shouldAbort) {
    deps.state.status = 'aborted';
    return {
      response: {
        persona: step.persona ?? step.name,
        status: 'blocked',
        content: ERROR_MESSAGES.LOOP_DETECTED(step.name, loopCheck.count),
        timestamp: new Date(),
      },
      nextStep: ABORT_STEP,
      isComplete: true,
      loopDetected: true,
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
  const stepRuntime = withFallbackRuntime(deps.state, promotedRuntime);
  let prebuiltInstruction: string | undefined;
  if (!isDelegated && stepIteration !== undefined) {
    prebuiltInstruction = deps.buildInstruction(step, stepIteration);
  }
  const result = await deps.runStep(step, prebuiltInstruction, stepRuntime);
  const { response, providerInfo } = result;
  if (stepRuntime?.fallback) {
    deps.state.pendingFallback = undefined;
  }

  if (response.status === 'blocked') {
    deps.state.status = 'aborted';
    deps.emit('workflow:abort', deps.state, 'Workflow blocked and no user input provided');
    return { response, nextStep: ABORT_STEP, isComplete: true, loopDetected: loopCheck.isLoop };
  }
  if (response.status === 'rate_limited') {
    const currentProvider = providerInfo ?? deps.resolveStepProviderModel(step, stepRuntime);
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
    return { response, nextStep: ABORT_STEP, isComplete: true, loopDetected: loopCheck.isLoop };
  }
  if (response.status === 'error') {
    deps.state.status = 'aborted';
    deps.emit('workflow:abort', deps.state, `Step "${step.name}" failed: ${response.error ?? response.content}`);
    return { response, nextStep: ABORT_STEP, isComplete: true, loopDetected: loopCheck.isLoop };
  }

  if (stepRuntime?.fallback) {
    deps.state.rateLimitFallbackAttempts = undefined;
  }

  const transition = deps.resolveDoneTransition(step, response);
  if (transition.requiresUserInput) {
    if (!deps.options.onUserInput) {
      deps.state.status = 'aborted';
      return { response, nextStep: ABORT_STEP, isComplete: true, loopDetected: loopCheck.isLoop };
    }
    const userInput = await deps.options.onUserInput({ step, response, prompt: response.content });
    if (userInput === null) {
      deps.state.status = 'aborted';
      return { response, nextStep: ABORT_STEP, isComplete: true, loopDetected: loopCheck.isLoop };
    }
    deps.addUserInput(userInput);
    deps.emit('step:user_input', step, userInput);
    deps.state.currentStep = step.name;
    return { response, nextStep: step.name, isComplete: false, loopDetected: loopCheck.isLoop };
  }

  if (transition.returnValue !== undefined) {
    deps.state.status = 'completed';
    return { response, nextStep: COMPLETE_STEP, isComplete: true, loopDetected: loopCheck.isLoop };
  }

  const nextStep = requireNextStep(step, transition);
  const isComplete = nextStep === COMPLETE_STEP || nextStep === ABORT_STEP;

  if (!isComplete) {
    advanceActiveStep(deps, nextStep, deps.state.iteration);
  } else {
    deps.state.status = nextStep === COMPLETE_STEP ? 'completed' : 'aborted';
  }

  return { response, nextStep, isComplete, loopDetected: loopCheck.isLoop };
}

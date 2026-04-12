import { createLogger, getErrorMessage } from '../../../shared/utils/index.js';
import type { AgentResponse, LoopMonitorConfig, WorkflowState, WorkflowStep } from '../../models/types.js';
import { ABORT_STEP, COMPLETE_STEP, ERROR_MESSAGES } from '../constants.js';
import type { RuntimeStepResolution, StepProviderInfo, WorkflowEngineOptions } from '../types.js';
import { incrementStepIteration } from './state-manager.js';
import { handleBlocked } from './blocked-handler.js';

const log = createLogger('workflow-run-loop');

interface WorkflowRunLoopDeps {
  state: WorkflowState;
  options: WorkflowEngineOptions;
  getMaxSteps: () => number;
  abortRequested: () => boolean;
  getStep: (name: string) => WorkflowStep;
  applyRuntimeEnvironment: (stage: 'step') => void;
  loopDetectorCheck: (stepName: string) => { shouldWarn?: boolean; shouldAbort?: boolean; count: number; isLoop: boolean };
  cycleDetectorRecordAndCheck: (stepName: string) => { triggered: boolean; monitor?: LoopMonitorConfig; cycleCount: number };
  resolveNextStepFromDone: (step: WorkflowStep, response: AgentResponse) => string;
  runLoopMonitorJudge: (
    monitor: LoopMonitorConfig,
    cycleCount: number,
    triggeringStep: WorkflowStep,
    triggeringRuntime?: RuntimeStepResolution,
  ) => Promise<string>;
  runStep: (step: WorkflowStep, prebuiltInstruction?: string) => Promise<{ response: AgentResponse; instruction: string }>;
  buildInstruction: (step: WorkflowStep, stepIteration: number) => string;
  buildPhase1Instruction: (step: WorkflowStep, instruction: string) => string;
  resolveStepProviderModel: (step: WorkflowStep, runtime?: RuntimeStepResolution) => StepProviderInfo;
  addUserInput: (input: string) => void;
  emit: (event: string, ...args: unknown[]) => void;
  updateMaxSteps: (maxSteps: number) => void;
}

export async function runWorkflowToCompletion(deps: WorkflowRunLoopDeps): Promise<WorkflowState> {
  while (deps.state.status === 'running') {
    if (deps.abortRequested()) {
      deps.state.status = 'aborted';
      deps.emit('workflow:abort', deps.state, 'Workflow interrupted by user (SIGINT)');
      break;
    }

    const maxSteps = deps.getMaxSteps();
    if (deps.state.iteration >= maxSteps) {
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

      deps.state.status = 'aborted';
      deps.emit('workflow:abort', deps.state, ERROR_MESSAGES.MAX_STEPS_REACHED);
      break;
    }

    const step = deps.getStep(deps.state.currentStep);
    deps.applyRuntimeEnvironment('step');
    const loopCheck = deps.loopDetectorCheck(step.name);

    if (loopCheck.shouldWarn) {
      deps.emit('step:loop_detected', step, loopCheck.count);
    }
    if (loopCheck.shouldAbort) {
      deps.state.status = 'aborted';
      deps.emit('workflow:abort', deps.state, ERROR_MESSAGES.LOOP_DETECTED(step.name, loopCheck.count));
      break;
    }

    deps.state.iteration++;
    const isDelegated = step.mode === 'system'
      || (step.parallel && step.parallel.length > 0)
      || !!step.arpeggio
      || !!step.teamLeader;
    let prebuiltInstruction: string | undefined;
    if (!isDelegated) {
      const stepIteration = incrementStepIteration(deps.state, step.name);
      prebuiltInstruction = deps.buildInstruction(step, stepIteration);
    }
    const stepInstruction = prebuiltInstruction
      ? deps.buildPhase1Instruction(step, prebuiltInstruction)
      : '';
    deps.emit('step:start', step, deps.state.iteration, stepInstruction, deps.resolveStepProviderModel(step));

    try {
      const { response, instruction } = await deps.runStep(step, prebuiltInstruction);
      deps.emit('step:complete', step, response, instruction);

      if (response.status === 'blocked') {
        deps.emit('step:blocked', step, response);
        const result = await handleBlocked(step, response, deps.options);
        if (result.shouldContinue && result.userInput) {
          deps.addUserInput(result.userInput);
          deps.emit('step:user_input', step, result.userInput);
          continue;
        }
        deps.state.status = 'aborted';
        deps.emit('workflow:abort', deps.state, 'Workflow blocked and no user input provided');
        break;
      }

      if (response.status === 'error') {
        deps.state.status = 'aborted';
        deps.emit('workflow:abort', deps.state, `Step "${step.name}" failed: ${response.error ?? response.content}`);
        break;
      }

      let nextStep = deps.resolveNextStepFromDone(step, response);
      log.debug('Step transition', {
        from: step.name,
        status: response.status,
        matchedRuleIndex: response.matchedRuleIndex,
        nextStep,
      });

      if (response.matchedRuleIndex != null && step.rules) {
        const matchedRule = step.rules[response.matchedRuleIndex];
        if (matchedRule?.requiresUserInput) {
          if (!deps.options.onUserInput) {
            deps.state.status = 'aborted';
            deps.emit('workflow:abort', deps.state, 'User input required but no handler is configured');
            break;
          }
          const userInput = await deps.options.onUserInput({ step, response, prompt: response.content });
          if (userInput === null) {
            deps.state.status = 'aborted';
            deps.emit('workflow:abort', deps.state, 'User input cancelled');
            break;
          }
          deps.addUserInput(userInput);
          deps.emit('step:user_input', step, userInput);
          deps.state.currentStep = step.name;
          continue;
        }
      }

      const cycleCheck = deps.cycleDetectorRecordAndCheck(step.name);
      if (cycleCheck.triggered && cycleCheck.monitor) {
        log.info('Loop monitor cycle threshold reached', {
          cycle: cycleCheck.monitor.cycle,
          cycleCount: cycleCheck.cycleCount,
          threshold: cycleCheck.monitor.threshold,
        });
        deps.emit('step:cycle_detected', cycleCheck.monitor, cycleCheck.cycleCount);
        nextStep = await deps.runLoopMonitorJudge(cycleCheck.monitor, cycleCheck.cycleCount, step, {
          providerInfo: deps.resolveStepProviderModel(step),
        });
      }

      if (nextStep === COMPLETE_STEP) {
        deps.state.status = 'completed';
        deps.emit('workflow:complete', deps.state);
        break;
      }
      if (nextStep === ABORT_STEP) {
        deps.state.status = 'aborted';
        deps.emit('workflow:abort', deps.state, 'Workflow aborted by step transition');
        break;
      }
      deps.state.currentStep = nextStep;
    } catch (error) {
      deps.state.status = 'aborted';
      if (deps.abortRequested()) {
        deps.emit('workflow:abort', deps.state, 'Workflow interrupted by user (SIGINT)');
      } else {
        deps.emit('workflow:abort', deps.state, ERROR_MESSAGES.STEP_EXECUTION_FAILED(getErrorMessage(error)));
      }
      break;
    }
  }

  return deps.state;
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
  const { response } = await deps.runStep(step);

  if (response.status === 'blocked') {
    deps.state.status = 'aborted';
    deps.emit('workflow:abort', deps.state, 'Workflow blocked and no user input provided');
    return { response, nextStep: ABORT_STEP, isComplete: true, loopDetected: loopCheck.isLoop };
  }
  if (response.status === 'error') {
    deps.state.status = 'aborted';
    deps.emit('workflow:abort', deps.state, `Step "${step.name}" failed: ${response.error ?? response.content}`);
    return { response, nextStep: ABORT_STEP, isComplete: true, loopDetected: loopCheck.isLoop };
  }

  const nextStep = deps.resolveNextStepFromDone(step, response);
  const isComplete = nextStep === COMPLETE_STEP || nextStep === ABORT_STEP;

  if (response.matchedRuleIndex != null && step.rules) {
    const matchedRule = step.rules[response.matchedRuleIndex];
    if (matchedRule?.requiresUserInput) {
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
  }

  if (!isComplete) {
    deps.state.currentStep = nextStep;
  } else {
    deps.state.status = nextStep === COMPLETE_STEP ? 'completed' : 'aborted';
  }

  return { response, nextStep, isComplete, loopDetected: loopCheck.isLoop };
}

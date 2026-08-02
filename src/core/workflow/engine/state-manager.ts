/**
 * Workflow state management
 *
 * Manages the mutable state of a workflow execution including
 * user inputs and agent sessions.
 */

import {
  isDynamicParallelSubSteps,
  type WorkflowState,
  type WorkflowConfig,
  type AgentResponse,
} from '../../models/types.js';
import {
  MAX_USER_INPUTS,
  MAX_INPUT_LENGTH,
} from '../constants.js';
import type { WorkflowEngineOptions } from '../types.js';
import {
  workflowEntryMatchesWorkflow,
} from '../workflow-reference.js';
import { buildDynamicParallelSelectionIdentity } from '../dynamic-parallel/identity.js';
import { restoreAndValidateDynamicParallelSelections } from '../dynamic-parallel/resume-state.js';
import { workflowOwnerPathFromStack } from '../workflow-execution-scope.js';

function resolveInitialIteration(options: WorkflowEngineOptions): number {
  const resumeIteration = options.resumePoint?.iteration;
  if (
    options.initialIteration !== undefined
    && resumeIteration !== undefined
    && options.initialIteration !== resumeIteration
  ) {
    throw new Error(
      `Initial iteration ${options.initialIteration} does not match resume iteration ${resumeIteration}`,
    );
  }
  return options.initialIteration ?? resumeIteration ?? 0;
}

/**
 * Manages workflow execution state.
 *
 * Encapsulates WorkflowState and provides methods for state mutations.
 */
export class StateManager {
  readonly state: WorkflowState;

  constructor(config: WorkflowConfig, options: WorkflowEngineOptions) {
    // Restore persona sessions from options if provided
    const personaSessions = new Map<string, string>();
    if (options.initialSessions) {
      for (const [persona, sessionId] of Object.entries(options.initialSessions)) {
        personaSessions.set(persona, sessionId);
      }
    }

    // Initialize user inputs from options if provided
    const userInputs = options.initialUserInputs
      ? [...options.initialUserInputs]
      : [];

    const currentStep = options.startStep ?? config.initialStep;
    const resumeEntry = options.resumePoint?.stack[options.resumeStackPrefix?.length ?? 0];
    const pendingJudge = options.resumePoint?.pending_loop_judge;
    const resumeEntryOwnsState = resumeEntry !== undefined
      && workflowEntryMatchesWorkflow(resumeEntry, config)
      && (resumeEntry.step === currentStep
        || (pendingJudge?.status === 'started' && resumeEntry.step === pendingJudge.judge_step));
    const stepIterations = resumeEntryOwnsState
      ? new Map(Object.entries(resumeEntry.step_iterations ?? {}))
      : new Map<string, number>();
    const dynamicParallelSelections = restoreAndValidateDynamicParallelSelections(config, options);
    const isResumeTarget = resumeEntry !== undefined
      && resumeEntry.step === currentStep
      && workflowEntryMatchesWorkflow(resumeEntry, config);
    const currentStepConfig = config.steps.find((step) => step.name === currentStep);
    const dynamicParallelSelectionIdentity = currentStepConfig?.parallel !== undefined
      && isDynamicParallelSubSteps(currentStepConfig.parallel)
      ? buildDynamicParallelSelectionIdentity(
          config,
          currentStep,
          workflowOwnerPathFromStack(options.resumeStackPrefix ?? []),
        )
      : undefined;
    const savedSelectionForCurrentStep = dynamicParallelSelectionIdentity === undefined
      ? undefined
      : dynamicParallelSelections.get(dynamicParallelSelectionIdentity);
    if (
      isResumeTarget
      && currentStepConfig?.parallel !== undefined
      && isDynamicParallelSubSteps(currentStepConfig.parallel)
      && savedSelectionForCurrentStep === undefined
    ) {
      throw new Error(
        `Dynamic parallel selection snapshot is required to resume "${currentStep}"`,
      );
    }
    if (
      savedSelectionForCurrentStep !== undefined
      && savedSelectionForCurrentStep.step_name !== currentStep
    ) {
      throw new Error(
        `Dynamic parallel selection snapshot step_name does not match resumed step "${currentStep}"`,
      );
    }

    this.state = {
      workflowName: config.name,
      currentStep,
      iteration: resolveInitialIteration(options),
      stepOutputs: new Map(),
      structuredOutputs: new Map(),
      systemContexts: new Map(),
      effectResults: new Map(),
      lastOutput: undefined,
      previousResponseSourcePath: undefined,
      userInputs,
      personaSessions,
      stepIterations,
      restoredStepIterationNames: new Set(stepIterations.keys()),
      dynamicParallelSelections,
      resumedDynamicParallelSteps: isResumeTarget
        && dynamicParallelSelectionIdentity !== undefined
        && savedSelectionForCurrentStep !== undefined
        ? new Set([dynamicParallelSelectionIdentity])
        : new Set(),
      ...(!isResumeTarget
        || dynamicParallelSelectionIdentity === undefined
        || savedSelectionForCurrentStep === undefined
        ? {}
        : { activeDynamicParallelSelectionIdentity: dynamicParallelSelectionIdentity }),
      ...(options.resumePoint?.pending_fallback === undefined
        ? {}
        : {
            pendingFallback: { ...options.resumePoint.pending_fallback.context },
            rateLimitFallbackAttempts: options.resumePoint.pending_fallback.attempts.map(
              (attempt) => ({ ...attempt }),
            ),
          }),
      status: 'running',
    };
  }

  /**
   * Increment the iteration counter for a step and return the new value.
   */
  incrementStepIteration(stepName: string): number {
    const current = this.state.stepIterations.get(stepName) ?? 0;
    const next = current + 1;
    this.state.stepIterations.set(stepName, next);
    return next;
  }

  /**
   * Add user input to state with truncation and limit handling.
   */
  addUserInput(input: string): void {
    if (this.state.userInputs.length >= MAX_USER_INPUTS) {
      this.state.userInputs.shift();
    }
    const truncated = input.slice(0, MAX_INPUT_LENGTH);
    this.state.userInputs.push(truncated);
  }

  /**
   * Get the most recent step output.
   */
  getPreviousOutput(): AgentResponse | undefined {
    const outputs = Array.from(this.state.stepOutputs.values());
    return outputs[outputs.length - 1];
  }
}

/**
 * Create initial workflow state from config and options.
 */
export function createInitialState(
  config: WorkflowConfig,
  options: WorkflowEngineOptions,
): WorkflowState {
  return new StateManager(config, options).state;
}

/**
 * Increment the iteration counter for a step and return the new value.
 */
export function incrementStepIteration(state: WorkflowState, stepName: string): number {
  const current = state.stepIterations.get(stepName) ?? 0;
  const next = current + 1;
  state.stepIterations.set(stepName, next);
  return next;
}

export function decrementStepIteration(state: WorkflowState, stepName: string): number {
  const current = state.stepIterations.get(stepName) ?? 0;
  const next = Math.max(0, current - 1);
  if (next === 0) {
    state.stepIterations.delete(stepName);
  } else {
    state.stepIterations.set(stepName, next);
  }
  return next;
}

/**
 * Add user input to state with truncation and limit handling.
 */
export function addUserInput(state: WorkflowState, input: string): void {
  if (state.userInputs.length >= MAX_USER_INPUTS) {
    state.userInputs.shift();
  }
  const truncated = input.slice(0, MAX_INPUT_LENGTH);
  state.userInputs.push(truncated);
}

/**
 * Get the most recent step output.
 */
export function getPreviousOutput(state: WorkflowState): AgentResponse | undefined {
  if (state.lastOutput) return state.lastOutput;
  const outputs = Array.from(state.stepOutputs.values());
  return outputs[outputs.length - 1];
}

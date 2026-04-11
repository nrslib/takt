/**
 * Workflow state management
 *
 * Manages the mutable state of a workflow execution including
 * user inputs and agent sessions.
 */

import type { WorkflowState, WorkflowConfig, AgentResponse } from '../../models/types.js';
import {
  MAX_USER_INPUTS,
  MAX_INPUT_LENGTH,
} from '../constants.js';
import type { WorkflowEngineOptions } from '../types.js';

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

    this.state = {
      workflowName: config.name,
      currentStep: options.startStep ?? config.initialStep,
      iteration: options.initialIteration ?? 0,
      stepOutputs: new Map(),
      structuredOutputs: new Map(),
      systemContexts: new Map(),
      effectResults: new Map(),
      lastOutput: undefined,
      previousResponseSourcePath: undefined,
      userInputs,
      personaSessions,
      stepIterations: new Map(),
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

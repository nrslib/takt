import type {
  FallbackContext,
  RateLimitFallbackProvider,
  WorkflowState,
} from '../../models/types.js';
import { decrementStepIteration, incrementStepIteration } from './state-manager.js';

interface CountableStepStartOptions {
  state: WorkflowState;
  stepName: string;
  iteration: number;
  expectedStepIteration: number;
  recordProgress: () => void;
  persist: () => void;
}

export function commitCountableStepStart(options: CountableStepStartOptions): number {
  if (options.iteration !== options.state.iteration + 1) {
    throw new Error(`Countable step "${options.stepName}" has a non-sequential iteration`);
  }
  options.state.iteration = options.iteration;
  const stepIteration = incrementStepIteration(options.state, options.stepName);
  if (stepIteration !== options.expectedStepIteration) {
    throw new Error(`Countable step "${options.stepName}" has an inconsistent step iteration`);
  }
  options.recordProgress();
  options.persist();
  return stepIteration;
}

interface FallbackRollbackOptions {
  state: WorkflowState;
  context: FallbackContext;
  attempts: readonly RateLimitFallbackProvider[];
  consumedStepIterations: readonly string[];
  persist: () => void;
}

export function commitFallbackRollback(options: FallbackRollbackOptions): void {
  if (options.context.originalIteration !== options.state.iteration) {
    throw new Error(`Fallback for "${options.context.stepName}" does not own the active iteration`);
  }
  options.state.pendingFallback = { ...options.context };
  options.state.rateLimitFallbackAttempts = options.attempts.map((attempt) => ({ ...attempt }));
  options.state.iteration = options.context.originalIteration - 1;
  for (const stepName of new Set(options.consumedStepIterations)) {
    decrementStepIteration(options.state, stepName);
  }
  options.persist();
}

export function requeueFallbackAfterTerminalResponse(
  state: WorkflowState,
  consumedStepIterations: readonly string[],
  persist: () => void,
): void {
  if (state.pendingFallback === undefined || state.rateLimitFallbackAttempts === undefined) {
    throw new Error('Cannot requeue a fallback without persisted fallback state');
  }
  commitFallbackRollback({
    state,
    context: state.pendingFallback,
    attempts: state.rateLimitFallbackAttempts,
    consumedStepIterations,
    persist,
  });
}

export function completeFallback(
  state: WorkflowState,
  persist: () => void,
): void {
  if (state.pendingFallback === undefined || state.rateLimitFallbackAttempts === undefined) {
    throw new Error('Cannot complete a fallback without persisted fallback state');
  }
  state.pendingFallback = undefined;
  state.rateLimitFallbackAttempts = undefined;
  persist();
}

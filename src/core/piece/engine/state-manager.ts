/**
 * Piece state management
 *
 * Manages the mutable state of a piece execution including
 * user inputs and agent sessions.
 */

import type { PieceState, PieceConfig, AgentResponse } from '../../models/types.js';
import {
  MAX_USER_INPUTS,
  MAX_INPUT_LENGTH,
} from '../constants.js';
import type { PieceEngineOptions } from '../types.js';

/**
 * Manages piece execution state.
 *
 * Encapsulates PieceState and provides methods for state mutations.
 */
export class StateManager {
  readonly state: PieceState;

  constructor(config: PieceConfig, options: PieceEngineOptions) {
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
      pieceName: config.name,
      currentMovement: options.startMovement ?? config.initialMovement,
      iteration: 0,
      movementOutputs: new Map(),
      lastOutput: undefined,
      previousResponseSourcePath: undefined,
      userInputs,
      personaSessions,
      movementIterations: new Map(),
      status: 'running',
    };
  }

  /**
   * Increment the iteration counter for a movement and return the new value.
   */
  incrementMovementIteration(movementName: string): number {
    const current = this.state.movementIterations.get(movementName) ?? 0;
    const next = current + 1;
    this.state.movementIterations.set(movementName, next);
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
   * Get the most recent movement output.
   */
  getPreviousOutput(): AgentResponse | undefined {
    const outputs = Array.from(this.state.movementOutputs.values());
    return outputs[outputs.length - 1];
  }
}

/**
 * Create initial piece state from config and options.
 */
export function createInitialState(
  config: PieceConfig,
  options: PieceEngineOptions,
): PieceState {
  return new StateManager(config, options).state;
}

/**
 * Increment the iteration counter for a movement and return the new value.
 */
export function incrementMovementIteration(state: PieceState, movementName: string): number {
  const current = state.movementIterations.get(movementName) ?? 0;
  const next = current + 1;
  state.movementIterations.set(movementName, next);
  return next;
}

/**
 * Add user input to state with truncation and limit handling.
 */
export function addUserInput(state: PieceState, input: string): void {
  if (state.userInputs.length >= MAX_USER_INPUTS) {
    state.userInputs.shift();
  }
  const truncated = input.slice(0, MAX_INPUT_LENGTH);
  state.userInputs.push(truncated);
}

/**
 * Get the most recent movement output.
 */
export function getPreviousOutput(state: PieceState): AgentResponse | undefined {
  if (state.lastOutput) return state.lastOutput;
  const outputs = Array.from(state.movementOutputs.values());
  return outputs[outputs.length - 1];
}

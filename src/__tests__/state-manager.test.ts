/**
 * Unit tests for StateManager
 *
 * Tests piece state initialization, user input management,
 * movement iteration tracking, and output retrieval.
 */

import { describe, it, expect } from 'vitest';
import {
  StateManager,
  createInitialState,
  incrementMovementIteration,
  addUserInput,
  getPreviousOutput,
} from '../core/piece/engine/state-manager.js';
import { MAX_USER_INPUTS, MAX_INPUT_LENGTH } from '../core/piece/constants.js';
import type { PieceConfig, AgentResponse, PieceState } from '../core/models/types.js';
import type { PieceEngineOptions } from '../core/piece/types.js';

function makeConfig(overrides: Partial<PieceConfig> = {}): PieceConfig {
  return {
    name: 'test-piece',
    movements: [],
    initialMovement: 'start',
    maxMovements: 10,
    ...overrides,
  };
}

function makeOptions(overrides: Partial<PieceEngineOptions> = {}): PieceEngineOptions {
  return {
    projectCwd: '/tmp/project',
    ...overrides,
  };
}

function makeResponse(content: string): AgentResponse {
  return {
    persona: 'tester',
    status: 'done',
    content,
    timestamp: new Date(),
  };
}

describe('StateManager', () => {
  describe('constructor', () => {
    it('should initialize state with config defaults', () => {
      const manager = new StateManager(makeConfig(), makeOptions());

      expect(manager.state.pieceName).toBe('test-piece');
      expect(manager.state.currentMovement).toBe('start');
      expect(manager.state.iteration).toBe(0);
      expect(manager.state.status).toBe('running');
      expect(manager.state.userInputs).toEqual([]);
      expect(manager.state.movementOutputs.size).toBe(0);
      expect(manager.state.personaSessions.size).toBe(0);
      expect(manager.state.movementIterations.size).toBe(0);
    });

    it('should use startMovement option when provided', () => {
      const manager = new StateManager(
        makeConfig(),
        makeOptions({ startMovement: 'custom-start' }),
      );

      expect(manager.state.currentMovement).toBe('custom-start');
    });

    it('should restore initial sessions from options', () => {
      const manager = new StateManager(
        makeConfig(),
        makeOptions({
          initialSessions: { coder: 'session-1', reviewer: 'session-2' },
        }),
      );

      expect(manager.state.personaSessions.get('coder')).toBe('session-1');
      expect(manager.state.personaSessions.get('reviewer')).toBe('session-2');
    });

    it('should restore initial user inputs from options', () => {
      const manager = new StateManager(
        makeConfig(),
        makeOptions({
          initialUserInputs: ['input1', 'input2'],
        }),
      );

      expect(manager.state.userInputs).toEqual(['input1', 'input2']);
    });
  });

  describe('incrementMovementIteration', () => {
    it('should start at 1 for new movement', () => {
      const manager = new StateManager(makeConfig(), makeOptions());
      const count = manager.incrementMovementIteration('review');
      expect(count).toBe(1);
    });

    it('should increment correctly for repeated movements', () => {
      const manager = new StateManager(makeConfig(), makeOptions());
      manager.incrementMovementIteration('review');
      manager.incrementMovementIteration('review');
      const count = manager.incrementMovementIteration('review');
      expect(count).toBe(3);
    });

    it('should track different movements independently', () => {
      const manager = new StateManager(makeConfig(), makeOptions());
      manager.incrementMovementIteration('review');
      manager.incrementMovementIteration('review');
      manager.incrementMovementIteration('implement');
      expect(manager.state.movementIterations.get('review')).toBe(2);
      expect(manager.state.movementIterations.get('implement')).toBe(1);
    });
  });

  describe('addUserInput', () => {
    it('should add input to state', () => {
      const manager = new StateManager(makeConfig(), makeOptions());
      manager.addUserInput('hello');
      expect(manager.state.userInputs).toEqual(['hello']);
    });

    it('should truncate input exceeding max length', () => {
      const manager = new StateManager(makeConfig(), makeOptions());
      const longInput = 'x'.repeat(MAX_INPUT_LENGTH + 100);
      manager.addUserInput(longInput);
      expect(manager.state.userInputs[0]!.length).toBe(MAX_INPUT_LENGTH);
    });

    it('should evict oldest input when exceeding max inputs', () => {
      const manager = new StateManager(makeConfig(), makeOptions());
      for (let i = 0; i < MAX_USER_INPUTS; i++) {
        manager.addUserInput(`input-${i}`);
      }
      expect(manager.state.userInputs.length).toBe(MAX_USER_INPUTS);

      manager.addUserInput('overflow');
      expect(manager.state.userInputs.length).toBe(MAX_USER_INPUTS);
      expect(manager.state.userInputs[0]).toBe('input-1');
      expect(manager.state.userInputs[manager.state.userInputs.length - 1]).toBe('overflow');
    });
  });

  describe('getPreviousOutput', () => {
    it('should return undefined when no outputs exist', () => {
      const manager = new StateManager(makeConfig(), makeOptions());
      expect(manager.getPreviousOutput()).toBeUndefined();
    });

    it('should return the last output from movementOutputs', () => {
      const manager = new StateManager(makeConfig(), makeOptions());
      const response1 = makeResponse('first');
      const response2 = makeResponse('second');
      manager.state.movementOutputs.set('step-1', response1);
      manager.state.movementOutputs.set('step-2', response2);
      expect(manager.getPreviousOutput()?.content).toBe('second');
    });
  });
});

describe('standalone functions', () => {
  function makeState(): PieceState {
    return {
      pieceName: 'test',
      currentMovement: 'start',
      iteration: 0,
      movementOutputs: new Map(),
      userInputs: [],
      personaSessions: new Map(),
      movementIterations: new Map(),
      status: 'running',
    };
  }

  describe('createInitialState', () => {
    it('should create state from config and options', () => {
      const state = createInitialState(makeConfig(), makeOptions());
      expect(state.pieceName).toBe('test-piece');
      expect(state.currentMovement).toBe('start');
      expect(state.status).toBe('running');
    });
  });

  describe('incrementMovementIteration (standalone)', () => {
    it('should increment counter on state', () => {
      const state = makeState();
      expect(incrementMovementIteration(state, 'review')).toBe(1);
      expect(incrementMovementIteration(state, 'review')).toBe(2);
    });
  });

  describe('addUserInput (standalone)', () => {
    it('should add input and truncate', () => {
      const state = makeState();
      addUserInput(state, 'test input');
      expect(state.userInputs).toEqual(['test input']);
    });
  });

  describe('getPreviousOutput (standalone)', () => {
    it('should prefer lastOutput over movementOutputs', () => {
      const state = makeState();
      const lastOutput = makeResponse('last');
      const mapOutput = makeResponse('from-map');
      state.lastOutput = lastOutput;
      state.movementOutputs.set('step-1', mapOutput);

      expect(getPreviousOutput(state)?.content).toBe('last');
    });

    it('should fall back to movementOutputs when lastOutput is undefined', () => {
      const state = makeState();
      const mapOutput = makeResponse('from-map');
      state.movementOutputs.set('step-1', mapOutput);

      expect(getPreviousOutput(state)?.content).toBe('from-map');
    });

    it('should return undefined when both are empty', () => {
      const state = makeState();
      expect(getPreviousOutput(state)).toBeUndefined();
    });
  });
});

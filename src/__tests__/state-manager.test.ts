/**
 * Unit tests for StateManager
 *
 * Tests workflow state initialization, user input management,
 * step iteration tracking, and output retrieval.
 */

import { describe, it, expect } from 'vitest';
import {
  StateManager,
  createInitialState,
  incrementStepIteration,
  addUserInput,
  getPreviousOutput,
} from '../core/workflow/engine/state-manager.js';
import { MAX_USER_INPUTS, MAX_INPUT_LENGTH } from '../core/workflow/constants.js';
import type { WorkflowConfig, AgentResponse, WorkflowState } from '../core/models/types.js';
import type { WorkflowEngineOptions } from '../core/workflow/types.js';

function makeConfig(overrides: Partial<WorkflowConfig> = {}): WorkflowConfig {
  return {
    name: 'test-workflow',
    steps: [],
    initialStep: 'start',
    maxSteps: 10,
    ...overrides,
  };
}

function makeOptions(overrides: Partial<WorkflowEngineOptions> = {}): WorkflowEngineOptions {
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

      expect(manager.state.workflowName).toBe('test-workflow');
      expect(manager.state.currentStep).toBe('start');
      expect(manager.state.iteration).toBe(0);
      expect(manager.state.status).toBe('running');
      expect(manager.state.userInputs).toEqual([]);
      expect(manager.state.stepOutputs.size).toBe(0);
      expect(manager.state.personaSessions.size).toBe(0);
      expect(manager.state.stepIterations.size).toBe(0);
    });

    it('should use startStep option when provided', () => {
      const manager = new StateManager(
        makeConfig(),
        makeOptions({ startStep: 'custom-start' }),
      );

      expect(manager.state.currentStep).toBe('custom-start');
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

  describe('incrementStepIteration', () => {
    it('should start at 1 for new step', () => {
      const manager = new StateManager(makeConfig(), makeOptions());
      const count = manager.incrementStepIteration('review');
      expect(count).toBe(1);
    });

    it('should increment correctly for repeated steps', () => {
      const manager = new StateManager(makeConfig(), makeOptions());
      manager.incrementStepIteration('review');
      manager.incrementStepIteration('review');
      const count = manager.incrementStepIteration('review');
      expect(count).toBe(3);
    });

    it('should track different steps independently', () => {
      const manager = new StateManager(makeConfig(), makeOptions());
      manager.incrementStepIteration('review');
      manager.incrementStepIteration('review');
      manager.incrementStepIteration('implement');
      expect(manager.state.stepIterations.get('review')).toBe(2);
      expect(manager.state.stepIterations.get('implement')).toBe(1);
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

    it('should return the last output from stepOutputs', () => {
      const manager = new StateManager(makeConfig(), makeOptions());
      const response1 = makeResponse('first');
      const response2 = makeResponse('second');
      manager.state.stepOutputs.set('step-1', response1);
      manager.state.stepOutputs.set('step-2', response2);
      expect(manager.getPreviousOutput()?.content).toBe('second');
    });
  });
});

describe('standalone functions', () => {
  function makeState(): WorkflowState {
    return {
      workflowName: 'test',
      currentStep: 'start',
      iteration: 0,
      stepOutputs: new Map(),
      userInputs: [],
      personaSessions: new Map(),
      stepIterations: new Map(),
      status: 'running',
    };
  }

  describe('createInitialState', () => {
    it('should create state from config and options', () => {
      const state = createInitialState(makeConfig(), makeOptions());
      expect(state.workflowName).toBe('test-workflow');
      expect(state.currentStep).toBe('start');
      expect(state.status).toBe('running');
    });
  });

  describe('incrementStepIteration (standalone)', () => {
    it('should increment counter on state', () => {
      const state = makeState();
      expect(incrementStepIteration(state, 'review')).toBe(1);
      expect(incrementStepIteration(state, 'review')).toBe(2);
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
    it('should prefer lastOutput over stepOutputs', () => {
      const state = makeState();
      const lastOutput = makeResponse('last');
      const mapOutput = makeResponse('from-map');
      state.lastOutput = lastOutput;
      state.stepOutputs.set('step-1', mapOutput);

      expect(getPreviousOutput(state)?.content).toBe('last');
    });

    it('should fall back to stepOutputs when lastOutput is undefined', () => {
      const state = makeState();
      const mapOutput = makeResponse('from-map');
      state.stepOutputs.set('step-1', mapOutput);

      expect(getPreviousOutput(state)?.content).toBe('from-map');
    });

    it('should return undefined when both are empty', () => {
      const state = makeState();
      expect(getPreviousOutput(state)).toBeUndefined();
    });
  });
});

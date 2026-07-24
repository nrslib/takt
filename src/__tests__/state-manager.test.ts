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
import type {
  WorkflowConfig,
  AgentResponse,
  WorkflowResumePoint,
  WorkflowState,
} from '../core/models/types.js';
import type { WorkflowEngineOptions } from '../core/workflow/types.js';
import { resolveWorkflowCallContinuation } from '../core/workflow/run/resume-point.js';

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

    it('should continue step iterations from the matching resume workflow frame', () => {
      const manager = new StateManager(
        makeConfig(),
        makeOptions({
          startStep: 'review',
          resumePoint: {
            version: 1,
            stack: [
              {
                workflow: 'parent',
                step: 'delegate',
                kind: 'workflow_call',
                step_iterations: { delegate: 3 },
              },
              {
                workflow: 'test-workflow',
                step: 'review',
                kind: 'agent',
                step_iterations: { review: 6, fix: 2 },
              },
            ],
            iteration: 12,
            elapsed_ms: 100,
          },
          resumeStackPrefix: [
            { workflow: 'parent', step: 'delegate', kind: 'workflow_call' },
          ],
        }),
      );

      expect(manager.incrementStepIteration('review')).toBe(7);
      expect(manager.state.stepIterations.get('fix')).toBe(2);
    });

    it('should preserve the persisted workflow_call invocation iteration for an in-flight child continuation', () => {
      const childConfig = makeConfig({
        name: 'child',
        initialStep: 'review',
        steps: [{ name: 'review', personaDisplayName: 'review', instruction: '' }],
      });
      const parentConfig = makeConfig({
        steps: [{
          name: 'delegate',
          kind: 'workflow_call',
          call: childConfig.name,
          personaDisplayName: 'delegate',
          instruction: '',
        }],
      });
      const resumePoint: WorkflowResumePoint = {
        version: 1,
        stack: [{
          workflow: 'test-workflow',
          step: 'delegate',
          kind: 'workflow_call',
          step_iterations: { delegate: 3 },
        }, {
          workflow: 'child',
          step: 'review',
          kind: 'agent',
        }],
        iteration: 12,
        elapsed_ms: 100,
      };
      const continuation = resolveWorkflowCallContinuation({
        workflow: parentConfig,
        resumePoint,
        invocationRunId: 'source-run',
        resolveWorkflowCall: () => childConfig,
      });
      expect(continuation).toBeDefined();
      const manager = new StateManager(
        parentConfig,
        makeOptions({
          startStep: 'delegate',
          resumePoint,
          workflowCallContinuation: continuation,
        }),
      );

      expect(manager.incrementStepIteration('delegate')).toBe(3);
      expect(manager.incrementStepIteration('delegate')).toBe(4);
    });

    it('should not preserve an invocation iteration for a directly injected continuation object', () => {
      const parentConfig = makeConfig({
        steps: [{
          name: 'delegate',
          kind: 'workflow_call',
          call: 'child',
          personaDisplayName: 'delegate',
          instruction: '',
        }],
      });
      const manager = new StateManager(
        parentConfig,
        makeOptions({
          startStep: 'delegate',
          resumePoint: {
            version: 1,
            stack: [{
              workflow: parentConfig.name,
              step: 'delegate',
              kind: 'workflow_call',
              step_iterations: { delegate: 3 },
            }, {
              workflow: 'child',
              step: 'review',
              kind: 'agent',
            }],
            iteration: 12,
            elapsed_ms: 100,
          },
          workflowCallContinuation: {
            invocationRunId: 'source-run',
          } as unknown as NonNullable<WorkflowEngineOptions['workflowCallContinuation']>,
        }),
      );

      expect(manager.incrementStepIteration('delegate')).toBe(4);
    });

    it('should not transfer a continuation iteration to a parallel workflow_call sibling', () => {
      const childConfig = makeConfig({
        name: 'child',
        initialStep: 'review',
        steps: [{ name: 'review', personaDisplayName: 'review', instruction: '' }],
      });
      const parentConfig = makeConfig({
        initialStep: 'delegate-a',
        steps: [
          {
            name: 'delegate-a',
            kind: 'workflow_call',
            call: childConfig.name,
            personaDisplayName: 'delegate-a',
            instruction: '',
          },
          {
            name: 'delegate-b',
            kind: 'workflow_call',
            call: childConfig.name,
            personaDisplayName: 'delegate-b',
            instruction: '',
          },
        ],
      });
      const validatedResumePoint: WorkflowResumePoint = {
        version: 1,
        stack: [{
          workflow: parentConfig.name,
          step: 'delegate-a',
          kind: 'workflow_call',
          step_iterations: { 'delegate-a': 3 },
        }, {
          workflow: childConfig.name,
          step: 'review',
          kind: 'agent',
        }],
        iteration: 12,
        elapsed_ms: 100,
      };
      const continuation = resolveWorkflowCallContinuation({
        workflow: parentConfig,
        resumePoint: validatedResumePoint,
        invocationRunId: 'source-run',
        resolveWorkflowCall: () => childConfig,
      });
      const siblingResumePoint: WorkflowResumePoint = {
        ...validatedResumePoint,
        stack: [{
          ...validatedResumePoint.stack[0]!,
          step: 'delegate-b',
          step_iterations: { 'delegate-b': 3 },
        }, validatedResumePoint.stack[1]!],
      };

      const manager = new StateManager(parentConfig, makeOptions({
        startStep: 'delegate-b',
        resumePoint: siblingResumePoint,
        workflowCallContinuation: continuation,
      }));

      expect(manager.incrementStepIteration('delegate-b')).toBe(4);
    });

    it('should advance a single-frame workflow_call retry to a new invocation iteration', () => {
      const manager = new StateManager(
        makeConfig({
          steps: [{
            name: 'delegate',
            kind: 'workflow_call',
            call: 'child',
            personaDisplayName: 'delegate',
            instruction: '',
          }],
        }),
        makeOptions({
          startStep: 'delegate',
          resumePoint: {
            version: 1,
            stack: [{
              workflow: 'test-workflow',
              step: 'delegate',
              kind: 'workflow_call',
              step_iterations: { delegate: 3 },
            }],
            iteration: 12,
            elapsed_ms: 100,
          },
        }),
      );

      expect(manager.incrementStepIteration('delegate')).toBe(4);
    });

    it('should keep new, looped, and parallel workflow_call iterations unique', () => {
      const manager = new StateManager(
        makeConfig({
          initialStep: 'delegate-a',
          steps: [
            {
              name: 'delegate-a',
              kind: 'workflow_call',
              call: 'child',
              personaDisplayName: 'delegate-a',
              instruction: '',
            },
            {
              name: 'delegate-b',
              kind: 'workflow_call',
              call: 'child',
              personaDisplayName: 'delegate-b',
              instruction: '',
            },
          ],
        }),
        makeOptions(),
      );

      expect(manager.incrementStepIteration('delegate-a')).toBe(1);
      expect(manager.incrementStepIteration('delegate-b')).toBe(1);
      expect(manager.incrementStepIteration('delegate-a')).toBe(2);
      expect(manager.state.stepIterations).toEqual(new Map([
        ['delegate-a', 2],
        ['delegate-b', 1],
      ]));
    });

    it('should preserve only the nested workflow_call frame that still has an in-flight child', () => {
      const grandchildConfig = makeConfig({
        name: 'grandchild',
        initialStep: 'review',
        steps: [{ name: 'review', personaDisplayName: 'review', instruction: '' }],
      });
      const nestedConfig = makeConfig({
        name: 'nested-parent',
        initialStep: 'nested-delegate',
        steps: [{
          name: 'nested-delegate',
          kind: 'workflow_call',
          call: grandchildConfig.name,
          personaDisplayName: 'nested-delegate',
          instruction: '',
        }],
      });
      const rootConfig = makeConfig({
        name: 'root',
        initialStep: 'delegate',
        steps: [{
          name: 'delegate',
          kind: 'workflow_call',
          call: nestedConfig.name,
          personaDisplayName: 'delegate',
          instruction: '',
        }],
      });
      const resumePoint: WorkflowResumePoint = {
        version: 1,
        stack: [{
          workflow: 'root',
          step: 'delegate',
          kind: 'workflow_call',
          step_iterations: { delegate: 2 },
        }, {
          workflow: 'nested-parent',
          step: 'nested-delegate',
          kind: 'workflow_call',
          step_iterations: { 'nested-delegate': 5 },
        }, {
          workflow: 'grandchild',
          step: 'review',
          kind: 'agent',
        }],
        iteration: 12,
        elapsed_ms: 100,
      };
      const continuation = resolveWorkflowCallContinuation({
        workflow: rootConfig,
        resumePoint,
        invocationRunId: 'source-run',
        resolveWorkflowCall: (parent) =>
          parent.name === rootConfig.name ? nestedConfig : grandchildConfig,
      });
      expect(continuation).toBeDefined();
      const manager = new StateManager(
        nestedConfig,
        makeOptions({
          startStep: 'nested-delegate',
          resumePoint,
          resumeStackPrefix: [{
            workflow: 'root',
            step: 'delegate',
            kind: 'workflow_call',
          }],
          workflowCallContinuation: continuation,
        }),
      );

      expect(manager.incrementStepIteration('nested-delegate')).toBe(5);
    });

    it('should not transfer a nested continuation iteration to a sibling call frame', () => {
      const grandchildConfig = makeConfig({
        name: 'grandchild',
        initialStep: 'review',
        steps: [{ name: 'review', personaDisplayName: 'review', instruction: '' }],
      });
      const nestedConfig = makeConfig({
        name: 'nested-parent',
        initialStep: 'nested-delegate-a',
        steps: [
          {
            name: 'nested-delegate-a',
            kind: 'workflow_call',
            call: grandchildConfig.name,
            personaDisplayName: 'nested-delegate-a',
            instruction: '',
          },
          {
            name: 'nested-delegate-b',
            kind: 'workflow_call',
            call: grandchildConfig.name,
            personaDisplayName: 'nested-delegate-b',
            instruction: '',
          },
        ],
      });
      const rootConfig = makeConfig({
        name: 'root',
        initialStep: 'delegate',
        steps: [{
          name: 'delegate',
          kind: 'workflow_call',
          call: nestedConfig.name,
          personaDisplayName: 'delegate',
          instruction: '',
        }],
      });
      const validatedResumePoint: WorkflowResumePoint = {
        version: 1,
        stack: [{
          workflow: rootConfig.name,
          step: 'delegate',
          kind: 'workflow_call',
          step_iterations: { delegate: 2 },
        }, {
          workflow: nestedConfig.name,
          step: 'nested-delegate-a',
          kind: 'workflow_call',
          step_iterations: { 'nested-delegate-a': 5 },
        }, {
          workflow: grandchildConfig.name,
          step: 'review',
          kind: 'agent',
        }],
        iteration: 12,
        elapsed_ms: 100,
      };
      const continuation = resolveWorkflowCallContinuation({
        workflow: rootConfig,
        resumePoint: validatedResumePoint,
        invocationRunId: 'source-run',
        resolveWorkflowCall: (parent) =>
          parent.name === rootConfig.name ? nestedConfig : grandchildConfig,
      });
      const siblingResumePoint: WorkflowResumePoint = {
        ...validatedResumePoint,
        stack: [
          validatedResumePoint.stack[0]!,
          {
            ...validatedResumePoint.stack[1]!,
            step: 'nested-delegate-b',
            step_iterations: { 'nested-delegate-b': 5 },
          },
          validatedResumePoint.stack[2]!,
        ],
      };

      const manager = new StateManager(nestedConfig, makeOptions({
        startStep: 'nested-delegate-b',
        resumePoint: siblingResumePoint,
        resumeStackPrefix: [validatedResumePoint.stack[0]!],
        workflowCallContinuation: continuation,
      }));

      expect(manager.incrementStepIteration('nested-delegate-b')).toBe(6);
    });

    it('should not restore step iterations from a different resume target', () => {
      const manager = new StateManager(
        makeConfig(),
        makeOptions({
          startStep: 'implement',
          resumePoint: {
            version: 1,
            stack: [{
              workflow: 'test-workflow',
              step: 'review',
              kind: 'agent',
              step_iterations: { review: 6 },
            }],
            iteration: 12,
            elapsed_ms: 100,
          },
        }),
      );

      expect(manager.state.stepIterations).toEqual(new Map());
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
      structuredOutputs: new Map(),
      systemContexts: new Map(),
      effectResults: new Map(),
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

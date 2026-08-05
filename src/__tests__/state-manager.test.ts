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
import type { WorkflowConfig, AgentResponse, WorkflowState, DynamicFacetSelectionSnapshot } from '../core/models/types.js';
import type { WorkflowEngineOptions } from '../core/workflow/types.js';
import { buildWorkflowResumePointEntry } from '../core/workflow/workflow-reference.js';
import { buildDynamicParallelSelectionIdentity } from '../core/workflow/dynamic-parallel/identity.js';
import { cloneWorkflowResumePoint } from '../core/workflow/resume-point-codec.js';
import { cloneDynamicParallelSelectionSnapshot } from '../core/workflow/dynamic-parallel/snapshot.js';

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

function makeDynamicParallelConfig(): WorkflowConfig {
  const fixed = { name: 'architecture', personaDisplayName: 'architecture', instruction: 'Review' };
  const pool = { name: 'frontend', description: 'Review frontend', personaDisplayName: 'frontend', instruction: 'Review' };
  return makeConfig({
    initialStep: 'reviewers',
    steps: [{
      name: 'reviewers',
      personaDisplayName: 'reviewers',
      instruction: 'Review',
      parallel: {
        kind: 'dynamic',
        fixed: [fixed],
        pool: [pool],
        selection: { mode: 'replace' },
      },
    }],
  });
}

function makeDynamicFacetConfig(): WorkflowConfig {
  return makeConfig({
    initialStep: 'fix',
    steps: [{
      name: 'fix',
      personaDisplayName: 'coder',
      instruction: 'Fix',
      dynamicFacets: { pool: 'fix', maxSelected: 4 },
    }],
  });
}

function facetSelectionIdentity(workflow: WorkflowConfig, stepName = 'fix'): string {
  return buildDynamicParallelSelectionIdentity(workflow, stepName, []);
}

function makeFacetSnapshot(identity: string, stepName: string, round = 1): DynamicFacetSelectionSnapshot {
  return {
    identity,
    step_name: stepName,
    round,
    selected_ids: ['backend'],
    effective_policy_refs: [],
    effective_knowledge_refs: [],
    rationale: 'selection',
  };
}

function selectionIdentity(workflow: WorkflowConfig, stepName = 'reviewers'): string {
  return buildDynamicParallelSelectionIdentity(workflow, stepName, []);
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
            version: 2,
            stack: [
              {
                workflow: 'parent',
                workflow_ref: 'parent',
                step: 'delegate',
                kind: 'workflow_call',
                occurrence: 1,
                call_instance: 1,
                step_iterations: { delegate: 3 },
              },
              {
                workflow: 'test-workflow',
                workflow_ref: 'test-workflow',
                step: 'review',
                kind: 'agent',
                occurrence: 1,
                step_iterations: { review: 6, fix: 2 },
              },
            ],
            iteration: 12,
            elapsed_ms: 100,
            workflow_call_invocations: {},
            workflow_step_participations: {},
          },
          resumeStackPrefix: [
            {
              workflow: 'parent',
              workflow_ref: 'parent',
              step: 'delegate',
              kind: 'workflow_call',
              occurrence: 1,
              call_instance: 1,
            },
          ],
        }),
      );

      expect(manager.incrementStepIteration('review')).toBe(7);
      expect(manager.state.stepIterations.get('fix')).toBe(2);
    });

    it('should not restore step iterations from a different resume target', () => {
      const manager = new StateManager(
        makeConfig(),
        makeOptions({
          startStep: 'implement',
          resumePoint: {
            version: 2,
            stack: [{
              workflow: 'test-workflow',
              workflow_ref: 'test-workflow',
              step: 'review',
              kind: 'agent',
              occurrence: 1,
              step_iterations: { review: 6 },
            }],
            iteration: 12,
            elapsed_ms: 100,
            workflow_call_invocations: {},
            workflow_step_participations: {},
          },
        }),
      );

      expect(manager.state.stepIterations).toEqual(new Map());
    });

    it('should restore dynamic parallel selections for a resumed round', () => {
      const config = makeDynamicParallelConfig();
      const identity = selectionIdentity(config);
      const manager = new StateManager(
        config,
        makeOptions({
          startStep: 'reviewers',
          resumePoint: {
            version: 2,
            stack: [{ workflow: 'test-workflow', workflow_ref: 'test-workflow', step: 'reviewers', kind: 'parallel', occurrence: 1 }],
            iteration: 3,
            elapsed_ms: 100,
            workflow_call_invocations: {},
            workflow_step_participations: {},
            dynamic_parallel_selections: {
              [identity]: {
                identity,
                step_name: 'reviewers',
                round: 1,
                selected_pool_ids: ['frontend'],
                effective_selection_ids: ['architecture', 'frontend'],
              },
            },
          },
        }),
      );

      expect(manager.state.dynamicParallelSelections.get(identity)).toEqual({
        identity,
        step_name: 'reviewers',
        round: 1,
        selected_pool_ids: ['frontend'],
        effective_selection_ids: ['architecture', 'frontend'],
      });
      expect(manager.state.resumedDynamicParallelSteps.has(identity)).toBe(true);
    });

    it('should reject a snapshot whose identity is not reachable from the workflow graph', () => {
      expect(() => new StateManager(
        makeConfig({
          initialStep: 'prepare',
          steps: [
            { name: 'prepare', personaDisplayName: 'prepare', instruction: 'Prepare' },
            makeDynamicParallelConfig().steps[0]!,
          ],
        }),
        makeOptions({
          startStep: 'prepare',
          resumePoint: {
            version: 2,
            stack: [{ workflow: 'test-workflow', workflow_ref: 'test-workflow', step: 'prepare', kind: 'agent', occurrence: 1 }],
            iteration: 3,
            elapsed_ms: 100,
            workflow_call_invocations: {},
            workflow_step_participations: {},
            dynamic_parallel_selections: {
              'wrong-workflow:reviewers': {
                identity: 'wrong-workflow:reviewers',
                step_name: 'reviewers',
                round: 1,
                selected_pool_ids: ['frontend'],
                effective_selection_ids: ['architecture', 'frontend'],
              },
            },
          },
        }),
      )).toThrow('Dynamic parallel selection snapshot identity "wrong-workflow:reviewers" does not match a reachable dynamic parallel step');
    });

    it('should reject a snapshot whose internal identity differs from its canonical map key', () => {
      const config = makeDynamicParallelConfig();
      const identity = selectionIdentity(config);

      expect(() => new StateManager(config, makeOptions({
        startStep: 'reviewers',
        resumePoint: {
          version: 2,
          stack: [{ workflow: 'test-workflow', workflow_ref: 'test-workflow', step: 'reviewers', kind: 'parallel', occurrence: 1 }],
          iteration: 1,
          elapsed_ms: 0,
          workflow_call_invocations: {},
          workflow_step_participations: {},
          dynamic_parallel_selections: {
            [identity]: {
              identity: `${identity}-different`,
              step_name: 'reviewers',
              round: 1,
              selected_pool_ids: ['frontend'],
              effective_selection_ids: ['architecture', 'frontend'],
            },
          },
        },
      }))).toThrow(`Invalid dynamic parallel selection snapshot for identity "${identity}"`);
    });

    it.each([
      {
        label: 'an extra identity property',
        identity: '{"workflow":"test-workflow","step":"reviewers","calls":[],"extra":true}',
      },
      {
        label: 'a non-canonical identity key order',
        identity: '{"step":"reviewers","workflow":"test-workflow","calls":[]}',
      },
      {
        label: 'a non-canonical JSON representation',
        identity: '{ "workflow":"test-workflow","step":"reviewers","calls":[]}',
      },
    ])('should reject a reachable current snapshot with $label', ({ identity }) => {
      const config = makeDynamicParallelConfig();

      expect(() => new StateManager(config, makeOptions({
        startStep: 'reviewers',
        resumePoint: {
          version: 2,
          stack: [{ workflow: 'test-workflow', workflow_ref: 'test-workflow', step: 'reviewers', kind: 'parallel', occurrence: 1 }],
          iteration: 1,
          elapsed_ms: 0,
          workflow_call_invocations: {},
          workflow_step_participations: {},
          dynamic_parallel_selections: {
            [identity]: {
              identity,
              step_name: 'reviewers',
              round: 1,
              selected_pool_ids: ['frontend'],
              effective_selection_ids: ['architecture', 'frontend'],
            },
          },
        },
      }))).toThrow('does not match a reachable dynamic parallel step');
    });

    it('should reject a reachable future snapshot with a non-canonical identity', () => {
      const reviewers = makeDynamicParallelConfig().steps[0]!;
      const config = makeConfig({
        initialStep: 'prepare',
        steps: [
          { name: 'prepare', personaDisplayName: 'prepare', instruction: 'Prepare' },
          reviewers,
        ],
      });
      const identity = '{"workflow":"test-workflow","step":"reviewers","calls":[],"extra":true}';

      expect(() => new StateManager(config, makeOptions({
        startStep: 'prepare',
        resumePoint: {
          version: 2,
          stack: [{ workflow: 'test-workflow', workflow_ref: 'test-workflow', step: 'prepare', kind: 'agent', occurrence: 1 }],
          iteration: 1,
          elapsed_ms: 0,
          workflow_call_invocations: {},
          workflow_step_participations: {},
          dynamic_parallel_selections: {
            [identity]: {
              identity,
              step_name: 'reviewers',
              round: 1,
              selected_pool_ids: ['frontend'],
              effective_selection_ids: ['architecture', 'frontend'],
            },
          },
        },
      }))).toThrow('does not match a reachable dynamic parallel step');
    });

    it('should reject a nested snapshot with a non-canonical workflow-call kind', () => {
      const childWorkflow = makeDynamicParallelConfig();
      childWorkflow.name = 'child-workflow';
      childWorkflow.subworkflow = { callable: true };
      const parentWorkflow = makeConfig({
        initialStep: 'prepare',
        steps: [
          { name: 'prepare', personaDisplayName: 'prepare', instruction: 'Prepare' },
          { name: 'delegate', kind: 'workflow_call', call: 'child-workflow', personaDisplayName: 'delegate' },
        ],
      });
      const identity = '{"workflow":"child-workflow","step":"reviewers","calls":[{"workflow":"test-workflow","step":"delegate","kind":"agent","instance":1}]}';

      expect(() => new StateManager(parentWorkflow, makeOptions({
        startStep: 'prepare',
        workflowCallResolver: ({ step }) => step.call === 'child-workflow' ? childWorkflow : null,
        resumePoint: {
          version: 2,
          stack: [{ workflow: 'test-workflow', workflow_ref: 'test-workflow', step: 'prepare', kind: 'agent', occurrence: 1 }],
          iteration: 1,
          elapsed_ms: 0,
          workflow_call_invocations: {},
          workflow_step_participations: {},
          dynamic_parallel_selections: {
            [identity]: {
              identity,
              step_name: 'reviewers',
              round: 1,
              selected_pool_ids: ['frontend'],
              effective_selection_ids: ['architecture', 'frontend'],
            },
          },
        },
      }))).toThrow('does not match a reachable dynamic parallel step');
    });

    it('should reject a dynamic selection whose step_name does not match the resumed step', () => {
      const config = makeDynamicParallelConfig();
      const identity = selectionIdentity(config);
      expect(() => new StateManager(
        config,
        makeOptions({
          startStep: 'reviewers',
          resumePoint: {
            version: 2,
            stack: [{ workflow: 'test-workflow', workflow_ref: 'test-workflow', step: 'reviewers', kind: 'parallel', occurrence: 1 }],
            iteration: 3,
            elapsed_ms: 100,
            workflow_call_invocations: {},
            workflow_step_participations: {},
            dynamic_parallel_selections: {
              [identity]: {
                identity,
                step_name: 'different-step',
                round: 1,
                selected_pool_ids: ['frontend'],
                effective_selection_ids: ['architecture', 'frontend'],
              },
            },
          },
        }),
      )).toThrow('Dynamic parallel selection snapshot step_name does not match resumed step "reviewers"');
    });

    it('should reject a resumed dynamic selection with no effective sub-steps', () => {
      const pool = {
        name: 'frontend',
        description: 'Review frontend',
        personaDisplayName: 'frontend',
        instruction: 'Review',
      };
      const config = makeConfig({
        initialStep: 'reviewers',
        steps: [{
          name: 'reviewers',
          personaDisplayName: 'reviewers',
          instruction: 'Review',
          parallel: {
            kind: 'dynamic',
            fixed: [],
            pool: [pool],
            selection: { mode: 'replace' },
          },
        }],
      });
      const identity = selectionIdentity(config);

      expect(() => new StateManager(
        config,
        makeOptions({
          startStep: 'reviewers',
          resumePoint: {
            version: 2,
            stack: [{ workflow: 'test-workflow', workflow_ref: 'test-workflow', step: 'reviewers', kind: 'parallel', occurrence: 1 }],
            iteration: 3,
            elapsed_ms: 100,
            workflow_call_invocations: {},
            workflow_step_participations: {},
            dynamic_parallel_selections: {
              [identity]: {
                identity,
                step_name: 'reviewers',
                round: 1,
                selected_pool_ids: [],
                effective_selection_ids: [],
              },
            },
          },
        }),
      )).toThrow('Dynamic parallel selection snapshot for "reviewers" has an empty effective selection');
    });

    it('should reject an invalid future dynamic selection before the selector can run', () => {
      const reviewers = makeDynamicParallelConfig().steps[0]!;
      const config = makeConfig({
        initialStep: 'prepare',
        steps: [
          { name: 'prepare', personaDisplayName: 'prepare', instruction: 'Prepare' },
          reviewers,
        ],
      });
      const identity = selectionIdentity(config);

      expect(() => new StateManager(
        config,
        makeOptions({
          startStep: 'prepare',
          resumePoint: {
            version: 2,
            stack: [{ workflow: 'test-workflow', workflow_ref: 'test-workflow', step: 'prepare', kind: 'agent', occurrence: 1 }],
            iteration: 3,
            elapsed_ms: 100,
            workflow_call_invocations: {},
            workflow_step_participations: {},
            dynamic_parallel_selections: {
              [identity]: {
                identity,
                step_name: 'reviewers',
                round: 1,
                selected_pool_ids: ['unknown-reviewer'],
                effective_selection_ids: ['architecture', 'unknown-reviewer'],
              },
            },
          },
        }),
      )).toThrow('Dynamic parallel selection snapshot for "reviewers" contains unknown pool ID "unknown-reviewer"');
    });

    it('should accept a valid child workflow dynamic selection snapshot', () => {
      const childWorkflow = makeDynamicParallelConfig();
      childWorkflow.name = 'child-workflow';
      childWorkflow.subworkflow = { callable: true };
      const parentWorkflow = makeConfig({
        initialStep: 'prepare',
        steps: [
          { name: 'prepare', personaDisplayName: 'prepare', instruction: 'Prepare' },
          { name: 'delegate', kind: 'workflow_call', call: 'child-workflow', personaDisplayName: 'delegate' },
        ],
      });
      const identity = buildDynamicParallelSelectionIdentity(childWorkflow, 'reviewers', [
        buildWorkflowResumePointEntry(parentWorkflow, 'delegate', 'workflow_call', 1, new Map(), 1),
      ]);

      const manager = new StateManager(
        parentWorkflow,
        makeOptions({
          startStep: 'prepare',
          workflowCallResolver: ({ step }) => step.call === 'child-workflow' ? childWorkflow : null,
          resumePoint: {
            version: 2,
            stack: [{ workflow: 'test-workflow', workflow_ref: 'test-workflow', step: 'prepare', kind: 'agent', occurrence: 1 }],
            iteration: 3,
            elapsed_ms: 100,
            workflow_call_invocations: {},
            workflow_step_participations: {},
            dynamic_parallel_selections: {
              [identity]: {
                identity,
                step_name: 'reviewers',
                round: 1,
                selected_pool_ids: ['frontend'],
                effective_selection_ids: ['architecture', 'frontend'],
              },
            },
          },
        }),
      );

      expect(manager.state.dynamicParallelSelections.get(identity)?.effective_selection_ids)
        .toEqual(['architecture', 'frontend']);
    });

    it('should retain independent snapshots for separate workflow call instances', () => {
      const childWorkflow = makeDynamicParallelConfig();
      childWorkflow.name = 'child-workflow';
      childWorkflow.subworkflow = { callable: true };
      const parentWorkflow = makeConfig({
        initialStep: 'prepare',
        steps: [
          { name: 'prepare', personaDisplayName: 'prepare', instruction: 'Prepare' },
          { name: 'delegate', kind: 'workflow_call', call: 'child-workflow', personaDisplayName: 'delegate' },
        ],
      });
      const firstIdentity = buildDynamicParallelSelectionIdentity(childWorkflow, 'reviewers', [
        buildWorkflowResumePointEntry(parentWorkflow, 'delegate', 'workflow_call', 1, new Map(), 1),
      ]);
      const secondIdentity = buildDynamicParallelSelectionIdentity(childWorkflow, 'reviewers', [
        buildWorkflowResumePointEntry(parentWorkflow, 'delegate', 'workflow_call', 2, new Map(), 2),
      ]);
      const snapshot = (identity: string, selectedPoolId: string) => ({
        identity,
        step_name: 'reviewers',
        round: 1,
        selected_pool_ids: [selectedPoolId],
        effective_selection_ids: ['architecture', selectedPoolId],
      });

      const manager = new StateManager(parentWorkflow, makeOptions({
        startStep: 'prepare',
        workflowCallResolver: ({ step }) => step.call === 'child-workflow' ? childWorkflow : null,
        resumePoint: {
          version: 2,
          stack: [{ workflow: 'test-workflow', workflow_ref: 'test-workflow', step: 'prepare', kind: 'agent', occurrence: 1 }],
          iteration: 3,
          elapsed_ms: 100,
          workflow_call_invocations: {},
          workflow_step_participations: {},
          dynamic_parallel_selections: {
            [firstIdentity]: snapshot(firstIdentity, 'frontend'),
            [secondIdentity]: snapshot(secondIdentity, 'frontend'),
          },
        },
      }));

      expect(manager.state.dynamicParallelSelections).toHaveLength(2);
    });

    it('should reject resuming a dynamic parallel step without its saved round snapshot', () => {
      const config = makeDynamicParallelConfig();

      expect(() => new StateManager(config, makeOptions({
        startStep: 'reviewers',
        resumePoint: {
          version: 2,
          stack: [{ workflow: 'test-workflow', workflow_ref: 'test-workflow', step: 'reviewers', kind: 'parallel', occurrence: 1 }],
          iteration: 3,
          elapsed_ms: 100,
          workflow_call_invocations: {},
          workflow_step_participations: {},
        },
      }))).toThrow('Dynamic parallel selection snapshot is required to resume "reviewers"');
    });
  });

  describe('constructor: dynamic facet resume wiring', () => {
    it('should seed resumedDynamicFacetSteps when resuming a dynamic facet step with a saved snapshot', () => {
      const config = makeDynamicFacetConfig();
      const identity = facetSelectionIdentity(config);
      const manager = new StateManager(
        config,
        makeOptions({
          startStep: 'fix',
          resumePoint: {
            version: 2,
            stack: [{ workflow: 'test-workflow', workflow_ref: 'test-workflow', step: 'fix', kind: 'agent', occurrence: 1 }],
            iteration: 3,
            elapsed_ms: 100,
            workflow_call_invocations: {},
            workflow_step_participations: {},
            dynamic_facet_selections: {
              [identity]: makeFacetSnapshot(identity, 'fix'),
            },
          },
        }),
      );

      expect(manager.state.resumedDynamicFacetSteps.has(identity)).toBe(true);
      expect(manager.state.activeDynamicFacetSelectionIdentity).toBe(identity);
    });

    it('should reject resuming a dynamic facet step without a saved snapshot', () => {
      const config = makeDynamicFacetConfig();

      expect(() => new StateManager(config, makeOptions({
        startStep: 'fix',
        resumePoint: {
          version: 2,
          stack: [{ workflow: 'test-workflow', workflow_ref: 'test-workflow', step: 'fix', kind: 'agent', occurrence: 1 }],
          iteration: 3,
          elapsed_ms: 100,
          workflow_call_invocations: {},
          workflow_step_participations: {},
        },
      }))).toThrow('Dynamic facet selection snapshot is required to resume "fix"');
    });

    it('should reject a dynamic facet snapshot whose step_name does not match the resumed step', () => {
      const config = makeConfig({
        initialStep: 'fix',
        steps: [
          { name: 'fix', personaDisplayName: 'coder', instruction: 'Fix', dynamicFacets: { pool: 'fix', maxSelected: 4 } },
          { name: 'other', personaDisplayName: 'other', instruction: 'Other' },
        ],
      });
      const identity = facetSelectionIdentity(config);

      expect(() => new StateManager(config, makeOptions({
        startStep: 'fix',
        resumePoint: {
          version: 2,
          stack: [{ workflow: 'test-workflow', workflow_ref: 'test-workflow', step: 'fix', kind: 'agent', occurrence: 1 }],
          iteration: 3,
          elapsed_ms: 100,
          workflow_call_invocations: {},
          workflow_step_participations: {},
          dynamic_facet_selections: {
            [identity]: makeFacetSnapshot(identity, 'other'),
          },
        },
      }))).toThrow('Dynamic facet selection snapshot step_name does not match resumed step "fix"');
    });

    it('should leave resumedDynamicFacetSteps empty when not resuming', () => {
      const config = makeDynamicFacetConfig();
      const manager = new StateManager(config, makeOptions());

      expect(manager.state.resumedDynamicFacetSteps.size).toBe(0);
      expect(manager.state.activeDynamicFacetSelectionIdentity).toBeUndefined();
    });

    it('should leave resumedDynamicFacetSteps empty when the current step has no dynamicFacets', () => {
      const config = makeConfig({
        initialStep: 'fix',
        steps: [{ name: 'fix', personaDisplayName: 'coder', instruction: 'Fix' }],
      });
      const manager = new StateManager(
        config,
        makeOptions({
          startStep: 'fix',
          resumePoint: {
            version: 2,
            stack: [{ workflow: 'test-workflow', workflow_ref: 'test-workflow', step: 'fix', kind: 'agent', occurrence: 1 }],
            iteration: 3,
            elapsed_ms: 100,
            workflow_call_invocations: {},
            workflow_step_participations: {},
          },
        }),
      );

      expect(manager.state.resumedDynamicFacetSteps.size).toBe(0);
    });
  });

  describe('cloneWorkflowResumePoint: dynamic facet snapshot clone isolation', () => {
    it('should deep-clone dynamic_facet_selections snapshots so mutations to the original do not leak into the clone', () => {
      const config = makeDynamicFacetConfig();
      const identity = facetSelectionIdentity(config);
      const original: import('../core/models/types.js').WorkflowResumePoint = {
        version: 2,
        stack: [{ workflow: 'test-workflow', workflow_ref: 'test-workflow', step: 'fix', kind: 'agent', occurrence: 1 }],
        iteration: 3,
        elapsed_ms: 100,
        workflow_call_invocations: {},
        workflow_step_participations: {},
        dynamic_facet_selections: {
          [identity]: makeFacetSnapshot(identity, 'fix'),
        },
      };

      const cloned = cloneWorkflowResumePoint(original);

      const originalSnapshot = original.dynamic_facet_selections![identity]!;
      const clonedSnapshot = cloned.dynamic_facet_selections![identity]!;
      expect(clonedSnapshot).not.toBe(originalSnapshot);
      expect(clonedSnapshot.selected_ids).not.toBe(originalSnapshot.selected_ids);
      expect(clonedSnapshot.selected_ids).toEqual(originalSnapshot.selected_ids);

      originalSnapshot.selected_ids.push('extra-facet');
      expect(clonedSnapshot.selected_ids).toEqual(['backend']);
    });

    it('should deep-clone dynamic_parallel_selections snapshots symmetrically with dynamic_facet_selections', () => {
      const config = makeDynamicParallelConfig();
      const identity = selectionIdentity(config);
      const parallelSnapshot = cloneDynamicParallelSelectionSnapshot({
        identity,
        step_name: 'reviewers',
        round: 1,
        selected_pool_ids: ['frontend'],
        effective_selection_ids: ['frontend'],
      });
      const original: import('../core/models/types.js').WorkflowResumePoint = {
        version: 2,
        stack: [{ workflow: 'test-workflow', workflow_ref: 'test-workflow', step: 'reviewers', kind: 'parallel', occurrence: 1 }],
        iteration: 1,
        elapsed_ms: 0,
        workflow_call_invocations: {},
        workflow_step_participations: {},
        dynamic_parallel_selections: {
          [identity]: parallelSnapshot,
        },
      };

      const cloned = cloneWorkflowResumePoint(original);

      const originalSnapshot = original.dynamic_parallel_selections![identity]!;
      const clonedSnapshot = cloned.dynamic_parallel_selections![identity]!;
      expect(clonedSnapshot).not.toBe(originalSnapshot);
      originalSnapshot.selected_pool_ids.push('extra-pool');
      expect(clonedSnapshot.selected_pool_ids).toEqual(['frontend']);
    });

    it('should omit dynamic_facet_selections when the source omits it', () => {
      const original: import('../core/models/types.js').WorkflowResumePoint = {
        version: 2,
        stack: [{ workflow: 'test-workflow', workflow_ref: 'test-workflow', step: 'fix', kind: 'agent', occurrence: 1 }],
        iteration: 1,
        elapsed_ms: 0,
        workflow_call_invocations: {},
        workflow_step_participations: {},
      };

      const cloned = cloneWorkflowResumePoint(original);
      expect(cloned.dynamic_facet_selections).toBeUndefined();
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

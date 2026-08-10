import { describe, expect, it } from 'vitest';
import type { WorkflowConfig, WorkflowResumePoint } from '../core/models/types.js';
import { StateManager } from '../core/workflow/engine/state-manager.js';
import type { WorkflowEngineOptions } from '../core/workflow/types.js';

function resumePoint(step: string, kind: 'agent' | 'parallel'): WorkflowResumePoint {
  return {
    version: 2,
    stack: [{
      workflow: 'resume-test',
      workflow_ref: 'resume-test',
      step,
      kind,
      occurrence: 1,
    }],
    iteration: 3,
    elapsed_ms: 100,
    workflow_call_invocations: {},
    workflow_step_participations: {},
  };
}

function options(point: WorkflowResumePoint, startStep: string): WorkflowEngineOptions {
  return {
    projectCwd: '/tmp/project',
    startStep,
    resumePoint: point,
  };
}

function dynamicParallelWorkflow(): WorkflowConfig {
  return {
    name: 'resume-test',
    initialStep: 'reviewers',
    maxSteps: 3,
    steps: [{
      name: 'reviewers',
      personaDisplayName: 'reviewers',
      instruction: 'Review',
      parallel: {
        kind: 'dynamic',
        fixed: [{ name: 'architecture', personaDisplayName: 'architecture', instruction: 'Review' }],
        pool: [{ name: 'frontend', personaDisplayName: 'frontend', instruction: 'Review' }],
        selection: { mode: 'replace' },
      },
    }],
  };
}

function dynamicFacetWorkflow(): WorkflowConfig {
  return {
    name: 'resume-test',
    initialStep: 'fix',
    maxSteps: 3,
    steps: [{
      name: 'fix',
      personaDisplayName: 'coder',
      instruction: 'Fix',
      dynamicFacets: { pool: 'current-pool' },
    }],
    facetPools: {
      'current-pool': {
        name: 'current-pool',
        source: 'inline',
        candidates: [{
          id: 'current-facet',
          description: 'Current facet',
          policyRefs: [],
          knowledgeRefs: [],
          resolvedPolicyContents: [],
          resolvedKnowledgeContents: [],
        }],
      },
    },
  };
}

describe('dynamic selection resume state', () => {
  it('should start a resumed dynamic parallel step with an empty run-local selection store', () => {
    const config = dynamicParallelWorkflow();
    const manager = new StateManager(
      config,
      options(resumePoint('reviewers', 'parallel'), 'reviewers'),
    );

    expect(manager.state.dynamicParallelSelections).toEqual(new Map());
    expect(manager.state).not.toHaveProperty('resumedDynamicParallelSteps');
    expect(manager.state.activeDynamicParallelSelectionIdentity).toBeUndefined();
  });

  it('should start a resumed dynamic facet step with an empty run-local selection store', () => {
    const config = dynamicFacetWorkflow();
    const manager = new StateManager(
      config,
      options(resumePoint('fix', 'agent'), 'fix'),
    );

    expect(manager.state.dynamicFacetSelections).toEqual(new Map());
    expect(manager.state).not.toHaveProperty('resumedDynamicFacetSteps');
    expect(manager.state.activeDynamicFacetSelectionIdentity).toBeUndefined();
  });
});

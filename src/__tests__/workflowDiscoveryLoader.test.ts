import { describe, expect, it, vi } from 'vitest';
import type { WorkflowConfig } from '../core/models/index.js';
import { makeRule, makeStep } from './test-helpers.js';
import { loadValidatedWorkflowDiscoveryEntry } from '../infra/config/loaders/workflowDiscoveryLoader.js';
import type { WorkflowDirEntry } from '../infra/config/loaders/workflowDiscovery.js';

function createWorkflow(): WorkflowConfig {
  return {
    name: 'callable-child',
    description: 'Child workflow',
    subworkflow: {
      callable: true,
      visibility: 'internal',
    },
    maxSteps: 3,
    initialStep: 'review',
    steps: [
      makeStep({
        name: 'review',
        rules: [makeRule('done', 'COMPLETE')],
      }),
    ],
  };
}

describe('workflowDiscoveryLoader', () => {
  it('loads discovery metadata and validates workflow_call contracts without path-based recursion', () => {
    const entry: WorkflowDirEntry = {
      name: 'callable-child',
      path: '/tmp/callable-child.yaml',
      source: 'project',
    };
    const workflow = createWorkflow();
    const loadWorkflowForDiscovery = vi.fn(() => workflow);
    const validateWorkflowCallContracts = vi.fn();

    const config = loadValidatedWorkflowDiscoveryEntry(entry, '/project', {
      loadWorkflowForDiscovery,
      validateWorkflowCallContracts,
    });

    expect(config).toEqual({
      name: 'callable-child',
      description: 'Child workflow',
      subworkflow: workflow.subworkflow,
    });
    expect(loadWorkflowForDiscovery).toHaveBeenCalledWith(entry, '/project');
    expect(validateWorkflowCallContracts).toHaveBeenCalledWith(workflow, '/project', {
      lookupCwd: '/project',
      allowPathBasedCalls: false,
    });
  });
});

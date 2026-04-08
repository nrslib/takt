import { describe, expect, it } from 'vitest';
import type { WorkflowConfig } from '../core/models/index.js';
import { validateWorkflowConfig } from '../core/workflow/engine/WorkflowValidator.js';

function createWorkflow(overrides: Partial<WorkflowConfig> = {}): WorkflowConfig {
  return {
    name: 'validator-test',
    description: 'validator test workflow',
    maxSteps: 5,
    initialStep: 'plan',
    steps: [
      {
        name: 'plan',
        persona: 'planner',
        personaDisplayName: 'planner',
        edit: false,
        instruction: '{task}',
        passPreviousResponse: true,
        rules: [{ condition: 'done', next: 'COMPLETE' }],
      },
    ],
    ...overrides,
  };
}

describe('validateWorkflowConfig', () => {
  it('accepts canonical workflow transitions', () => {
    expect(() => validateWorkflowConfig(createWorkflow(), { projectCwd: process.cwd() })).not.toThrow();
  });

  it('fails fast when a loop monitor judge points to an unknown step', () => {
    const workflow = createWorkflow({
      loopMonitors: [
        {
          cycle: ['plan', 'plan'],
          threshold: 2,
          judge: {
            rules: [{ condition: 'continue', next: 'missing-step' }],
          },
        },
      ],
    });

    expect(() => validateWorkflowConfig(workflow, { projectCwd: process.cwd() })).toThrow('missing-step');
  });
});

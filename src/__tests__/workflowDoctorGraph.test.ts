import { describe, expect, it } from 'vitest';
import { WorkflowConfigRawSchema } from '../core/models/index.js';
import { validateDoctorGraph } from '../infra/config/loaders/workflowDoctorGraph.js';

describe('workflowDoctorGraph', () => {
  it('treats loop monitor destinations as reachable', () => {
    const raw = WorkflowConfigRawSchema.parse({
      name: 'loop-monitor-reachability',
      max_steps: 10,
      initial_step: 'step1',
      loop_monitors: [
        {
          cycle: ['step1', 'step2'],
          threshold: 2,
          judge: {
            rules: [{ condition: 'escape', next: 'step3' }],
          },
        },
      ],
      steps: [
        {
          name: 'step1',
          rules: [{ condition: 'continue', next: 'step2' }],
        },
        {
          name: 'step2',
          rules: [{ condition: 'repeat', next: 'step1' }],
        },
        {
          name: 'step3',
          rules: [{ condition: 'done', next: 'COMPLETE' }],
        },
      ],
    });
    const diagnostics: { level: 'error' | 'warning'; message: string }[] = [];

    validateDoctorGraph(raw, diagnostics);

    expect(diagnostics).toEqual([]);
  });
});

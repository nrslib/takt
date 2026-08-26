import { describe, expect, it } from 'vitest';
import {
  buildExecutionTrace,
  reportDirectory,
  reportDisplayName,
} from '../../web-ui/public/execution-model.js';

describe('Web UI execution model', () => {
  it('builds a chronological trace and merges phases into their step occurrence', () => {
    const trace = buildExecutionTrace(
      { workflow: 'default', status: 'running', currentStep: 'review', currentIteration: 2 },
      [
        { type: 'phase_start', step: 'review', phaseName: 'execute', iteration: 2 },
        { type: 'step_start', step: 'review', persona: 'Reviewer', iteration: 2 },
        { type: 'step_complete', step: 'plan', status: 'done', iteration: 1 },
        { type: 'step_start', step: 'plan', iteration: 1 },
      ],
    );

    expect(trace.nodes).toEqual([
      expect.objectContaining({ label: 'plan', status: 'completed', eventIndexes: [0, 1] }),
      expect.objectContaining({
        label: 'review',
        status: 'running',
        persona: 'Reviewer',
        phases: ['execute'],
        eventIndexes: [2, 3],
      }),
    ]);
    expect(trace.edges).toHaveLength(1);
  });

  it('represents nested workflow calls as distinct nodes', () => {
    const trace = buildExecutionTrace(
      { workflow: 'default', status: 'completed' },
      [
        {
          type: 'workflow_call_complete',
          workflow: 'default',
          step: 'review',
          childWorkflow: 'review-fix',
          callInstance: 'call-1',
          status: 'completed',
        },
        {
          type: 'workflow_call_start',
          workflow: 'default',
          step: 'review',
          childWorkflow: 'review-fix',
          callInstance: 'call-1',
        },
      ],
    );

    expect(trace.nodes).toEqual([
      expect.objectContaining({ kind: 'workflow', label: 'review-fix', status: 'completed' }),
    ]);
  });

  it('uses the basename as the primary report title', () => {
    expect(reportDisplayName('review/security-review.md')).toBe('security-review.md');
    expect(reportDirectory('review/security-review.md')).toBe('review');
    expect(reportDirectory('summary.md')).toBe('');
  });
});

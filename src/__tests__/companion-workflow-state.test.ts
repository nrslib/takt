import { describe, expect, it } from 'vitest';
import { parseWorkflowStateReference } from '../core/models/workflow-state-reference.js';
import { createInitialState } from '../core/workflow/engine/state-manager.js';
import { resolveWorkflowStateReference } from '../core/workflow/state/workflow-state-access.js';

function config() {
  return {
    name: 'companion-state',
    initialStep: 'implement',
    maxSteps: 3,
    steps: [{ name: 'implement', instruction: 'implement', rules: [] }],
  } as never;
}

describe('companion workflow diagnostics', () => {
  it('exposes only mechanical completion diagnostics', () => {
    const state = createInitialState(config(), { projectCwd: '/worktree' });
    state.companion = {
      completionSettled: false,
      completionFailure: true,
      followUpRounds: 2,
      reason: 'completion review failed',
    };

    expect(parseWorkflowStateReference('companion.completionSettled')).toEqual({
      root: 'companion',
      path: ['completionSettled'],
    });
    expect(resolveWorkflowStateReference('companion.completionSettled', state)).toBe(false);
    expect(resolveWorkflowStateReference('companion.completionFailure', state)).toBe(true);
    expect(resolveWorkflowStateReference('companion.followUpRounds', state)).toBe(2);
    expect(resolveWorkflowStateReference('companion.reason', state)).toBe('completion review failed');
  });
});

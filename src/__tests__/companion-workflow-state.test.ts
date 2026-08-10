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

describe('CT-COMP-09 companion workflow state and when routing', () => {
  it('should parse companion as a root without requiring a step scope', () => {
    expect(parseWorkflowStateReference('companion.escalated')).toEqual({
      root: 'companion',
      path: ['escalated'],
    });
  });

  it('should expose escalated, open must_fix count, findings, and reason to when evaluation', () => {
    const state = createInitialState(config(), { projectCwd: '/worktree' });
    state.companion = {
      escalated: true,
      completionVerified: true,
      openMustFixCount: 1,
      openMustFix: [{
        id: 'security-reviewer-1', severity: 'must_fix', file: 'src/a.ts', line: 1,
        finding: 'unsafe write',
      }],
      reason: 'unchanged diff after fix round',
    };

    expect(resolveWorkflowStateReference('companion.escalated', state)).toBe(true);
    expect(resolveWorkflowStateReference('companion.openMustFixCount', state)).toBe(1);
    expect(resolveWorkflowStateReference('companion.openMustFix[0].id', state))
      .toBe('security-reviewer-1');
    expect(resolveWorkflowStateReference('companion.reason', state))
      .toBe('unchanged diff after fix round');
  });

  it('should return defensive state snapshots instead of the coordinator-owned mutable array', () => {
    const state = createInitialState(config(), { projectCwd: '/worktree' });
    const owned = [{
      id: 'security-reviewer-1', severity: 'must_fix' as const, file: 'src/a.ts', line: 1,
      finding: 'unsafe write',
    }];
    state.companion = {
      escalated: true,
      completionVerified: true,
      openMustFixCount: 1,
      openMustFix: owned,
      reason: 'loop',
    };

    const exposed = resolveWorkflowStateReference('companion.openMustFix', state) as Array<{ id: string }>;
    exposed.push({ id: 'foreign' });

    expect(owned).toEqual([{
      id: 'security-reviewer-1', severity: 'must_fix', file: 'src/a.ts', line: 1,
      finding: 'unsafe write',
    }]);
    expect(resolveWorkflowStateReference('companion.openMustFix.length', state)).toBe(1);
  });
});

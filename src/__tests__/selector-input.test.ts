import { describe, expect, it } from 'vitest';
import type {
  DynamicParallelPoolSubStep,
  DynamicParallelSelectionSnapshot,
} from '../core/models/types.js';
import { buildDynamicSelectorInstruction } from '../core/workflow/dynamic-parallel/selector-input.js';

const SELECTION_HISTORY_SENTINEL = 'prior-selection-history-sentinel';

const pool: DynamicParallelPoolSubStep[] = [
  {
    name: 'frontend',
    description: 'Review React and UI changes',
    personaDisplayName: 'frontend',
    instruction: 'Review frontend',
    rules: [{ condition: 'approved' }],
  },
  {
    name: 'backend',
    description: 'Review API and persistence changes',
    personaDisplayName: 'backend',
    instruction: 'Review backend',
    rules: [{ condition: 'approved' }],
  },
];

const previousSnapshot: DynamicParallelSelectionSnapshot = {
  identity: 'workflow:reviewers',
  step_name: 'reviewers',
  round: 1,
  selected_pool_ids: [SELECTION_HISTORY_SENTINEL],
  effective_selection_ids: ['architecture', 'frontend'],
};

describe('buildDynamicSelectorInstruction', () => {
  it('should include every required initial-entry value and only pool candidates', () => {
    const instruction = buildDynamicSelectorInstruction({
      task: 'Implement checkout UI',
      reports: 'architecture report',
      workingTreeDiff: 'diff --git a/ui.tsx b/ui.tsx',
      pool,
      selection: { mode: 'replace' },
    });

    expect(instruction).toContain('Implement checkout UI');
    expect(instruction).toContain('architecture report');
    expect(instruction).toContain('diff --git a/ui.tsx b/ui.tsx');
    expect(instruction).toContain('frontend: Review React and UI changes');
    expect(instruction).toContain('backend: Review API and persistence changes');
  });

  it('should include fresh required values without selection history on replace re-entry', () => {
    const instruction = buildDynamicSelectorInstruction({
      task: 'Fix API validation',
      reports: 'latest backend report',
      workingTreeDiff: 'diff --git a/api.ts b/api.ts',
      pool,
      selection: { mode: 'replace' },
      previousSnapshot,
    });

    expect(instruction).toContain('Fix API validation');
    expect(instruction).toContain('latest backend report');
    expect(instruction).toContain('diff --git a/api.ts b/api.ts');
    expect(instruction).not.toContain(SELECTION_HISTORY_SENTINEL);
  });

  it('should include previous pool IDs and every required value on cumulative re-entry', () => {
    const instruction = buildDynamicSelectorInstruction({
      task: 'Re-review checkout',
      reports: 'frontend approved',
      workingTreeDiff: 'diff --git a/server.ts b/server.ts',
      pool,
      selection: { mode: 'cumulative' },
      previousSnapshot,
    });

    expect(instruction).toContain('Re-review checkout');
    expect(instruction).toContain('frontend approved');
    expect(instruction).toContain('diff --git a/server.ts b/server.ts');
    expect(instruction).toContain(SELECTION_HISTORY_SENTINEL);
    expect(instruction).toContain('backend: Review API and persistence changes');
  });
});

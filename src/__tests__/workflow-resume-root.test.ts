import { describe, expect, it, vi } from 'vitest';
import type { WorkflowConfig, WorkflowResumePoint, WorkflowResumePointEntry, WorkflowStep } from '../core/models/index.js';
import { getWorkflowResumeFrameError, trimResumePointStackForWorkflow, validateWorkflowResumeRoot } from '../core/workflow/run/resume-point.js';
import { attachWorkflowOpaqueRef } from '../shared/workflowConfigMetadata.js';
import { DebugLogger } from '../shared/utils/debug.js';

const agent = { name: 'reviewers', personaDisplayName: 'reviewer', instruction: 'Review' } satisfies WorkflowStep;
const workflow: WorkflowConfig = {
  name: 'default',
  initialStep: 'reviewers',
  maxSteps: 10,
  steps: [agent],
};

function point(overrides: Partial<WorkflowResumePointEntry> = {}): WorkflowResumePoint {
  return {
    version: 2,
    stack: [{ workflow: 'default', workflow_ref: 'default', step: 'reviewers', kind: 'agent', occurrence: 1, ...overrides }],
    iteration: 2,
    elapsed_ms: 100,
    workflow_call_invocations: {},
    workflow_step_participations: {},
  };
}

describe('saved workflow resume root validation', () => {
  it('accepts a legacy builtin checkpoint when workflow and step names match', () => {
    const current = attachWorkflowOpaqueRef({ ...workflow }, `builtin:v2:sha256:${'b'.repeat(64)}`);
    const saved = point({ workflow_ref: `builtin:sha256:${'a'.repeat(64)}` });
    const writeLog = vi.spyOn(DebugLogger.getInstance(), 'writeLog');
    try {
      validateWorkflowResumeRoot(current, saved);
      expect(writeLog.mock.calls.some(([level]) => level === 'WARN')).toBe(true);
    } finally {
      writeLog.mockRestore();
    }
  });

  it('accepts an exactly matching legacy builtin checkpoint restored from a bundle', () => {
    const ref = `builtin:sha256:${'a'.repeat(64)}`;
    const restored = attachWorkflowOpaqueRef({ ...workflow }, ref);

    expect(() => validateWorkflowResumeRoot(restored, point({ workflow_ref: ref }))).not.toThrow();
  });

  it('accepts a valid root without rejecting an unresolved child frame', () => {
    const saved = point();
    saved.stack.push({ ...saved.stack[0]!, step: 'removed-child' });
    expect(() => validateWorkflowResumeRoot(workflow, saved)).not.toThrow();
  });

  it.each([
    { overrides: { step: 'removed-reviewers' }, reason: /step not found/ },
    { overrides: { workflow: 'other' }, reason: /workflow|identity/i },
    { overrides: { kind: 'system' as const }, reason: /kind mismatch/ },
  ])('rejects an invalid root with an explanatory reason: $overrides', ({ overrides, reason }) => {
    expect(() => validateWorkflowResumeRoot(workflow, point(overrides))).toThrow(reason);
  });

  it('rejects an empty saved stack', () => {
    expect(() => validateWorkflowResumeRoot(workflow, { ...point(), stack: [] })).toThrow(/stack is empty/);
  });

  it('reports both workflow names when the saved name differs', () => {
    const saved = point({ workflow: 'previous', workflow_ref: 'project:old' });
    expect(getWorkflowResumeFrameError(workflow, saved.stack[0]!, workflow.steps))
      .toBe('Saved resume position "previous/reviewers" has a workflow name mismatch (saved: "previous", current: "default")');
  });

  it('reports an ambiguous saved step', () => {
    const duplicate = { ...workflow, steps: [agent, { ...agent }] };
    expect(getWorkflowResumeFrameError(duplicate, point().stack[0]!, duplicate.steps)).toMatch(/ambiguous/);
  });

  it('accepts the parallel frame kind and rejects the agent kind for a parallel step', () => {
    const parallel = { ...workflow, steps: [{ ...agent, parallel: [{ ...agent, name: 'child' }] }] };
    expect(() => validateWorkflowResumeRoot(parallel, point({ kind: 'parallel' }))).not.toThrow();
    expect(() => validateWorkflowResumeRoot(parallel, point())).toThrow(/kind mismatch/);
  });

  it('keeps the saved position when the workflow ref changes', () => {
    const current = attachWorkflowOpaqueRef({ ...workflow }, 'project:new');
    const saved = point({ workflow_ref: 'project:old' });
    expect(() => validateWorkflowResumeRoot(current, saved)).not.toThrow();
    expect(trimResumePointStackForWorkflow({ workflow: current, resumePoint: saved, resolveWorkflowCall: () => null }))
      .toEqual(saved);
  });

  it.each([true, false])('warns about a workflow ref mismatch only when refs differ: %s', (mismatch) => {
    const current = attachWorkflowOpaqueRef({ ...workflow }, 'project:current');
    const saved = point({ workflow_ref: mismatch ? 'project:previous' : 'project:current' });
    const writeLog = vi.spyOn(DebugLogger.getInstance(), 'writeLog');
    try {
      validateWorkflowResumeRoot(current, saved);
      const warnings = writeLog.mock.calls.filter(([level]) => level === 'WARN');
      expect(warnings.length > 0).toBe(mismatch);
      if (mismatch) {
        expect(JSON.stringify(warnings)).toMatch(/workflow|ref|hash/i);
      }
    } finally {
      writeLog.mockRestore();
    }
  });

});

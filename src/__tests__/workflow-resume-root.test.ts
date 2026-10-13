import { describe, expect, it } from 'vitest';
import type { WorkflowConfig, WorkflowResumePoint, WorkflowResumePointEntry, WorkflowStep } from '../core/models/index.js';
import { getWorkflowResumeFrameError, validateWorkflowResumeRoot } from '../core/workflow/run/resume-point.js';
import { attachWorkflowOpaqueRef } from '../shared/workflowConfigMetadata.js';

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
  it('explains why an absolute-path-derived builtin checkpoint cannot be verified', () => {
    const current = attachWorkflowOpaqueRef({ ...workflow }, `builtin:v2:sha256:${'b'.repeat(64)}`);
    const saved = point({ workflow_ref: `builtin:sha256:${'a'.repeat(64)}` });

    const reason = getWorkflowResumeFrameError(current, saved.stack[0]!, current.steps);

    expect(reason).toMatch(/legacy|旧/i);
    expect(reason).toMatch(/absolute.path|絶対パス/i);
    expect(reason).toMatch(/content|本文|内容/i);
    expect(() => validateWorkflowResumeRoot(current, saved)).toThrow(reason);
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
    { overrides: { workflow_ref: 'other' }, reason: /identity mismatch/ },
    { overrides: { kind: 'system' as const }, reason: /kind mismatch/ },
  ])('rejects an invalid root with an explanatory reason: $overrides', ({ overrides, reason }) => {
    expect(() => validateWorkflowResumeRoot(workflow, point(overrides))).toThrow(reason);
  });

  it('rejects an empty saved stack', () => {
    expect(() => validateWorkflowResumeRoot(workflow, { ...point(), stack: [] })).toThrow(/stack is empty/);
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
});

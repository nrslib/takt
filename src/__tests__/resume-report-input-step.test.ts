import { describe, expect, it } from 'vitest';
import type { WorkflowResumePoint, WorkflowResumePointEntry } from '../core/models/types.js';
import { isResumedReportInputStep } from '../core/workflow/engine/WorkflowEngineSetup.js';

const agentFrame = (): WorkflowResumePointEntry => ({
  workflow: 'review', workflow_ref: 'review', step: 'final-gate', kind: 'agent', occurrence: 2,
});
const sourcePoint = (stack: WorkflowResumePointEntry[]): WorkflowResumePoint => ({
  version: 2, stack, iteration: 3, elapsed_ms: 0,
  workflow_call_invocations: {}, workflow_step_participations: {},
});

describe('resumed report input step', () => {
  it('allows only the saved agent step and occurrence', () => {
    const frame = agentFrame();
    const source = sourcePoint([frame]);
    expect(isResumedReportInputStep(source, [{ ...frame }], 'final-gate', 2)).toBe(true);
    expect(isResumedReportInputStep(source, [{ ...frame, occurrence: 3 }], 'final-gate', 3)).toBe(false);
    expect(isResumedReportInputStep(source, [frame], 'other', 2)).toBe(false);
    expect(isResumedReportInputStep(source, [{ ...frame, step: 'other' }], 'final-gate', 2)).toBe(false);
    expect(isResumedReportInputStep(source, [{ ...frame, workflow_ref: 'other' }], 'final-gate', 2)).toBe(false);
    expect(isResumedReportInputStep(undefined, [frame], 'final-gate', 2)).toBe(false);
    expect(isResumedReportInputStep(source, undefined, 'final-gate', 2)).toBe(false);
  });

  it.each(['parallel', 'workflow_call', 'system'] as const)('rejects a terminal %s frame', (kind) => {
    const frame = { ...agentFrame(), kind, ...(kind === 'workflow_call' ? { call_instance: 1 } : {}) };
    expect(isResumedReportInputStep(sourcePoint([frame]), [frame], frame.step, frame.occurrence)).toBe(false);
  });

  it('keeps the exception within the saved workflow call path', () => {
    const parent: WorkflowResumePointEntry = {
      workflow: 'parent', workflow_ref: 'parent', step: 'delegate', kind: 'workflow_call',
      occurrence: 1, call_instance: 1,
    };
    const frame = agentFrame();
    const source = sourcePoint([parent, frame]);
    expect(isResumedReportInputStep(source, [{ ...parent }, { ...frame }], frame.step, 2)).toBe(true);
    expect(isResumedReportInputStep(source, [parent], frame.step, 2)).toBe(false);
    expect(isResumedReportInputStep(source, [frame], frame.step, 2)).toBe(false);
    for (const otherParent of [
      { ...parent, workflow_ref: 'sibling' },
      { ...parent, step: 'other-delegate' },
      { ...parent, occurrence: 2 },
      { ...parent, call_instance: 2 },
    ]) {
      expect(isResumedReportInputStep(source, [otherParent, frame], frame.step, 2)).toBe(false);
    }
  });
});

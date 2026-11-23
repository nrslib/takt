import { describe, expect, it, vi } from 'vitest';
import type { WorkflowConfig, WorkflowResumePoint } from '../core/models/types.js';
import { attachWorkflowOpaqueRef } from '../shared/workflowConfigMetadata.js';
import { buildWorkflowResumePointEntry, getWorkflowReference } from '../core/workflow/workflow-reference.js';
import { buildWorkflowCallInvocationIdentity } from '../core/workflow/workflow-call-invocation-index.js';
import { buildWorkflowStepParticipationIdentity } from '../core/workflow/workflow-step-participation-index.js';
import { collectWorkflowReportProducers, matchWorkflowResumeRecords } from '../core/workflow/workflow-resume-records.js';
import { resolveReviewReportStepParticipation } from '../core/workflow/review-report-participation.js';
import { DebugLogger } from '../shared/utils/debug.js';
import { makeStep } from './test-helpers.js';

function fixture() {
  const oldChild = attachWorkflowOpaqueRef<WorkflowConfig>({ name: 'child', initialStep: 'plan', maxSteps: 5,
    steps: [makeStep({ name: 'plan', outputContracts: [{ name: 'plan.md', format: 'Plan' }] }), makeStep({ name: 'verify' })],
  }, 'old-child');
  const child = attachWorkflowOpaqueRef({ ...oldChild }, 'new-child');
  const root: WorkflowConfig = { name: 'root', initialStep: 'delegate', maxSteps: 5,
    steps: [makeStep({ name: 'delegate', kind: 'workflow_call', call: 'child' })],
  };
  const frame = buildWorkflowResumePointEntry(root, 'delegate', 'workflow_call', 1, undefined, 1);
  const invocation = buildWorkflowCallInvocationIdentity(root.name, 'delegate', []);
  const savedIdentity = buildWorkflowStepParticipationIdentity(getWorkflowReference(oldChild), 'plan', [frame]);
  const point: WorkflowResumePoint = {
    version: 2, iteration: 2, elapsed_ms: 0,
    stack: [frame, buildWorkflowResumePointEntry(oldChild, 'verify', 'agent', 1)],
    workflow_call_invocations: { [invocation]: { call_instance: 1, report_namespace_segment: 'iteration-1--step-delegate--workflow-child' } },
    workflow_step_participations: { [savedIdentity]: { report_names: ['plan.md'] } },
  };
  const context = { workflow: root, workflowCallResolver: () => child, projectCwd: '/project', lookupCwd: '/project' };
  return { root, child, point, context, frame, savedIdentity, invocation };
}

describe('resume records matched by name', () => {
  it('adopts the saved body reference after a workflow hash change without changing the source', () => {
    const f = fixture();
    const before = structuredClone(f.point);
    const result = matchWorkflowResumeRecords(f.point, f.context);
    const identity = buildWorkflowStepParticipationIdentity(getWorkflowReference(f.child), 'plan', [f.frame]);
    expect(result.point.workflow_step_participations[identity]).toEqual({ report_names: ['plan.md'] });
    expect(result.inheritedReports).toEqual([{ identity, savedIdentity: f.savedIdentity, reportName: 'plan.md',
      reportPath: 'subworkflows/iteration-1--step-delegate--workflow-child/plan.md' }]);
    expect(f.point).toEqual(before);
  });

  it('drops conflicting report records with a warning', () => {
    const f = fixture();
    f.point.workflow_step_participations[buildWorkflowStepParticipationIdentity(getWorkflowReference(f.child), 'plan', [f.frame])] = { report_names: ['other.md'] };
    const warning = vi.spyOn(DebugLogger.getInstance(), 'writeLog');
    try {
      const result = matchWorkflowResumeRecords(f.point, f.context);
      expect(result.point.workflow_step_participations).toEqual({});
      expect(result.inheritedReports).toEqual([]);
      expect(warning.mock.calls.some(([level]) => level === 'WARN')).toBe(true);
    } finally { warning.mockRestore(); }
  });

  it('does not adopt a report from another call occurrence', () => {
    const f = fixture();
    f.point.workflow_call_invocations[f.invocation] = { call_instance: 2, report_namespace_segment: 'iteration-2--step-delegate--workflow-child' };
    expect(matchWorkflowResumeRecords(f.point, f.context).inheritedReports).toEqual([]);
  });

  it('drops an invocation with an unspecified namespace iteration', () => {
    const f = fixture();
    f.point.workflow_call_invocations[f.invocation]!.report_namespace_segment =
      'iteration-*--step-delegate--workflow-child';

    const result = matchWorkflowResumeRecords(f.point, f.context);

    expect(result.point.workflow_call_invocations).toEqual({});
    expect(result.point.workflow_step_participations).toEqual({});
    expect(result.inheritedReports).toEqual([]);
  });

  it('drops a workflow-call participation when its invocation was excluded', () => {
    const f = fixture();
    const identity = buildWorkflowStepParticipationIdentity(getWorkflowReference(f.root), 'delegate', []);
    f.point.workflow_step_participations[identity] = { report_names: [] };
    f.point.stack[0] = { ...f.frame, step_iterations: { delegate: 1 } };
    f.point.workflow_call_invocations[f.invocation]!.report_namespace_segment = 'iteration-1--step-delegate--workflow-other';

    const result = matchWorkflowResumeRecords(f.point, f.context);

    expect(result.point.workflow_call_invocations).toEqual({});
    expect(result.point.workflow_step_participations).toEqual({});
    expect(result.inheritedReports).toEqual([]);
    expect(result.point.stack[0]?.step_iterations?.delegate).toBeUndefined();
    expect(resolveReviewReportStepParticipation(f.root.steps[0]!, f.root, [], {
      activeWorkflowReference: getWorkflowReference(f.root),
      stepOutputNames: new Set(),
      restoredStepIterationNames: new Set(Object.keys(result.point.stack[0]?.step_iterations ?? {})),
      workflowCallInvocations: { kind: 'exact', records: new Map() },
      workflowStepParticipations: new Map(),
      dynamicParallelSelections: new Map(),
    }).kind).toBe('not-participated');
  });

  it.each([1, 2])('does not equate namespace iteration with call instance (%s)', (iteration) => {
    const f = fixture();
    f.point.workflow_call_invocations[f.invocation]!.report_namespace_segment =
      `iteration-${iteration}--step-delegate--workflow-child`;
    const warning = vi.spyOn(DebugLogger.getInstance(), 'writeLog');
    try {
      const result = matchWorkflowResumeRecords(f.point, f.context);
      expect(result.point.stack[0]).toEqual(f.point.stack[0]);
      expect(result.point.stack[1]?.step).toBe('verify');
      expect(result.point.workflow_call_invocations[f.invocation]?.call_instance).toBe(1);
      expect(result.inheritedReports[0]?.reportName).toBe('plan.md');
      expect(warning.mock.calls.some(([level, , message]) => level === 'WARN'
        && message === 'Ignoring unmatched inherited workflow invocation')).toBe(false);
    } finally { warning.mockRestore(); }
  });

  it('ignores a producer whose step name no longer exists', () => {
    const f = fixture();
    f.child.steps = f.child.steps.filter((step) => step.name !== 'plan');
    const result = matchWorkflowResumeRecords(f.point, f.context);
    expect(result.point.workflow_step_participations).toEqual({});
    expect(result.inheritedReports).toEqual([]);
  });

  it('ignores records when the root workflow name changes at the same reference', () => {
    const f = fixture();
    f.context.workflow = attachWorkflowOpaqueRef({ ...f.root, name: 'another-root' }, getWorkflowReference(f.root));
    const result = matchWorkflowResumeRecords(f.point, f.context);
    expect(result.point.workflow_call_invocations).toEqual({});
    expect(result.point.workflow_step_participations).toEqual({});
    expect(result.inheritedReports).toEqual([]);
  });

  it('matches a root producer from an earlier definition whose reference is absent from the saved stack', () => {
    const f = fixture();
    f.root.steps.push(makeStep({ name: 'root-plan', outputContracts: [{ name: 'root-plan.md', format: 'Plan' }] }));
    const savedIdentity = buildWorkflowStepParticipationIdentity('earlier-root-hash', 'root-plan', []);
    f.point.workflow_step_participations = { [savedIdentity]: { report_names: ['root-plan.md'] } };
    const result = matchWorkflowResumeRecords(f.point, f.context);
    const identity = buildWorkflowStepParticipationIdentity(getWorkflowReference(f.root), 'root-plan', []);
    expect(result.point.workflow_step_participations[identity]).toEqual({ report_names: ['root-plan.md'] });
    expect(result.inheritedReports).toEqual([{ identity, savedIdentity, reportName: 'root-plan.md', reportPath: 'root-plan.md' }]);
  });

  it('identifies the actual report producer inside a workflow call', () => {
    const f = fixture();
    f.point.workflow_call_invocations[f.invocation]!.completed = true;
    const matched = matchWorkflowResumeRecords(f.point, f.context);
    expect(collectWorkflowReportProducers(f.context, f.root.steps[0]!, [], matched.point.workflow_call_invocations)).toEqual([{
      identity: buildWorkflowStepParticipationIdentity(getWorkflowReference(f.child), 'plan', [f.frame]), reportName: 'plan.md',
    }]);
  });

  it('does not select reports inside an incomplete inherited workflow call', () => {
    const f = fixture();
    const matched = matchWorkflowResumeRecords(f.point, f.context);
    expect(collectWorkflowReportProducers(f.context, f.root.steps[0]!, [], matched.point.workflow_call_invocations)).toEqual([]);
  });

  it('drops conflicting inherited invocation namespaces instead of choosing one', () => {
    const f = fixture();
    f.point.workflow_call_invocations[buildWorkflowCallInvocationIdentity('another-root-hash', 'delegate', [])] = {
      call_instance: 1, report_namespace_segment: 'iteration-1--step-delegate--workflow-other',
    };
    // A known saved reference supplies its display name, independently of the current hash.
    f.point.stack[0] = { ...f.frame, workflow_ref: 'another-root-hash' };
    const matched = matchWorkflowResumeRecords(f.point, f.context);
    expect(matched.point.workflow_call_invocations).toEqual({});
    expect(matched.inheritedReports).toEqual([]);
  });

  it('preserves an unqualified parallel record only when its step has one existing parallel scope', () => {
    const f = fixture();
    f.child.steps.push(makeStep({ name: 'reviews', parallel: [makeStep({ name: 'review', outputContracts: [{ name: 'review.md', format: 'Review' }] })] }));
    const savedIdentity = JSON.stringify({ ...JSON.parse(f.savedIdentity) as Record<string, unknown>, step: 'review' });
    f.point.workflow_step_participations = { [savedIdentity]: { report_names: ['review.md'] } };
    const result = matchWorkflowResumeRecords(f.point, f.context);
    expect(result.point.workflow_step_participations[
      buildWorkflowStepParticipationIdentity(getWorkflowReference(f.child), 'review', [f.frame])
    ]).toEqual({ report_names: ['review.md'] });
    expect(result.inheritedReports[0]?.identity).toBe(
      buildWorkflowStepParticipationIdentity(getWorkflowReference(f.child), 'review', [f.frame], 'reviews'),
    );
    f.child.steps.push(makeStep({ name: 'other-reviews', parallel: [makeStep({ name: 'review' })] }));
    expect(matchWorkflowResumeRecords(f.point, f.context).inheritedReports).toEqual([]);
  });

  it('excludes inherited invocations that assign the same report namespace to different call positions', () => {
    const f = fixture();
    f.child.steps.push(makeStep({ name: 'delegate', kind: 'workflow_call', call: 'child' }));
    const nested = buildWorkflowCallInvocationIdentity(getWorkflowReference(f.child), 'delegate', [f.frame]);
    f.point.workflow_call_invocations[nested] = { ...f.point.workflow_call_invocations[f.invocation]! };
    const result = matchWorkflowResumeRecords(f.point, f.context);
    expect(result.point.workflow_call_invocations).toEqual({});
    expect(result.inheritedReports).toEqual([]);
  });

  it('excludes conflicting qualified and unqualified records for the same parallel producer', () => {
    const f = fixture();
    f.child.steps.push(makeStep({ name: 'reviews', parallel: [makeStep({ name: 'review' })] }));
    const saved = JSON.stringify({ ...JSON.parse(f.savedIdentity) as Record<string, unknown>, step: 'review' });
    const qualified = buildWorkflowStepParticipationIdentity(getWorkflowReference(f.child), 'review', [f.frame], 'reviews');
    f.point.workflow_step_participations = {
      [saved]: { report_names: ['first.md'] }, [qualified]: { report_names: ['second.md'] },
    };
    const result = matchWorkflowResumeRecords(f.point, f.context);
    expect(result.point.workflow_step_participations).toEqual({});
    expect(result.inheritedReports).toEqual([]);
  });

  it('excludes an unqualified record when qualified aliases conflict for the same parallel producer', () => {
    const f = fixture();
    f.child.steps.push(makeStep({ name: 'reviews', parallel: [makeStep({ name: 'review' })] }));
    const unqualified = JSON.stringify({ ...JSON.parse(f.savedIdentity) as Record<string, unknown>, step: 'review' });
    const firstQualified = buildWorkflowStepParticipationIdentity('old-child', 'review', [f.frame], 'reviews');
    const secondQualified = buildWorkflowStepParticipationIdentity('another-old-child', 'review', [f.frame], 'reviews');
    f.point.workflow_step_participations = {
      [unqualified]: { report_names: ['first.md'] },
      [firstQualified]: { report_names: ['second.md'] },
      [secondQualified]: { report_names: ['third.md'] },
    };

    const result = matchWorkflowResumeRecords(f.point, f.context);

    expect(result.point.workflow_step_participations).toEqual({});
    expect(result.inheritedReports).toEqual([]);
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkflowConfig, WorkflowResumePointEntry, WorkflowStep } from '../core/models/types.js';
import { createInitialState } from '../core/workflow/engine/state-manager.js';
import { WorkflowCallExecutor } from '../core/workflow/engine/WorkflowCallExecutor.js';
import { resolveDeclaredReportInputs } from '../core/workflow/instruction/declared-report-inputs.js';
import { InstructionBuilder } from '../core/workflow/instruction/InstructionBuilder.js';
import { formatMissingReportReference } from '../core/workflow/instruction/report-reference.js';
import { WorkflowCallInvocationIndex } from '../core/workflow/workflow-call-invocation-index.js';
import { WorkflowStepParticipationIndex } from '../core/workflow/workflow-step-participation-index.js';
import { buildWorkflowResumePointEntry } from '../core/workflow/workflow-reference.js';
import { buildDynamicParallelSelectionIdentity } from '../core/workflow/dynamic-parallel/identity.js';
import type { WorkflowSharedRuntimeState } from '../core/workflow/types.js';
import { makeNormalizedWorkflowCallStep } from './helpers/normalized-workflow-call-step.js';
import { makeInstructionContext, makeStep } from './test-helpers.js';

function workflow(name: string, steps: WorkflowStep[]): WorkflowConfig {
  return { name, initialStep: steps[0]!.name, maxSteps: 5, steps };
}

describe('declared report inputs', () => {
  const directories: string[] = [];
  afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

  function fixture() {
    const reportDir = mkdtempSync(join(tmpdir(), 'takt-declared-report-inputs-'));
    directories.push(reportDir);
    const source = makeNormalizedWorkflowCallStep({ name: 'source', call: 'child' });
    const consumer = makeStep({
      name: 'consumer',
      inputReports: { fromStep: 'source', reports: ['review.md'] },
    });
    const parent = workflow('parent', [source, consumer]);
    const child = workflow('child', [makeStep({
      name: 'review',
      outputContracts: [{ name: 'review.md', format: '# Review' }],
    })]);
    const state = createInitialState(parent, { projectCwd: reportDir });
    const invocations = new WorkflowCallInvocationIndex(new Map());
    const participation = new WorkflowStepParticipationIndex(new Map());
    const sharedRuntime: WorkflowSharedRuntimeState = {
      startedAtMs: 0,
      workflowCallInvocationEvidence: { kind: 'exact', index: invocations },
      workflowStepParticipationIndex: participation,
    };
    const resolve = (resumeStackPrefix: readonly WorkflowResumePointEntry[] = []) => resolveDeclaredReportInputs(consumer, {
      workflow: parent,
      state,
      sharedRuntime,
      workflowCallResolver: () => child,
      projectCwd: reportDir,
      lookupCwd: reportDir,
      reportDir,
      resumeStackPrefix,
    });
    const record = (instance: number, completed: boolean, reportPresent = true, resumeStackPrefix: readonly WorkflowResumePointEntry[] = []) => {
      const namespace = `iteration-${instance}--step-source--workflow-child`;
      invocations.record(parent, source.name, resumeStackPrefix, {
        call_instance: instance,
        report_namespace_segment: namespace,
        ...(completed ? { completed: true as const } : {}),
      });
      const callPath = [...resumeStackPrefix, buildWorkflowResumePointEntry(parent, source.name, 'workflow_call', instance, undefined, instance)];
      participation.record(child, 'review', callPath, reportPresent ? ['review.md'] : []);
      if (reportPresent) {
        const directory = join(reportDir, 'subworkflows', namespace);
        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, 'review.md'), `review from call ${instance}`);
      }
    };
    const resolvedText = (resumeStackPrefix: readonly WorkflowResumePointEntry[] = []) =>
      resolve(resumeStackPrefix)?.reports.map(({ content }) => content).join('\n');
    return { consumer, reportDir, state, resolve, resolvedText, record, source, parent, child, sharedRuntime, invocations };
  }

  it('passes only the declared completed invocation body to the consumer', () => {
    const f = fixture();
    f.record(1, true);
    expect(f.resolvedText()).toContain('review from call 1');
    f.record(2, true);
    expect(f.resolvedText()).toContain('review from call 2');
    expect(f.resolvedText()).not.toContain('review from call 1');
  });

  it('does not fall back to an older completed call when the current call is pending', () => {
    const f = fixture();
    f.record(1, true);
    f.record(2, false);
    expect(f.resolve).toThrow(/not_completed/);
  });

  it('resets completion before replaying the same call occurrence', () => {
    const f = fixture();
    f.record(1, true);
    expect(f.resolvedText()).toContain('review from call 1');
    const executor = new WorkflowCallExecutor({
      getConfig: () => f.parent,
      getOptions: () => ({}),
      getMaxSteps: () => 5,
      updateMaxSteps: () => undefined,
      getCwd: () => f.reportDir,
      projectCwd: f.reportDir,
      task: 'test',
      sharedRuntime: f.sharedRuntime,
      resumeStackPrefix: [],
      consumeWorkflowCallContinuation: () => undefined,
      runPaths: {} as never,
      resolveWorkflowCall: () => f.child,
      createEngine: () => { throw new Error('not used'); },
      emit: () => undefined,
      state: f.state,
      setActiveResumePoint: () => undefined,
    });
    executor.recordPendingInvocation(f.source, 1, []);
    expect(f.invocations.get(f.parent, f.source.name, [])?.completed).toBeUndefined();
    expect(f.resolve).toThrow(/not_completed/);
    const callPath = [buildWorkflowResumePointEntry(f.parent, f.source.name, 'workflow_call', 1, undefined, 1)];
    f.sharedRuntime.workflowStepParticipationIndex!.record(f.child, 'review', callPath, []);
    f.invocations.replace(f.parent, f.source.name, [], {
      ...f.invocations.get(f.parent, f.source.name, [])!,
      completed: true,
    });
    expect(f.resolve).toThrow(/not_produced:review:review.md/);
  });

  it('retains an earlier replan report when replaying a later fix step', () => {
    const f = fixture();
    f.child.steps = [
      makeStep({ name: 'plan', outputContracts: [{ name: 'fix-plan.md', format: '# Plan' }] }),
      makeStep({ name: 'fix' }),
      makeStep({ name: 'replan', outputContracts: [{ name: 'fix-plan.md', format: '# Replan' }] }),
    ];
    f.consumer.inputReports = { fromStep: 'source', reports: ['fix-plan.md'] };
    const namespace = 'iteration-1--step-source--workflow-child';
    f.invocations.record(f.parent, f.source.name, [], {
      call_instance: 1,
      report_namespace_segment: namespace,
      completed: true,
    });
    const callPath = [buildWorkflowResumePointEntry(f.parent, f.source.name, 'workflow_call', 1, undefined, 1)];
    const participation = f.sharedRuntime.workflowStepParticipationIndex!;
    participation.record(f.child, 'plan', callPath, ['fix-plan.md']);
    participation.record(f.child, 'replan', callPath, ['fix-plan.md']);
    mkdirSync(join(f.reportDir, 'subworkflows', namespace), { recursive: true });
    writeFileSync(join(f.reportDir, 'subworkflows', namespace, 'fix-plan.md'), 'latest replan');
    expect(f.resolvedText()).toContain('latest replan');

    const executor = new WorkflowCallExecutor({
      getConfig: () => f.parent,
      getOptions: () => ({}),
      getMaxSteps: () => 5,
      updateMaxSteps: () => undefined,
      getCwd: () => f.reportDir,
      projectCwd: f.reportDir,
      task: 'test',
      sharedRuntime: f.sharedRuntime,
      resumeStackPrefix: [],
      consumeWorkflowCallContinuation: () => undefined,
      runPaths: {} as never,
      resolveWorkflowCall: () => f.child,
      createEngine: () => { throw new Error('not used'); },
      emit: () => undefined,
      state: f.state,
      setActiveResumePoint: () => undefined,
    });
    executor.recordPendingInvocation(f.source, 1, []);
    participation.record(f.child, 'fix', callPath, []);
    f.invocations.replace(f.parent, f.source.name, [], {
      ...f.invocations.get(f.parent, f.source.name, [])!,
      completed: true,
    });
    expect(f.resolvedText()).toContain('latest replan');
  });

  it('does not fill a later producer failure from an earlier same-name report', () => {
    const f = fixture();
    f.child.steps = [
      makeStep({ name: 'plan', outputContracts: [{ name: 'fix-plan.md', format: '# Plan' }] }),
      makeStep({ name: 'replan', outputContracts: [{ name: 'fix-plan.md', format: '# Replan' }] }),
    ];
    f.consumer.inputReports = { fromStep: 'source', reports: ['fix-plan.md'] };
    const namespace = 'iteration-1--step-source--workflow-child';
    f.invocations.record(f.parent, f.source.name, [], {
      call_instance: 1,
      report_namespace_segment: namespace,
      completed: true,
    });
    const callPath = [buildWorkflowResumePointEntry(f.parent, f.source.name, 'workflow_call', 1, undefined, 1)];
    const participation = f.sharedRuntime.workflowStepParticipationIndex!;
    participation.record(f.child, 'plan', callPath, ['fix-plan.md']);
    mkdirSync(join(f.reportDir, 'subworkflows', namespace), { recursive: true });
    writeFileSync(join(f.reportDir, 'subworkflows', namespace, 'fix-plan.md'), 'earlier plan');
    expect(f.resolvedText()).toContain('earlier plan');
    participation.record(f.child, 'replan', callPath, []);
    expect(f.resolve).toThrow(/not_produced:replan:fix-plan.md/);
  });

  it('keeps completed invocations isolated by their resume call path', () => {
    const f = fixture();
    const outer = workflow('outer', [makeNormalizedWorkflowCallStep({ name: 'delegate', call: 'parent' })]);
    const firstPath = [buildWorkflowResumePointEntry(outer, 'delegate', 'workflow_call', 1, undefined, 1)];
    const secondPath = [buildWorkflowResumePointEntry(outer, 'delegate', 'workflow_call', 2, undefined, 2)];
    f.record(1, true, true, firstPath);
    expect(f.resolvedText(firstPath)).toContain('review from call 1');
    expect(() => f.resolve(secondPath)).toThrow(/0 matching completed reports/);
    f.record(2, true, true, secondPath);
    expect(f.resolvedText(secondPath)).toContain('review from call 2');
    expect(f.resolvedText(secondPath)).not.toContain('review from call 1');
  });

  it('rejects a missing contracted report despite an unrelated same-name file', () => {
    const f = fixture();
    f.record(1, true, false);
    writeFileSync(join(f.reportDir, 'review.md'), 'unrelated review');
    expect(f.resolve).toThrow(/not_produced/);
  });

  it('includes only selected completed reviewers and rejects a selected reviewer without participation', () => {
    const f = fixture();
    const backend = makeStep({ name: 'backend', outputContracts: [{ name: 'backend.md', format: '# Backend' }] });
    const security = makeStep({ name: 'security', outputContracts: [{ name: 'security.md', format: '# Security' }] });
    f.child.steps = [{
      ...makeStep({ name: 'reviewers' }),
      parallel: {
        kind: 'dynamic',
        fixed: [backend],
        pool: [security],
        selection: { mode: 'replace' },
      },
    }];
    f.consumer.inputReports = { fromStep: 'source', reports: 'all' };
    f.record(1, true, false);
    const callPath = [buildWorkflowResumePointEntry(f.parent, f.source.name, 'workflow_call', 1, undefined, 1)];
    const participation = f.sharedRuntime.workflowStepParticipationIndex!;
    participation.record(f.child, 'reviewers', callPath, []);
    participation.record(f.child, 'backend', callPath, ['backend.md'], 'reviewers');
    const namespace = join(f.reportDir, 'subworkflows', 'iteration-1--step-source--workflow-child');
    mkdirSync(namespace, { recursive: true });
    writeFileSync(join(namespace, 'backend.md'), 'backend findings');
    writeFileSync(join(namespace, 'security.md'), 'unrelated security findings');
    const identity = buildDynamicParallelSelectionIdentity(f.child, 'reviewers', callPath);
    f.state.dynamicParallelSelections.set(identity, {
      identity,
      step_name: 'reviewers',
      round: 1,
      selected_pool_ids: [],
      effective_selection_ids: ['backend'],
    });
    expect(f.resolvedText()).toContain('backend findings');
    expect(f.resolvedText()).not.toContain('unrelated security findings');
    f.state.dynamicParallelSelections.set(identity, {
      identity,
      step_name: 'reviewers',
      round: 1,
      selected_pool_ids: ['security'],
      effective_selection_ids: ['backend', 'security'],
    });
    expect(f.resolve).toThrow(/selected_reviewer_missing:reviewers:security/);
  });

  it('rejects an unrecorded static reviewer with a required report', () => {
    const f = fixture();
    const backend = makeStep({ name: 'backend', outputContracts: [{ name: 'backend.md', format: '# Backend' }] });
    const testing = makeStep({ name: 'testing', outputContracts: [{ name: 'testing.md', format: '# Testing' }] });
    f.child.steps = [{ ...makeStep({ name: 'reviewers' }), parallel: [backend, testing] }];
    f.consumer.inputReports = { fromStep: 'source', reports: 'all' };
    f.record(1, true, false);
    const callPath = [buildWorkflowResumePointEntry(f.parent, f.source.name, 'workflow_call', 1, undefined, 1)];
    const participation = f.sharedRuntime.workflowStepParticipationIndex!;
    participation.record(f.child, 'reviewers', callPath, []);
    participation.record(f.child, 'backend', callPath, ['backend.md'], 'reviewers');
    const namespace = join(f.reportDir, 'subworkflows', 'iteration-1--step-source--workflow-child');
    mkdirSync(namespace, { recursive: true });
    writeFileSync(join(namespace, 'backend.md'), 'backend findings');
    writeFileSync(join(namespace, 'testing.md'), 'stale unrelated file');

    expect(f.resolve).toThrow(/static_reviewer_missing:reviewers:testing/);
  });

  it('allows an optional source only before it has run', () => {
    const f = fixture();
    f.consumer.inputReports = { fromStep: 'source', reports: ['review.md'], optionalIfUnrun: true };
    expect(f.resolve()).toEqual({ declaredNames: ['review.md'], reports: [] });
    f.record(1, false);
    expect(f.resolve).toThrow(/not_completed/);
  });

  it.each(['workflow_call', 'agent'] as const)(
    'reserves an unrun %s source contract for reports: all without blocking unrelated local reports',
    (sourceKind) => {
      const f = fixture();
      if (sourceKind === 'agent') {
        f.parent.steps[0] = makeStep({
          name: 'source',
          outputContracts: [{ name: 'review.md', format: '# Review' }],
        });
      }
      f.consumer.inputReports = { fromStep: 'source', reports: 'all', optionalIfUnrun: true };
      writeFileSync(join(f.reportDir, 'review.md'), 'UNRELATED-REVIEW');
      writeFileSync(join(f.reportDir, 'local-note.md'), 'LOCAL-NOTE');

      const declared = f.resolve();
      expect(declared).toEqual({ declaredNames: ['review.md'], reports: [] });
      const prepared = new InstructionBuilder(
        makeStep({ instruction: '{report:review.md}\n{report:local-note.md}' }),
        makeInstructionContext({ reportDir: f.reportDir, declaredReportInputs: [declared!] }),
      ).prepare();
      expect(prepared.text).toContain(formatMissingReportReference('review.md'));
      expect(prepared.text).toContain('LOCAL-NOTE');
      expect(prepared.text).not.toContain('UNRELATED-REVIEW');
    },
  );
});

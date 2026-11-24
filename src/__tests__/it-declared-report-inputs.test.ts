import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NormalAgentWorkflowStep, WorkflowCallStep, WorkflowConfig, WorkflowResumePointEntry, WorkflowStep } from '../core/models/types.js';
import { createInitialState } from '../core/workflow/engine/state-manager.js';
import { WorkflowCallExecutor } from '../core/workflow/engine/WorkflowCallExecutor.js';
import { resolveDeclaredReportInputs } from '../core/workflow/instruction/declared-report-inputs.js';
import { InstructionBuilder } from '../core/workflow/instruction/InstructionBuilder.js';
import { CURRENT_REPORT_BODY_LIMIT } from '../core/workflow/instruction/prepared-instruction.js';
import { formatMissingReportReference } from '../core/workflow/instruction/report-reference.js';
import { WorkflowCallInvocationIndex } from '../core/workflow/workflow-call-invocation-index.js';
import { WorkflowStepParticipationIndex, buildWorkflowStepParticipationIdentity } from '../core/workflow/workflow-step-participation-index.js';
import { buildWorkflowResumePointEntry } from '../core/workflow/workflow-reference.js';
import { buildDynamicParallelSelectionIdentity } from '../core/workflow/dynamic-parallel/identity.js';
import type { WorkflowSharedRuntimeState } from '../core/workflow/types.js';
import { makeInstructionContext, makeStep } from './test-helpers.js';
import { ReportExecutionStore } from '../core/workflow/report-execution-store.js';
import { DebugLogger } from '../shared/utils/debug.js';

function workflow(name: string, steps: WorkflowStep[]): WorkflowConfig {
  return { name, initialStep: steps[0]!.name, maxSteps: 5, steps };
}

describe('declared report inputs', () => {
  const directories: string[] = [];
  afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

  function fixture() {
    const reportDir = mkdtempSync(join(tmpdir(), 'takt-declared-report-inputs-'));
    directories.push(reportDir);
    const source: WorkflowCallStep = {
      name: 'source', kind: 'workflow_call', call: 'child', personaDisplayName: 'source', instruction: '',
    };
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

  it.each([true, false])('keeps other declared inputs when the inherited report is recorded=%s', (recorded) => {
    const f = fixture();
    f.record(1, true);
    f.child.steps.push(makeStep({ name: 'verify', outputContracts: [{ name: 'verification.md', format: 'Verification' }] }));
    f.consumer.inputReports = { fromStep: 'source', reports: ['review.md', 'verification.md'] };
    const prefix = [buildWorkflowResumePointEntry(f.parent, 'source', 'workflow_call', 1, undefined, 1)];
    const namespace = 'subworkflows/iteration-1--step-source--workflow-child';
    const directory = join(f.reportDir, namespace);
    const identity = buildWorkflowStepParticipationIdentity(f.child.name, 'review', prefix);
    const writer = new ReportExecutionStore(f.reportDir);
    const id = writer.begin(identity, 'review', directory, ['review.md']);
    if (recorded) writer.capture(directory, 'review.md', 'SAVED-PLAN');
    writer.finish(id, true);
    writeFileSync(join(directory, 'review.md'), 'OLD-PLAN');
    writeFileSync(join(directory, 'verification.md'), 'VERIFIED');
    f.sharedRuntime.workflowStepParticipationIndex!.record(f.child, 'verify', prefix, ['verification.md']);
    const restored = new ReportExecutionStore(f.reportDir);
    const verification = buildWorkflowStepParticipationIdentity(f.child.name, 'verify', prefix);
    restored.restoreInheritedReports([
      { identity, savedIdentity: identity, reportName: 'review.md', reportPath: `${namespace}/review.md` },
      { identity: verification, savedIdentity: verification, reportName: 'verification.md', reportPath: `${namespace}/verification.md` },
    ]);
    f.sharedRuntime.reportExecutions = restored;
    const warning = vi.spyOn(DebugLogger.getInstance(), 'writeLog');
    try {
      const input = f.resolve()!;
      expect(input.declaredNames).toEqual(['review.md', 'verification.md']);
      expect(input.reports.find(({ reference }) => reference === 'verification.md')?.content).toBe('VERIFIED');
      if (recorded) expect(input.reports.find(({ reference }) => reference === 'review.md')?.content).toBe('SAVED-PLAN');
      else {
        expect(input.reports.map(({ reference }) => reference)).toEqual(['verification.md']);
        expect(warning.mock.calls.some(([level, , , data]) => level === 'WARN'
          && JSON.stringify(data).includes('review.md'))).toBe(true);
      }
      expect(input.reports.every(({ content }) => !content.includes('OLD-PLAN'))).toBe(true);
    } finally { warning.mockRestore(); }
  });

  it.each(['explicit', 'all'] as const)(
    'reserves a missing inherited report alongside a newly completed report (%s selection)', (selection) => {
      const f = fixture();
      f.child.steps.push(makeStep({ name: 'verify', outputContracts: [{ name: 'verification.md', format: 'Verification' }] }));
      f.consumer.inputReports = {
        fromStep: 'source', reports: selection === 'all' ? 'all' : ['review.md', 'verification.md'],
      };
      f.consumer.instruction = '{report:review.md}\n{report:verification.md}';
      f.record(1, true);
      const prefix = [buildWorkflowResumePointEntry(f.parent, 'source', 'workflow_call', 1, undefined, 1)];
      const namespace = 'subworkflows/iteration-1--step-source--workflow-child';
      const directory = join(f.reportDir, namespace);
      const reviewIdentity = buildWorkflowStepParticipationIdentity(f.child.name, 'review', prefix);
      const verificationIdentity = buildWorkflowStepParticipationIdentity(f.child.name, 'verify', prefix);
      const writer = new ReportExecutionStore(f.reportDir);
      const reviewExecution = writer.begin(reviewIdentity, 'review', directory, ['review.md']);
      writer.capture(directory, 'review.md', 'SAVED-PLAN');
      writer.finish(reviewExecution, true);
      rmSync(writer.current(reviewIdentity, 'review.md')!.path);
      rmSync(join(directory, 'review.md'));

      const restored = new ReportExecutionStore(f.reportDir);
      restored.restoreInheritedReports([
        { identity: reviewIdentity, savedIdentity: reviewIdentity, reportName: 'review.md', reportPath: `${namespace}/review.md` },
        { identity: verificationIdentity, savedIdentity: verificationIdentity, reportName: 'verification.md', reportPath: `${namespace}/verification.md` },
      ]);
      const verificationExecution = restored.begin(verificationIdentity, 'verify', directory, ['verification.md']);
      writeFileSync(join(directory, 'verification.md'), 'VERIFIED');
      restored.capture(directory, 'verification.md', 'VERIFIED');
      restored.finish(verificationExecution, true);
      f.sharedRuntime.workflowStepParticipationIndex!.record(f.child, 'verify', prefix, ['verification.md']);
      f.sharedRuntime.reportExecutions = restored;
      writeFileSync(join(f.reportDir, 'review.md'), 'OTHER-PLAN');
      const warning = vi.spyOn(DebugLogger.getInstance(), 'writeLog');
      try {
        const input = f.resolve()!;
        expect.soft(input.declaredNames).toEqual(['review.md', 'verification.md']);
        expect(input.reports.map(({ reference, content }) => ({ reference, content }))).toEqual([
          { reference: 'verification.md', content: 'VERIFIED' },
        ]);
        expect(warning.mock.calls.some(([level, , message, data]) => level === 'WARN'
          && message === 'Ignoring missing inherited report input'
          && JSON.stringify(data).includes('review.md'))).toBe(true);

        const prepared = new InstructionBuilder(f.consumer, makeInstructionContext({
          reportDir: f.reportDir, declaredReportInputs: [input],
        })).prepare();
        expect.soft(prepared.injectedReports.find(({ reference }) => reference === 'review.md')).toEqual({
          reference: 'review.md', scope: 'missing', content: formatMissingReportReference('review.md'),
        });
        expect(prepared.injectedReports.find(({ reference }) => reference === 'verification.md')).toMatchObject({
          scope: 'declared-producer', content: 'VERIFIED',
        });
        expect.soft(prepared.text).toContain(formatMissingReportReference('review.md'));
        expect(prepared.text).toContain('VERIFIED');
        expect.soft(prepared.text).not.toContain('OTHER-PLAN');
        expect(prepared.text).not.toContain('SAVED-PLAN');
      } finally { warning.mockRestore(); }
    },
  );

  it.each(['ja', 'en'] as const)('marks a short legacy report as lacking its original fixed version and execution ID (%s)', (language) => {
    const f = fixture();
    f.record(1, true);
    const inputs = f.resolve()!;
    expect(inputs.reports[0]).toMatchObject({ content: 'review from call 1' });
    const prompt = new InstructionBuilder(f.consumer, makeInstructionContext({
      reportDir: f.reportDir, language, declaredReportInputs: [inputs],
    })).prepare().text;
    expect(prompt).toContain('review from call 1');
    expect(prompt).toContain(language === 'ja' ? '元の完了実行の固定版と実行IDは未供給' : 'Original completed execution version and ID not supplied');
  });

  it.each(['ja', 'en'] as const)('distinguishes a host snapshot of a long legacy report from the original version (%s)', (language) => {
    const f = fixture();
    f.record(1, true);
    const body = 'x'.repeat(CURRENT_REPORT_BODY_LIMIT + 1);
    writeFileSync(join(f.reportDir, 'subworkflows', 'iteration-1--step-source--workflow-child', 'review.md'), body);
    const inputs = f.resolve()!;
    const snapshot = inputs.reports[0]!.path!;
    expect(readFileSync(snapshot, 'utf8')).toBe(body);
    const prompt = new InstructionBuilder(f.consumer, makeInstructionContext({
      reportDir: f.reportDir, language, declaredReportInputs: [inputs],
    })).prepare().text;
    expect(prompt).toContain(snapshot);
    expect(prompt).toContain(language === 'ja' ? '今回作成したsnapshot' : 'snapshot created for this call');
    expect(prompt).toContain(language === 'ja' ? '元の完了実行の固定版と実行IDは未供給' : 'Original completed execution version and ID not supplied');
  });

  it('does not fall back to an older completed call when the current call is pending', () => {
    const f = fixture();
    f.record(1, true);
    f.record(2, false);
    expect(f.resolve).toThrow(/not_completed/);
  });

  it('uses inherited parallel participation recorded without its unique parallel parent', () => {
    const f = fixture();
    f.record(1, true);
    f.child.steps = [makeStep({ name: 'reviews', parallel: [f.child.steps[0]!] })];
    const prefix = [buildWorkflowResumePointEntry(f.parent, 'source', 'workflow_call', 1, undefined, 1)];
    const savedIdentity = buildWorkflowStepParticipationIdentity(f.child.name, 'review', prefix);
    const identity = buildWorkflowStepParticipationIdentity(f.child.name, 'review', prefix, 'reviews');
    const store = new ReportExecutionStore(f.reportDir);
    store.restoreInheritedReports([{ identity, savedIdentity, reportName: 'review.md',
      reportPath: 'subworkflows/iteration-1--step-source--workflow-child/review.md' }]);
    f.sharedRuntime.reportExecutions = store;

    expect(f.resolve()?.reports).toEqual([expect.objectContaining({ reference: 'review.md', content: 'review from call 1' })]);
  });

  it('resets completion before replaying the same call occurrence', () => {
    const f = fixture();
    f.record(1, true);
    expect(f.resolvedText()).toContain('review from call 1');
    const executor = new WorkflowCallExecutor({
      getConfig: () => f.parent,
      getOptions: () => ({ projectCwd: f.reportDir }),
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
      getOptions: () => ({ projectCwd: f.reportDir }),
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

  it.each(['unrun', 'no-output', 'missing-body'] as const)(
    'resolves inherited same-name producers using participation before reading bodies (%s)', (later) => {
      const f = fixture();
      f.child.steps = [
        makeStep({ name: 'plan', outputContracts: [{ name: 'fix-plan.md', format: 'Plan' }] }),
        makeStep({ name: 'replan', outputContracts: [{ name: 'fix-plan.md', format: 'Replan' }] }),
        makeStep({ name: 'verify', outputContracts: [{ name: 'verification.md', format: 'Verification' }] }),
      ];
      f.consumer.inputReports = { fromStep: 'source', reports: ['fix-plan.md', 'verification.md'] };
      f.record(1, true, false);
      const prefix = [buildWorkflowResumePointEntry(f.parent, 'source', 'workflow_call', 1, undefined, 1)];
      const namespace = 'subworkflows/iteration-1--step-source--workflow-child';
      const directory = join(f.reportDir, namespace);
      mkdirSync(directory, { recursive: true });
      const writer = new ReportExecutionStore(f.reportDir);
      const inherited = [];
      for (const [step, report, body] of [
        ['plan', 'fix-plan.md', 'EARLIER-PLAN'],
        ['replan', 'fix-plan.md', 'LATER-PLAN'],
        ['verify', 'verification.md', 'VERIFIED'],
      ] as const) {
        if (step === 'replan' && later === 'unrun') continue;
        const identity = buildWorkflowStepParticipationIdentity(f.child.name, step, prefix);
        const recorded = step !== 'replan' || later !== 'no-output';
        f.sharedRuntime.workflowStepParticipationIndex!.record(f.child, step, prefix, recorded ? [report] : []);
        const id = writer.begin(identity, step, directory, [report]);
        if (recorded) writer.capture(directory, report, body);
        writer.finish(id, true);
        if (recorded) {
          inherited.push({ identity, savedIdentity: identity, reportName: report, reportPath: `${namespace}/${report}` });
          if (step === 'replan') rmSync(writer.current(identity, report)!.path);
        }
      }
      const restored = new ReportExecutionStore(f.reportDir);
      restored.restoreInheritedReports(inherited);
      f.sharedRuntime.reportExecutions = restored;
      writeFileSync(join(f.reportDir, 'fix-plan.md'), 'LOCAL-PLAN');
      const warning = vi.spyOn(DebugLogger.getInstance(), 'writeLog');
      try {
        const input = f.resolve()!;
        expect(input.declaredNames).toEqual(['fix-plan.md', 'verification.md']);
        expect(input.reports.find(({ reference }) => reference === 'verification.md')?.content).toBe('VERIFIED');
        const prepared = new InstructionBuilder(makeStep({ instruction: '{report:fix-plan.md}\n{report:verification.md}' }),
          makeInstructionContext({ reportDir: f.reportDir, declaredReportInputs: [input] })).prepare();
        expect(prepared.text).toContain('VERIFIED');
        expect(prepared.text).not.toContain('LOCAL-PLAN');
        if (later === 'unrun') expect(prepared.text).toContain('EARLIER-PLAN');
        else {
          expect(input.reports.map(({ reference }) => reference)).toEqual(['verification.md']);
          expect(prepared.text).toContain(formatMissingReportReference('fix-plan.md'));
          expect(prepared.text).not.toContain('EARLIER-PLAN');
          expect(prepared.text).not.toContain('LATER-PLAN');
          expect(warning.mock.calls.some(([level, , message, data]) => level === 'WARN'
            && message === 'Ignoring ambiguous inherited report input'
            && JSON.stringify(data).includes('fix-plan.md'))).toBe(true);
        }
      } finally { warning.mockRestore(); }
    },
  );

  it('keeps completed invocations isolated by their resume call path', () => {
    const f = fixture();
    const outer = workflow('outer', [{
      name: 'delegate', kind: 'workflow_call', call: 'parent', personaDisplayName: 'delegate', instruction: '',
    }]);
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
    const backend: NormalAgentWorkflowStep = {
      name: 'backend', personaDisplayName: 'tester', instruction: '', passPreviousResponse: false,
      outputContracts: [{ name: 'backend.md', format: '# Backend' }],
    };
    const security = {
      name: 'security', personaDisplayName: 'tester', instruction: '', passPreviousResponse: false,
      description: 'Security reviewer',
      outputContracts: [{ name: 'security.md', format: '# Security' }],
    };
    f.child.steps = [{
      name: 'reviewers', personaDisplayName: 'tester', instruction: '', passPreviousResponse: false,
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
    const input = f.resolve()!;
    expect.soft(input.declaredNames).toEqual(['backend.md']);
    writeFileSync(join(f.reportDir, 'security.md'), 'LOCAL-SECURITY');
    const prepared = new InstructionBuilder(makeStep({ instruction: '{report:backend.md}\n{report:security.md}' }),
      makeInstructionContext({ reportDir: f.reportDir, declaredReportInputs: [input] })).prepare();
    expect(prepared.injectedReports.find(({ reference }) => reference === 'backend.md')).toMatchObject({
      scope: 'declared-producer', content: 'backend findings',
    });
    expect.soft(prepared.injectedReports.find(({ reference }) => reference === 'security.md')).toMatchObject({
      scope: 'step', content: 'LOCAL-SECURITY',
    });
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
    f.child.steps = [{
      name: 'reviewers', personaDisplayName: 'tester', instruction: '', passPreviousResponse: false,
      parallel: [backend, testing],
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
    writeFileSync(join(namespace, 'testing.md'), 'stale unrelated file');

    expect(f.resolve).toThrow(/static_reviewer_missing:reviewers:testing/);
  });

  it('allows an optional source only before it has run', () => {
    const f = fixture();
    f.consumer.inputReports = { fromStep: 'source', reports: ['review.md'], optionalIfUnrun: true };
    expect(f.resolve()).toEqual({ declaredNames: ['review.md'], reports: [], unavailable: [{ producer: 'source', names: ['review.md'] }] });
    f.record(1, false);
    expect(f.resolve).toThrow(/not_completed/);
  });

  it('rejects an unrun mandatory all-reports source when the consumer runs', () => {
    const f = fixture();
    f.consumer.inputReports = { fromStep: 'source', reports: 'all' };
    expect(f.resolve).toThrow(/Report input from "source"/);
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
      expect(declared).toEqual({ declaredNames: ['review.md'], reports: [], unavailable: [{ producer: 'source', names: ['review.md'] }] });
      const prepared = new InstructionBuilder(
        makeStep({ instruction: '{report:review.md}\n{report:local-note.md}' }),
        makeInstructionContext({ reportDir: f.reportDir, declaredReportInputs: [declared!] }),
      ).prepare();
      expect(prepared.text).toContain(formatMissingReportReference('review.md'));
      expect(prepared.text).toMatch(/producer has not run|producer未実行/);
      expect(prepared.text).toContain('LOCAL-NOTE');
      expect(prepared.text).not.toContain('UNRELATED-REVIEW');
    },
  );
});

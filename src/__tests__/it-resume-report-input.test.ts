import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../agents/runner.js', () => ({ runAgent: vi.fn() }));
vi.mock('../core/workflow/phase-runner.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../core/workflow/phase-runner.js')>(),
  runReportPhase: vi.fn(),
  runStatusJudgmentPhase: vi.fn(),
}));
vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../shared/utils/index.js')>(),
  generateReportDir: vi.fn().mockReturnValue('test-report-dir'),
}));

import { runAgent } from '../agents/runner.js';
import { WorkflowEngine, type WorkflowEngineOptions } from '../core/workflow/index.js';
import type { WorkflowConfig, WorkflowResumePoint } from '../core/models/types.js';
import { runReportPhase, runStatusJudgmentPhase } from '../core/workflow/phase-runner.js';
import { ReportPhaseGenerationError } from '../core/workflow/report-phase-runner.js';
import { parseWorkflowResumePoint } from '../core/workflow/resume-point-codec.js';
import { createSharedRuntime } from '../core/workflow/engine/WorkflowEngineSetup.js';
import { formatMissingReportReference } from '../core/workflow/instruction/report-reference.js';
import { buildWorkflowRestartPointEntry, buildWorkflowResumePointEntry, getWorkflowReference } from '../core/workflow/workflow-reference.js';
import { buildWorkflowCallInvocationIdentity } from '../core/workflow/workflow-call-invocation-index.js';
import { buildWorkflowStepParticipationIdentity } from '../core/workflow/workflow-step-participation-index.js';
import { buildWorkflowCallNamespaceSegment } from '../core/workflow/workflow-call-namespace.js';
import { ReportExecutionStore } from '../core/workflow/report-execution-store.js';
import { inheritResumeReportSnapshot } from '../core/workflow/run/resume-report-snapshot.js';
import { DebugLogger } from '../shared/utils/debug.js';
import { normalizeWorkflowConfig } from '../infra/config/loaders/workflowParser.js';
import { attachWorkflowOpaqueRef } from '../shared/workflowConfigMetadata.js';
import { applyDefaultMocks, createTestTmpDir, makeResponse, makeStep, makeRule } from './engine-test-helpers.js';

describe('WorkflowEngine report inputs after report generation failure', () => {
  let tmpDir: string;
  let engines: WorkflowEngine[];

  beforeEach(() => {
    vi.resetAllMocks();
    applyDefaultMocks();
    tmpDir = createTestTmpDir();
    engines = [];
    vi.mocked(runStatusJudgmentPhase).mockResolvedValue({ label: 'done', method: 'auto_select' });
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      options?.onPromptResolved?.({ systemPrompt: persona ?? '', userInstruction: instruction });
      return makeResponse({ persona, content: 'done' });
    });
  });

  afterEach(() => {
    for (const engine of engines) engine.removeAllListeners();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads the preceding same-name report when resuming the failed report step', async () => {
    const reportName = 'review-resolution.md';
    const priorBody = 'PREVIOUS_ADJUDICATION_BODY';
    const config = normalizeWorkflowConfig({
      name: 'report-resume',
      initial_step: 'adjudication',
      max_steps: 10,
      steps: [
        {
          name: 'adjudication', persona: 'adjudicator', instruction: 'Write the adjudication',
          output_contracts: { report: [{ name: reportName, format: 'report' }] },
          rules: [{ condition: 'done', next: 'final-gate' }],
        },
        {
          name: 'final-gate', persona: 'supervisor', pass_previous_response: false,
          instruction: `Read prior review: {report:${reportName}}`,
          output_contracts: { report: [{ name: reportName, format: 'report' }] },
          rules: [{ condition: 'done', next: 'COMPLETE' }],
        },
      ],
      report_formats: { report: 'Write the review resolution' },
    }, tmpDir);
    const options: WorkflowEngineOptions = {
      projectCwd: tmpDir, provider: 'mock', reportDirName: 'test-report-dir',
    };
    let reportPath: string | undefined;
    vi.mocked(runReportPhase).mockImplementation(async (step, _iteration, context, onReportWritten) => {
      if (step.name === 'final-gate') {
        throw new ReportPhaseGenerationError('Report provider failed', 'provider_error', {
          requiresFreshPhase1: false, failureReasons: ['provider_error'],
        });
      }
      reportPath = join(context.reportDir, reportName);
      mkdirSync(context.reportDir, { recursive: true });
      writeFileSync(reportPath, priorBody);
      onReportWritten?.(reportName);
    });
    const source = new WorkflowEngine(config, tmpDir, 'Review the changes', options);
    engines.push(source);

    const stopped = await source.run();
    const checkpoint = parseWorkflowResumePoint(JSON.parse(JSON.stringify(source.getResumePoint())));

    expect(stopped.status).toBe('aborted');
    expect(checkpoint.stack.at(-1)).toMatchObject({ step: 'final-gate', kind: 'agent', occurrence: 1 });
    expect(Object.values(checkpoint.missing_report_generations ?? {}).flat()).toContain(reportName);
    expect(reportPath).toBeDefined();
    expect(readFileSync(reportPath!, 'utf-8')).toBe(priorBody);
    const originalPrompt = vi.mocked(runAgent).mock.calls.find(([, , callOptions]) => (
      callOptions?.executionPhase === 1 && callOptions.workflowMeta?.currentStep === 'final-gate'
    ));
    expect(originalPrompt?.[1]).toContain(`Read prior review: ${priorBody}`);

    vi.mocked(runAgent).mockClear();
    vi.mocked(runReportPhase).mockImplementation(async (_step, _iteration, context, onReportWritten) => {
      writeFileSync(join(context.reportDir, reportName), 'RESUMED_GATE_BODY');
      onReportWritten?.(reportName);
    });
    const resumed = new WorkflowEngine(config, tmpDir, 'Review the changes', {
      ...options,
      startStep: 'final-gate',
      resumePoint: checkpoint,
    });
    engines.push(resumed);

    const result = await resumed.run();
    const resumedPrompts = vi.mocked(runAgent).mock.calls.filter(([, , callOptions]) => (
      callOptions?.executionPhase === 1 && callOptions.workflowMeta?.currentStep === 'final-gate'
    ));

    expect(resumedPrompts).toHaveLength(1);
    expect(resumedPrompts[0]![1]).toContain(`Read prior review: ${priorBody}`);
    expect(resumedPrompts[0]![1]).not.toContain(formatMissingReportReference(reportName));
    expect(result.status).toBe('completed');
    expect(vi.mocked(runAgent).mock.calls.some(([, , callOptions]) => (
      callOptions?.workflowMeta?.currentStep === 'adjudication'
    ))).toBe(false);
  });

  it('reads the previous report body after the workflow reference changes', async () => {
    const reportName = 'review-resolution.md';
    const priorBody = 'PREVIOUS_BODY_AFTER_REF_CHANGE';
    const reportDir = join(tmpDir, '.takt', 'runs', 'test-report-dir', 'reports');
    writeFileSync(join(reportDir, reportName), priorBody);
    const baseConfig: WorkflowConfig = {
      name: 'resume-ref-change', initialStep: 'final-gate', maxSteps: 5,
      steps: [makeStep('final-gate', {
        passPreviousResponse: false,
        instruction: `Read prior review: {report:${reportName}}`,
        outputContracts: [{ name: reportName, format: 'Write a review' }],
        rules: [makeRule('done', 'COMPLETE')],
      })],
    };
    const savedWorkflow = attachWorkflowOpaqueRef({ ...baseConfig }, 'project:saved-ref');
    const currentWorkflow = attachWorkflowOpaqueRef({ ...baseConfig }, 'project:current-ref');
    const savedFrame = {
      workflow: savedWorkflow.name,
      workflow_ref: getWorkflowReference(savedWorkflow),
      step: 'final-gate',
      kind: 'agent' as const,
      occurrence: 1,
    };
    const resumePoint = parseWorkflowResumePoint({
      version: 2,
      stack: [savedFrame],
      iteration: 1,
      elapsed_ms: 0,
      workflow_call_invocations: {},
      workflow_step_participations: {},
      missing_report_generations: { '': [reportName] },
      report_input_recoveries: { [reportName]: [savedFrame] },
    });
    vi.mocked(runReportPhase).mockImplementation(async (_step, _iteration, context, onReportWritten) => {
      writeFileSync(join(context.reportDir, reportName), 'CURRENT_GATE_REVIEW');
      onReportWritten?.(reportName);
    });
    const engine = new WorkflowEngine(currentWorkflow, tmpDir, 'Review the changes', {
      projectCwd: tmpDir,
      provider: 'mock',
      reportDirName: 'test-report-dir',
      startStep: 'final-gate',
      resumePoint,
    });
    engines.push(engine);

    const state = await engine.run();
    const prompts = vi.mocked(runAgent).mock.calls.filter(([, , options]) => (
      options?.executionPhase === 1 && options.workflowMeta?.currentStep === 'final-gate'
    ));

    expect(prompts).toHaveLength(1);
    expect(prompts[0]![1]).toContain(`Read prior review: ${priorBody}`);
    expect(prompts[0]![1]).not.toContain(formatMissingReportReference(reportName));
    expect(state.status).toBe('completed');
  });

  it('keeps unrelated failed reports blocked when resuming a report consumer', async () => {
    const reportName = 'review-resolution.md';
    const otherName = 'other-review.md';
    const reportDir = join(tmpDir, '.takt', 'runs', 'test-report-dir', 'reports');
    writeFileSync(join(reportDir, reportName), 'PREVIOUS_ADJUDICATION_BODY');
    writeFileSync(join(reportDir, otherName), 'STALE_OTHER_REVIEW');
    const config: WorkflowConfig = {
      name: 'resume-report-isolation', initialStep: 'final-gate', maxSteps: 5,
      steps: [makeStep('final-gate', {
        passPreviousResponse: false,
        instruction: `Own review: {report:${reportName}}\nOther review: {report:${otherName}}`,
        outputContracts: [{ name: reportName, format: 'Write a review' }],
        rules: [makeRule('done', 'COMPLETE')],
      })],
    };
    const resumePoint = parseWorkflowResumePoint({
      version: 2,
      stack: [{
        workflow: config.name, workflow_ref: getWorkflowReference(config),
        step: 'final-gate', kind: 'agent', occurrence: 1,
      }],
      iteration: 1, elapsed_ms: 0,
      workflow_call_invocations: {}, workflow_step_participations: {},
      missing_report_generations: { '': [reportName, otherName] },
      report_input_recoveries: { [reportName]: [{
        workflow: config.name, workflow_ref: getWorkflowReference(config),
        step: 'final-gate', kind: 'agent', occurrence: 1,
      }] },
    });
    vi.mocked(runReportPhase).mockImplementation(async (_step, _iteration, context, onReportWritten) => {
      writeFileSync(join(context.reportDir, reportName), 'CURRENT_GATE_REVIEW');
      onReportWritten?.(reportName);
    });
    const engine = new WorkflowEngine(config, tmpDir, 'Review the changes', {
      projectCwd: tmpDir, provider: 'mock', reportDirName: 'test-report-dir',
      startStep: 'final-gate', resumePoint,
    });
    engines.push(engine);

    const state = await engine.run();
    const prompts = vi.mocked(runAgent).mock.calls.filter(([, , options]) => (
      options?.executionPhase === 1 && options.workflowMeta?.currentStep === 'final-gate'
    ));

    expect(prompts).toHaveLength(1);
    expect(prompts[0]![1]).toContain(`Other review: ${formatMissingReportReference(otherName)}`);
    expect(prompts[0]![1]).not.toContain('STALE_OTHER_REVIEW');
    expect(prompts[0]![1]).toContain('Own review: PREVIOUS_ADJUDICATION_BODY');
    expect(state.status).toBe('completed');
  });

  it('does not reuse the resume exception on a later occurrence of the same step', async () => {
    const reportName = 'review-resolution.md';
    const reportDir = join(tmpDir, '.takt', 'runs', 'test-report-dir', 'reports');
    writeFileSync(join(reportDir, reportName), 'PREVIOUS_ADJUDICATION_BODY');
    const config: WorkflowConfig = {
      name: 'resume-occurrence-isolation', initialStep: 'final-gate', maxSteps: 5,
      steps: [
        makeStep('final-gate', {
          passPreviousResponse: false,
          instruction: `Read prior review: {report:${reportName}}`,
          outputContracts: [{ name: reportName, format: 'Write a review' }],
          rules: [makeRule('finish', 'COMPLETE'), makeRule('continue', 'reviewers')],
        }),
        makeStep('reviewers', {
          parallel: [makeStep('review', {
            outputContracts: [{ name: reportName, format: 'Write a review' }],
            rules: [makeRule('done', 'COMPLETE')],
          })],
          rules: [makeRule('any("error")', 'final-gate')],
        }),
      ],
    };
    const resumePoint = parseWorkflowResumePoint({
      version: 2,
      stack: [{
        workflow: config.name, workflow_ref: getWorkflowReference(config),
        step: 'final-gate', kind: 'agent', occurrence: 1,
      }],
      iteration: 1, elapsed_ms: 0,
      workflow_call_invocations: {}, workflow_step_participations: {},
      missing_report_generations: { '': [reportName] },
      report_input_recoveries: { [reportName]: [{
        workflow: config.name, workflow_ref: getWorkflowReference(config),
        step: 'final-gate', kind: 'agent', occurrence: 1,
      }] },
    });
    let judgments = 0;
    vi.mocked(runStatusJudgmentPhase).mockImplementation(async () => ({
      label: judgments++ === 0 ? 'continue' : 'finish', method: 'auto_select',
    }));
    vi.mocked(runReportPhase).mockImplementation(async (step, _iteration, context, onReportWritten) => {
      if (step.name === 'review') {
        throw new ReportPhaseGenerationError('Review report failed', 'provider_error', {
          requiresFreshPhase1: false, failureReasons: ['provider_error'],
        });
      }
      writeFileSync(join(context.reportDir, reportName), 'CURRENT_GATE_REVIEW');
      onReportWritten?.(reportName);
    });
    const engine = new WorkflowEngine(config, tmpDir, 'Review the changes', {
      projectCwd: tmpDir, provider: 'mock', reportDirName: 'test-report-dir',
      startStep: 'final-gate', resumePoint,
    });
    engines.push(engine);

    const state = await engine.run();
    const prompts = vi.mocked(runAgent).mock.calls.filter(([, , options]) => (
      options?.executionPhase === 1 && options.workflowMeta?.currentStep === 'final-gate'
    ));

    expect(prompts).toHaveLength(2);
    expect(prompts[1]![1]).toContain(`Read prior review: ${formatMissingReportReference(reportName)}`);
    expect(prompts[1]![1]).not.toContain('CURRENT_GATE_REVIEW');
    expect(prompts[0]![1]).toContain('Read prior review: PREVIOUS_ADJUDICATION_BODY');
    expect(state.status).toBe('completed');
  });

  it.each([true, false])('restores report evidence in the resumed child with local report=%s', async (hasLocalReport) => {
    const reportName = 'review-resolution.md';
    const priorBody = 'PREVIOUS_CHILD_ADJUDICATION';
    const rootReports = join(tmpDir, '.takt', 'runs', 'test-report-dir', 'reports');
    writeFileSync(join(rootReports, reportName), 'STALE_ANCESTOR_REVIEW');
    const child = normalizeWorkflowConfig({
      name: 'child-report-resume', subworkflow: { callable: true },
      initial_step: 'adjudication', max_steps: 10,
      steps: [
        { name: 'adjudication', persona: 'adjudicator', instruction: 'Write the review',
          output_contracts: { report: [{ name: reportName, format: 'report' }] },
          rules: [{ condition: 'done', next: 'final-gate' }] },
        { name: 'final-gate', persona: 'supervisor', pass_previous_response: false,
          instruction: `Own review: {report:${reportName}}`,
          output_contracts: { report: [{ name: reportName, format: 'report' }] },
          rules: [{ condition: 'done', next: 'COMPLETE' }] },
      ],
      report_formats: { report: 'Write a review' },
    }, tmpDir);
    const parent = normalizeWorkflowConfig({
      name: 'parent-report-resume', initial_step: 'delegate', max_steps: 10,
      steps: [{ name: 'delegate', kind: 'workflow_call', call: 'child-report-resume',
        rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }, { condition: 'ABORT', next: 'ABORT' }] }],
    }, tmpDir);
    const options: WorkflowEngineOptions = {
      projectCwd: tmpDir, provider: 'mock', reportDirName: 'test-report-dir',
      workflowCallResolver: () => child,
    };
    const sourceRuntime = createSharedRuntime(undefined, 10);
    sourceRuntime.reportGenerationIndex!.record(rootReports, rootReports, reportName, false);
    let childReport: string | undefined;
    vi.mocked(runReportPhase).mockImplementation(async (step, _iteration, context, onReportWritten) => {
      if (step.name === 'final-gate') {
        throw new ReportPhaseGenerationError('Child report failed', 'provider_error', {
          requiresFreshPhase1: false, failureReasons: ['provider_error'],
        });
      }
      mkdirSync(context.reportDir, { recursive: true });
      childReport = join(context.reportDir, reportName);
      writeFileSync(childReport, priorBody);
      onReportWritten?.(reportName);
    });
    const source = new WorkflowEngine(parent, tmpDir, 'Review the changes', {
      ...options, sharedRuntime: sourceRuntime,
    });
    engines.push(source);
    expect((await source.run()).status).toBe('aborted');
    expect(childReport).toBeDefined();
    expect(readFileSync(childReport!, 'utf-8')).toBe(priorBody);
    // 親 getter の子フレームの保存方法とは分けて、実際の失敗記録の復元を検証する。
    const checkpoint = parseWorkflowResumePoint(JSON.parse(JSON.stringify({
      ...source.getResumePoint(),
      missing_report_generations: sourceRuntime.reportGenerationIndex!.serialized(),
      report_input_recoveries: sourceRuntime.reportGenerationIndex!.serializedInputRecoveries(),
    })));
    expect(checkpoint.stack.at(-1)).toMatchObject({ step: 'final-gate', kind: 'agent' });
    expect(Object.keys(checkpoint.missing_report_generations!)).toHaveLength(2);
    if (!hasLocalReport) rmSync(childReport!);
    vi.mocked(runAgent).mockClear();
    vi.mocked(runReportPhase).mockImplementation(async (_step, _iteration, context, onReportWritten) => {
      writeFileSync(join(context.reportDir, reportName), 'CURRENT_CHILD_GATE');
      onReportWritten?.(reportName);
    });
    const resumed = new WorkflowEngine(parent, tmpDir, 'Review the changes', {
      ...options, startStep: 'delegate', resumePoint: checkpoint,
    });
    engines.push(resumed);

    const state = await resumed.run();
    const prompts = vi.mocked(runAgent).mock.calls.filter(([, , callOptions]) => (
      callOptions?.executionPhase === 1 && callOptions.workflowMeta?.currentStep === 'final-gate'
    ));

    expect(prompts).toHaveLength(1);
    expect(prompts[0]![1]).toContain(`Own review: ${hasLocalReport ? priorBody : formatMissingReportReference(reportName)}`);
    expect(prompts[0]![1]).not.toContain('STALE_ANCESTOR_REVIEW');
    expect(state.status).toBe('completed');
    expect(resumed.getResumePoint()?.missing_report_generations).toEqual({ '': [reportName] });
  });

  it.each([true, false])('preserves report availability after a consumer Phase 1 stop with child generation=%s', async (childWritesReport) => {
    const reportName = 'review-resolution.md';
    const reportDir = join(tmpDir, '.takt', 'runs', 'test-report-dir', 'reports');
    writeFileSync(join(reportDir, reportName), 'STALE_PARALLEL_REVIEW');
    const config: WorkflowConfig = {
      name: 'parallel-consumer-resume', initialStep: 'reviewers', maxSteps: 5,
      steps: [
        makeStep('reviewers', {
          parallel: [makeStep('review', {
            outputContracts: [{ name: reportName, format: 'Write a review' }],
            rules: [makeRule('done', 'COMPLETE')],
          })],
          rules: [makeRule('all("done")', 'consume'), makeRule('any("error")', 'consume')],
        }),
        makeStep('consume', {
          passPreviousResponse: false,
          instruction: `Read prior review: {report:${reportName}}`,
          outputContracts: [{ name: reportName, format: 'Write a review' }],
          rules: [makeRule('done', 'COMPLETE')],
        }),
      ],
    };
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      options?.onPromptResolved?.({ systemPrompt: persona ?? '', userInstruction: instruction });
      return makeResponse({ persona, status: options?.workflowMeta?.currentStep === 'consume' ? 'error' : 'done' });
    });
    vi.mocked(runReportPhase).mockImplementation(async (_step, _iteration, context, onReportWritten) => {
      if (!childWritesReport) {
        throw new ReportPhaseGenerationError('Review report failed', 'provider_error', {
          requiresFreshPhase1: false, failureReasons: ['provider_error'],
        });
      }
      writeFileSync(join(context.reportDir, reportName), 'CURRENT_PARALLEL_REVIEW');
      onReportWritten?.(reportName);
    });
    const options: WorkflowEngineOptions = {
      projectCwd: tmpDir, provider: 'mock', reportDirName: 'test-report-dir',
    };
    const source = new WorkflowEngine(config, tmpDir, 'Review the changes', options);
    engines.push(source);
    const stopped = await source.run();
    const checkpoint = parseWorkflowResumePoint(JSON.parse(JSON.stringify(source.getResumePoint())));
    const initialPrompt = vi.mocked(runAgent).mock.calls.find(([, , callOptions]) => (
      callOptions?.executionPhase === 1 && callOptions.workflowMeta?.currentStep === 'consume'
    ));
    const expected = childWritesReport ? 'CURRENT_PARALLEL_REVIEW' : formatMissingReportReference(reportName);
    expect(stopped.status).toBe('aborted');
    expect(stopped.stepOutputs.get('review')?.status).toBe(childWritesReport ? 'done' : 'error');
    expect(checkpoint.stack.at(-1)).toMatchObject({ step: 'consume', kind: 'agent', occurrence: 1 });
    expect(Object.values(checkpoint.missing_report_generations ?? {}).flat().includes(reportName)).toBe(!childWritesReport);
    expect(initialPrompt?.[1]).toContain(`Read prior review: ${expected}`);
    expect(initialPrompt?.[1]).not.toContain('STALE_PARALLEL_REVIEW');
    vi.mocked(runAgent).mockClear();
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, callOptions) => {
      callOptions?.onPromptResolved?.({ systemPrompt: persona ?? '', userInstruction: instruction });
      return makeResponse({ persona, content: 'done' });
    });
    vi.mocked(runReportPhase).mockImplementation(async (_step, _iteration, context, onReportWritten) => {
      writeFileSync(join(context.reportDir, reportName), 'CURRENT_CONSUMER_REVIEW');
      onReportWritten?.(reportName);
    });
    const resumed = new WorkflowEngine(config, tmpDir, 'Review the changes', {
      ...options, startStep: 'consume', resumePoint: checkpoint,
    });
    engines.push(resumed);
    const resumedState = await resumed.run();
    expect(resumedState.status).toBe('completed');
    const resumedPrompts = vi.mocked(runAgent).mock.calls.filter(([, , callOptions]) => (
      callOptions?.executionPhase === 1 && callOptions.workflowMeta?.currentStep === 'consume'
    ));
    expect(resumedPrompts).toHaveLength(1);
    expect(resumedPrompts[0]![1]).toContain(`Read prior review: ${expected}`);
    expect(resumedPrompts[0]![1]).not.toContain('STALE_PARALLEL_REVIEW');
  });

  it.each([true, false])('recovers only valid input after the consumer report phase fails with input available=%s', async (inputAvailable) => {
    const reportName = 'review-resolution.md';
    const reports = join(tmpDir, '.takt', 'runs', 'test-report-dir', 'reports');
    writeFileSync(join(reports, reportName), 'PREVIOUS_CONSUMER_INPUT');
    const config: WorkflowConfig = {
      name: 'missing-input-report-failure', initialStep: 'consume', maxSteps: 5,
      steps: [makeStep('consume', {
        passPreviousResponse: false,
        instruction: `Read prior review: {report:${reportName}}`,
        outputContracts: [{ name: reportName, format: 'Write a review' }],
        rules: [makeRule('done', 'COMPLETE')],
      })],
    };
    const runtime = createSharedRuntime(undefined, 5);
    if (!inputAvailable) runtime.reportGenerationIndex!.record(reports, reports, reportName, false);
    vi.mocked(runReportPhase).mockRejectedValue(new ReportPhaseGenerationError(
      'Consumer report failed', 'provider_error', { requiresFreshPhase1: false, failureReasons: ['provider_error'] },
    ));
    const options: WorkflowEngineOptions = {
      projectCwd: tmpDir, provider: 'mock', reportDirName: 'test-report-dir',
    };
    const source = new WorkflowEngine(config, tmpDir, 'Review the changes', { ...options, sharedRuntime: runtime });
    engines.push(source);
    expect((await source.run()).status).toBe('aborted');
    const checkpoint = parseWorkflowResumePoint(JSON.parse(JSON.stringify(source.getResumePoint())));
    const initial = vi.mocked(runAgent).mock.calls.find(([, , callOptions]) => callOptions?.executionPhase === 1);
    const expected = inputAvailable ? 'PREVIOUS_CONSUMER_INPUT' : formatMissingReportReference(reportName);
    expect(initial?.[1]).toContain(`Read prior review: ${expected}`);
    if (!inputAvailable) expect(initial?.[1]).not.toContain('PREVIOUS_CONSUMER_INPUT');
    vi.mocked(runAgent).mockClear();
    vi.mocked(runReportPhase).mockImplementation(async (_step, _iteration, context, onReportWritten) => {
      writeFileSync(join(context.reportDir, reportName), 'CURRENT_CONSUMER_REVIEW');
      onReportWritten?.(reportName);
    });
    const resumed = new WorkflowEngine(config, tmpDir, 'Review the changes', {
      ...options, startStep: 'consume', resumePoint: checkpoint,
    });
    engines.push(resumed);
    expect((await resumed.run()).status).toBe('completed');
    const prompts = vi.mocked(runAgent).mock.calls.filter(([, , callOptions]) => callOptions?.executionPhase === 1);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]![1]).toContain(`Read prior review: ${expected}`);
    if (!inputAvailable) expect(prompts[0]![1]).not.toContain('PREVIOUS_CONSUMER_INPUT');
  });

  it('blocks the old report in the next step after a parallel parent advances on any error', async () => {
    const reportName = 'review-resolution.md';
    const staleBody = 'STALE_PARALLEL_REVIEW';
    const reportDir = join(tmpDir, '.takt', 'runs', 'test-report-dir', 'reports');
    writeFileSync(join(reportDir, reportName), staleBody);
    const config: WorkflowConfig = {
      name: 'parallel-report-failure', initialStep: 'reviewers', maxSteps: 5,
      steps: [
        makeStep('reviewers', {
          parallel: [makeStep('review', {
            outputContracts: [{ name: reportName, format: 'Write a review' }],
            rules: [makeRule('done', 'COMPLETE')],
          })],
          rules: [makeRule('all("done")', 'ABORT'), makeRule('any("error")', 'consume')],
        }),
        makeStep('consume', {
          passPreviousResponse: false,
          instruction: `Read prior review: {report:${reportName}}`,
          outputContracts: [{ name: reportName, format: 'Write a review' }],
          rules: [makeRule('done', 'COMPLETE')],
        }),
      ],
    };
    vi.mocked(runReportPhase).mockImplementation(async (step, _iteration, context, onReportWritten) => {
      if (step.name === 'review') {
        throw new ReportPhaseGenerationError('Review report failed', 'provider_error', {
          requiresFreshPhase1: false, failureReasons: ['provider_error'],
        });
      }
      writeFileSync(join(context.reportDir, reportName), 'CURRENT_CONSUMER_REVIEW');
      onReportWritten?.(reportName);
    });
    const engine = new WorkflowEngine(config, tmpDir, 'Review the changes', {
      projectCwd: tmpDir, provider: 'mock', reportDirName: 'test-report-dir',
    });
    engines.push(engine);

    const state = await engine.run();
    const consumerPrompts = vi.mocked(runAgent).mock.calls.filter(([, , options]) => (
      options?.executionPhase === 1 && options.workflowMeta?.currentStep === 'consume'
    ));

    expect(state.stepOutputs.get('review')?.status).toBe('error');
    expect(consumerPrompts).toHaveLength(1);
    expect(consumerPrompts[0]![1]).toContain(`Read prior review: ${formatMissingReportReference(reportName)}`);
    expect(consumerPrompts[0]![1]).not.toContain(staleBody);
    expect(state.status).toBe('completed');
  });
});

describe('WorkflowEngine inherited resume records', () => {
  let tmpDir: string;
  let engines: WorkflowEngine[];

  async function expectCompleted(engine: WorkflowEngine): Promise<void> {
    const state = await engine.run();
    expect(state.status, state.lastOutput?.content).toBe('completed');
  }

  beforeEach(() => {
    vi.resetAllMocks();
    applyDefaultMocks();
    tmpDir = createTestTmpDir();
    engines = [];
    vi.mocked(runStatusJudgmentPhase).mockResolvedValue({ label: 'done', method: 'auto_select' });
    vi.mocked(runReportPhase).mockImplementation(async (step, _iteration, context, onReportWritten) => {
      mkdirSync(context.reportDir, { recursive: true });
      for (const contract of step.outputContracts ?? []) {
        const body = contract.name === 'fix-plan.md' ? 'SAVED-PLAN'
          : contract.name === 'review-resolution.md' ? 'SAVED-RESOLUTION' : 'VERIFIED';
        writeFileSync(join(context.reportDir, contract.name), body);
        context.onReportPersisted?.(contract.name, body);
        onReportWritten?.(contract.name);
      }
    });
  });

  afterEach(() => {
    for (const engine of engines) engine.removeAllListeners();
    vi.restoreAllMocks();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function respond(stopAt?: string): void {
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      options?.onPromptResolved?.({ systemPrompt: persona ?? '', userInstruction: instruction });
      return makeResponse({ persona, status: options?.workflowMeta?.currentStep === stopAt ? 'error' : 'done' });
    });
  }

  function prompts(step: string): string[] {
    return vi.mocked(runAgent).mock.calls
      .filter(([, , options]) => options?.executionPhase === 1 && options.workflowMeta?.currentStep === step)
      .map(([, instruction]) => instruction);
  }

  function agentSteps(): string[] {
    return vi.mocked(runAgent).mock.calls
      .filter(([, , options]) => options?.executionPhase === 1)
      .map(([, , options]) => options!.workflowMeta!.currentStep);
  }

  async function stoppedFixture() {
    const fix = normalizeWorkflowConfig({
      name: 'development-remediation', subworkflow: { callable: true }, initial_step: 'fix-plan', max_steps: 20,
      steps: [
        { name: 'fix-plan', persona: 'planner', instruction: 'Plan the fix',
          output_contracts: { report: [{ name: 'fix-plan.md', format: 'Plan' }] },
          rules: [{ condition: 'done', next: 'fix-verifier' }] },
        { name: 'fix-verifier', persona: 'verifier', instruction: 'Verify the fix',
          output_contracts: { report: [{ name: 'verification.md', format: 'Verification' }] },
          rules: [{ condition: 'done', next: 'COMPLETE' }] },
      ],
    }, tmpDir);
    const peer = attachWorkflowOpaqueRef(normalizeWorkflowConfig({
      name: 'peer-review', subworkflow: { callable: true }, initial_step: 'review-adjudication', max_steps: 20,
      steps: [
        { name: 'review-adjudication', persona: 'adjudicator', pass_previous_response: false,
          instruction: 'Previous plan: {report:fix-plan.md}',
          input_reports: { from_step: 'remediation', reports: ['fix-plan.md'], optional_if_unrun: true },
          output_contracts: { report: [{ name: 'review-resolution.md', format: 'Resolution' }] },
          rules: [{ condition: 'done', next: 'remediation' }] },
        { name: 'remediation', kind: 'workflow_call', call: fix.name,
          input_reports: { from_step: 'review-adjudication', reports: ['review-resolution.md'] },
          rules: [{ condition: 'COMPLETE', next: 'reviewers' }, { condition: 'ABORT', next: 'ABORT' }] },
        { name: 'reviewers', persona: 'reviewer', pass_previous_response: false,
          instruction: 'Plan: {report:fix-plan.md}\nVerification: {report:verification.md}',
          input_reports: { from_step: 'remediation', reports: ['fix-plan.md', 'verification.md'] },
          rules: [{ condition: 'done', next: 'COMPLETE' }] },
      ],
    }, tmpDir), `builtin:v2:sha256:${'a'.repeat(64)}`);
    const root = normalizeWorkflowConfig({
      name: 'root-review', initial_step: 'delegate-a', max_steps: 20,
      steps: ['delegate-a', 'delegate-b'].map((name) => ({ name, kind: 'workflow_call', call: peer.name,
        rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }, { condition: 'ABORT', next: 'ABORT' }] })),
    }, tmpDir);
    const resolver: NonNullable<WorkflowEngineOptions['workflowCallResolver']> = ({ step }) =>
      step.call === peer.name ? peer : fix;
    respond('fix-verifier');
    const source = new WorkflowEngine(root, tmpDir, 'Review the changes', {
      projectCwd: tmpDir, provider: 'mock', reportDirName: 'test-report-dir', workflowCallResolver: resolver,
    });
    engines.push(source);
    const stopped = await source.run();
    expect(stopped.status).toBe('aborted');
    const point = parseWorkflowResumePoint(JSON.parse(JSON.stringify(source.getResumePoint())));
    expect(point.stack.map(({ step }) => step), JSON.stringify([...stopped.stepOutputs])).toEqual(['delegate-a', 'remediation', 'fix-verifier']);
    const sourceReports = join(tmpDir, '.takt', 'runs', 'test-report-dir', 'reports');
    const peerNamespace = point.workflow_call_invocations[buildWorkflowCallInvocationIdentity(
      getWorkflowReference(root), 'delegate-a', [],
    )]!.report_namespace_segment;
    const fixNamespace = point.workflow_call_invocations[buildWorkflowCallInvocationIdentity(
      getWorkflowReference(peer), 'remediation', point.stack.slice(0, 1),
    )]!.report_namespace_segment;
    const peerDirectory = join('subworkflows', peerNamespace);
    const fixDirectory = join(peerDirectory, 'subworkflows', fixNamespace);
    expect(readFileSync(join(sourceReports, fixDirectory, 'fix-plan.md'), 'utf8')).toBe('SAVED-PLAN');
    return { root, peer, fix, resolver, point, sourceReports, peerDirectory, fixDirectory };
  }

  function inherit(): string {
    inheritResumeReportSnapshot({ cwd: tmpDir, sourceRunSlug: 'test-report-dir', targetRunSlug: 'resumed-run' });
    vi.mocked(runAgent).mockClear();
    respond();
    return join(tmpDir, '.takt', 'runs', 'resumed-run', 'reports');
  }

  function resume(f: Awaited<ReturnType<typeof stoppedFixture>>, point: WorkflowResumePoint = f.point) {
    const engine = new WorkflowEngine(f.root, tmpDir, 'Review the changes', {
      projectCwd: tmpDir, provider: 'mock', reportDirName: 'resumed-run',
      startStep: point.stack[0]!.step, resumePoint: point,
      workflowCallResolver: ({ step }) => step.call === f.peer.name ? f.peer : f.fix,
    });
    engines.push(engine);
    return engine;
  }

  it('passes the saved adjudication report after only the peer workflow hash changes', async () => {
    const f = await stoppedFixture();
    f.peer = attachWorkflowOpaqueRef({ ...f.peer }, `builtin:v2:sha256:${'b'.repeat(64)}`);
    inherit();

    await expectCompleted(resume(f));
    expect(agentSteps()).toEqual(['fix-verifier', 'reviewers']);
    expect(prompts('fix-verifier')[0]).toContain('SAVED-RESOLUTION');
    expect(prompts('reviewers')[0]).toContain('SAVED-PLAN');
  });

  it.each([1, 2])('starts the saved verifier with namespace iteration %s and call instance 1', async (iteration) => {
    const f = await stoppedFixture();
    const identity = buildWorkflowCallInvocationIdentity(getWorkflowReference(f.peer), 'remediation', f.point.stack.slice(0, 1));
    f.point.workflow_call_invocations[identity]!.report_namespace_segment =
      f.point.workflow_call_invocations[identity]!.report_namespace_segment.replace('iteration-1--', `iteration-${iteration}--`);
    inherit();
    const warning = vi.spyOn(DebugLogger.getInstance(), 'writeLog');

    await expectCompleted(resume(f));
    expect(agentSteps()).toEqual(['fix-verifier', 'reviewers']);
    expect(prompts('reviewers')[0]).toContain('VERIFIED');
    if (iteration === 1) expect(prompts('reviewers')[0]).toContain('SAVED-PLAN');
    else {
      expect(prompts('reviewers')[0]).not.toContain('SAVED-PLAN');
      expect(warning.mock.calls.some(([level, , , data]) => level === 'WARN'
        && JSON.stringify(data).includes('remediation'))).toBe(true);
    }
  });

  it.each([true, false])('uses only recorded inherited plan output after parent completion (recorded=%s)', async (recorded) => {
    const f = await stoppedFixture();
    const identity = buildWorkflowStepParticipationIdentity(getWorkflowReference(f.fix), 'fix-plan', f.point.stack.slice(0, 2));
    const directory = join(f.sourceReports, f.fixDirectory);
    const writer = new ReportExecutionStore(f.sourceReports);
    const id = writer.begin(identity, 'fix-plan', directory, ['fix-plan.md']);
    if (recorded) writer.capture(directory, 'fix-plan.md', 'SAVED-PLAN');
    writer.finish(id, true);
    writeFileSync(join(directory, 'fix-plan.md'), 'OLD-PLAN');
    inherit();
    const warning = vi.spyOn(DebugLogger.getInstance(), 'writeLog');

    await expectCompleted(resume(f));
    expect(agentSteps()).toEqual(['fix-verifier', 'reviewers']);
    const input = prompts('reviewers')[0]!;
    expect(input).toContain('VERIFIED');
    expect(input).not.toContain('OLD-PLAN');
    if (recorded) expect(input).toContain('SAVED-PLAN');
    else {
      expect(input).not.toContain('SAVED-PLAN');
      expect(warning.mock.calls.some(([level, , , data]) => level === 'WARN'
        && JSON.stringify(data).includes('fix-plan.md'))).toBe(true);
    }
  });

  it.each([false, true])('handles inherited summaries from sequential call sites with duplicates=%s', async (duplicates) => {
    const leaf = (name: string, produces: boolean) => normalizeWorkflowConfig({
      name, subworkflow: { callable: true }, initial_step: 'summarize', max_steps: 5,
      steps: [{ name: 'summarize', persona: 'reviewer', instruction: 'Summarize',
        ...(produces ? { output_contracts: { report: [{ name: 'summary.md', format: 'Summary' }] } } : {}),
        rules: [{ condition: 'done', next: 'COMPLETE' }] }],
    }, tmpDir);
    const leaves = [leaf('leaf-a', true), leaf('leaf-b', duplicates)];
    const aggregate = normalizeWorkflowConfig({
      name: 'aggregate', subworkflow: { callable: true }, initial_step: 'delegate-a', max_steps: 10,
      steps: [
        { name: 'delegate-a', kind: 'workflow_call', call: 'leaf-a', rules: [{ condition: 'COMPLETE', next: 'delegate-b' }] },
        { name: 'delegate-b', kind: 'workflow_call', call: 'leaf-b', rules: [{ condition: 'COMPLETE', next: 'verify' }] },
        { name: 'verify', persona: 'verifier', instruction: 'Verify',
          output_contracts: { report: [{ name: 'verification.md', format: 'Verification' }] },
          rules: [{ condition: 'done', next: 'COMPLETE' }] },
      ],
    }, tmpDir);
    const root = normalizeWorkflowConfig({
      name: 'root-summary', initial_step: 'aggregate', max_steps: 10,
      steps: [
        { name: 'aggregate', kind: 'workflow_call', call: aggregate.name, rules: [{ condition: 'COMPLETE', next: 'consumer' }] },
        { name: 'consumer', persona: 'reviewer', instruction: 'Stop before aggregation', pass_previous_response: false,
          rules: [{ condition: 'done', next: 'COMPLETE' }] },
      ],
    }, tmpDir);
    const configs = [aggregate, ...leaves];
    const resolver: NonNullable<WorkflowEngineOptions['workflowCallResolver']> = ({ step }) =>
      configs.find(({ name }) => name === step.call) ?? null;
    vi.mocked(runReportPhase).mockImplementation(async (step, _iteration, context, written) => {
      mkdirSync(context.reportDir, { recursive: true });
      for (const contract of step.outputContracts ?? []) {
        const body = contract.name !== 'summary.md' ? 'VERIFIED'
          : context.reportDir.includes('--step-delegate-a--') ? duplicates ? 'A-SUMMARY' : 'ONE-SUMMARY' : 'B-SUMMARY';
        writeFileSync(join(context.reportDir, contract.name), body);
        context.onReportPersisted?.(contract.name, body);
        written?.(contract.name);
      }
    });
    respond('consumer');
    const source = new WorkflowEngine(root, tmpDir, 'Aggregate', {
      projectCwd: tmpDir, provider: 'mock', reportDirName: 'test-report-dir', workflowCallResolver: resolver,
    });
    engines.push(source);
    expect((await source.run()).status).toBe('aborted');
    const point = parseWorkflowResumePoint(JSON.parse(JSON.stringify(source.getResumePoint())));
    expect(point.stack.map(({ step }) => step)).toEqual(['consumer']);
    root.steps[1]!.inputReports = { fromStep: 'aggregate', reports: ['summary.md', 'verification.md'] };
    root.steps[1]!.instruction = 'Summary: {report:summary.md}\nVerification: {report:verification.md}';
    const reports = inherit();
    writeFileSync(join(reports, 'summary.md'), 'LOCAL-SUMMARY');
    const warning = vi.spyOn(DebugLogger.getInstance(), 'writeLog');
    const resumed = new WorkflowEngine(root, tmpDir, 'Aggregate', {
      projectCwd: tmpDir, provider: 'mock', reportDirName: 'resumed-run', resumePoint: point,
      startStep: 'consumer', workflowCallResolver: resolver,
    });
    engines.push(resumed);

    await expectCompleted(resumed);
    expect(agentSteps()).toEqual(['consumer']);
    const input = prompts('consumer')[0]!;
    expect(input).toContain('VERIFIED');
    expect(input).not.toContain('LOCAL-SUMMARY');
    if (!duplicates) expect(input).toContain('ONE-SUMMARY');
    else {
      expect(input).not.toContain('A-SUMMARY');
      expect(input).not.toContain('B-SUMMARY');
      expect(warning.mock.calls.some(([level, , , data]) => level === 'WARN'
        && JSON.stringify(data).includes('summary.md'))).toBe(true);
    }
  });

  it.each(['unrun', 'no-output', 'missing-body'] as const)(
    'keeps participation ambiguity after snapshot transfer when the later producer is %s', async (later) => {
      const child = normalizeWorkflowConfig({
        name: 'same-name-producers', subworkflow: { callable: true }, initial_step: 'plan', max_steps: 10,
        steps: [
          { name: 'plan', persona: 'planner', instruction: 'Plan',
            output_contracts: { report: [{ name: 'fix-plan.md', format: 'Plan' }] },
            rules: [{ condition: 'done', next: later === 'unrun' ? 'verify' : 'replan' }] },
          { name: 'replan', persona: 'planner', instruction: 'Replan',
            output_contracts: { report: [{ name: 'fix-plan.md', format: 'Replan' }] },
            rules: [{ condition: 'done', next: 'verify' }] },
          { name: 'verify', persona: 'verifier', instruction: 'Verify',
            output_contracts: { report: [{ name: 'verification.md', format: 'Verification' }] },
            rules: [{ condition: 'done', next: 'COMPLETE' }] },
        ],
      }, tmpDir);
      const root = normalizeWorkflowConfig({
        name: 'partial-output-resume', initial_step: 'source', max_steps: 10,
        steps: [
          { name: 'source', kind: 'workflow_call', call: child.name,
            rules: [{ condition: 'COMPLETE', next: 'consumer' }] },
          { name: 'consumer', persona: 'reviewer', instruction: 'Stop before consuming', pass_previous_response: false,
            rules: [{ condition: 'done', next: 'COMPLETE' }] },
        ],
      }, tmpDir);
      const resolver: NonNullable<WorkflowEngineOptions['workflowCallResolver']> = () => child;
      vi.mocked(runReportPhase).mockImplementation(async (step, _iteration, context, written) => {
        const name = step.name === 'verify' ? 'verification.md' : 'fix-plan.md';
        const body = step.name === 'verify' ? 'VERIFIED' : step.name === 'plan' ? 'EARLIER-PLAN' : 'LATER-PLAN';
        mkdirSync(context.reportDir, { recursive: true });
        writeFileSync(join(context.reportDir, name), body);
        context.onReportPersisted?.(name, body);
        written?.(name);
      });
      respond('consumer');
      const source = new WorkflowEngine(root, tmpDir, 'Review', {
        projectCwd: tmpDir, provider: 'mock', reportDirName: 'test-report-dir', workflowCallResolver: resolver,
      });
      engines.push(source);
      expect((await source.run()).status).toBe('aborted');
      const point = parseWorkflowResumePoint(JSON.parse(JSON.stringify(source.getResumePoint())));
      expect(point.stack.map(({ step }) => step)).toEqual(['consumer']);
      const prefix = [buildWorkflowResumePointEntry(root, 'source', 'workflow_call', 1, undefined, 1)];
      const namespace = point.workflow_call_invocations[buildWorkflowCallInvocationIdentity(
        getWorkflowReference(root), 'source', [],
      )]!.report_namespace_segment;
      const reports = join(tmpDir, '.takt', 'runs', 'test-report-dir', 'reports');
      const directory = join(reports, 'subworkflows', namespace);
      if (later !== 'unrun') {
        const identity = buildWorkflowStepParticipationIdentity(getWorkflowReference(child), 'replan', prefix);
        const writer = new ReportExecutionStore(reports);
        if (later === 'no-output') {
          point.workflow_step_participations[identity] = { report_names: [] };
          const id = writer.begin(identity, 'replan', directory, ['fix-plan.md']);
          writer.finish(id, true);
        } else rmSync(writer.current(identity, 'fix-plan.md')!.path);
        rmSync(join(directory, 'fix-plan.md'));
      }
      root.steps[1]!.inputReports = { fromStep: 'source', reports: ['fix-plan.md', 'verification.md'] };
      root.steps[1]!.instruction = 'Plan: {report:fix-plan.md}\nVerification: {report:verification.md}';
      const inherited = inherit();
      writeFileSync(join(inherited, 'fix-plan.md'), 'LOCAL-PLAN');
      const warning = vi.spyOn(DebugLogger.getInstance(), 'writeLog');
      const resumed = new WorkflowEngine(root, tmpDir, 'Review', {
        projectCwd: tmpDir, provider: 'mock', reportDirName: 'resumed-run', resumePoint: point,
        startStep: 'consumer', workflowCallResolver: resolver,
      });
      engines.push(resumed);

      await expectCompleted(resumed);
      expect(agentSteps()).toEqual(['consumer']);
      const input = prompts('consumer')[0]!;
      expect(input).toContain('VERIFIED');
      expect(input).not.toContain('LOCAL-PLAN');
      if (later === 'unrun') expect(input).toContain('EARLIER-PLAN');
      else {
        expect(input).toContain(formatMissingReportReference('fix-plan.md'));
        expect(input).not.toContain('EARLIER-PLAN');
        expect(input).not.toContain('LATER-PLAN');
        expect(warning.mock.calls.some(([level, , message, data]) => level === 'WARN'
          && message === 'Ignoring ambiguous inherited report input'
          && JSON.stringify(data).includes('fix-plan.md'))).toBe(true);
      }
    },
  );

  it('omits an inherited pending call when restarting adjudication with optional input', async () => {
    const f = await stoppedFixture();
    const point = parseWorkflowResumePoint({ ...f.point, stack: [f.point.stack[0],
      buildWorkflowResumePointEntry(f.peer, 'review-adjudication', 'agent', 1,
        new Map([['review-adjudication', 1], ['remediation', 1]]))] });
    inherit();
    const writeLog = vi.spyOn(DebugLogger.getInstance(), 'writeLog');

    await expectCompleted(resume(f, point));
    expect(agentSteps()[0]).toBe('review-adjudication');
    expect(prompts('review-adjudication')).toHaveLength(1);
    expect(prompts('review-adjudication')[0]).not.toContain('SAVED-PLAN');
    expect(writeLog.mock.calls.filter(([level, , message]) => level === 'WARN'
      && !message.startsWith('Saved workflow results are unavailable')).some((call) =>
      /remediation|fix-plan/.test(JSON.stringify(call)))).toBe(true);
  });

  it('warns and starts remediation when inherited participation names do not match', async () => {
    const f = await stoppedFixture();
    const identity = buildWorkflowStepParticipationIdentity(getWorkflowReference(f.peer), 'review-adjudication', f.point.stack.slice(0, 1));
    const record = f.point.workflow_step_participations[identity]!;
    delete f.point.workflow_step_participations[identity];
    f.point.workflow_step_participations[buildWorkflowStepParticipationIdentity(
      getWorkflowReference(f.peer), 'removed-adjudication', f.point.stack.slice(0, 1),
    )] = record;
    inherit();
    const writeLog = vi.spyOn(DebugLogger.getInstance(), 'writeLog');

    await expectCompleted(resume(f));
    expect(agentSteps()[0]).toBe('fix-verifier');
    expect(prompts('fix-verifier')[0]).not.toContain('SAVED-RESOLUTION');
    expect(writeLog.mock.calls.filter(([level, , message]) => level === 'WARN'
      && !message.startsWith('Saved workflow results are unavailable')).some((call) =>
      /adjudication|participation/.test(JSON.stringify(call)))).toBe(true);
  });

  it.each(['missing', 'different-instance'] as const)(
    'keeps the saved start position with a %s inherited outer invocation', async (record) => {
      const f = await stoppedFixture();
      const identity = buildWorkflowCallInvocationIdentity(getWorkflowReference(f.root), 'delegate-a', []);
      if (record === 'missing') delete f.point.workflow_call_invocations[identity];
      else f.point.workflow_call_invocations[identity] = {
        call_instance: 2, report_namespace_segment: buildWorkflowCallNamespaceSegment('delegate-a', f.peer.name, 2),
      };
      inherit();
      const writeLog = vi.spyOn(DebugLogger.getInstance(), 'writeLog');

      await expectCompleted(resume(f));
      expect(agentSteps()).toEqual(['fix-verifier', 'reviewers']);
      expect(writeLog.mock.calls.filter(([level, , message]) => level === 'WARN'
        && !message.startsWith('Saved workflow results are unavailable')).some((call) =>
        /delegate-a|invocation/.test(JSON.stringify(call)))).toBe(true);
    },
  );

  it('drops conflicting inherited participation records instead of selecting either report', async () => {
    const f = await stoppedFixture();
    const currentRef = `builtin:v2:sha256:${'b'.repeat(64)}`;
    f.peer = attachWorkflowOpaqueRef({ ...f.peer }, currentRef);
    const prefix = f.point.stack.slice(0, 1);
    const oldIdentity = buildWorkflowStepParticipationIdentity(f.point.stack[1]!.workflow_ref, 'review-adjudication', prefix);
    f.point.workflow_step_participations[oldIdentity] = { report_names: ['a.md'] };
    f.point.workflow_step_participations[buildWorkflowStepParticipationIdentity(currentRef, 'review-adjudication', prefix)] = { report_names: ['b.md'] };
    f.peer.steps[0]!.outputContracts = [{ name: 'a.md', format: 'A' }, { name: 'b.md', format: 'B' }];
    f.peer.steps[1]!.inputReports = { fromStep: 'review-adjudication', reports: ['a.md', 'b.md'] };
    writeFileSync(join(f.sourceReports, f.peerDirectory, 'a.md'), 'CONFLICT-A');
    writeFileSync(join(f.sourceReports, f.peerDirectory, 'b.md'), 'CONFLICT-B');
    inherit();
    const writeLog = vi.spyOn(DebugLogger.getInstance(), 'writeLog');

    await expectCompleted(resume(f));
    const input = prompts('fix-verifier')[0]!;
    expect(input).not.toContain('CONFLICT-A');
    expect(input).not.toContain('CONFLICT-B');
    expect(agentSteps()[0]).toBe('fix-verifier');
    expect(writeLog.mock.calls.filter(([level, , message]) => level === 'WARN'
      && !message.startsWith('Saved workflow results are unavailable')).some((call) =>
      /adjudication|conflict/.test(JSON.stringify(call)))).toBe(true);
  });

  it('does not inherit participation from an earlier occurrence of the same outer call', async () => {
    const f = await stoppedFixture();
    // レポートと参加記録は1回目のまま、保存位置と呼び出し記録だけ2回目に進める。
    const outer = f.point.stack[0]!;
    f.point.stack[0] = { ...outer, occurrence: 2, call_instance: 2, step_iterations: { 'delegate-a': 2 } };
    const outerIdentity = buildWorkflowCallInvocationIdentity(getWorkflowReference(f.root), 'delegate-a', []);
    f.point.workflow_call_invocations[outerIdentity] = {
      call_instance: 2, report_namespace_segment: buildWorkflowCallNamespaceSegment('delegate-a', f.peer.name, 2),
    };
    const innerIdentity = buildWorkflowCallInvocationIdentity(getWorkflowReference(f.peer), 'remediation', [outer]);
    const inner = f.point.workflow_call_invocations[innerIdentity]!;
    delete f.point.workflow_call_invocations[innerIdentity];
    f.point.workflow_call_invocations[buildWorkflowCallInvocationIdentity(
      getWorkflowReference(f.peer), 'remediation', f.point.stack.slice(0, 1),
    )] = inner;
    inherit();
    const writeLog = vi.spyOn(DebugLogger.getInstance(), 'writeLog');

    await expectCompleted(resume(f));
    expect(agentSteps()[0]).toBe('fix-verifier');
    expect(prompts('fix-verifier')[0]).not.toContain('SAVED-RESOLUTION');
    expect(prompts('reviewers')[0]).not.toContain('SAVED-PLAN');
    expect(writeLog.mock.calls.filter(([level, , message]) => level === 'WARN'
      && !message.startsWith('Saved workflow results are unavailable')).some((call) =>
      /record|participation|report|invocation/.test(JSON.stringify(call)))).toBe(true);
  });

  it('keeps reports from another outer call out of the selected call input', async () => {
    const f = await stoppedFixture();
    const other = buildWorkflowResumePointEntry(f.root, 'delegate-b', 'workflow_call', 1, undefined, 1);
    const namespace = buildWorkflowCallNamespaceSegment('delegate-b', f.peer.name, 1);
    f.point.workflow_call_invocations[buildWorkflowCallInvocationIdentity(getWorkflowReference(f.root), 'delegate-b', [])] = {
      call_instance: 1, report_namespace_segment: namespace, completed: true,
    };
    f.point.workflow_step_participations[buildWorkflowStepParticipationIdentity(
      getWorkflowReference(f.peer), 'review-adjudication', [other],
    )] = { report_names: ['review-resolution.md'] };
    const directory = join(f.sourceReports, 'subworkflows', namespace);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'review-resolution.md'), 'OTHER-RESOLUTION');
    f.peer = attachWorkflowOpaqueRef({ ...f.peer }, `builtin:v2:sha256:${'b'.repeat(64)}`);
    inherit();

    await expectCompleted(resume(f));
    expect(agentSteps()).toEqual(['fix-verifier', 'reviewers']);
    expect(prompts('fix-verifier')[0]).toContain('SAVED-RESOLUTION');
    expect(prompts('fix-verifier')[0]).not.toContain('OTHER-RESOLUTION');
  });

  it.each([
    { start: 'saved', body: 'public' },
    { start: 'saved', body: 'fixed' },
    { start: 'selected', body: 'public' },
    { start: 'selected', body: 'fixed' },
  ] as const)('passes the inherited plan after parent completion with $start start and $body body', async ({ start, body }) => {
    const f = await stoppedFixture();
    const reports = inherit();
    const runtime = createSharedRuntime(f.point, 20);
    const store = new ReportExecutionStore(reports);
    runtime.reportExecutions = store;
    const planIdentity = buildWorkflowStepParticipationIdentity(getWorkflowReference(f.fix), 'fix-plan', f.point.stack.slice(0, 2));
    const pinned = store.executions(planIdentity).at(-1)!.reports['fix-plan.md']!;
    if (body === 'fixed') rmSync(join(reports, f.fixDirectory, 'fix-plan.md'));
    else rmSync(join(reports, pinned));
    const parentIdentity = buildWorkflowStepParticipationIdentity(getWorkflowReference(f.peer), 'remediation', f.point.stack.slice(0, 1));
    const startOptions: Partial<WorkflowEngineOptions> = start === 'saved'
      ? { resumePoint: f.point, startStep: 'delegate-a' }
      : { sourceResumePoint: f.point, restartPoint: { stack: [
        buildWorkflowRestartPointEntry(f.root, 'delegate-a', 'workflow_call', 1),
        buildWorkflowRestartPointEntry(f.peer, 'remediation', 'workflow_call', 1),
        buildWorkflowRestartPointEntry(f.fix, 'fix-verifier', 'agent'),
      ] } };
    const engine = new WorkflowEngine(f.root, tmpDir, 'Review the changes', {
      projectCwd: tmpDir, provider: 'mock', reportDirName: 'resumed-run', workflowCallResolver: f.resolver,
      sharedRuntime: runtime, ...startOptions,
    });
    engines.push(engine);

    await expectCompleted(engine);
    expect(agentSteps()).toEqual(['fix-verifier', 'reviewers']);
    expect(prompts('reviewers')).toHaveLength(1);
    expect(prompts('reviewers')[0]).toContain('SAVED-PLAN');
    expect(prompts('reviewers')[0]).toContain('VERIFIED');
    expect(store.executions(parentIdentity).at(-1)?.completed).toBe(true);
  });

  it('warns and omits a missing inherited body while preserving other declared inputs', async () => {
    const f = await stoppedFixture();
    const reports = inherit();
    rmSync(join(reports, f.fixDirectory, 'fix-plan.md'));
    const store = new ReportExecutionStore(reports);
    const identity = buildWorkflowStepParticipationIdentity(getWorkflowReference(f.fix), 'fix-plan', f.point.stack.slice(0, 2));
    rmSync(join(reports, store.executions(identity).at(-1)!.reports['fix-plan.md']!));
    writeFileSync(join(reports, 'fix-plan.md'), 'OTHER-PLAN');
    const unrelated = store.begin('unrelated-producer', 'fix-plan', reports, ['fix-plan.md']);
    store.capture(reports, 'fix-plan.md', 'OTHER-VERSION-PLAN');
    store.finish(unrelated, true);
    const writeLog = vi.spyOn(DebugLogger.getInstance(), 'writeLog');

    await expectCompleted(resume(f));
    expect(agentSteps()).toEqual(['fix-verifier', 'reviewers']);
    const input = prompts('reviewers')[0]!;
    expect(input).toContain('VERIFIED');
    expect(input).not.toContain('SAVED-PLAN');
    expect(input).not.toContain('OTHER-PLAN');
    expect(input).not.toContain('OTHER-VERSION-PLAN');
    expect(writeLog.mock.calls.filter(([level, , message]) => level === 'WARN'
      && !message.startsWith('Saved workflow results are unavailable')).some((call) =>
      /fix-plan/.test(JSON.stringify(call)))).toBe(true);
  });

  it('rejects a newly rerun producer missing its report instead of reusing the inherited plan', async () => {
    const f = await stoppedFixture();
    inherit();
    const writeReports = vi.mocked(runReportPhase).getMockImplementation()!;
    vi.mocked(runReportPhase).mockImplementation(async (...args) => {
      if (args[0].name !== 'fix-plan') await writeReports(...args);
    });
    const engine = new WorkflowEngine(f.root, tmpDir, 'Review the changes', {
      projectCwd: tmpDir, provider: 'mock', reportDirName: 'resumed-run', workflowCallResolver: f.resolver,
      sourceResumePoint: f.point, restartPoint: { stack: [
        buildWorkflowRestartPointEntry(f.root, 'delegate-a', 'workflow_call', 1),
        buildWorkflowRestartPointEntry(f.peer, 'remediation', 'workflow_call', 1),
        buildWorkflowRestartPointEntry(f.fix, 'fix-plan', 'agent'),
      ] },
    });
    engines.push(engine);

    const state = await engine.run();
    expect(state.status).toBe('aborted');
    expect(state.lastOutput?.content).toContain('workflow_report_input_not_produced:fix-plan:fix-plan.md');
    expect(agentSteps()).toContain('fix-plan');
    expect(prompts('reviewers')).toHaveLength(0);
  });
});

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
import type { WorkflowConfig } from '../core/models/types.js';
import { runReportPhase, runStatusJudgmentPhase } from '../core/workflow/phase-runner.js';
import { ReportPhaseGenerationError } from '../core/workflow/report-phase-runner.js';
import { parseWorkflowResumePoint } from '../core/workflow/resume-point-codec.js';
import { createSharedRuntime } from '../core/workflow/engine/WorkflowEngineSetup.js';
import { formatMissingReportReference } from '../core/workflow/instruction/report-reference.js';
import { getWorkflowReference } from '../core/workflow/workflow-reference.js';
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

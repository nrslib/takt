import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowConfig, WorkflowResumePoint } from '../core/models/types.js';
import type { WorkflowEngineOptions } from '../core/workflow/types.js';
import { WorkflowEngine } from '../core/workflow/index.js';
import { createInitialState } from '../core/workflow/engine/state-manager.js';
import { inheritWorkflowResults, WorkflowResultsStore } from '../core/workflow/run/workflow-results.js';
import { normalizeWorkflowConfig } from '../infra/config/loaders/workflowParser.js';
import { loadWorkflowByIdentifier } from '../infra/config/loaders/workflowResolver.js';
import { buildWorkflowRestartPointEntry, buildWorkflowResumePointEntry } from '../core/workflow/workflow-reference.js';
import type { SystemStepServices } from '../core/workflow/system/system-step-services.js';
import { runAgent } from '../agents/runner.js';
import { attachWorkflowOpaqueRef, buildBuiltinWorkflowRef } from '../shared/workflowConfigMetadata.js';
import { LogManager } from '../shared/ui/LogManager.js';
import * as atomicFile from '../shared/utils/atomic-file.js';
import { ReportExecutionStore } from '../core/workflow/report-execution-store.js';
import { buildWorkflowCallNamespaceSegment } from '../core/workflow/workflow-call-namespace.js';

vi.mock('../agents/runner.js', () => ({ runAgent: vi.fn() }));
vi.mock('node:fs', async (importOriginal) => ({ ...await importOriginal<typeof import('node:fs')>() }));

describe('workflow results across resume', () => {
  let project: string;
  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'takt-resume-results-'));
    vi.mocked(runAgent).mockReset().mockImplementation(async (persona, instruction, options) => {
      options.onPromptResolved?.({ systemPrompt: '', userInstruction: instruction });
      return {
        persona: persona ?? 'analyze', status: 'done', content: 'done', timestamp: new Date(),
        structuredOutput: { verdict: 'approved' },
      };
    });
  });
  afterEach(() => rmSync(project, { recursive: true, force: true }));

  function createEngine(config: WorkflowConfig, options: Partial<WorkflowEngineOptions>) {
    return new WorkflowEngine(config, project, 'Resume workflow', {
      projectCwd: project, provider: 'mock', reportDirName: 'original', ...options,
    });
  }

  it.each([
    ['start_step', false, 'retry'], ['resume_point', false, 'retry'],
    ['start_step', true, 'retry'], ['resume_point', true, 'retry'],
    ['start_step', false, 'instruct'],
  ] as const)('%s restores all results without replay (reference changed: %s, operation: %s)', async (mode, referenceChanged, resumeMode) => {
    let number = 100;
    const resolveSystemInput = vi.fn(() => ({ number }));
    const executeEffect = vi.fn<SystemStepServices['executeEffect']>(async (effect) => effect.type === 'caccia'
      ? { headSha: 'original-head' } : { success: true });
    const systemStepServicesFactory = () => ({ resolveSystemInput, executeEffect });
    const config = normalizeWorkflowConfig({
      name: 'resume-results', initial_step: 'read', max_steps: 10,
      steps: [
        { name: 'read', mode: 'system',
          system_inputs: [{ type: 'pr_status', source: 'current_pr', as: 'pr' }],
          rules: [{ condition: 'when(true)', next: 'write' }] },
        { name: 'write', mode: 'system', effects: [{ type: 'caccia', pr: '{context:read.pr.number}' }],
          rules: [{ condition: 'when(true)', next: 'analyze' }] },
        { name: 'analyze', instruction: 'Analyze',
          rules: [{ condition: 'when(true)', next: 'consume' }] },
        { name: 'consume', mode: 'system',
          effects: [{ type: 'comment_pr', pr: '{context:read.pr.number}',
            body: 'head={effect:write.caccia.headSha}: {structured:analyze.verdict}' }],
          rules: [{ condition: 'when(true)', next: 'COMPLETE' }] },
      ],
    }, project);
    const analyze = config.steps.find((step) => step.name === 'analyze')!;
    if (analyze.kind !== 'agent') throw new Error('Expected agent step');
    analyze.structuredOutput = {
      schemaRef: 'inline-test',
      schema: { type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'] },
    };
    const originalRef = buildBuiltinWorkflowRef('ja/workflows/resume-results.yaml', 'original');
    attachWorkflowOpaqueRef(config, originalRef);
    const original = createEngine(config, { systemStepServicesFactory });
    const failures = vi.fn();
    original.on('workflow:abort', failures);
    const normal = await original.run();
    expect(normal.status, JSON.stringify(failures.mock.calls)).toBe('completed');
    expect(resolveSystemInput).toHaveBeenCalledOnce();
    expect(executeEffect.mock.calls.map(([effect]) => effect.type)).toEqual(['caccia', 'comment_pr']);
    expect(executeEffect.mock.calls[1]?.[1]).toEqual({ type: 'comment_pr', pr: 100, body: 'head=original-head: approved' });
    expect(JSON.parse(readFileSync(join(project, '.takt', 'runs', 'original', 'context', 'workflow-results.json'), 'utf8')))
      .toMatchObject({ workflow: config.name, workflow_ref: originalRef });
    const checkpoint = original.getResumePoint()!;
    const currentConfig = referenceChanged
      ? attachWorkflowOpaqueRef({ ...config }, buildBuiltinWorkflowRef('ja/workflows/resume-results.yaml', 'updated'))
      : config;
    const resumed = createEngine(currentConfig, {
      reportDirName: 'resumed', startStep: 'consume', systemStepServicesFactory,
      resumeSource: { sourceRunSlug: 'original', resumeMode },
      ...(mode === 'resume_point' ? { resumePoint: checkpoint } : {}),
    });
    number = 200;

    const aborted = vi.fn();
    resumed.on('workflow:abort', aborted);
    const state = await resumed.run();

    expect(state.status, JSON.stringify({ abort: aborted.mock.calls, outputs: [...state.stepOutputs.values()] })).toBe('completed');
    expect(resolveSystemInput).toHaveBeenCalledOnce();
    expect(vi.mocked(runAgent)).toHaveBeenCalledOnce();
    expect(executeEffect.mock.calls.map(([effect]) => effect.type)).toEqual(['caccia', 'comment_pr', 'comment_pr']);
    expect(executeEffect.mock.calls[2]?.[1]).toEqual({ type: 'comment_pr', pr: 100, body: 'head=original-head: approved' });
  });

  it.each([
    ['instruct', false], ['instruct', true], ['start_step', false], ['start_step', true],
    ['restart_point', false], ['restart_point', true],
  ] as const)('%s starts with empty results (workflow changed: %s)', async (operation, workflowChanged) => {
    const resolveSystemInput = vi.fn().mockReturnValueOnce({ number: 100 }).mockReturnValue({ number: 200 });
    const executeEffect = vi.fn<SystemStepServices['executeEffect']>().mockResolvedValue({ headSha: 'saved-head' });
    const systemStepServicesFactory = () => ({ resolveSystemInput, executeEffect });
    const config = normalizeWorkflowConfig({
      name: 'fresh-results', initial_step: 'read', max_steps: 5,
      steps: [
        { name: 'read', mode: 'system', system_inputs: [{ type: 'pr_status', source: 'current_pr', as: 'pr' }],
          rules: [{ condition: 'when(true)', next: 'write' }] },
        { name: 'write', mode: 'system', effects: [{ type: 'caccia', pr: '{context:read.pr.number}' }],
          rules: [{ condition: 'when(true)', next: 'analyze' }] },
        { name: 'analyze', instruction: 'Analyze PR {context:read.pr.number}',
          rules: [{ condition: 'when(true)', next: 'COMPLETE' }] },
      ],
    }, project);
    const analyze = config.steps[2]!;
    if (analyze.kind !== 'agent') throw new Error('Expected agent step');
    analyze.structuredOutput = {
      schemaRef: 'inline-test', schema: { type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'] },
    };
    const original = createEngine(config, { systemStepServicesFactory });
    const saved = await original.run();
    expect(saved.status).toBe('completed');
    expect(saved.systemContexts.get('read')).toEqual({ pr: { number: 100 } });
    expect(saved.effectResults.get('write')).toEqual({ caccia: { headSha: 'saved-head' } });
    expect(saved.structuredOutputs.get('analyze')).toEqual({ verdict: 'approved' });
    const selectedConfig = workflowChanged ? { ...config, name: 'another-workflow' } : config;
    const fresh = createEngine(selectedConfig, {
      reportDirName: 'fresh', systemStepServicesFactory,
      resumeSource: { sourceRunSlug: 'original', resumeMode: 'instruct' },
      ...(operation === 'start_step' ? { startStep: 'read' } : {}),
      ...(operation === 'restart_point' ? {
        sourceResumePoint: original.getResumePoint(),
        restartPoint: { stack: [buildWorkflowRestartPointEntry(selectedConfig, 'read', 'system')] },
      } : {}),
    });

    expect(fresh.getState().systemContexts.size).toBe(0);
    expect(fresh.getState().effectResults.size).toBe(0);
    expect(fresh.getState().structuredOutputs.size).toBe(0);
    expect((await fresh.run()).status).toBe('completed');
    expect(resolveSystemInput).toHaveBeenCalledTimes(2);
    expect(executeEffect.mock.calls[1]?.[1]).toMatchObject({ pr: 200 });
    expect(vi.mocked(runAgent).mock.calls[1]?.[1]).toContain('Analyze PR 200');
  });

  it('rejects saved results from a differently named workflow on a partial resume', async () => {
    const config = normalizeWorkflowConfig({
      name: 'original-workflow', initial_step: 'read', max_steps: 3,
      steps: [
        { name: 'read', mode: 'system', system_inputs: [{ type: 'pr_status', source: 'current_pr', as: 'pr' }],
          rules: [{ condition: 'when(true)', next: 'analyze' }] },
        { name: 'analyze', instruction: 'Analyze PR {context:read.pr.number}',
          rules: [{ condition: 'when(true)', next: 'COMPLETE' }] },
      ],
    }, project);
    const resolveSystemInput = vi.fn(() => ({ number: 100 }));
    const systemStepServicesFactory = () => ({ resolveSystemInput, executeEffect: vi.fn() });
    await createEngine(config, { systemStepServicesFactory }).runSingleIteration();

    expect(() => createEngine({ ...config, name: 'another-workflow' }, {
      startStep: 'analyze', reportDirName: 'resumed', systemStepServicesFactory,
      resumeSource: { sourceRunSlug: 'original', resumeMode: 'retry' },
    })).toThrow();
    expect(resolveSystemInput).toHaveBeenCalledOnce();
    expect(runAgent).not.toHaveBeenCalled();
  });

  it.each(['start_step', 'resume_point'] as const)('%s warns and resumes an old run with empty results', async (mode) => {
    const config = normalizeWorkflowConfig({
      name: 'old-run', initial_step: 'producer', max_steps: 4,
      steps: [
        { name: 'producer', instruction: 'Produce results', rules: [{ condition: 'when(true)', next: 'consume' }] },
        { name: 'consume', instruction: 'Continue without previous results',
          rules: [{ condition: 'when(true)', next: 'COMPLETE' }] },
      ],
    }, project);
    const warning = vi.spyOn(LogManager.getInstance(), 'warn');
    try {
      const resumed = createEngine(config, {
        startStep: 'consume',
        resumeSource: { sourceRunSlug: 'old-run', resumeMode: 'retry' },
        ...(mode === 'resume_point' ? { resumePoint: {
          version: 2, stack: [buildWorkflowResumePointEntry(config, 'consume', 'agent', 1)],
          iteration: 2, elapsed_ms: 0, workflow_call_invocations: {}, workflow_step_participations: {},
        } } : {}),
      });

      expect(warning).toHaveBeenCalledOnce();
      expect(resumed.getState().systemContexts.size).toBe(0);
      expect(resumed.getState().effectResults.size).toBe(0);
      expect(resumed.getState().structuredOutputs.size).toBe(0);
      expect((await resumed.run()).status).toBe('completed');
      expect(runAgent).toHaveBeenCalledOnce();
      expect(vi.mocked(runAgent).mock.calls[0]?.[1]).toContain('Continue without previous results');
    } finally {
      warning.mockRestore();
    }
  });

  it.each(['context', 'effect', 'structured'] as const)('an old run fails at the step that references unavailable %s results', async (root) => {
    const resolveSystemInput = vi.fn();
    const executeEffect = vi.fn();
    const reference = root === 'context' ? '{context:producer.pr.number}'
      : root === 'effect' ? '{effect:producer.caccia.headSha}' : '{structured:producer.verdict}';
    const config = normalizeWorkflowConfig({
      name: 'missing-results', initial_step: 'producer', max_steps: 4,
      steps: [
        { name: 'producer', instruction: 'Produce results', rules: [{ condition: 'when(true)', next: 'resume' }] },
        { name: 'resume', instruction: 'Continue without previous results',
          rules: [{ condition: 'when(true)', next: 'consume' }] },
        { name: 'consume', instruction: `Use ${reference}`,
          rules: [{ condition: 'when(true)', next: 'COMPLETE' }] },
      ],
    }, project);

    const resumed = createEngine(config, {
      startStep: 'resume',
      resumeSource: { sourceRunSlug: 'old-run', resumeMode: 'retry' },
      systemStepServicesFactory: () => ({ resolveSystemInput, executeEffect }),
    });

    expect((await resumed.run()).status).toBe('aborted');
    expect(resumed.getState().currentStep).toBe('consume');
    expect(resolveSystemInput).not.toHaveBeenCalled();
    expect(executeEffect).not.toHaveBeenCalled();
    expect(runAgent).toHaveBeenCalledOnce();
  });

  it.each(['instruction', 'workflow_rule'] as const)('restores a context referenced only by an AI %s', async (location) => {
    const resolveSystemInput = vi.fn(() => ({ number: 321 }));
    const config = normalizeWorkflowConfig({
      name: 'ai-reference', initial_step: 'read', max_steps: 4,
      steps: [
        { name: 'read', mode: 'system',
          system_inputs: [{ type: 'pr_status', source: 'current_pr', as: 'pr' }],
          rules: [{ condition: 'when(true)', next: 'analyze' }] },
        { name: 'analyze', instruction: location === 'instruction' ? 'Review PR {context:read.pr.number}' : 'Review',
          rules: [{ condition: 'when(true)', next: 'COMPLETE' }] },
      ],
    }, project);
    if (location === 'workflow_rule') {
      config.allStepsRules = [{ ref: 'review-target', position: 'before_instruction', content: 'Review PR {context:read.pr.number}' }];
    }
    const options = { systemStepServicesFactory: () => ({ resolveSystemInput, executeEffect: vi.fn() }) };
    const original = createEngine(config, options);
    await original.runSingleIteration();
    const resumed = createEngine(config, {
      ...options, startStep: 'analyze', reportDirName: 'resumed',
      resumeSource: { sourceRunSlug: 'original', resumeMode: 'retry' },
    });

    expect((await resumed.run()).status).toBe('completed');
    expect(runAgent).toHaveBeenCalledOnce();
    expect(vi.mocked(runAgent).mock.calls[0]?.[1]).toContain('Review PR 321');
    expect(resolveSystemInput).toHaveBeenCalledOnce();
  });

  it('keeps the selected Issue aligned with its saved plan when resuming at enqueue', async () => {
    const resolveSystemInput = vi.fn().mockReturnValueOnce({ number: 101, exists: true }).mockReturnValue({ number: 202, exists: true });
    const executeEffect = vi.fn<SystemStepServices['executeEffect']>().mockResolvedValue({ success: true });
    const config = normalizeWorkflowConfig({
      name: 'selected-issue', initial_step: 'select', max_steps: 5,
      steps: [
        { name: 'select', mode: 'system',
          system_inputs: [{ type: 'issue_selection', source: 'current_project', as: 'issue' }],
          rules: [{ condition: 'when(true)', next: 'plan' }] },
        { name: 'plan', instruction: 'Plan for Issue {context:select.issue.number}',
          rules: [{ condition: 'when(true)', next: 'enqueue' }] },
        { name: 'enqueue', mode: 'system', effects: [{ type: 'enqueue_task', mode: 'new', workflow: 'takt-default',
          task: '{structured:plan.task_markdown}', issue_number: '{context:select.issue.number}' }],
          rules: [{ condition: 'when(true)', next: 'COMPLETE' }] },
      ],
    }, project);
    const plan = config.steps[1]!;
    if (plan.kind !== 'agent') throw new Error('Expected agent step');
    plan.structuredOutput = {
      schemaRef: 'inline-test', schema: { type: 'object', properties: { task_markdown: { type: 'string' } }, required: ['task_markdown'] },
    };
    vi.mocked(runAgent).mockImplementationOnce(async (_persona, instruction, options) => {
      options.onPromptResolved?.({ systemPrompt: '', userInstruction: instruction });
      return {
        persona: 'plan', status: 'done', content: 'planned', timestamp: new Date(),
        structuredOutput: { task_markdown: 'Plan for Issue 101' },
      };
    });
    const options = { systemStepServicesFactory: () => ({ resolveSystemInput, executeEffect }) };
    const original = createEngine(config, options);
    await original.runSingleIteration();
    await original.runSingleIteration();
    const resumed = createEngine(config, {
      ...options, startStep: 'enqueue', reportDirName: 'resumed',
      resumeSource: { sourceRunSlug: 'original', resumeMode: 'requeue' },
    });

    expect((await resumed.run()).status).toBe('completed');
    expect(executeEffect.mock.calls[0]?.[1]).toMatchObject({ issue_number: 101, task: 'Plan for Issue 101' });
    expect(resolveSystemInput).toHaveBeenCalledOnce();
    expect(runAgent).toHaveBeenCalledOnce();
  });

  it('keeps a completed effect result when a later effect in the same step fails', async () => {
    const executeEffect = vi.fn<SystemStepServices['executeEffect']>(async (effect, payload) => {
      if (payload.body === 'stop') throw new Error('effect interrupted');
      return effect.type === 'caccia' ? { headSha: 'saved-head' } : { success: true };
    });
    const systemStepServicesFactory = () => ({ resolveSystemInput: vi.fn(), executeEffect });
    const config = normalizeWorkflowConfig({
      name: 'partial-effect', initial_step: 'producer', max_steps: 4,
      steps: [
        { name: 'producer', mode: 'system',
          effects: [{ type: 'caccia', pr: 1 }, { type: 'comment_pr', pr: 1, body: 'stop' }],
          rules: [{ condition: 'when(true)', next: 'consume' }] },
        { name: 'consume', mode: 'system', effects: [{ type: 'comment_pr', pr: 1, body: '{effect:producer.caccia.headSha}' }],
          rules: [{ condition: 'when(true)', next: 'COMPLETE' }] },
      ],
    }, project);
    expect((await createEngine(config, { systemStepServicesFactory }).run()).status).toBe('aborted');
    const resumed = createEngine(config, {
      reportDirName: 'resumed', startStep: 'consume', systemStepServicesFactory,
      resumeSource: { sourceRunSlug: 'original', resumeMode: 'retry' },
    });

    expect((await resumed.run()).status).toBe('completed');
    expect(executeEffect.mock.calls.map(([effect]) => effect.type)).toEqual(['caccia', 'comment_pr', 'comment_pr']);
    expect(executeEffect.mock.calls[2]?.[1]).toMatchObject({ body: 'saved-head' });
  });

  it.each(['start_step', 'resume_point', 'restart_point'] as const)('%s restores the state before the selected step first started', async (mode) => {
    const resolveSystemInput = vi.fn().mockReturnValueOnce({ number: 101 }).mockReturnValue({ number: 202 });
    const executeEffect = vi.fn<SystemStepServices['executeEffect']>().mockResolvedValue({ success: true });
    const config = normalizeWorkflowConfig({
      name: 'reselect-issue', initial_step: 'begin', max_steps: 12,
      steps: [
        { name: 'begin', instruction: 'Begin', rules: [{ condition: 'when(true)', next: 'select' }] },
        { name: 'select', mode: 'system',
          system_inputs: [{ type: 'issue_selection', source: 'current_project', as: 'issue' }],
          rules: [{ condition: 'when(context.select.issue.number == 101)', next: 'plan' },
            { condition: 'when(true)', next: 'enqueue' }] },
        { name: 'plan', instruction: 'Plan for Issue {context:select.issue.number}',
          rules: [{ condition: 'when(true)', next: 'enqueue' }] },
        { name: 'enqueue', mode: 'system', effects: [{ type: 'enqueue_task', mode: 'new', workflow: 'takt-default',
          task: '{structured:plan.task_markdown}', issue_number: '{context:select.issue.number}' }],
          rules: [{ condition: 'when(true)', next: 'COMPLETE' }] },
      ],
    }, project);
    const plan = config.steps[2]!;
    if (plan.kind !== 'agent') throw new Error('Expected agent step');
    plan.structuredOutput = {
      schemaRef: 'inline-test', schema: { type: 'object', properties: { task_markdown: { type: 'string' } }, required: ['task_markdown'] },
    };
    vi.mocked(runAgent).mockImplementation(async (_persona, instruction, options) => {
      options.onPromptResolved?.({ systemPrompt: '', userInstruction: instruction });
      return { persona: 'plan', status: 'done', content: 'planned', timestamp: new Date(),
        structuredOutput: { task_markdown: 'Plan for Issue 101' } };
    });
    const options = { systemStepServicesFactory: () => ({ resolveSystemInput, executeEffect }) };
    const original = createEngine(config, options);
    const failures = vi.fn();
    original.on('workflow:abort', failures);
    expect((await original.run()).status, JSON.stringify(failures.mock.calls)).toBe('completed');
    const checkpoint = original.getResumePoint()!;
    checkpoint.stack = [buildWorkflowResumePointEntry(config, 'select', 'system', 1)];
    const resumed = createEngine(config, {
      ...options, startStep: 'select', reportDirName: 'resumed',
      resumeSource: { sourceRunSlug: 'original', resumeMode: 'requeue' },
      ...(mode === 'resume_point' ? { resumePoint: checkpoint } : {}),
      ...(mode === 'restart_point' ? {
        sourceResumePoint: original.getResumePoint(),
        restartPoint: { stack: [buildWorkflowRestartPointEntry(config, 'select', 'system')] },
      } : {}),
    });

    expect((await resumed.run()).status).toBe('aborted');
    expect(resumed.getState().systemContexts.get('select')).toEqual({ issue: { number: 202 } });
    expect(executeEffect).toHaveBeenCalledOnce();
    expect(executeEffect.mock.calls[0]?.[1]).toMatchObject({ issue_number: 101, task: 'Plan for Issue 101' });
    expect(resumed.getState().structuredOutputs.has('plan')).toBe(false);
    expect(resumed.getState().effectResults.has('enqueue')).toBe(false);
    const retry = createEngine(config, {
      ...options, startStep: 'enqueue', reportDirName: 'retry',
      resumeSource: { sourceRunSlug: 'resumed', resumeMode: 'retry' },
    });
    expect(retry.getState().systemContexts.get('select')).toEqual({ issue: { number: 202 } });
    expect((await retry.run()).status).toBe('aborted');
    expect(executeEffect).toHaveBeenCalledOnce();
  });

  it.each(['bigint', 'circular', 'write'] as const)('continues normal execution when saving results fails (%s)', async (failure) => {
    const value: Record<string, unknown> = { number: 123 };
    if (failure === 'bigint') value.extra = 1n;
    if (failure === 'circular') value.extra = value;
    const resolveSystemInput = vi.fn(() => value);
    const executeEffect = vi.fn<SystemStepServices['executeEffect']>().mockResolvedValue({ success: true });
    const config = normalizeWorkflowConfig({
      name: 'save-failure', initial_step: 'read', max_steps: 3,
      steps: [
        { name: 'read', mode: 'system', system_inputs: [{ type: 'pr_status', source: 'current_pr', as: 'pr' }],
          rules: [{ condition: 'when(true)', next: 'consume' }] },
        { name: 'consume', mode: 'system', effects: [{ type: 'comment_pr', pr: '{context:read.pr.number}', body: 'done' }],
          rules: [{ condition: 'when(true)', next: 'COMPLETE' }] },
      ],
    }, project);
    const warning = vi.spyOn(LogManager.getInstance(), 'warn');
    try {
      const engine = createEngine(config, { systemStepServicesFactory: () => ({ resolveSystemInput, executeEffect }) });
      if (failure === 'write') {
        const path = join(project, '.takt', 'runs', 'original', 'context', 'workflow-results.json');
        rmSync(path);
        mkdirSync(path);
      }
      expect((await engine.run()).status).toBe('completed');
      expect(executeEffect.mock.calls[0]?.[1]).toMatchObject({ pr: 123 });
      expect(warning).toHaveBeenCalled();
    } finally {
      warning.mockRestore();
    }
  });

  it('restores the full state before the latest visit even when the provider reuses its object', async () => {
    const output = { task_markdown: 'Plan for Issue 101' };
    vi.mocked(runAgent).mockImplementation(async (_persona, instruction, options) => {
      options.onPromptResolved?.({ systemPrompt: '', userInstruction: instruction });
      if (vi.mocked(runAgent).mock.calls.length === 2) output.task_markdown = 'Plan for Issue 202';
      return { persona: 'plan', status: 'done', content: 'planned', timestamp: new Date(), structuredOutput: output };
    });
    const resolveSystemInput = vi.fn()
      .mockReturnValueOnce({ number: 101 }).mockReturnValueOnce({ number: 202 }).mockReturnValue({ number: 303 });
    const executeEffect = vi.fn<SystemStepServices['executeEffect']>().mockResolvedValue({ success: true });
    const config = normalizeWorkflowConfig({
      name: 'regenerated-results', initial_step: 'begin', max_steps: 8,
      steps: [
        { name: 'begin', mode: 'system', rules: [{ condition: 'when(true)', next: 'select' }] },
        { name: 'select', mode: 'system', system_inputs: [{ type: 'pr_status', source: 'current_pr', as: 'pr' }],
          rules: [{ condition: 'when(context.select.pr.number == 303)', next: 'consume' },
            { condition: 'when(true)', next: 'plan' }] },
        { name: 'plan', instruction: 'Plan',
          rules: [{ condition: 'when(context.select.pr.number == 101)', next: 'select' },
            { condition: 'when(true)', next: 'COMPLETE' }] },
        { name: 'consume', mode: 'system', effects: [{ type: 'comment_pr', pr: '{context:select.pr.number}',
          body: '{structured:plan.task_markdown}' }], rules: [{ condition: 'when(true)', next: 'COMPLETE' }] },
      ],
    }, project);
    const plan = config.steps[2]!;
    if (plan.kind !== 'agent') throw new Error('Expected agent step');
    plan.structuredOutput = {
      schemaRef: 'inline-test', schema: { type: 'object', properties: { task_markdown: { type: 'string' } }, required: ['task_markdown'] },
    };
    const options = { systemStepServicesFactory: () => ({ resolveSystemInput, executeEffect }) };
    expect((await createEngine(config, options).run()).status).toBe('completed');
    expect(runAgent).toHaveBeenCalledTimes(2);
    const resumed = createEngine(config, {
      ...options, startStep: 'select', reportDirName: 'resumed',
      resumeSource: { sourceRunSlug: 'original', resumeMode: 'retry' },
    });

    expect(resumed.getState().structuredOutputs.get('plan')).toEqual({ task_markdown: 'Plan for Issue 101' });
    expect(resumed.getState().systemContexts.get('select')).toEqual({ pr: { number: 101 } });
    expect((await resumed.run()).status).toBe('completed');
    expect(executeEffect.mock.calls[0]?.[1]).toMatchObject({ pr: 303, body: 'Plan for Issue 101' });
  });

  it.each([false, true])('finishes report execution and preserves the step outcome when saving fails (step throws: %s)', async (stepThrows) => {
    const stepError = new Error('agent interrupted');
    const config = normalizeWorkflowConfig({
      name: 'report-save-failure', initial_step: 'report', max_steps: 2,
      steps: [{ name: 'report', instruction: 'Report', output_contracts: { report: [{ name: 'report.md', format: 'Report' }] },
        rules: [{ condition: 'when(true)', next: 'COMPLETE' }] }],
    }, project);
    vi.mocked(runAgent).mockImplementationOnce(async (_persona, _instruction, options) => {
      options.onPromptResolved?.({ systemPrompt: '', userInstruction: 'Report' });
      const path = join(project, '.takt', 'runs', 'original', 'context', 'workflow-results.json');
      rmSync(path);
      mkdirSync(path);
      if (stepThrows) throw stepError;
      return { persona: 'report', status: 'done', content: 'done', timestamp: new Date() };
    });
    const finish = vi.spyOn(ReportExecutionStore.prototype, 'finish');
    const warning = vi.spyOn(LogManager.getInstance(), 'warn');
    try {
      const engine = createEngine(config, {});
      const outcome = engine.runSingleIteration();
      if (stepThrows) await expect(outcome).rejects.toBe(stepError);
      else expect((await outcome).isComplete).toBe(true);
      expect(finish).toHaveBeenCalledWith(expect.any(String), !stepThrows);
      expect(warning).toHaveBeenCalled();
    } finally {
      finish.mockRestore();
      warning.mockRestore();
    }
  });

  it('does not restore child results when the parent workflow name changes at the same reference', async () => {
    const parent = attachWorkflowOpaqueRef(normalizeWorkflowConfig({
      name: 'old-parent', initial_step: 'delegate', max_steps: 10,
      steps: [{ name: 'delegate', kind: 'workflow_call', call: 'child', rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }] }],
    }, project), join(project, 'parent.yaml'));
    const child = normalizeWorkflowConfig({
      name: 'child', subworkflow: { callable: true }, initial_step: 'read', max_steps: 10,
      steps: [
        { name: 'read', mode: 'system', system_inputs: [{ type: 'pr_status', source: 'current_pr', as: 'pr' }],
          rules: [{ condition: 'when(true)', next: 'consume' }] },
        { name: 'consume', instruction: 'Use PR {context:read.pr.number}',
          rules: [{ condition: 'when(true)', next: 'comment' }] },
        { name: 'comment', mode: 'system', effects: [{ type: 'comment_pr', pr: '{context:read.pr.number}', body: 'done' }],
          rules: [{ condition: 'when(true)', next: 'COMPLETE' }] },
      ],
    }, project);
    const resolveSystemInput = vi.fn(() => ({ number: 101 }));
    const executeEffect = vi.fn<SystemStepServices['executeEffect']>().mockResolvedValue({ success: true });
    const options = { workflowCallResolver: () => child, systemStepServicesFactory: () => ({ resolveSystemInput, executeEffect }) };
    const original = createEngine(parent, options);
    expect((await original.run()).status).toBe('completed');
    const renamed = attachWorkflowOpaqueRef({ ...parent, name: 'new-parent' }, join(project, 'parent.yaml'));
    const resumed = createEngine(renamed, {
      ...options, reportDirName: 'resumed',
      resumeSource: { sourceRunSlug: 'original', resumeMode: 'instruct' },
      sourceResumePoint: original.getResumePoint(),
      restartPoint: { stack: [
        buildWorkflowRestartPointEntry(renamed, 'delegate', 'workflow_call', 1),
        buildWorkflowRestartPointEntry(child, 'consume', 'agent'),
      ] },
    });

    expect((await resumed.run()).status).toBe('aborted');
    expect(executeEffect).toHaveBeenCalledOnce();
    expect(resolveSystemInput).toHaveBeenCalledOnce();
  });

  it('restores contexts from arbitrary command inputs without running the command again', async () => {
    mkdirSync(join(project, '.takt'), { recursive: true });
    writeFileSync(join(project, '.takt', 'config.yaml'), 'workflow_system_commands:\n  custom_scripts: true\n');
    const resolveSystemInput = vi.fn(() => ({ number: 123 }));
    const executeEffect = vi.fn<SystemStepServices['executeEffect']>().mockResolvedValue({ success: true });
    const systemStepServicesFactory = () => ({ resolveSystemInput, executeEffect });
    const workflowPath = join(project, 'command.yaml');
    writeFileSync(workflowPath, JSON.stringify({
      name: 'command-context', initial_step: 'probe', max_steps: 4,
      steps: [
        { name: 'probe', mode: 'system',
          system_inputs: [{ type: 'command', command: 'probe', timeout_ms: 1000, as: 'pr', output: 'json' }],
          rules: [{ condition: 'when(true)', next: 'consume' }] },
        { name: 'consume', mode: 'system', effects: [{ type: 'comment_pr', pr: '{context:probe.pr.number}', body: 'done' }],
          rules: [{ condition: 'when(true)', next: 'COMPLETE' }] },
      ],
    }));
    const config = loadWorkflowByIdentifier(workflowPath, project)!;
    expect((await createEngine(config, { systemStepServicesFactory }).run()).status).toBe('completed');
    const resumed = createEngine(config, {
      reportDirName: 'resumed', startStep: 'consume', systemStepServicesFactory,
      resumeSource: { sourceRunSlug: 'original', resumeMode: 'retry' },
    });

    expect((await resumed.run()).status).toBe('completed');
    expect(resolveSystemInput).toHaveBeenCalledOnce();
    expect(executeEffect.mock.calls[1]?.[1]).toMatchObject({ pr: 123 });
  });

  it('warns and continues without child results for an invalid public resumeInvocationSource ID', async () => {
    const parent = normalizeWorkflowConfig({
      name: 'parent', initial_step: 'delegate', max_steps: 10,
      steps: [{ name: 'delegate', kind: 'workflow_call', call: 'child',
        rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }] }],
    }, project);
    const child = normalizeWorkflowConfig({
      name: 'child', subworkflow: { callable: true }, initial_step: 'read', max_steps: 10,
      steps: [
        { name: 'read', mode: 'system', system_inputs: [{ type: 'pr_status', source: 'current_pr', as: 'pr' }],
          rules: [{ condition: 'when(true)', next: 'comment' }] },
        { name: 'comment', mode: 'system', effects: [{ type: 'comment_pr', pr: '{context:read.pr.number}', body: 'done' }],
          rules: [{ condition: 'when(true)', next: 'COMPLETE' }] },
      ],
    }, project);
    const resolveSystemInput = vi.fn(() => ({ number: 101 }));
    const executeEffect = vi.fn<SystemStepServices['executeEffect']>().mockResolvedValue({ success: true });
    const options = { workflowCallResolver: () => child,
      systemStepServicesFactory: () => ({ resolveSystemInput, executeEffect }) };
    const original = createEngine(parent, options);
    expect((await original.run()).status).toBe('completed');
    const checkpoint: WorkflowResumePoint = {
      ...original.getResumePoint()!, stack: [
        buildWorkflowResumePointEntry(parent, 'delegate', 'workflow_call', 1, undefined, 1),
        buildWorkflowResumePointEntry(child, 'comment', 'system', 1),
      ],
    };
    const record = Object.values(checkpoint.workflow_call_invocations)[0]!;
    const warning = vi.spyOn(LogManager.getInstance(), 'warn');
    try {
      const resumed = createEngine(parent, {
        ...options, reportDirName: 'resumed', resumePoint: checkpoint,
        resumeSource: { sourceRunSlug: 'original', resumeMode: 'retry' },
        sharedRuntime: { startedAtMs: Date.now(), resumeInvocationSource: {
          ...checkpoint, workflow_call_invocations: { invalid: record },
        } },
      });

      expect(warning).toHaveBeenCalled();
      expect((await resumed.run()).status).toBe('aborted');
      expect(resolveSystemInput).toHaveBeenCalledOnce();
      expect(executeEffect).toHaveBeenCalledOnce();
    } finally { warning.mockRestore(); }
  });

  it('restores child results after the parent process is killed during its first workflow call', async () => {
    const parent = normalizeWorkflowConfig({
      name: 'parent', initial_step: 'delegate', max_steps: 10,
      steps: [{ name: 'delegate', kind: 'workflow_call', call: 'child',
        rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }] }],
    }, project);
    const child = normalizeWorkflowConfig({
      name: 'child', subworkflow: { callable: true }, initial_step: 'read', max_steps: 10,
      steps: [
        { name: 'read', mode: 'system', system_inputs: [{ type: 'pr_status', source: 'current_pr', as: 'pr' }],
          rules: [{ condition: 'when(true)', next: 'write' }] },
        { name: 'write', mode: 'system', effects: [{ type: 'caccia', pr: '{context:read.pr.number}' }],
          rules: [{ condition: 'when(true)', next: 'consume' }] },
        { name: 'consume', instruction: 'Saved child results: {context:read.pr.number}, {effect:write.caccia.headSha}',
          rules: [{ condition: 'when(true)', next: 'COMPLETE' }] },
      ],
    }, project);
    const checkpointPath = join(project, 'checkpoint.json');
    const finallyPath = join(project, 'parent-finally');
    const source = `
      import { writeFileSync } from 'node:fs';
      import { WorkflowEngine } from ${JSON.stringify(new URL('../core/workflow/engine/WorkflowEngine.ts', import.meta.url).href)};
      const engine = new WorkflowEngine(${JSON.stringify(parent)}, process.cwd(), 'Resume workflow', {
        projectCwd: process.cwd(), provider: 'mock', reportDirName: 'original',
        workflowCallResolver: () => (${JSON.stringify(child)}),
        systemStepServicesFactory: () => ({
          resolveSystemInput: async () => ({ number: 123 }),
          executeEffect: async () => ({ headSha: 'child-head' }),
        }),
        onStream: () => {
          writeFileSync(${JSON.stringify(checkpointPath)}, JSON.stringify(engine.getResumePoint()));
          process.kill(process.pid, 'SIGKILL');
        },
      });
      try { await engine.run(); }
      finally { writeFileSync(${JSON.stringify(finallyPath)}, 'reached'); }
    `;

    const killed = spawnSync(process.execPath, [
      '--import', createRequire(import.meta.url).resolve('tsx/esm'), '--input-type=module', '--eval', source,
    ], {
      cwd: project, encoding: 'utf8', timeout: 20_000, killSignal: 'SIGKILL',
      env: { ...process.env, NODE_OPTIONS: undefined },
    });

    expect(killed.error, killed.stderr).toBeUndefined();
    expect(killed.signal, killed.stderr).toBe('SIGKILL');
    expect(existsSync(finallyPath)).toBe(false);
    expect(JSON.parse(readFileSync(join(project, '.takt', 'runs', 'original', 'context', 'workflow-results.json'), 'utf8')))
      .toMatchObject({ latest: { context: {}, effect: {}, structured: {} } });
    const resumePoint = JSON.parse(readFileSync(checkpointPath, 'utf8')) as WorkflowResumePoint;
    expect(resumePoint.stack.map((frame) => frame.step)).toEqual(['delegate', 'consume']);
    const resolveSystemInput = vi.fn();
    const executeEffect = vi.fn();
    const resumed = createEngine(parent, {
      reportDirName: 'resumed', startStep: 'delegate', resumePoint,
      resumeSource: { sourceRunSlug: 'original', resumeMode: 'retry' },
      workflowCallResolver: () => child,
      systemStepServicesFactory: () => ({ resolveSystemInput, executeEffect }),
    });

    const failures = vi.fn();
    resumed.on('workflow:abort', failures);
    expect((await resumed.run()).status, JSON.stringify(failures.mock.calls)).toBe('completed');
    expect(resolveSystemInput).not.toHaveBeenCalled();
    expect(executeEffect).not.toHaveBeenCalled();
    expect(runAgent).toHaveBeenCalledOnce();
    expect(vi.mocked(runAgent).mock.calls[0]?.[1]).toContain('Saved child results: 123, child-head');
  });

  it.each([false, true])('keeps Issue 101 when resuming a child killed during an effect under parallel (nested: %s)', async (nested) => {
    const parallel = normalizeWorkflowConfig({
      name: 'parallel-parent', subworkflow: { callable: true }, initial_step: 'parallel', max_steps: 10,
      steps: [{ name: 'parallel', parallel: [
        { name: 'delegate', kind: 'workflow_call', call: 'child',
          rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }] },
      ], rules: [{ condition: 'when(true)', next: 'COMPLETE' }] }],
    }, project);
    const parent = nested ? normalizeWorkflowConfig({
      name: 'outer-parent', initial_step: 'outer-call', max_steps: 10,
      steps: [{ name: 'outer-call', kind: 'workflow_call', call: 'parallel-parent',
        rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }] }],
    }, project) : parallel;
    const child = normalizeWorkflowConfig({
      name: 'child', subworkflow: { callable: true }, initial_step: 'select', max_steps: 10,
      steps: [{ name: 'select', mode: 'system',
        system_inputs: [{ type: 'issue_selection', source: 'current_project', as: 'issue' }],
        effects: [
          { type: 'caccia', pr: '{context:select.issue.number}' },
          { type: 'comment_pr', pr: '{context:select.issue.number}', body: 'selected' },
        ], rules: [{ condition: 'when(true)', next: 'COMPLETE' }] }],
    }, project);
    const checkpointPath = join(project, 'checkpoint.json');
    const selectedPath = join(project, 'selected.json');
    const source = `
      import { writeFileSync } from 'node:fs';
      import { WorkflowEngine } from ${JSON.stringify(new URL('../core/workflow/engine/WorkflowEngine.ts', import.meta.url).href)};
      import { readPreviousSelectedNumber, selectNextCandidate } from ${JSON.stringify(new URL('../infra/workflow/system/system-selection-helpers.ts', import.meta.url).href)};
      const engine = new WorkflowEngine(${JSON.stringify(parent)}, process.cwd(), 'Resume workflow', {
        projectCwd: process.cwd(), provider: 'mock', reportDirName: 'original',
        workflowCallResolver: ({ step }) => step.call === 'parallel-parent' ? ${JSON.stringify(parallel)} : ${JSON.stringify(child)},
        systemStepServicesFactory: () => ({
          resolveSystemInput: (input, state, step) => selectNextCandidate(
            [{ number: 101 }, { number: 202 }], readPreviousSelectedNumber(state, step, input.as)),
          executeEffect: async (effect, payload) => {
            if (effect.type === 'caccia') {
              writeFileSync(${JSON.stringify(selectedPath)}, JSON.stringify(payload));
              return { headSha: 'selected-head' };
            }
            writeFileSync(${JSON.stringify(checkpointPath)}, JSON.stringify(engine.getResumePoint()));
            process.kill(process.pid, 'SIGKILL');
          },
        }),
      });
      await engine.run();
    `;

    const killed = spawnSync(process.execPath, [
      '--import', createRequire(import.meta.url).resolve('tsx/esm'), '--input-type=module', '--eval', source,
    ], {
      cwd: project, encoding: 'utf8', timeout: 20_000, killSignal: 'SIGKILL',
      env: { ...process.env, NODE_OPTIONS: undefined },
    });

    expect(killed.error, killed.stderr).toBeUndefined();
    expect(killed.signal, killed.stderr).toBe('SIGKILL');
    expect(JSON.parse(readFileSync(selectedPath, 'utf8'))).toMatchObject({ pr: 101 });
    const resumePoint = JSON.parse(readFileSync(checkpointPath, 'utf8')) as WorkflowResumePoint;
    expect(resumePoint.stack.map((frame) => frame.step)).toEqual([
      ...(nested ? ['outer-call'] : []), 'parallel', 'delegate', 'select',
    ]);
    const { readPreviousSelectedNumber, selectNextCandidate } = await import('../infra/workflow/system/system-selection-helpers.js');
    const resolveSystemInput = vi.fn<SystemStepServices['resolveSystemInput']>((input, state, step) => {
      if (state === undefined || step === undefined) throw new Error('Expected workflow state and step');
      return selectNextCandidate([{ number: 101 }, { number: 202 }], readPreviousSelectedNumber(state, step, input.as));
    });
    const executeEffect = vi.fn<SystemStepServices['executeEffect']>().mockResolvedValue({ success: true });
    const resumed = createEngine(parent, {
      reportDirName: 'resumed', resumePoint,
      resumeSource: { sourceRunSlug: 'original', resumeMode: 'retry' },
      workflowCallResolver: ({ step }) => step.call === 'parallel-parent' ? parallel : child,
      systemStepServicesFactory: () => ({ resolveSystemInput, executeEffect }),
    });
    const failures = vi.fn();
    resumed.on('workflow:abort', failures);

    expect((await resumed.run()).status, JSON.stringify(failures.mock.calls)).toBe('completed');
    expect(resolveSystemInput).toHaveBeenCalledOnce();
    expect(resolveSystemInput.mock.results[0]?.value).toEqual({ number: 101 });
    expect(executeEffect.mock.calls.map(([, payload]) => payload)).toEqual([
      { type: 'caccia', pr: 101 }, { type: 'comment_pr', pr: 101, body: 'selected' },
    ]);
  });

  it.each([false, true])('restores child results through the initial parent step (reference changed: %s)', async (referenceChanged) => {
    const parent = normalizeWorkflowConfig({
      name: 'parent', initial_step: 'delegate', max_steps: 10,
      steps: [{ name: 'delegate', kind: 'workflow_call', call: 'child', rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }] }],
    }, project);
    const child = normalizeWorkflowConfig({
      name: 'child', subworkflow: { callable: true }, initial_step: 'read', max_steps: 10,
      steps: [
        { name: 'read', mode: 'system', system_inputs: [{ type: 'pr_status', source: 'current_pr', as: 'pr' }],
          rules: [{ condition: 'when(true)', next: 'write' }] },
        { name: 'write', mode: 'system', effects: [{ type: 'caccia', pr: '{context:read.pr.number}' }],
          rules: [{ condition: 'when(true)', next: 'consume' }] },
        { name: 'consume', instruction: 'Use the previously collected results',
          rules: [{ condition: 'when(context.read.pr.number > 0 && effect.write.caccia.headSha == \"child-head\")', next: 'COMPLETE' }] },
      ],
    }, project);
    attachWorkflowOpaqueRef(parent, buildBuiltinWorkflowRef('ja/workflows/parent.yaml', 'original'));
    attachWorkflowOpaqueRef(child, buildBuiltinWorkflowRef('ja/workflows/child.yaml', 'original'));
    let number = 100;
    const resolveSystemInput = vi.fn(() => ({ number }));
    const executeEffect = vi.fn<SystemStepServices['executeEffect']>(async (effect) => effect.type === 'caccia'
      ? { headSha: 'child-head' } : { success: true });
    let currentChild = child;
    const options = {
      workflowCallResolver: () => currentChild,
      systemStepServicesFactory: () => ({ resolveSystemInput, executeEffect }),
    };
    const original = createEngine(parent, options);
    expect((await original.run()).status).toBe('completed');
    const currentParent = referenceChanged
      ? attachWorkflowOpaqueRef({ ...parent }, buildBuiltinWorkflowRef('ja/workflows/parent.yaml', 'updated'))
      : parent;
    if (referenceChanged) {
      currentChild = attachWorkflowOpaqueRef({ ...child }, buildBuiltinWorkflowRef('ja/workflows/child.yaml', 'updated'));
    }
    const resumed = createEngine(currentParent, {
      ...options, reportDirName: 'resumed',
      resumeSource: { sourceRunSlug: 'original', resumeMode: 'retry' },
      sourceResumePoint: original.getResumePoint(),
      restartPoint: { stack: [
        buildWorkflowRestartPointEntry(parent, 'delegate', 'workflow_call', 1),
        buildWorkflowRestartPointEntry(child, 'consume', 'agent'),
      ] },
    });
    number = 200;

    const failures = vi.fn();
    resumed.on('workflow:abort', failures);
    const state = await resumed.run();

    expect(state.status, JSON.stringify(failures.mock.calls)).toBe('completed');
    expect(resolveSystemInput).toHaveBeenCalledOnce();
    expect(executeEffect.mock.calls.map(([effect]) => effect.type)).toEqual(['caccia']);
    expect(runAgent).toHaveBeenCalledTimes(2);
  });

  it.each(['before_child', 'workflow_call:start'] as const)('inherits child results across a retry that fails at %s', async (failurePoint) => {
    const parent = normalizeWorkflowConfig({
      name: 'parent', initial_step: 'before_child', max_steps: 20,
      steps: [
        { name: 'before_child', mode: 'system',
          system_inputs: [{ type: 'pr_status', source: 'current_pr', as: 'pr' }],
          rules: [{ condition: 'when(true)', next: 'delegate' }] },
        { name: 'delegate', kind: 'workflow_call', call: 'child', rules: [
          { condition: 'COMPLETE', next: 'COMPLETE' }, { condition: 'ABORT', next: 'ABORT' },
        ] },
      ],
    }, project);
    const child = normalizeWorkflowConfig({
      name: 'child', subworkflow: { callable: true }, initial_step: 'read', max_steps: 20,
      steps: [
        { name: 'read', mode: 'system', system_inputs: [{ type: 'pr_status', source: 'current_pr', as: 'pr' }],
          rules: [{ condition: 'when(true)', next: 'write' }] },
        { name: 'write', mode: 'system', effects: [{ type: 'caccia', pr: '{context:read.pr.number}' }],
          rules: [{ condition: 'when(true)', next: 'analyze' }] },
        { name: 'analyze', instruction: 'Analyze', rules: [{ condition: 'when(true)', next: 'consume' }] },
        { name: 'consume', instruction: 'Saved child results: {context:read.pr.number}, {effect:write.caccia.headSha}, {structured:analyze.verdict}',
          rules: [{ condition: 'when(true)', next: 'comment' }] },
        { name: 'comment', mode: 'system', effects: [{ type: 'comment_pr', pr: '{context:read.pr.number}',
          body: 'head={effect:write.caccia.headSha}: {structured:analyze.verdict}' }],
          rules: [{ condition: 'when(true)', next: 'COMPLETE' }] },
      ],
    }, project);
    const analyze = child.steps[2]!;
    if (analyze.kind !== 'agent') throw new Error('Expected agent step');
    analyze.structuredOutput = {
      schemaRef: 'inline-test', schema: { type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'] },
    };
    const resolveSystemInput = vi.fn(() => ({ number: 123 }));
    const executeEffect = vi.fn<SystemStepServices['executeEffect']>(async (effect) => {
      if (effect.type === 'comment_pr') throw new Error('Child interrupted');
      return { headSha: 'child-head' };
    });
    const workflowCallResolver = vi.fn(() => child);
    const options = {
      workflowCallResolver,
      systemStepServicesFactory: () => ({ resolveSystemInput, executeEffect }),
    };
    const original = createEngine(parent, {
      ...options,
      ...(failurePoint === 'workflow_call:start' ? { resumePoint: {
        version: 2, stack: [buildWorkflowResumePointEntry(parent, 'before_child', 'system', 1, new Map([['delegate', 1]]))],
        iteration: 0, elapsed_ms: 0, workflow_call_invocations: {}, workflow_step_participations: {},
      } as WorkflowResumePoint } : {}),
    });
    expect((await original.run()).status).toBe('aborted');

    const interrupted = createEngine(parent, {
      ...options, reportDirName: 'interrupted',
      resumeSource: { sourceRunSlug: 'original', resumeMode: 'requeue' },
      sourceResumePoint: original.getResumePoint(),
      restartPoint: { stack: failurePoint === 'before_child'
        ? [buildWorkflowRestartPointEntry(parent, 'before_child', 'system')]
        : [buildWorkflowRestartPointEntry(parent, 'delegate', 'workflow_call', 1),
          buildWorkflowRestartPointEntry(child, 'consume', 'agent')],
      },
    });
    workflowCallResolver.mockClear();
    if (failurePoint === 'before_child') {
      resolveSystemInput.mockImplementationOnce(() => { throw new Error('Parent unavailable'); });
    } else {
      interrupted.on('workflow_call:start', () => { throw new Error('Call start interrupted'); });
    }
    expect((await interrupted.run()).status).toBe('aborted');
    expect(workflowCallResolver).not.toHaveBeenCalled();
    expect(interrupted.getState().systemContexts.size).toBe(failurePoint === 'before_child' ? 0 : 1);

    // The next retry must be self-contained in B even after A is removed.
    rmSync(join(project, '.takt', 'runs', 'original'), { recursive: true });
    executeEffect.mockResolvedValue({ success: true });
    const retry = createEngine(parent, {
      ...options, reportDirName: 'retry',
      resumeSource: { sourceRunSlug: 'interrupted', resumeMode: 'retry' },
      sourceResumePoint: interrupted.getResumePoint(),
      restartPoint: { stack: [
        buildWorkflowRestartPointEntry(parent, 'delegate', 'workflow_call', 1),
        buildWorkflowRestartPointEntry(child, 'consume', 'agent'),
      ] },
    });
    const failures = vi.fn();
    retry.on('workflow:abort', failures);

    expect((await retry.run()).status, JSON.stringify(failures.mock.calls)).toBe('completed');
    expect(executeEffect.mock.calls.map(([effect]) => effect.type)).toEqual(['caccia', 'comment_pr', 'comment_pr']);
    expect(executeEffect.mock.calls[2]?.[1]).toMatchObject({ pr: 123, body: 'head=child-head: approved' });
    expect(resolveSystemInput).toHaveBeenCalledTimes(failurePoint === 'before_child' ? 3 : 2);
    expect(runAgent).toHaveBeenCalledTimes(3);
  });

  function loopConfig(skipPlanOnReselection = false): WorkflowConfig {
    const config = normalizeWorkflowConfig({
      name: 'snapshot-loop', initial_step: 'begin', max_steps: 20,
      steps: [
        { name: 'begin', mode: 'system', rules: [{ condition: 'when(true)', next: 'select' }] },
        { name: 'select', mode: 'system', system_inputs: [{ type: 'pr_status', source: 'current_pr', as: 'pr' }],
          rules: skipPlanOnReselection
            ? [{ condition: 'when(context.select.pr.number == 101)', next: 'plan' },
              { condition: 'when(true)', next: 'enqueue' }]
            : [{ condition: 'when(true)', next: 'plan' }] },
        { name: 'plan', instruction: 'Plan {context:select.pr.number}',
          rules: [{ condition: 'when(context.select.pr.number == 101)', next: 'select' },
            { condition: 'when(true)', next: 'enqueue' }] },
        { name: 'enqueue', mode: 'system', effects: [{ type: 'comment_pr', pr: '{context:select.pr.number}',
          body: '{structured:plan.task}' }], rules: [{ condition: 'when(true)', next: 'COMPLETE' }] },
      ],
    }, project);
    const plan = config.steps[2]!;
    if (plan.kind !== 'agent') throw new Error('Expected agent step');
    plan.structuredOutput = {
      schemaRef: 'inline-test', schema: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'] },
    };
    return config;
  }

  it.each(['bigint', 'circular', 'write'] as const)('R1 resumes with empty results after the latest loop save fails (%s)', async (failure) => {
    const config = loopConfig();
    const resolveSystemInput = vi.fn().mockReturnValueOnce({ number: 101 }).mockReturnValue({ number: 202 });
    const executeEffect = vi.fn<SystemStepServices['executeEffect']>().mockResolvedValue({ success: true });
    let broken = false;
    vi.mocked(runAgent).mockImplementation(async (_persona, instruction, options) => {
      options.onPromptResolved?.({ systemPrompt: '', userInstruction: instruction });
      const output: Record<string, unknown> = { task: instruction.includes('Plan 202') ? 'Plan 202' : 'Plan 101' };
      if (instruction.includes('Plan 202')) {
        if (failure === 'bigint') output.extra = 1n;
        if (failure === 'circular') output.extra = output;
        broken = true;
      }
      return { persona: 'plan', status: 'done', content: 'planned', timestamp: new Date(), structuredOutput: output };
    });
    const write = atomicFile.writeFileAtomic;
    const save = vi.spyOn(atomicFile, 'writeFileAtomic').mockImplementation((path, content, mode) => {
      if (broken && failure === 'write' && path.endsWith('workflow-results.json')) throw new Error('disk unavailable');
      write(path, content, mode);
    });
    const warning = vi.spyOn(LogManager.getInstance(), 'warn');
    try {
      const options = { systemStepServicesFactory: () => ({ resolveSystemInput, executeEffect }) };
      const original = createEngine(config, options);
      for (let i = 0; i < 5; i++) await original.runSingleIteration();
      const checkpoint = original.getResumePoint()!;
      expect(checkpoint.stack[0]).toMatchObject({ step: 'enqueue', occurrence: 1 });
      expect(executeEffect).not.toHaveBeenCalled();
      save.mockRestore();
      warning.mockClear();
      const resumed = createEngine(config, {
        ...options, reportDirName: 'resumed', startStep: 'enqueue', resumePoint: checkpoint,
        resumeSource: { sourceRunSlug: 'original', resumeMode: 'retry' },
      });
      expect(warning).toHaveBeenCalled();
      expect(resumed.getState().systemContexts.size).toBe(0);
      expect(resumed.getState().structuredOutputs.size).toBe(0);
      expect((await resumed.run()).status).toBe('aborted');
      expect(executeEffect).not.toHaveBeenCalled();
    } finally {
      save.mockRestore();
      warning.mockRestore();
    }
  });

  it('keeps written bytes per occurrence constant as history grows', () => {
    const config = loopConfig();
    const source = join(project, 'source-context');
    mkdirSync(source);
    const state = createInitialState(config, { projectCwd: project, startStep: 'select' });
    const store = new WorkflowResultsStore(source, config, state);
    store.initialize(source, false, false);
    const write = vi.spyOn(atomicFile, 'writeFileAtomic');
    try {
      const bytes: number[] = [];
      for (let occurrence = 1; occurrence <= 40; occurrence++) {
        write.mockClear();
        state.systemContexts.set('select', { pr: { number: String(occurrence).padStart(3, '0') } });
        store.startStep('select', occurrence);
        store.save();
        bytes.push(write.mock.calls.reduce((total, [, content]) => total + Buffer.byteLength(content), 0));
      }
      expect(bytes[0]).toBeGreaterThan(0);
      expect(new Set(bytes).size).toBe(1);
      const restored = createInitialState(config, { projectCwd: project, startStep: 'select' });
      const target = join(project, 'target-context');
      mkdirSync(target);
      new WorkflowResultsStore(target, config, restored).initialize(source, true, true, 1);
      expect(restored.systemContexts.get('select')).toEqual({ pr: { number: '001' } });
      const latest = createInitialState(config, { projectCwd: project, startStep: 'select' });
      new WorkflowResultsStore(target, config, latest).initialize(target, true, false);
      expect(latest.systemContexts.get('select')).toEqual({ pr: { number: '001' } });
    } finally { write.mockRestore(); }
  });

  it('starts another resume with the empty state restored from a failed occurrence', () => {
    const config = loopConfig();
    const source = join(project, 'source-context');
    const target = join(project, 'target-context');
    const retry = join(project, 'retry-context');
    for (const directory of [source, target, retry]) mkdirSync(directory);
    const state = createInitialState(config, { projectCwd: project, startStep: 'select' });
    const store = new WorkflowResultsStore(source, config, state);
    store.initialize(source, false, false);
    state.systemContexts.set('select', { pr: { number: 101 } });
    store.startStep('select', 1);
    const warning = vi.spyOn(LogManager.getInstance(), 'warn');
    const write = vi.spyOn(atomicFile, 'writeFileAtomic').mockImplementation(() => { throw new Error('disk unavailable'); });
    try {
      store.startStep('select', 2);
      write.mockRestore();
      state.systemContexts.set('select', { pr: { number: 202 } });
      store.save();
      const resumed = createInitialState(config, { projectCwd: project, startStep: 'select' });
      new WorkflowResultsStore(target, config, resumed).initialize(source, true, true, 2);
      expect(resumed.systemContexts.size).toBe(0);
      warning.mockClear();
      const resumedAgain = createInitialState(config, { projectCwd: project, startStep: 'select' });
      new WorkflowResultsStore(retry, config, resumedAgain).initialize(target, true, false, 2);
      expect(resumedAgain.systemContexts.size).toBe(0);
      expect(warning).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
      warning.mockRestore();
    }
  });

  it.each([2, undefined])('keeps a failed directory creation distinct from an unstarted occurrence (%s)', (occurrence) => {
    const config = loopConfig();
    const source = join(project, 'source-context');
    const target = join(project, 'target-context');
    mkdirSync(source);
    mkdirSync(target);
    const state = createInitialState(config, { projectCwd: project, startStep: 'select' });
    const store = new WorkflowResultsStore(source, config, state);
    store.initialize(source, false, false);
    state.systemContexts.set('select', { pr: { number: 101 } });
    store.startStep('select', 1);
    const failedDirectory = join(source, 'workflow-results', 'step-select', '2');
    const makeDirectory = fs.mkdirSync;
    const mkdir = vi.spyOn(fs, 'mkdirSync').mockImplementation((path, options) => {
      if (path === failedDirectory) throw new Error('Directory unavailable');
      return makeDirectory(path, options);
    });
    const warning = vi.spyOn(LogManager.getInstance(), 'warn');
    try {
      store.startStep('select', 2);
      mkdir.mockRestore();
      expect(existsSync(failedDirectory)).toBe(false);
      state.systemContexts.set('select', { pr: { number: 202 } });
      store.save();
      state.systemContexts.set('select', { pr: { number: 303 } });
      store.startStep('plan', 1);
      warning.mockClear();

      const resumed = createInitialState(config, { projectCwd: project, startStep: 'select' });
      new WorkflowResultsStore(target, config, resumed).initialize(source, true, false, occurrence);

      expect(warning).toHaveBeenCalled();
      expect(resumed.systemContexts.size).toBe(0);
      expect(resumed.effectResults.size).toBe(0);
      expect(resumed.structuredOutputs.size).toBe(0);
      const unstarted = createInitialState(config, { projectCwd: project, startStep: 'select' });
      new WorkflowResultsStore(target, config, unstarted).initialize(source, true, false, 3);
      expect(unstarted.systemContexts.get('select')).toEqual({ pr: { number: 303 } });
    } finally {
      mkdir.mockRestore();
      warning.mockRestore();
    }
  });

  it.each([false, true])('validates the selected occurrence without a root artifact (workflow changed: %s)', (renamed) => {
    const config = loopConfig();
    const source = join(project, 'source-context');
    const target = join(project, 'target-context');
    mkdirSync(source);
    mkdirSync(target);
    const state = createInitialState(config, { projectCwd: project, startStep: 'select' });
    const store = new WorkflowResultsStore(source, config, state);
    store.initialize(source, false, false);
    state.systemContexts.set('select', { pr: { number: 101 } });
    store.startStep('select', 1);
    state.systemContexts.set('select', { pr: { number: 202 } });
    store.save();
    rmSync(join(source, 'workflow-results.json'));
    const current = renamed ? { ...config, name: 'another-workflow' } : config;
    const restored = createInitialState(current, { projectCwd: project, startStep: 'select' });
    const restore = () => new WorkflowResultsStore(target, current, restored).initialize(source, true, false, 1);

    if (renamed) {
      expect(restore).toThrow();
      expect(restored.systemContexts.size).toBe(0);
    } else {
      restore();
      expect(restored.systemContexts.get('select')).toEqual({ pr: { number: 101 } });
    }
  });

  it.each(['.DS_Store', 'notes', '03', '3.5', '3e2', 'Infinity'])('ignores %s when selecting the latest occurrence', (entry) => {
    const config = loopConfig();
    const source = join(project, 'source-context');
    const target = join(project, 'target-context');
    mkdirSync(source);
    mkdirSync(target);
    const state = createInitialState(config, { projectCwd: project, startStep: 'select' });
    const store = new WorkflowResultsStore(source, config, state);
    store.initialize(source, false, false);
    state.systemContexts.set('select', { pr: { number: 101 } });
    store.startStep('select', 1);
    state.systemContexts.set('select', { pr: { number: 202 } });
    store.startStep('select', 2);
    state.systemContexts.set('select', { pr: { number: 303 } });
    store.save();
    const unrelatedPath = join(source, 'workflow-results', 'step-select', entry);
    if (entry === '.DS_Store') writeFileSync(unrelatedPath, 'metadata');
    else mkdirSync(unrelatedPath);
    const restored = createInitialState(config, { projectCwd: project, startStep: 'select' });

    new WorkflowResultsStore(target, config, restored).initialize(source, true, false);

    expect(restored.systemContexts.get('select')).toEqual({ pr: { number: 202 } });
  });

  it('inherits only child results with saved workflow call namespace names', () => {
    const config = loopConfig();
    const source = join(project, 'source-context');
    const target = join(project, 'target-context');
    const namespace = buildWorkflowCallNamespaceSegment('delegate', config.name, 1);
    for (const entry of [namespace, '.DS_Store', 'notes']) {
      const directory = join(source, 'subworkflows', entry);
      mkdirSync(directory, { recursive: true });
      const state = createInitialState(config, { projectCwd: project });
      state.systemContexts.set('select', { pr: { number: 101 } });
      new WorkflowResultsStore(directory, config, state).save();
    }

    inheritWorkflowResults(source, target);

    expect(fs.readdirSync(join(target, 'subworkflows'))).toEqual([namespace]);
    expect(JSON.parse(readFileSync(join(target, 'subworkflows', namespace, 'workflow-results.json'), 'utf8')))
      .toMatchObject({ latest: { context: { select: { pr: { number: 101 } } } } });
  });

  it.each(['large-history', 'unreadable'] as const)('handles occurrence enumeration with %s', (scenario) => {
    const config = loopConfig();
    const source = join(project, 'source-context');
    const target = join(project, 'target-context');
    mkdirSync(source);
    mkdirSync(target);
    const state = createInitialState(config, { projectCwd: project, startStep: 'select' });
    const store = new WorkflowResultsStore(source, config, state);
    store.initialize(source, false, false);
    state.systemContexts.set('select', { pr: { number: 101 } });
    store.startStep('select', 200000);
    state.systemContexts.set('select', { pr: { number: 202 } });
    store.save();
    const read = vi.spyOn(fs, 'readdirSync');
    if (scenario === 'large-history') read.mockReturnValueOnce(
      Array.from({ length: 200000 }, (_, index) => String(index + 1)) as unknown as ReturnType<typeof fs.readdirSync>,
    );
    else read.mockImplementationOnce(() => { throw new Error('Directory unreadable'); });
    const warning = vi.spyOn(LogManager.getInstance(), 'warn');
    try {
      const restored = createInitialState(config, { projectCwd: project, startStep: 'select' });
      new WorkflowResultsStore(target, config, restored).initialize(source, true, false);

      if (scenario === 'large-history') {
        expect(restored.systemContexts.get('select')).toEqual({ pr: { number: 101 } });
        expect(warning).not.toHaveBeenCalled();
      } else {
        expect(restored.systemContexts.size).toBe(0);
        expect(restored.effectResults.size).toBe(0);
        expect(restored.structuredOutputs.size).toBe(0);
        expect(warning).toHaveBeenCalled();
      }
    } finally {
      read.mockRestore();
      warning.mockRestore();
    }
  });

  it('does not substitute a newer valid state for a failed occurrence snapshot', () => {
    const config = loopConfig();
    const source = join(project, 'source-context');
    const target = join(project, 'target-context');
    mkdirSync(source);
    mkdirSync(target);
    const state = createInitialState(config, { projectCwd: project, startStep: 'select' });
    const store = new WorkflowResultsStore(source, config, state);
    store.initialize(source, false, false);
    state.systemContexts.set('select', { pr: { number: 101 } });
    store.startStep('select', 1);
    state.structuredOutputs.set('plan', { task: 'Plan 101', extra: 1n });
    const warning = vi.spyOn(LogManager.getInstance(), 'warn');
    try {
      store.startStep('select', 2);
      state.structuredOutputs.set('plan', { task: 'Plan 202' });
      state.systemContexts.set('select', { pr: { number: 202 } });
      store.save();
      warning.mockClear();
      const resumed = createInitialState(config, { projectCwd: project, startStep: 'select' });
      new WorkflowResultsStore(target, config, resumed).initialize(source, true, false, 2);
      expect(warning).toHaveBeenCalledOnce();
      expect(resumed.systemContexts.size).toBe(0);
      expect(resumed.effectResults.size).toBe(0);
      expect(resumed.structuredOutputs.size).toBe(0);
    } finally { warning.mockRestore(); }
  });

  it('R2 restores the full state before a failed second selection and supports selecting an earlier occurrence', async () => {
    const config = loopConfig(true);
    const resolveSystemInput = vi.fn().mockReturnValueOnce({ number: 101 })
      .mockImplementationOnce(() => { throw new Error('selection interrupted'); }).mockReturnValue({ number: 202 });
    const executeEffect = vi.fn<SystemStepServices['executeEffect']>().mockResolvedValue({ success: true });
    vi.mocked(runAgent).mockImplementation(async (_persona, instruction, options) => {
      options.onPromptResolved?.({ systemPrompt: '', userInstruction: instruction });
      return { persona: 'plan', status: 'done', content: 'planned', timestamp: new Date(), structuredOutput: { task: instruction.includes('Plan 202') ? 'Plan 202' : 'Plan 101' } };
    });
    const options = { systemStepServicesFactory: () => ({ resolveSystemInput, executeEffect }) };
    const original = createEngine(config, options);
    await original.runSingleIteration();
    await original.runSingleIteration();
    await original.runSingleIteration();
    const before = original.getState();
    await expect(original.runSingleIteration()).rejects.toThrow();
    const checkpoint = original.getResumePoint()!;
    expect(checkpoint.stack[0]).toMatchObject({ step: 'select', occurrence: 2 });
    const resumed = createEngine(config, {
      ...options, reportDirName: 'resumed', startStep: 'select', resumePoint: checkpoint,
      resumeSource: { sourceRunSlug: 'original', resumeMode: 'retry' },
    });
    expect(resumed.getState().systemContexts).toEqual(before.systemContexts);
    expect(resumed.getState().structuredOutputs).toEqual(before.structuredOutputs);
    expect(resumed.getState().effectResults).toEqual(before.effectResults);
    expect((await resumed.run()).status).toBe('completed');
    expect(executeEffect.mock.calls[0]?.[1]).toMatchObject({ pr: 202, body: 'Plan 101' });
    const earlier = createEngine(config, {
      ...options, reportDirName: 'earlier', startStep: 'select',
      resumePoint: { ...checkpoint, stack: [buildWorkflowResumePointEntry(config, 'select', 'system', 1)] },
      resumeSource: { sourceRunSlug: 'original', resumeMode: 'retry' },
    });
    expect(earlier.getState().systemContexts.get('begin')).toEqual({});
    expect(earlier.getState().systemContexts.has('select')).toBe(false);
    expect(earlier.getState().structuredOutputs.size).toBe(0);
    expect((await earlier.run()).status).toBe('aborted');
    expect(executeEffect).toHaveBeenCalledOnce();
    expect(runAgent).toHaveBeenCalledOnce();
  });

  it('R4 restores the latest completed state when the checkpoint points to an unstarted second plan', async () => {
    const config = loopConfig();
    const resolveSystemInput = vi.fn().mockReturnValueOnce({ number: 101 }).mockReturnValue({ number: 202 });
    const executeEffect = vi.fn<SystemStepServices['executeEffect']>().mockResolvedValue({ success: true });
    vi.mocked(runAgent).mockImplementation(async (_persona, instruction, options) => {
      options.onPromptResolved?.({ systemPrompt: '', userInstruction: instruction });
      return { persona: 'plan', status: 'done', content: 'planned', timestamp: new Date(), structuredOutput: { task: instruction.includes('Plan 202') ? 'Plan 202' : 'Plan 101' } };
    });
    const options = { systemStepServicesFactory: () => ({ resolveSystemInput, executeEffect }) };
    const original = createEngine(config, options);
    for (let i = 0; i < 4; i++) await original.runSingleIteration();
    const checkpoint = original.getResumePoint()!;
    expect(checkpoint.stack[0]).toMatchObject({ step: 'plan', occurrence: 2 });
    const resumed = createEngine(config, {
      ...options, reportDirName: 'resumed', startStep: 'plan', resumePoint: checkpoint,
      resumeSource: { sourceRunSlug: 'original', resumeMode: 'retry' },
    });
    expect(resumed.getState().systemContexts.get('select')).toEqual({ pr: { number: 202 } });
    expect(resumed.getState().structuredOutputs.get('plan')).toEqual({ task: 'Plan 101' });
    expect((await resumed.run()).status).toBe('completed');
    expect(executeEffect.mock.calls[0]?.[1]).toMatchObject({ pr: 202, body: 'Plan 202' });
    expect(resolveSystemInput).toHaveBeenCalledTimes(2);
  });

  it.each(['start_step', 'restart_point'] as const)('restores B’s latest selection when C resumes its unstarted plan after %s', async (mode) => {
    const config = loopConfig();
    const resolveSystemInput = vi.fn().mockReturnValueOnce({ number: 101 }).mockReturnValue({ number: 202 });
    const executeEffect = vi.fn<SystemStepServices['executeEffect']>().mockResolvedValue({ success: true });
    vi.mocked(runAgent).mockImplementation(async (_persona, instruction, options) => {
      options.onPromptResolved?.({ systemPrompt: '', userInstruction: instruction });
      return { persona: 'plan', status: 'done', content: 'planned', timestamp: new Date(),
        structuredOutput: { task: instruction.includes('Plan 202') ? 'Plan 202' : 'Plan 101' } };
    });
    const options = { systemStepServicesFactory: () => ({ resolveSystemInput, executeEffect }) };
    const original = createEngine(config, options);
    for (let i = 0; i < 3; i++) await original.runSingleIteration();
    expect(original.getState().structuredOutputs.get('plan')).toEqual({ task: 'Plan 101' });

    const intermediate = createEngine(config, {
      ...options, reportDirName: 'intermediate', maxStepsOverride: 1,
      resumeSource: { sourceRunSlug: 'original', resumeMode: 'retry' },
      ...(mode === 'start_step' ? { startStep: 'select' } : {
        sourceResumePoint: original.getResumePoint(),
        restartPoint: { stack: [buildWorkflowRestartPointEntry(config, 'select', 'system')] },
      }),
    });
    expect((await intermediate.run()).status).toBe('aborted');
    const checkpoint = intermediate.getResumePoint()!;
    expect(checkpoint.stack[0]).toMatchObject({ step: 'plan', occurrence: 1 });
    expect(runAgent).toHaveBeenCalledOnce();
    rmSync(join(project, '.takt', 'runs', 'original'), { recursive: true });

    const resumed = createEngine(config, {
      ...options, reportDirName: 'resumed', startStep: 'plan', resumePoint: checkpoint,
      resumeSource: { sourceRunSlug: 'intermediate', resumeMode: 'requeue' },
    });
    expect(resumed.getState().systemContexts.get('select')).toEqual({ pr: { number: 202 } });
    expect((await resumed.run()).status).toBe('completed');
    expect(executeEffect.mock.calls.map(([, params]) => params)).toEqual([
      { type: 'comment_pr', pr: 202, body: 'Plan 202' },
    ]);
    expect(resolveSystemInput).toHaveBeenCalledTimes(2);
  });

  it('keeps only the selected child state when a retry stops before entering that child', async () => {
    const parent = normalizeWorkflowConfig({
      name: 'parent', initial_step: 'delegate', max_steps: 20,
      steps: [{ name: 'delegate', kind: 'workflow_call', call: 'snapshot-loop',
        rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }] }],
    }, project);
    const child = normalizeWorkflowConfig({
      name: 'snapshot-loop', subworkflow: { callable: true }, initial_step: 'select', max_steps: 20,
      steps: [
        { name: 'select', mode: 'system', system_inputs: [{ type: 'pr_status', source: 'current_pr', as: 'pr' }],
          rules: [{ condition: 'when(true)', next: 'plan' }] },
        { name: 'plan', instruction: 'Plan {context:select.pr.number}',
          rules: [{ condition: 'when(context.select.pr.number == 101)', next: 'select' },
            { condition: 'when(true)', next: 'observe' }] },
        { name: 'observe', instruction: 'Saved plan: {structured:plan.task}',
          rules: [{ condition: 'when(true)', next: 'enqueue' }] },
        { name: 'enqueue', mode: 'system', effects: [{ type: 'comment_pr', pr: '{context:select.pr.number}',
          body: '{structured:plan.task}' }], rules: [{ condition: 'when(true)', next: 'COMPLETE' }] },
      ],
    }, project);
    const plan = child.steps[1]!;
    if (plan.kind !== 'agent') throw new Error('Expected agent step');
    plan.structuredOutput = {
      schemaRef: 'inline-test', schema: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'] },
    };
    const resolveSystemInput = vi.fn().mockReturnValueOnce({ number: 101 }).mockReturnValue({ number: 202 });
    const executeEffect = vi.fn<SystemStepServices['executeEffect']>().mockResolvedValue({ success: true });
    vi.mocked(runAgent).mockImplementation(async (_persona, instruction, options) => {
      options.onPromptResolved?.({ systemPrompt: '', userInstruction: instruction });
      return { persona: 'plan', status: 'done', content: 'planned', timestamp: new Date(),
        structuredOutput: { task: instruction.includes('Plan 202') ? 'Plan 202' : 'Plan 101' } };
    });
    const options = { workflowCallResolver: () => child,
      systemStepServicesFactory: () => ({ resolveSystemInput, executeEffect }) };
    const original = createEngine(parent, options);
    expect((await original.run()).status).toBe('completed');
    expect(executeEffect.mock.calls[0]?.[1]).toMatchObject({ pr: 202, body: 'Plan 202' });

    const interrupted = createEngine(parent, {
      ...options, reportDirName: 'interrupted', sourceResumePoint: original.getResumePoint(),
      resumeSource: { sourceRunSlug: 'original', resumeMode: 'retry' },
      restartPoint: { stack: [buildWorkflowRestartPointEntry(parent, 'delegate', 'workflow_call', 1),
        buildWorkflowRestartPointEntry(child, 'plan', 'agent')] },
    });
    interrupted.on('workflow_call:start', () => { throw new Error('Call start interrupted'); });
    expect((await interrupted.run()).status).toBe('aborted');
    rmSync(join(project, '.takt', 'runs', 'original'), { recursive: true });
    vi.mocked(runAgent).mockClear();
    executeEffect.mockClear();

    const resumed = createEngine(parent, {
      ...options, reportDirName: 'resumed', sourceResumePoint: interrupted.getResumePoint(),
      resumeSource: { sourceRunSlug: 'interrupted', resumeMode: 'retry' },
      restartPoint: { stack: [buildWorkflowRestartPointEntry(parent, 'delegate', 'workflow_call', 1),
        buildWorkflowRestartPointEntry(child, 'observe', 'agent')] },
    });
    expect((await resumed.run()).status).toBe('completed');
    expect(vi.mocked(runAgent).mock.calls[0]?.[1]).toContain('Saved plan: Plan 101');
    expect(executeEffect.mock.calls.map(([, params]) => params)).toEqual([
      { type: 'comment_pr', pr: 202, body: 'Plan 101' },
    ]);
    expect(resolveSystemInput).toHaveBeenCalledTimes(2);
  });

  it('R4 restores the state of an unstarted call instance selected by restartPoint', async () => {
    const parent = normalizeWorkflowConfig({
      name: 'parent-call-loop', initial_step: 'select', max_steps: 20,
      steps: [
        { name: 'select', mode: 'system', system_inputs: [{ type: 'pr_status', source: 'current_pr', as: 'pr' }],
          rules: [{ condition: 'when(true)', next: 'delegate' }] },
        { name: 'delegate', kind: 'workflow_call', call: 'child', rules: [{ condition: 'COMPLETE', next: 'comment' }] },
        { name: 'comment', mode: 'system', effects: [{ type: 'comment_pr', pr: '{context:select.pr.number}', body: 'done' }],
          rules: [{ condition: 'when(context.select.pr.number == 101)', next: 'select' },
            { condition: 'when(true)', next: 'COMPLETE' }] },
      ],
    }, project);
    const child = normalizeWorkflowConfig({
      name: 'child', subworkflow: { callable: true }, initial_step: 'work', max_steps: 5,
      steps: [{ name: 'work', instruction: 'Work', rules: [{ condition: 'when(true)', next: 'COMPLETE' }] }],
    }, project);
    const resolveSystemInput = vi.fn().mockReturnValueOnce({ number: 101 }).mockReturnValue({ number: 202 });
    const executeEffect = vi.fn<SystemStepServices['executeEffect']>().mockResolvedValue({ success: true });
    const options = { workflowCallResolver: () => child, systemStepServicesFactory: () => ({ resolveSystemInput, executeEffect }) };
    const original = createEngine(parent, options);
    for (let i = 0; i < 4; i++) await original.runSingleIteration();
    const checkpoint = original.getResumePoint()!;
    expect(checkpoint.stack[0]).toMatchObject({ step: 'delegate', occurrence: 2, call_instance: 2 });
    const resumed = createEngine(parent, {
      ...options, reportDirName: 'resumed', sourceResumePoint: checkpoint,
      restartPoint: { stack: [buildWorkflowRestartPointEntry(parent, 'delegate', 'workflow_call', 1)] },
      resumeSource: { sourceRunSlug: 'original', resumeMode: 'retry' },
    });
    expect(resumed.getState().systemContexts.get('select')).toEqual({ pr: { number: 202 } });
    const calls = vi.fn();
    resumed.on('workflow_call:start', calls);
    expect((await resumed.run()).status).toBe('completed');
    expect(resumed.getResumePoint()?.workflow_call_invocations).toEqual(expect.objectContaining({
      [Object.keys(checkpoint.workflow_call_invocations)[0]!]: expect.objectContaining({ call_instance: 2 }),
    }));
    expect(calls).toHaveBeenCalledOnce();
    expect(resolveSystemInput).toHaveBeenCalledTimes(2);
    expect(executeEffect.mock.calls.map(([, params]) => params)).toEqual([
      { type: 'comment_pr', pr: 101, body: 'done' }, { type: 'comment_pr', pr: 202, body: 'done' },
    ]);
  });

  it('R6-1 restores parent results when continuing inside its initial call after a loop', async () => {
    const parent = normalizeWorkflowConfig({
      name: 'initial-call-loop', initial_step: 'delegate', max_steps: 20,
      steps: [
        { name: 'delegate', kind: 'workflow_call', call: 'child', rules: [{ condition: 'COMPLETE', next: 'gate' }] },
        { name: 'gate', mode: 'system', system_inputs: [{ type: 'pr_status', source: 'current_pr', as: 'visit' }],
          rules: [{ condition: 'when(context.gate.visit.number == 1)', next: 'select' },
            { condition: 'when(true)', next: 'consume' }] },
        { name: 'select', mode: 'system', system_inputs: [{ type: 'pr_status', source: 'current_pr', as: 'pr' }],
          rules: [{ condition: 'when(true)', next: 'prepare' }] },
        { name: 'prepare', mode: 'system', effects: [{ type: 'caccia', pr: '{context:select.pr.number}' }],
          rules: [{ condition: 'when(true)', next: 'plan' }] },
        { name: 'plan', instruction: 'Plan', rules: [{ condition: 'when(true)', next: 'delegate' }] },
        { name: 'consume', mode: 'system', effects: [{ type: 'comment_pr', pr: '{context:select.pr.number}',
          body: 'head={effect:prepare.caccia.headSha}: {structured:plan.verdict}' }],
          rules: [{ condition: 'when(true)', next: 'COMPLETE' }] },
      ],
    }, project);
    const plan = parent.steps.find((step) => step.name === 'plan')!;
    if (plan.kind !== 'agent') throw new Error('Expected agent step');
    plan.structuredOutput = { schemaRef: 'inline-test',
      schema: { type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'] } };
    const child = normalizeWorkflowConfig({
      name: 'child', subworkflow: { callable: true }, initial_step: 'read', max_steps: 5,
      steps: [
        { name: 'read', mode: 'system', system_inputs: [{ type: 'pr_status', source: 'current_pr', as: 'pr' }],
          rules: [{ condition: 'when(true)', next: 'work' }] },
        { name: 'work', instruction: 'Child PR {context:read.pr.number}', rules: [{ condition: 'when(true)', next: 'COMPLETE' }] },
      ],
    }, project);
    const resolveSystemInput = vi.fn().mockReturnValueOnce({ number: 11 }).mockReturnValueOnce({ number: 1 })
      .mockReturnValueOnce({ number: 101 }).mockReturnValueOnce({ number: 22 }).mockReturnValue({ number: 2 });
    const executeEffect = vi.fn<SystemStepServices['executeEffect']>(async (effect) => effect.type === 'caccia'
      ? { headSha: 'parent-head' } : { success: true });
    const run = vi.mocked(runAgent).getMockImplementation()!;
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      if (instruction.includes('Child PR 22')) throw new Error('child interrupted');
      return run(persona, instruction, options);
    });
    const options = { workflowCallResolver: () => child, systemStepServicesFactory: () => ({ resolveSystemInput, executeEffect }) };
    const original = createEngine(parent, options);
    expect((await original.run()).status).toBe('aborted');
    const checkpoint = original.getResumePoint()!;
    expect(checkpoint.stack.map(({ step, occurrence }) => ({ step, occurrence }))).toEqual([
      { step: 'delegate', occurrence: 2 }, { step: 'work', occurrence: 1 },
    ]);
    vi.mocked(runAgent).mockImplementation(run);
    const resumed = createEngine(parent, {
      ...options, reportDirName: 'resumed', sourceResumePoint: checkpoint,
      restartPoint: { stack: [buildWorkflowRestartPointEntry(parent, 'delegate', 'workflow_call', 1),
        buildWorkflowRestartPointEntry(child, 'work', 'agent')] },
      resumeSource: { sourceRunSlug: 'original', resumeMode: 'retry' },
    });
    const failures = vi.fn();
    resumed.on('workflow:abort', failures);
    const state = await resumed.run();
    expect(state.status, JSON.stringify(failures.mock.calls)).toBe('completed');
    expect(vi.mocked(runAgent).mock.lastCall?.[1]).toContain('Child PR 22');
    expect(resolveSystemInput).toHaveBeenCalledTimes(5);
    expect(executeEffect.mock.calls.map(([, params]) => params)).toEqual([
      { type: 'caccia', pr: 101 }, { type: 'comment_pr', pr: 101, body: 'head=parent-head: approved' },
    ]);
    const fresh = createEngine(parent, {
      ...options, reportDirName: 'fresh', sourceResumePoint: checkpoint,
      restartPoint: { stack: [buildWorkflowRestartPointEntry(parent, 'delegate', 'workflow_call', 1)] },
      resumeSource: { sourceRunSlug: 'original', resumeMode: 'retry' },
    });
    expect(fresh.getState().systemContexts.size).toBe(0);
    expect(fresh.getState().effectResults.size).toBe(0);
    expect(fresh.getState().structuredOutputs.size).toBe(0);
  });

  it('R3 does not copy a resumed child into a new call instance when the next call fails at start', async () => {
    const parent = normalizeWorkflowConfig({
      name: 'parent', initial_step: 'delegate', max_steps: 20,
      steps: [{ name: 'delegate', kind: 'workflow_call', call: 'child',
        rules: [{ condition: 'COMPLETE', next: 'delegate' }, { condition: 'ABORT', next: 'ABORT' }] }],
    }, project);
    const child = normalizeWorkflowConfig({
      name: 'child', subworkflow: { callable: true }, initial_step: 'read', max_steps: 20,
      steps: [
        { name: 'read', mode: 'system', system_inputs: [{ type: 'pr_status', source: 'current_pr', as: 'pr' }],
          rules: [{ condition: 'when(true)', next: 'consume' }] },
        { name: 'consume', instruction: 'Read {context:read.pr.number}',
          rules: [{ condition: 'when(true)', next: 'comment' }] },
        { name: 'comment', mode: 'system', effects: [{ type: 'comment_pr', pr: '{context:read.pr.number}', body: 'done' }],
          rules: [{ condition: 'when(true)', next: 'COMPLETE' }] },
      ],
    }, project);
    const resolveSystemInput = vi.fn(() => ({ number: 101 }));
    const executeEffect = vi.fn<SystemStepServices['executeEffect']>().mockRejectedValueOnce(new Error('child interrupted'))
      .mockResolvedValue({ success: true });
    const options = { workflowCallResolver: () => child, systemStepServicesFactory: () => ({ resolveSystemInput, executeEffect }) };
    const original = createEngine(parent, options);
    expect((await original.run()).status).toBe('aborted');
    const resumed = createEngine(parent, {
      ...options, reportDirName: 'resumed', resumePoint: original.getResumePoint(),
      resumeSource: { sourceRunSlug: 'original', resumeMode: 'retry' },
    });
    let starts = 0;
    resumed.on('workflow_call:start', () => { if (++starts === 2) throw new Error('next call interrupted'); });
    expect((await resumed.run()).status).toBe('aborted');
    expect(starts).toBe(2);
    const checkpoint = resumed.getResumePoint()!;
    expect(checkpoint.stack[0]).toMatchObject({ step: 'delegate', call_instance: 2 });
    const retry = createEngine(parent, {
      ...options, reportDirName: 'retry', sourceResumePoint: checkpoint,
      restartPoint: { stack: [buildWorkflowRestartPointEntry(parent, 'delegate', 'workflow_call', 1),
        buildWorkflowRestartPointEntry(child, 'consume', 'agent')] },
      resumeSource: { sourceRunSlug: 'resumed', resumeMode: 'retry' },
    });
    const warning = vi.spyOn(LogManager.getInstance(), 'warn');
    const failures = vi.fn();
    retry.on('workflow:abort', failures);
    try {
      expect((await retry.run()).status).toBe('aborted');
      expect(warning, JSON.stringify(failures.mock.calls)).toHaveBeenCalled();
      expect(resolveSystemInput).toHaveBeenCalledOnce();
      expect(executeEffect).toHaveBeenCalledTimes(2);
    } finally { warning.mockRestore(); }
  });

  it.each(['ja', 'en'] as const)('%s merge-prepare resumes at review with saved identify context', async (language) => {
    const config = loadWorkflowByIdentifier(join(process.cwd(), 'builtins', language, 'workflows', 'merge-prepare.yaml'), project)!;
    const child = normalizeWorkflowConfig({
      name: 'mock-review', subworkflow: { callable: true }, initial_step: 'review', max_steps: 2,
      steps: [{ name: 'review', instruction: 'Review', rules: [{ condition: 'when(true)', next: 'COMPLETE' }] }],
    }, project);
    let number = 100;
    const resolveSystemInput = vi.fn(() => ({
      number, headSha: 'reviewed-head', ci: { passed: true, finished: true },
      mergeable: 'MERGEABLE', reviewDecision: 'APPROVED', rerunHeadChanged: false,
    }));
    const executeEffect = vi.fn<SystemStepServices['executeEffect']>(async (effect) => ({
      success: true,
      ...(effect.type === 'sync_with_root' ? { resyncCount: 0, resyncLimit: 2 } : {}),
      ...(effect.type === 'caccia' ? { outcome: 'success', headSha: 'reviewed-head' } : {}),
    }));
    const options = {
      systemStepServicesFactory: () => ({ resolveSystemInput, executeEffect }),
      workflowCallResolver: () => child,
    };
    const original = createEngine(config, options);
    await original.runSingleIteration();
    await original.runSingleIteration();
    const checkpoint = original.getResumePoint()!;
    checkpoint.stack = [buildWorkflowResumePointEntry(config, 'review', 'workflow_call', 1, undefined, 1)];
    const resumed = createEngine(config, {
      ...options, startStep: 'review', reportDirName: 'resumed',
      resumeSource: { sourceRunSlug: 'original', resumeMode: 'requeue' },
      resumePoint: checkpoint,
    });
    number = 200;

    const aborted = vi.fn();
    resumed.on('workflow:abort', aborted);
    const state = await resumed.run();

    expect(state.status, JSON.stringify({ abort: aborted.mock.calls, outputs: [...state.stepOutputs.values()] })).toBe('completed');
    expect(state.systemContexts.get('identify')).toEqual({ pr: expect.objectContaining({ number: 100 }) });
    expect(resolveSystemInput).toHaveBeenCalledTimes(2);
    expect(executeEffect.mock.calls.map(([effect]) => effect.type)).toEqual(['sync_with_root', 'commit_and_push', 'caccia', 'comment_pr']);
    for (const call of executeEffect.mock.calls.slice(1)) expect(call[1]).toMatchObject({ pr: 100 });
  });
});

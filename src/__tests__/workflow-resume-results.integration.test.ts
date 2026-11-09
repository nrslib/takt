import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowConfig, WorkflowResumePoint } from '../core/models/types.js';
import type { WorkflowEngineOptions } from '../core/workflow/types.js';
import { WorkflowEngine } from '../core/workflow/index.js';
import { normalizeWorkflowConfig } from '../infra/config/loaders/workflowParser.js';
import { loadWorkflowByIdentifier } from '../infra/config/loaders/workflowResolver.js';
import { buildWorkflowRestartPointEntry, buildWorkflowResumePointEntry } from '../core/workflow/workflow-reference.js';
import type { SystemStepServices } from '../core/workflow/system/system-step-services.js';
import { runAgent } from '../agents/runner.js';
import { attachWorkflowOpaqueRef, buildBuiltinWorkflowRef } from '../shared/workflowConfigMetadata.js';
import { LogManager } from '../shared/ui/LogManager.js';

vi.mock('../agents/runner.js', () => ({ runAgent: vi.fn() }));

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
    ['start_step', false], ['resume_point', false], ['start_step', true], ['resume_point', true],
  ] as const)('%s restores all results without replay (reference changed: %s)', async (mode, referenceChanged) => {
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
      resumeSource: { sourceRunSlug: 'original', resumeMode: 'retry' },
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
      .toMatchObject({ context: {}, effect: {}, structured: {} });
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

  it('inherits child results across a retry that fails before entering the child', async () => {
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
    const original = createEngine(parent, options);
    expect((await original.run()).status).toBe('aborted');

    const interrupted = createEngine(parent, {
      ...options, reportDirName: 'interrupted',
      resumeSource: { sourceRunSlug: 'original', resumeMode: 'requeue' },
      sourceResumePoint: original.getResumePoint(),
      restartPoint: { stack: [buildWorkflowRestartPointEntry(parent, 'before_child', 'system')] },
    });
    workflowCallResolver.mockClear();
    resolveSystemInput.mockImplementationOnce(() => { throw new Error('Parent unavailable'); });
    expect((await interrupted.run()).status).toBe('aborted');
    expect(workflowCallResolver).not.toHaveBeenCalled();
    expect(interrupted.getState().systemContexts.size).toBe(0);

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
    expect(resolveSystemInput).toHaveBeenCalledTimes(3);
    expect(runAgent).toHaveBeenCalledTimes(3);
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

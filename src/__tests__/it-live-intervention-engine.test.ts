import { getLabel } from '../shared/i18n/index.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

vi.mock('../agents/runner.js', () => ({
  runAgent: vi.fn(),
}));

vi.mock('../core/workflow/evaluation/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/workflow/evaluation/index.js')>();
  const { MockRuleEvaluator } = await import('./rule-evaluator-test-double.js');
  return {
    ...actual,
    RuleEvaluator: MockRuleEvaluator,
  };
});

vi.mock('../core/workflow/phase-runner.js', () => ({
  runReportPhase: vi.fn().mockResolvedValue(undefined),
  runStatusJudgmentPhase: vi.fn().mockResolvedValue({ label: 'done', method: 'auto_select' }),
}));

const mockOutputWarn = vi.hoisted(() => vi.fn());
const liveInterventionReadFailure = vi.hoisted(() => ({ target: undefined as 'next' | 'terminal' | undefined }));

vi.mock('../infra/workflow/live-intervention-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../infra/workflow/live-intervention-store.js')>();
  type ActualStore = InstanceType<typeof actual.LiveInterventionFileStore>;

  class TestLiveInterventionFileStore extends actual.LiveInterventionFileStore {
    private inTerminal = false;

    override async recordTerminal(...args: Parameters<ActualStore['recordTerminal']>): Promise<number> {
      this.inTerminal = true;
      try {
        return await super.recordTerminal(...args);
      } finally {
        this.inTerminal = false;
      }
    }

    override read(): ReturnType<ActualStore['read']> {
      if (liveInterventionReadFailure.target === 'next'
        || (liveInterventionReadFailure.target === 'terminal' && this.inTerminal)) {
        liveInterventionReadFailure.target = undefined;
        throw new Error('deterministic live intervention read failure');
      }
      return super.read();
    }
  }

  return {
    ...actual,
    LiveInterventionFileStore: TestLiveInterventionFileStore,
  };
});

vi.mock('../shared/ui/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  warn: (...args: unknown[]) => mockOutputWarn(...args),
}));

import { runAgent } from '../agents/runner.js';
import { createTaktMcpServer } from '../app/mcp/server.js';
import { WorkflowEngine, type WorkflowEngineOptions } from '../core/workflow/index.js';
import { RuleEvaluator as ActualRuleEvaluator } from '../core/workflow/evaluation/RuleEvaluator.js';
import { runReportPhase, runStatusJudgmentPhase } from '../core/workflow/phase-runner.js';
import type { AgentResponse, LoopMonitorRule, WorkflowConfig } from '../core/models/index.js';
import type { LiveInterventionChannel } from '../core/workflow/live-intervention/types.js';
import { createLiveInterventionState, reduceLiveInterventionEvent } from '../core/workflow/live-intervention/state.js';
import { buildLiveInterventionPrompt } from '../core/workflow/live-intervention/prompt.js';
import { executeWorkflow } from '../features/tasks/execute/workflowExecution.js';
import * as workflowExecutionBundle from '../features/tasks/execute/workflowExecutionBundle.js';
import { issueTellableRunningTask } from '../features/tasks/liveIntervention.js';
import { resolveTaskSpecForExecution } from '../features/tasks/execute/taskSpecContext.js';
import { buildRunPaths } from '../core/workflow/run/run-paths.js';
import { TaskRunner } from '../infra/task/index.js';
import { stringify as stringifyYaml } from 'yaml';
import { LiveInterventionFileStore } from '../infra/workflow/live-intervention-store.js';
import { mockRuleEvaluation } from './rule-evaluator-test-double.js';
import { firstTextContent } from './helpers/mcp-content.js';
import {
  cleanupWorkflowEngine,
  createTestTmpDir,
  makeResponse,
  makeRule,
  makeStep,
} from './engine-test-helpers.js';

const REPORT_DIR = 'test-report-dir';

const STRUCTURED_RESULT_SCHEMA = {
  type: 'object',
  properties: { result: { type: 'string' } },
  required: ['result'],
  additionalProperties: false,
};

interface LiveWorkflowEngineOptions extends WorkflowEngineOptions {
  readonly liveIntervention: LiveInterventionChannel;
}

function createEngineOptions(
  projectCwd: string,
  store: LiveInterventionChannel,
  onLiveInterventionWarning?: (count: number) => void,
): LiveWorkflowEngineOptions {
  return {
    projectCwd,
    reportDirName: REPORT_DIR,
    provider: 'mock',
    liveIntervention: store,
    ...(onLiveInterventionWarning === undefined ? {} : { onLiveInterventionWarning }),
  };
}

function failLiveInterventionRead(target: 'next' | 'terminal'): void {
  liveInterventionReadFailure.target = target;
}

function clearLiveInterventionReadFailure(): void {
  liveInterventionReadFailure.target = undefined;
}

function createDeferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: resolvePromise,
  };
}

async function dispatchMockResponse(
  persona: string | undefined,
  instruction: string,
  options: Parameters<typeof runAgent>[2],
  response: AgentResponse,
): Promise<AgentResponse> {
  options.onPromptResolved?.({
    systemPrompt: persona ?? '',
    userInstruction: instruction,
  });
  options.onDispatch?.(options.permissionMode);
  return response;
}

function buildSingleStepConfig(
  rules: WorkflowConfig['steps'][number]['rules'],
): WorkflowConfig {
  return {
    name: 'live-intervention-engine',
    description: 'live intervention test workflow',
    maxSteps: 10,
    initialStep: 'review',
    steps: [
      makeStep('review', { rules }),
      makeStep('fix', { rules: [makeRule('done', 'COMPLETE')] }),
    ],
  };
}

function buildCompanionStatusConfig(name: string): WorkflowConfig {
  return {
    name,
    maxSteps: 1,
    initialStep: 'implement',
    companions: {
      reviewer: {
        name: 'reviewer',
        description: 'Review the implementation.',
        instruction: 'Review the implementation.',
        instructionRef: 'reviewer',
        intervalMs: 60_000,
      },
    },
    steps: [makeStep('implement', {
      companion: { fixed: ['reviewer'], pool: [] },
      rules: [makeRule('done', 'COMPLETE')],
    })],
  };
}

function createCompanionDiffReader(fixedDigest?: string) {
  let readCount = 0;
  return {
    readBaselineSha: vi.fn().mockResolvedValue('baseline-sha'),
    readDiff: vi.fn().mockImplementation(async () => {
      readCount += 1;
      const digest = fixedDigest ?? `current-digest-${readCount}`;
      return {
        status: 'ok' as const,
        snapshot: {
          digest,
          changedLines: 10,
          content: '+changed content\n',
          changedFiles: ['src/changed.ts'],
          fileFingerprints: { 'src/changed.ts': digest },
          hunkFingerprints: { 'src/changed.ts:1-10': digest },
          omittedBytes: 0,
          truncated: false,
        },
      };
    }),
  };
}

describe('WorkflowEngine live intervention integration', () => {
  let projectCwd: string;
  let engine: WorkflowEngine | undefined;

  beforeEach(() => {
    vi.resetAllMocks();
    clearLiveInterventionReadFailure();
    projectCwd = createTestTmpDir();
    vi.stubEnv('TAKT_CONFIG_DIR', join(projectCwd, 'config'));
    vi.mocked(mockRuleEvaluation).mockReturnValue({ index: 0, method: 'phase3_tag' });
    vi.mocked(runReportPhase).mockResolvedValue(undefined);
    vi.mocked(runStatusJudgmentPhase).mockResolvedValue({ label: 'done', method: 'auto_select' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (engine !== undefined) {
      cleanupWorkflowEngine(engine);
      engine = undefined;
    }
    if (existsSync(projectCwd)) {
      rmSync(projectCwd, { recursive: true, force: true });
    }
  });

  function createTellTaskSpecFixture(runSlug: string, source: 'task_dir' | 'content' | 'content_file' = 'task_dir') {
    const cloneCwd = join(projectCwd, '.takt', 'worktrees', 'tell-task');
    const originalOrder = '# Task\n\nOriginal task instructions.\n';
    const inputFile = join(projectCwd, 'task.txt');
    mkdirSync(cloneCwd, { recursive: true });
    if (source === 'task_dir') {
      mkdirSync(join(projectCwd, '.takt/tasks/tell-task'), { recursive: true });
      writeFileSync(join(projectCwd, '.takt/tasks/tell-task/order.md'), originalOrder, 'utf8');
    } else if (source === 'content_file') {
      writeFileSync(inputFile, originalOrder, 'utf8');
    }
    writeFileSync(join(projectCwd, '.takt', 'tasks.yaml'), stringifyYaml({
      tasks: [{
        name: 'tell-task', status: 'running', summary: 'Tell task',
        ...(source === 'task_dir' ? { task_dir: '.takt/tasks/tell-task' }
          : source === 'content' ? { content: originalOrder } : { content_file: 'task.txt' }),
        workflow: 'live-intervention-engine', worktree: true, worktree_path: cloneCwd,
        auto_pr: false, branch: 'feature/tell', run_slug: runSlug,
        created_at: '2026-10-18T00:00:00.000Z', started_at: '2026-10-18T00:00:00.000Z',
        completed_at: null,
      }],
    }), 'utf8');
    const runner = new TaskRunner(projectCwd);
    const running = runner.updateRunningTaskExecution('tell-task', { runSlug, worktreePath: cloneCwd });
    expect(running.taskDir).toBeDefined();
    const taskDir = running.taskDir!;
    const sourceOrderPath = join(projectCwd, taskDir, 'order.md');
    return {
      cloneCwd, taskDir, sourceOrderPath, inputFile, originalOrder,
      taskSpec: resolveTaskSpecForExecution(projectCwd, cloneCwd, taskDir, runSlug),
      runPaths: buildRunPaths(cloneCwd, runSlug),
      store: new LiveInterventionFileStore(projectCwd, runSlug),
    };
  }

  it('passes a tell received by the coder exactly once to later child agents and the parent planner', async () => {
    const runSlug = 'tell-coder-to-adjudicator';
    const fixture = createTellTaskSpecFixture(runSlug);
    const content = 'docs は変えない';
    const workflowDir = join(fixture.cloneCwd, '.takt', 'workflows');
    mkdirSync(workflowDir, { recursive: true });
    writeFileSync(join(workflowDir, 'tell-child.yaml'), stringifyYaml({
      name: 'tell-child',
      subworkflow: { callable: true },
      initial_step: 'adjudicate',
      max_steps: 3,
      steps: [
        { name: 'adjudicate', persona: 'Adjudicator role', instruction: 'Adjudicate this task.',
          rules: [{ condition: 'done', next: 'replan' }] },
        { name: 'replan', persona: 'Planner role', instruction: 'Replan this task.',
          rules: [{ condition: 'done', next: 'COMPLETE' }] },
      ],
    }), 'utf8');
    const config: WorkflowConfig = {
      name: 'tell-parent', maxSteps: 8, initialStep: 'implement',
      steps: [
        makeStep('implement', { persona: 'Coder role', rules: [makeRule('done', 'delegate')] }),
        { name: 'delegate', personaDisplayName: 'delegate', instruction: '', kind: 'workflow_call',
          call: './.takt/workflows/tell-child.yaml', rules: [makeRule('COMPLETE', 'finalize')] },
        makeStep('finalize', { persona: 'Parent planner role', instruction: 'Finalize this task.',
          rules: [makeRule('done', 'COMPLETE')] }),
      ],
    };
    const server = createTaktMcpServer({}, { allowedProjectRoot: projectCwd });
    const client = new Client({ name: 'tell-propagation-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      let issued = false;
      vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
        options.onPromptResolved?.({ systemPrompt: persona ?? '', userInstruction: instruction });
        options.onDispatch?.(options.permissionMode);
        if (!issued) {
          issued = true;
          expect(instruction).not.toContain(content);
          expect(readFileSync(fixture.runPaths.contextTaskOrderAbs, 'utf8')).toBe(fixture.originalOrder);
          const result = await client.callTool({
            name: 'takt_tell_run', arguments: { cwd: projectCwd, runSlug, content },
          });
          expect(result.isError, firstTextContent(result.content)).toBeUndefined();
          expect(fixture.store.read().pending).toBe(1);
        }
        return makeResponse({ content: 'done', sessionId: 'coder-session' });
      });

      const result = await executeWorkflow(config, fixture.taskSpec.taskPrompt, fixture.cloneCwd, {
        projectCwd, provider: 'mock', reportDirName: runSlug,
        taskSpec: fixture.taskSpec, language: 'ja', outputMode: 'silent',
      });

      expect(result.success).toBe(true);
      const calls = vi.mocked(runAgent).mock.calls;
      expect(calls).toHaveLength(5);
      expect(calls[1]?.[2].sessionId).toBe('coder-session');
      const sourceOrder = readFileSync(fixture.sourceOrderPath, 'utf8');
      expect(sourceOrder.split(content)).toHaveLength(2);
      expect(readFileSync(fixture.runPaths.contextTaskOrderAbs, 'utf8')).toBe(sourceOrder);
      expect(fixture.store.read()).toMatchObject({ pending: 0, deliveredSameSession: 1, deliveredNextStep: 0 });
      const deliveries = readFileSync(fixture.store.getFilePath(), 'utf8').trim().split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((event) => event.type === 'delivered');
      expect(deliveries).toHaveLength(1);
      for (const [index, marker] of ['Adjudicate this task.', 'Replan this task.', 'Finalize this task.'].entries()) {
        expect(calls[index + 2]?.[1]).toContain(marker);
      }
      for (const [index, call] of calls.slice(1).entries()) {
        expect.soft(call[1].split(content).length - 1, `prompt ${index + 1}`).toBe(1);
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('includes a new instruction arriving after preparation without duplicating delivered history', async () => {
    let liveState = reduceLiveInterventionEvent(createLiveInterventionState(), {
      type: 'issued', instructionId: 1, issuedAt: '2026-10-29T00:00:00.000Z', content: 'docs は変えない',
    });
    const channel: LiveInterventionChannel = {
      read: () => liveState,
      prepareDelivery: async (context) => ({
        instructionIds: liveState.instructions.filter((entry) => entry.state === 'pending').map((entry) => entry.instructionId),
        prompt: buildLiveInterventionPrompt(liveState.instructions, context.language), context,
      }),
      commitDelivery: vi.fn(async (delivery) => {
        liveState = reduceLiveInterventionEvent(liveState, {
          type: 'delivered', instructionIds: [...delivery.instructionIds],
          deliveredAt: '2026-10-29T00:00:02.000Z', ...delivery.context,
        });
      }),
      recordTerminal: async () => 0,
    };
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) =>
      dispatchMockResponse(persona, instruction, options, makeResponse({ content: 'done', sessionId: `${persona}-session` })));
    engine = new WorkflowEngine(
      buildSingleStepConfig([makeRule('done', 'fix')]),
      projectCwd, 'test task', createEngineOptions(projectCwd, channel),
    );
    let issuedAfterPreparation = false;
    engine.on('step:start', (step) => {
      if (step.name === 'fix') {
        expect(liveState.pending).toBe(0);
        liveState = reduceLiveInterventionEvent(liveState, {
          type: 'issued', instructionId: 2, issuedAt: '2026-10-29T00:00:01.000Z', content: 'focused tests only',
        });
        issuedAfterPreparation = true;
      }
    });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(issuedAfterPreparation).toBe(true);
    const calls = vi.mocked(runAgent).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[1]![1].split('docs は変えない')).toHaveLength(2);
    expect(calls[1]![1].split('focused tests only')).toHaveLength(2);
    expect(channel.commitDelivery).toHaveBeenCalledTimes(2);
    expect(liveState).toMatchObject({ pending: 0, deliveredNextStep: 2 });
  });

  it('passes delivered history and a new pending instruction once in issue order to subsequent agents', async () => {
    const store = new LiveInterventionFileStore(projectCwd, REPORT_DIR);
    const first = 'docs は変えない';
    const second = '対象のテストだけ実行する';
    await store.issue(first);
    vi.mocked(runReportPhase).mockImplementationOnce(async () => {
      await store.issue(second);
    });
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) =>
      dispatchMockResponse(persona, instruction, options, makeResponse({ content: 'done', sessionId: `${persona}-session` })));
    const config = buildSingleStepConfig([makeRule('done', 'fix')]);
    config.steps[0]!.outputContracts = [{ name: 'review.md', format: 'markdown' }];
    config.steps[1]!.rules = [makeRule('done', 'finalize')];
    config.steps.push(makeStep('finalize', { rules: [makeRule('done', 'COMPLETE')] }));
    engine = new WorkflowEngine(config, projectCwd, 'test task', createEngineOptions(projectCwd, store));

    const state = await engine.run();

    expect(state.status).toBe('completed');
    const calls = vi.mocked(runAgent).mock.calls;
    expect(calls).toHaveLength(3);
    expect(calls[0]![1].split(first)).toHaveLength(2);
    expect(calls[0]![1]).not.toContain(second);
    expect(store.read()).toMatchObject({ pending: 0, deliveredNextStep: 2, deliveredSameSession: 0 });
    const deliveries = readFileSync(store.getFilePath(), 'utf8').trim().split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((event) => event.type === 'delivered');
    expect(deliveries.map((event) => event.instructionIds)).toEqual([[1], [2]]);
    for (const [index, call] of calls.slice(1).entries()) {
      expect.soft(call[1].split(first).length - 1, `prompt ${index + 1}: first instruction`).toBe(1);
      expect.soft(call[1].split(second).length - 1, `prompt ${index + 1}: second instruction`).toBe(1);
      expect.soft(call[1].indexOf(first), `prompt ${index + 1}: issue order`).toBeLessThan(call[1].indexOf(second));
    }
  });

  it.each((['task_dir', 'content', 'content_file'] as const).flatMap((source) =>
    (['same_session', 'next_step'] as const).map((mode) => ({ source, mode })),
  ))('lets a later agent read $source instructions persisted after $mode delivery', async ({ source, mode }) => {
    const runSlug = 'tell-persisted-workflow';
    const fixture = createTellTaskSpecFixture(runSlug, source);
    const content = '後続の役もこの追加指示を読む。';
    const orderReads: string[] = [];
    let issued = false;
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      options.onPromptResolved?.({ systemPrompt: persona ?? '', userInstruction: instruction });
      options.onDispatch?.(options.permissionMode);
      orderReads.push(readFileSync(fixture.runPaths.contextTaskOrderAbs, 'utf8'));
      if (!issued && mode === 'same_session') {
        issued = true;
        await issueTellableRunningTask(projectCwd, runSlug, content);
        expect(readFileSync(fixture.sourceOrderPath, 'utf8')).not.toContain(content);
        expect(readFileSync(fixture.runPaths.contextTaskOrderAbs, 'utf8')).not.toContain(content);
      }
      return makeResponse({ content: 'done', sessionId: 'tell-session' });
    });
    const config = buildSingleStepConfig([makeRule('done', 'fix')]);
    if (mode === 'next_step') {
      config.steps[0]!.outputContracts = [{ name: 'review.md', format: 'markdown' }];
      vi.mocked(runReportPhase).mockImplementationOnce(async () => {
        await issueTellableRunningTask(projectCwd, runSlug, content);
        expect(readFileSync(fixture.sourceOrderPath, 'utf8')).not.toContain(content);
        expect(readFileSync(fixture.runPaths.contextTaskOrderAbs, 'utf8')).not.toContain(content);
      });
    }

    const result = await executeWorkflow(config, fixture.taskSpec.taskPrompt, fixture.cloneCwd, {
      projectCwd, provider: 'mock', reportDirName: runSlug,
      taskSpec: fixture.taskSpec, language: 'ja', outputMode: 'silent',
    });

    expect(result.success).toBe(true);
    expect(orderReads).toHaveLength(mode === 'same_session' ? 3 : 2);
    expect(orderReads[0]).toBe('# Task\n\nOriginal task instructions.\n');
    expect(orderReads[1]).toContain(content);
    expect(orderReads.at(-1)).toContain(content);
    const calls = vi.mocked(runAgent).mock.calls;
    if (mode === 'same_session') expect(calls[1]?.[2].sessionId).toBe('tell-session');
    expect(calls.at(-1)?.[1]).toContain(fixture.runPaths.contextTaskOrderRel);
    expect(fixture.store.read()).toMatchObject({ pending: 0,
      deliveredSameSession: mode === 'same_session' ? 1 : 0,
      deliveredNextStep: mode === 'next_step' ? 1 : 0 });
    const delivered = fixture.store.read().instructions[0]!;
    const original = readFileSync(fixture.sourceOrderPath, 'utf8');
    expect(original.startsWith(fixture.originalOrder)).toBe(true);
    for (const text of [content, `instructionId: ${delivered.instructionId}`, delivered.issuedAt]) {
      expect(original).toContain(text);
      expect(orderReads.at(-1)).toContain(text);
    }
    if (source === 'content_file') expect(readFileSync(fixture.inputFile, 'utf8')).toBe(fixture.originalOrder);
    for (const call of calls.slice(1)) {
      expect.soft(call[1].split(content).length - 1).toBe(1);
    }
  });

  it.each(['same_session', 'next_step'] as const)(
    'delivers an issued instruction through %s even when appending the source order fails',
    async (mode) => {
      const runSlug = `tell-append-failure-${mode.replaceAll('_', '-')}`;
      const fixture = createTellTaskSpecFixture(runSlug);
      const content = 'order.md の失敗で配送を止めない。';
      const issueWithAppendFailure = async () => {
        rmSync(fixture.sourceOrderPath);
        mkdirSync(fixture.sourceOrderPath);
        await expect(issueTellableRunningTask(projectCwd, runSlug, content)).resolves.toMatchObject({ instructionId: 1 });
      };
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      if (mode === 'next_step') {
        vi.mocked(runReportPhase).mockImplementationOnce(issueWithAppendFailure);
      }
      let agentCalls = 0;
      vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
        agentCalls += 1;
        options.onPromptResolved?.({ systemPrompt: persona ?? '', userInstruction: instruction });
        options.onDispatch?.(options.permissionMode);
        if (mode === 'same_session' && agentCalls === 1) await issueWithAppendFailure();
        return makeResponse({ content: 'done', sessionId: 'append-failure-session' });
      });
      const config = buildSingleStepConfig([makeRule('done', 'fix')]);
      config.steps[0]!.outputContracts = [{ name: 'review.md', format: 'markdown' }];

      const result = await executeWorkflow(config, fixture.taskSpec.taskPrompt, fixture.cloneCwd, {
        projectCwd, provider: 'mock', reportDirName: runSlug,
        taskSpec: fixture.taskSpec, language: 'ja', outputMode: 'silent',
      });

      expect(result.success).toBe(true);
      const calls = vi.mocked(runAgent).mock.calls;
      expect(calls).toHaveLength(mode === 'same_session' ? 3 : 2);
      expect(calls[1]?.[1]).toContain(content);
      if (mode === 'same_session') expect(calls[1]?.[2].sessionId).toBe('append-failure-session');
      expect(fixture.store.read()).toMatchObject({
        pending: 0,
        deliveredSameSession: mode === 'same_session' ? 1 : 0,
        deliveredNextStep: mode === 'next_step' ? 1 : 0,
      });
      const events = readFileSync(fixture.store.getFilePath(), 'utf8').trim().split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(events.filter((event) => event.type === 'issued')).toEqual([
        { type: 'issued', instructionId: 1, issuedAt: expect.any(String), content },
      ]);
      expect(events.find((event) => event.type === 'delivered')).toMatchObject({ mode, instructionIds: [1] });
      expect(calls.at(-1)?.[1].split(content).length).toBe(2);
    },
  );

  it.each((['task_dir', 'content', 'content_file'] as const).flatMap((source) =>
    [true, false].map((delivered) => ({ source, delivered })),
  ))('restores only delivered instructions after requeue from $source (delivered=$delivered)', async ({ source, delivered }) => {
    const runSlug = 'tell-before-resume';
    const fixture = createTellTaskSpecFixture(runSlug, source);
    const content = '再開後もこの追加指示を保持する。';
    let issued = false;
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      options.onPromptResolved?.({ systemPrompt: persona ?? '', userInstruction: instruction });
      if (delivered) options.onDispatch?.(options.permissionMode);
      if (!issued) {
        issued = true;
        await issueTellableRunningTask(projectCwd, runSlug, content);
        expect(readFileSync(fixture.sourceOrderPath, 'utf8')).not.toContain(content);
        if (delivered) return makeResponse({ content: 'done', sessionId: 'before-resume' });
      }
      return makeResponse({ status: 'error', error: 'deterministic failure before resume', content: 'failed' });
    });
    const config = buildSingleStepConfig([makeRule('done', 'COMPLETE')]);
    const failed = await executeWorkflow(config, fixture.taskSpec.taskPrompt, fixture.cloneCwd, {
      projectCwd, provider: 'mock', reportDirName: runSlug,
      taskSpec: fixture.taskSpec, language: 'ja', outputMode: 'silent',
    });
    expect(failed.success).toBe(false);
    expect(fixture.store.read().deliveredSameSession).toBe(delivered ? 1 : 0);
    const expectedOrder = readFileSync(fixture.sourceOrderPath, 'utf8');
    expect(expectedOrder.includes(content)).toBe(delivered);
    expect(readFileSync(fixture.runPaths.contextTaskOrderAbs, 'utf8')).toBe(expectedOrder);
    const runner = new TaskRunner(projectCwd);
    runner.forceFailRunningTask('tell-task', { error: 'deterministic failure before resume', step: 'review' });
    runner.requeueTask('tell-task', ['failed']);
    const [claimed] = runner.claimNextTasks(1);
    expect(claimed?.taskDir).toBe(fixture.taskDir);
    const resumedSlug = 'tell-after-resume';
    runner.updateRunningTaskExecution('tell-task', { runSlug: resumedSlug });
    const resumedSpec = resolveTaskSpecForExecution(projectCwd, fixture.cloneCwd, claimed!.taskDir!, resumedSlug);
    const resumedPaths = buildRunPaths(fixture.cloneCwd, resumedSlug);
    const orderReads: string[] = [];
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      orderReads.push(readFileSync(resumedPaths.contextTaskOrderAbs, 'utf8'));
      return dispatchMockResponse(persona, instruction, options, makeResponse({ content: 'resumed', sessionId: 'resumed-session' }));
    });

    const resumed = await executeWorkflow(config, resumedSpec.taskPrompt, fixture.cloneCwd, {
      projectCwd, provider: 'mock', reportDirName: resumedSlug, taskSpec: resumedSpec,
      resumeSource: { sourceRunSlug: runSlug, resumeMode: 'requeue' },
      language: 'ja', outputMode: 'silent',
    });

    expect(resumed.success).toBe(true);
    expect(orderReads).toHaveLength(1);
    expect(orderReads[0]).toBe(expectedOrder);
    expect(readFileSync(resumedPaths.contextTaskOrderAbs, 'utf8')).toBe(expectedOrder);
    expect(expectedOrder.startsWith(fixture.originalOrder)).toBe(true);
    if (delivered) {
      const instruction = fixture.store.read().instructions[0]!;
      expect(orderReads[0]).toContain(`instructionId: ${instruction.instructionId}`);
      expect(orderReads[0]).toContain(instruction.issuedAt);
    } else {
      expect(expectedOrder).toBe(fixture.originalOrder);
    }
    if (source === 'content_file') expect(readFileSync(fixture.inputFile, 'utf8')).toBe(fixture.originalOrder);
  });

  it.each([
    { language: 'en' as const, heading: 'additional instructions from the user' },
    { language: 'ja' as const, heading: 'ユーザー' },
  ])('waits for Phase 1 and sends the full same-session history in $language', async ({ language, heading }) => {
    const store = new LiveInterventionFileStore(projectCwd, REPORT_DIR);
    const firstTurn = createDeferred<AgentResponse>();
    let firstTurnStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      firstTurnStarted = resolve;
    });
    const abortSignals: (AbortSignal | undefined)[] = [];

    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      abortSignals.push(options.abortSignal);
      if (vi.mocked(runAgent).mock.calls.length === 1) {
        options.onPromptResolved?.({
          systemPrompt: persona ?? '',
          userInstruction: instruction,
        });
        options.onDispatch?.(options.permissionMode);
        firstTurnStarted();
        return firstTurn.promise;
      }
      return dispatchMockResponse(
        persona,
        instruction,
        options,
        makeResponse({ content: 'follow-up completed', sessionId: 'phase-one-session' }),
      );
    });

    engine = new WorkflowEngine(
      buildSingleStepConfig([makeRule('done', 'COMPLETE')]),
      projectCwd,
      'test task',
      { ...createEngineOptions(projectCwd, store), language },
    );
    const runPromise = engine.run();
    await started;

    await store.issue('Aを追加して', '2026-09-03T00:00:00.000Z');
    await store.issue('さっきのAはやっぱりなし', '2026-09-03T00:00:01.000Z');
    firstTurn.resolve(makeResponse({ content: 'first turn completed', sessionId: 'phase-one-session' }));

    const state = await runPromise;
    const calls = vi.mocked(runAgent).mock.calls;
    const firstOptions = calls[0]?.[2];
    const followUpOptions = calls[1]?.[2];
    const followUpPrompt = calls[1]?.[1] ?? '';

    expect(state.status).toBe('completed');
    expect(calls).toHaveLength(2);
    expect(firstOptions?.sessionId).toBeUndefined();
    expect(followUpOptions?.sessionId).toBe('phase-one-session');
    expect(abortSignals[0]?.aborted).toBe(false);
    expect(calls[0]?.[1]).not.toContain('Aを追加して');
    expect(followUpPrompt.indexOf('Aを追加して')).toBeLessThan(
      followUpPrompt.indexOf('さっきのAはやっぱりなし'),
    );
    expect(followUpPrompt).toContain(heading);
    expect(store.read()).toMatchObject({
      pending: 0,
      deliveredSameSession: 2,
      deliveredNextStep: 0,
      instructions: [
        expect.objectContaining({ instructionId: 1, state: 'deliveredSameSession' }),
        expect.objectContaining({ instructionId: 2, state: 'deliveredSameSession' }),
      ],
    });
  });

  it.each(['done', 'throw'] as const)('counts every replaced Phase 1 response and live %s attempt once', async (outcome) => {
    const store = new LiveInterventionFileStore(projectCwd, REPORT_DIR);
    const delegatedUsage = vi.fn();
    const completedTokens: number[] = [];
    let calls = 0;
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      calls += 1;
      options.onPromptResolved?.({ systemPrompt: persona ?? '', userInstruction: instruction });
      options.onDispatch?.(options.permissionMode);
      if (calls < 3) await store.issue(`instruction ${calls}`);
      if (calls === 3 && outcome === 'throw') throw new Error('live provider failure');
      return makeResponse({
        sessionId: 'usage-session',
        providerUsage: { inputTokens: calls * 10, outputTokens: calls, totalTokens: calls * 11, usageMissing: false },
      });
    });
    engine = new WorkflowEngine(
      buildSingleStepConfig([makeRule('done', 'COMPLETE')]), projectCwd, 'usage test',
      { ...createEngineOptions(projectCwd, store), onDelegatedAgentUsage: delegatedUsage },
    );
    engine.on('step:complete', (_step, response) => {
      completedTokens.push(response.providerUsage?.totalTokens ?? 0);
    });
    if (outcome === 'throw') {
      expect((await engine.run()).status).toBe('aborted');
    } else {
      expect((await engine.run()).status).toBe('completed');
    }
    expect(calls).toBe(3);
    const usage = delegatedUsage.mock.calls.map(([, result]) => result);
    expect(usage.map((result) => result.usage?.totalTokens)).toEqual(
      outcome === 'throw' ? [11, 22, undefined] : [11, 22],
    );
    expect(completedTokens).toEqual(outcome === 'throw' ? [] : [33]);
    if (outcome === 'throw') expect(usage.at(-1)?.success).toBe(false);
  });

  it('normalizes a non-native live response, stores it, and evaluates a structured rule', async () => {
    const store = new LiveInterventionFileStore(projectCwd, REPORT_DIR);
    const schema = STRUCTURED_RESULT_SCHEMA;
    const config: WorkflowConfig = {
      name: 'live-intervention-structured-output',
      maxSteps: 1,
      initialStep: 'review',
      steps: [makeStep('review', {
        structuredOutput: { schemaRef: 'structured-result', schema },
        rules: [makeRule('when(structured.review.result == "accepted")', 'COMPLETE')],
      })],
    };
    let providerCalls = 0;
    const phaseStarts: (string | undefined)[] = [];
    const phaseCompletions: (string | undefined)[] = [];
    vi.mocked(mockRuleEvaluation).mockImplementation((step, selection, context) => (
      new ActualRuleEvaluator(step, context).evaluate(selection)
    ));
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      providerCalls += 1;
      if (providerCalls === 1) {
        options.onPromptResolved?.({
          systemPrompt: typeof persona === 'string' ? persona : '',
          userInstruction: instruction,
        });
        options.onDispatch?.(options.permissionMode);
        await store.issue('accept the review');
        return makeResponse({
          content: '```json\n{"result":"initial"}\n```',
          sessionId: 'cursor-session',
        });
      }
      return dispatchMockResponse(
        persona,
        instruction,
        options,
        makeResponse({
          content: '```json\n{"result":"accepted"}\n```',
          sessionId: 'cursor-session',
        }),
      );
    });

    engine = new WorkflowEngine(config, projectCwd, 'test task', {
      ...createEngineOptions(projectCwd, store),
      provider: 'cursor',
      model: 'cursor-fast',
    });
    engine.on('phase:start', (step, phase, _phaseName, _instruction, _promptParts, phaseExecutionId) => {
      if (step.name === 'review' && phase === 1) phaseStarts.push(phaseExecutionId);
    });
    engine.on('phase:complete', (step, phase, _phaseName, _content, _status, _error, phaseExecutionId) => {
      if (step.name === 'review' && phase === 1) phaseCompletions.push(phaseExecutionId);
    });

    const state = await engine.run();
    const calls = vi.mocked(runAgent).mock.calls;

    expect(state.status).toBe('completed');
    expect(state.structuredOutputs.get('review')).toEqual({ result: 'accepted' });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.[1]).toContain('"result"');
    expect(calls[1]?.[2].outputSchema).toBeUndefined();
    expect(calls[1]?.[2].sessionId).toBe('cursor-session');
    expect(phaseStarts).toEqual(['review:1:1:1', 'review:1:1:2']);
    expect(phaseCompletions).toEqual(phaseStarts);
    expect(store.read()).toMatchObject({
      pending: 0,
      deliveredSameSession: 1,
      instructions: [expect.objectContaining({ state: 'deliveredSameSession' })],
    });
  });

  it('does not parse native provider response content when structured output is missing', async () => {
    const store = new LiveInterventionFileStore(projectCwd, REPORT_DIR);
    const schema = STRUCTURED_RESULT_SCHEMA;
    const config: WorkflowConfig = {
      name: 'live-intervention-native-structured-output',
      maxSteps: 1,
      initialStep: 'review',
      steps: [makeStep('review', {
        structuredOutput: { schemaRef: 'structured-result', schema },
        rules: [makeRule('done', 'COMPLETE')],
      })],
    };
    let providerCalls = 0;
    const phaseCompletions: Array<{ id: string | undefined; status: string; error: string | undefined }> = [];
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      providerCalls += 1;
      if (providerCalls === 1) {
        options.onPromptResolved?.({
          systemPrompt: typeof persona === 'string' ? persona : '',
          userInstruction: instruction,
        });
        options.onDispatch?.(options.permissionMode);
        await store.issue('native response must remain structured');
        return makeResponse({
          content: 'initial native response',
          sessionId: 'mock-session',
          structuredOutput: { result: 'initial' },
        });
      }
      return dispatchMockResponse(
        persona,
        instruction,
        options,
        makeResponse({
          content: '{"result":"accepted"}',
          sessionId: 'mock-session',
        }),
      );
    });

    engine = new WorkflowEngine(config, projectCwd, 'test task', createEngineOptions(projectCwd, store));
    engine.on('phase:complete', (step, phase, _phaseName, _content, status, error, phaseExecutionId) => {
      if (step.name === 'review' && phase === 1) phaseCompletions.push({ id: phaseExecutionId, status, error });
    });

    const abortReasons: string[] = [];
    engine.on('workflow:abort', (_state, reason) => abortReasons.push(reason));
    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(providerCalls).toBe(2);
    expect(state.structuredOutputs.has('review')).toBe(false);
    expect(abortReasons).toHaveLength(1);
    expect(abortReasons[0]).toContain('requires structured_output');
    expect(phaseCompletions).toHaveLength(2);
    expect(phaseCompletions[0]).toMatchObject({ id: 'review:1:1:1', status: 'done' });
    expect(phaseCompletions[1]).toMatchObject({ id: 'review:1:1:2', status: 'error' });
    expect(phaseCompletions[1]?.error).toContain('Structured output response is missing');
    expect(store.read()).toMatchObject({
      pending: 0,
      deliveredSameSession: 1,
      instructions: [expect.objectContaining({ state: 'deliveredSameSession' })],
    });
  });

  it('keeps a Phase 2 instruction pending until the rule transition starts the next step', async () => {
    const store = new LiveInterventionFileStore(projectCwd, REPORT_DIR);
    const config: WorkflowConfig = {
      name: 'live-intervention-phase-2',
      maxSteps: 10,
      initialStep: 'review',
      steps: [
        makeStep('review', {
          outputContracts: [{ name: 'review.md', format: 'markdown' }],
          rules: [makeRule('done', 'fix')],
        }),
        makeStep('fix', {
          rules: [makeRule('done', 'COMPLETE')],
        }),
      ],
    };
    vi.mocked(runReportPhase).mockImplementation(async () => {
      await store.issue('発行順を維持する', '2026-09-03T00:00:00.000Z');
    });
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) =>
      dispatchMockResponse(
        persona,
        instruction,
        options,
        makeResponse({ content: `${persona ?? 'step'} completed`, sessionId: `${persona ?? 'step'}-session` }),
      ));

    engine = new WorkflowEngine(config, projectCwd, 'test task', createEngineOptions(projectCwd, store));
    const state = await engine.run();
    const calls = vi.mocked(runAgent).mock.calls;

    expect(state.status).toBe('completed');
    expect(calls).toHaveLength(2);
    expect(calls[0]?.[1]).not.toContain('発行順を維持する');
    expect(calls[1]?.[1]).toContain('発行順を維持する');
    expect(store.read()).toMatchObject({
      pending: 0,
      deliveredSameSession: 0,
      deliveredNextStep: 1,
      instructions: [expect.objectContaining({ state: 'deliveredNextStep' })],
    });
  });

  it('keeps a Phase 3 instruction pending until a non-terminal next step is selected', async () => {
    const store = new LiveInterventionFileStore(projectCwd, REPORT_DIR);
    const config: WorkflowConfig = {
      name: 'live-intervention-phase-3',
      maxSteps: 10,
      initialStep: 'review',
      steps: [
        makeStep('review', {
          rules: [makeRule('needs-fix', 'fix'), makeRule('approved', 'COMPLETE')],
        }),
        makeStep('fix', {
          rules: [makeRule('done', 'COMPLETE')],
        }),
      ],
    };
    vi.mocked(runStatusJudgmentPhase).mockImplementation(async () => {
      await store.issue('Phase 3の後で反映', '2026-09-03T00:00:00.000Z');
      return { label: 'needs-fix', method: 'auto_select' };
    });
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) =>
      dispatchMockResponse(
        persona,
        instruction,
        options,
        makeResponse({ content: `${persona ?? 'step'} completed`, sessionId: `${persona ?? 'step'}-session` }),
      ));

    engine = new WorkflowEngine(config, projectCwd, 'test task', createEngineOptions(projectCwd, store));
    const state = await engine.run();
    const calls = vi.mocked(runAgent).mock.calls;

    expect(state.status).toBe('completed');
    expect(vi.mocked(runStatusJudgmentPhase)).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.[1]).not.toContain('Phase 3の後で反映');
    expect(calls[1]?.[1]).toContain('Phase 3の後で反映');
    expect(store.read()).toMatchObject({
      pending: 0,
      deliveredSameSession: 0,
      deliveredNextStep: 1,
      instructions: [expect.objectContaining({ state: 'deliveredNextStep' })],
    });
  });

  it('keeps an intervention out of the synthetic loop judge until its selected step runs', async () => {
    const store = new LiveInterventionFileStore(projectCwd, REPORT_DIR);
    const config: WorkflowConfig = {
      name: 'live-intervention-loop-judge',
      maxSteps: 10,
      initialStep: 'review',
      loopMonitors: [{
        cycle: ['review'],
        threshold: 1,
        judge: {
          persona: 'loop-judge',
          instruction: 'Choose the next step for this loop.',
          rules: [makeRule('judge-selected-fix', 'fix') as LoopMonitorRule],
        },
      }],
      steps: [
        makeStep('review', {
          rules: [makeRule('loop', 'review'), makeRule('approved', 'fix')],
        }),
        makeStep('fix', { rules: [makeRule('done', 'COMPLETE')] }),
      ],
    };
    vi.mocked(runStatusJudgmentPhase).mockImplementationOnce(async () => {
      await store.issue('loop judge must not consume this instruction');
      return { label: 'loop', method: 'auto_select' };
    });
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) =>
      dispatchMockResponse(
        persona,
        instruction,
        options,
        makeResponse({
          content: `${persona ?? 'step'} completed`,
          sessionId: `${persona ?? 'step'}-session`,
          ...(options.outputSchema === undefined
            ? {}
            : { structuredOutput: { content: `${persona ?? 'step'} completed` } }),
        }),
      ));

    engine = new WorkflowEngine(config, projectCwd, 'test task', createEngineOptions(projectCwd, store));
    const state = await engine.run();
    const calls = vi.mocked(runAgent).mock.calls;

    expect(state.status).toBe('completed');
    expect(calls).toHaveLength(3);
    expect(calls[1]?.[1]).not.toContain('loop judge must not consume this instruction');
    expect(calls[2]?.[1]).toContain('loop judge must not consume this instruction');
    expect(store.read()).toMatchObject({
      pending: 0,
      deliveredSameSession: 0,
      deliveredNextStep: 1,
      instructions: [expect.objectContaining({ state: 'deliveredNextStep' })],
    });
  });

  it('inherits project-side instructions through a direct workflow_call child', async () => {
    const store = new LiveInterventionFileStore(projectCwd, REPORT_DIR);
    await store.issue('direct workflow_call instruction', '2026-09-03T00:00:00.000Z');
    const childConfig: WorkflowConfig = {
      name: 'live-intervention-direct-child',
      subworkflow: { callable: true },
      maxSteps: 3,
      initialStep: 'child-review',
      steps: [makeStep('child-review', {
        rules: [makeRule('approved', 'COMPLETE')],
      })],
    };
    const config: WorkflowConfig = {
      name: 'live-intervention-direct-parent',
      maxSteps: 3,
      initialStep: 'delegate',
      steps: [{
        name: 'delegate',
        personaDisplayName: 'delegate',
        instruction: '',
        kind: 'workflow_call',
        call: childConfig.name,
        rules: [makeRule('COMPLETE', 'COMPLETE')],
      }],
    };
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) =>
      dispatchMockResponse(
        persona,
        instruction,
        options,
        makeResponse({
          persona: typeof persona === 'string' ? persona : 'child-review',
          content: 'approved',
          sessionId: 'direct-child-session',
        }),
      ));

    engine = new WorkflowEngine(config, projectCwd, 'test task', {
      ...createEngineOptions(projectCwd, store),
      workflowCallResolver: ({ step }) => step.call === childConfig.name ? childConfig : null,
    });
    const state = await engine.run();
    const calls = vi.mocked(runAgent).mock.calls;

    expect(state.status).toBe('completed');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1]).toContain('direct workflow_call instruction');
    expect(store.read()).toMatchObject({
      pending: 0,
      deliveredNextStep: 1,
      instructions: [expect.objectContaining({ state: 'deliveredNextStep' })],
    });
  });

  it('keeps a completed result when the terminal read fails after Phase 3', async () => {
    const store = new LiveInterventionFileStore(projectCwd, REPORT_DIR);
    const warning = vi.fn();
    const config = buildSingleStepConfig([
      makeRule('needs-fix', 'fix'),
      makeRule('approved', 'COMPLETE'),
    ]);
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) =>
      dispatchMockResponse(
        persona,
        instruction,
        options,
        makeResponse({ content: 'done', sessionId: 'completed-session' }),
      ));
    vi.mocked(runStatusJudgmentPhase).mockImplementation(async () => {
      await store.issue('未消化の一件目', '2026-09-03T00:00:00.000Z');
      await store.issue('未消化の二件目', '2026-09-03T00:00:01.000Z');
      failLiveInterventionRead('terminal');
      return { label: 'approved', method: 'auto_select' };
    });
    vi.mocked(mockRuleEvaluation).mockImplementation((_step, selection) => ({
      index: selection?.label === 'approved' ? 1 : 0,
      method: 'phase3_tag',
    }));

    engine = new WorkflowEngine(config, projectCwd, 'test task', createEngineOptions(projectCwd, store, warning));
    const state = await engine.run();
    const rawEvents = readFileSync(store.getFilePath(), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(state.status).toBe('completed');
    expect(state.lastOutput?.content).toBe('done');
    expect(store.read()).toMatchObject({
      pending: 2,
      instructions: [
        expect.objectContaining({ instructionId: 1, state: 'pending' }),
        expect.objectContaining({ instructionId: 2, state: 'pending' }),
      ],
    });
    expect(rawEvents).toHaveLength(2);
    expect(rawEvents.every((event) => event.type === 'issued')).toBe(true);
    expect(warning).not.toHaveBeenCalled();
  });

  it('keeps a failed result when the terminal read fails after a provider error', async () => {
    const store = new LiveInterventionFileStore(projectCwd, REPORT_DIR);
    const warning = vi.fn();
    const config = buildSingleStepConfig([makeRule('done', 'COMPLETE')]);
    let providerCalls = 0;
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      const response = await dispatchMockResponse(
        persona,
        instruction,
        options,
        makeResponse({ status: 'error', content: 'provider failed', error: 'provider failed' }),
      );
      // エンジンの fresh retry でも同じ error を返す。指示の発行は初回のみ（呼び出しごとの副作用ではない）
      if (providerCalls === 0) {
        await store.issue('未消化の一件目', '2026-09-03T00:00:00.000Z');
        await store.issue('未消化の二件目', '2026-09-03T00:00:01.000Z');
        failLiveInterventionRead('terminal');
      }
      providerCalls += 1;
      return response;
    });

    engine = new WorkflowEngine(config, projectCwd, 'test task', createEngineOptions(projectCwd, store, warning));
    const state = await engine.run();
    const rawEvents = readFileSync(store.getFilePath(), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(state.status).toBe('aborted');
    expect(state.lastOutput?.error).toBe('provider failed');
    expect(store.read()).toMatchObject({
      pending: 2,
      instructions: [
        expect.objectContaining({ instructionId: 1, state: 'pending' }),
        expect.objectContaining({ instructionId: 2, state: 'pending' }),
      ],
    });
    expect(rawEvents).toHaveLength(2);
    expect(rawEvents.every((event) => event.type === 'issued')).toBe(true);
    expect(warning).not.toHaveBeenCalled();
  });

  it('rejects a same-session delivery without a session ID and preserves it for terminal warning', async () => {
    const store = new LiveInterventionFileStore(projectCwd, REPORT_DIR);
    const warning = vi.fn();
    let providerCalls = 0;

    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      providerCalls += 1;
      const response = await dispatchMockResponse(
        persona,
        instruction,
        options,
        makeResponse({ sessionId: undefined, content: 'no session returned' }),
      );
      if (providerCalls === 1) {
        await store.issue('session is required for this follow-up');
      }
      return response;
    });

    engine = new WorkflowEngine(
      buildSingleStepConfig([makeRule('done', 'COMPLETE')]),
      projectCwd,
      'test task',
      createEngineOptions(projectCwd, store, warning),
    );
    const state = await engine.run();
    const rawEvents = readFileSync(store.getFilePath(), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(state.status).toBe('aborted');
    expect(providerCalls).toBe(1);
    expect(store.read()).toMatchObject({
      pending: 0,
      unconsumedWarned: 1,
      terminalStatus: 'failed',
    });
    expect(rawEvents.at(-1)).toMatchObject({
      type: 'terminal',
      status: 'failed',
      unconsumedInstructionIds: [1],
    });
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith(1);
  });

  it('drains an intervention issued during completion retry before the next judge', async () => {
    const store = new LiveInterventionFileStore(projectCwd, REPORT_DIR);
    const config: WorkflowConfig = {
      name: 'live-intervention-completion-retry',
      maxSteps: 1,
      initialStep: 'review',
      steps: [makeStep('review', {
        completionRetry: {
          minRetry: 0,
          maxRetry: 1,
          retryInstruction: 'Recheck the review gaps.',
        },
        outputContracts: [{ name: 'review.md', format: 'markdown', useJudge: false }],
        rules: [makeRule('done', 'COMPLETE')],
      })],
    };
    let reviewerCalls = 0;
    let judgeCalls = 0;
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      if (options.internalAgentName === 'review-completion-judge') {
        judgeCalls += 1;
        return makeResponse({
          persona: 'review-completion-judge',
          content: 'decision',
          structuredOutput: {
            complete: judgeCalls === 2,
            reason: judgeCalls === 2 ? 'closed' : 'missing consumer',
            missing_paths: judgeCalls === 2 ? [] : [{ path: 'consumer.ts', reason: 'not inspected' }],
          },
        });
      }

      reviewerCalls += 1;
      options.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: instruction,
      });
      options.onDispatch?.(options.permissionMode);
      if (reviewerCalls === 2) {
        await store.issue('completion retry中に確認する');
      }
      return makeResponse({
        persona: typeof persona === 'string' ? persona : 'reviewer',
        content: `review-${reviewerCalls}`,
        sessionId: `review-session-${reviewerCalls}`,
      });
    });

    engine = new WorkflowEngine(config, projectCwd, 'test task', createEngineOptions(projectCwd, store));
    const state = await engine.run();
    const reviewerCallRecords = vi.mocked(runAgent).mock.calls
      .filter(([, , options]) => options.internalAgentName !== 'review-completion-judge');

    expect(state.status).toBe('completed');
    expect(reviewerCalls).toBe(3);
    expect(judgeCalls).toBe(2);
    expect(reviewerCallRecords[0]?.[2].sessionId).toBeUndefined();
    expect(reviewerCallRecords[1]?.[2].sessionId).toBe('review-session-1');
    expect(reviewerCallRecords[2]?.[2].sessionId).toBe('review-session-2');
    expect(reviewerCallRecords[2]?.[1]).toContain('completion retry中に確認する');
    expect(store.read()).toMatchObject({
      pending: 0,
      deliveredSameSession: 1,
      instructions: [expect.objectContaining({ state: 'deliveredSameSession' })],
    });
  });

  it('normalizes a native live response issued during completion retry before the next judge', async () => {
    const store = new LiveInterventionFileStore(projectCwd, REPORT_DIR);
    const schema = STRUCTURED_RESULT_SCHEMA;
    const config: WorkflowConfig = {
      name: 'live-intervention-completion-retry-structured-output',
      maxSteps: 1,
      initialStep: 'review',
      steps: [makeStep('review', {
        structuredOutput: { schemaRef: 'structured-result', schema },
        completionRetry: {
          minRetry: 0,
          maxRetry: 1,
          retryInstruction: 'Recheck the review gaps.',
        },
        outputContracts: [{ name: 'review.md', format: 'markdown', useJudge: false }],
        rules: [makeRule('done', 'COMPLETE')],
      })],
    };
    let reviewerCalls = 0;
    let judgeCalls = 0;
    const phaseStarts: (string | undefined)[] = [];
    const phaseCompletions: (string | undefined)[] = [];
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      if (options.internalAgentName === 'review-completion-judge') {
        judgeCalls += 1;
        return makeResponse({
          persona: 'review-completion-judge',
          content: 'decision',
          structuredOutput: {
            complete: judgeCalls === 2,
            reason: judgeCalls === 2 ? 'closed' : 'missing consumer',
            missing_paths: judgeCalls === 2 ? [] : [{ path: 'consumer.ts', reason: 'not inspected' }],
          },
        });
      }

      reviewerCalls += 1;
      options.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: instruction,
      });
      options.onDispatch?.(options.permissionMode);
      if (reviewerCalls === 2) {
        await store.issue('completion retry structured intervention');
      }
      return makeResponse({
        persona: typeof persona === 'string' ? persona : 'reviewer',
        content: `review-${reviewerCalls}`,
        sessionId: `review-session-${reviewerCalls}`,
        structuredOutput: { result: reviewerCalls === 3 ? 'live' : `review-${reviewerCalls}` },
      });
    });

    engine = new WorkflowEngine(config, projectCwd, 'test task', createEngineOptions(projectCwd, store));
    engine.on('phase:start', (step, phase, _phaseName, _instruction, _promptParts, phaseExecutionId) => {
      if (step.name === 'review' && phase === 1) phaseStarts.push(phaseExecutionId);
    });
    engine.on('phase:complete', (step, phase, _phaseName, _content, _status, _error, phaseExecutionId) => {
      if (step.name === 'review' && phase === 1) phaseCompletions.push(phaseExecutionId);
    });

    const state = await engine.run();
    const reviewerCallRecords = vi.mocked(runAgent).mock.calls
      .filter(([, , options]) => options.internalAgentName !== 'review-completion-judge');

    expect(state.status).toBe('completed');
    expect(reviewerCalls).toBe(3);
    expect(judgeCalls).toBe(2);
    expect(state.structuredOutputs.get('review')).toEqual({ result: 'live' });
    expect(reviewerCallRecords[2]?.[1]).toContain('completion retry structured intervention');
    expect(reviewerCallRecords[2]?.[2].sessionId).toBe('review-session-2');
    expect(reviewerCallRecords[2]?.[2].outputSchema).toEqual(schema);
    expect(phaseStarts).toEqual(['review:1:1:1', 'review:1:1:2', 'review:1:1:3']);
    expect(phaseCompletions).toEqual(phaseStarts);
    expect(store.read()).toMatchObject({
      pending: 0,
      deliveredSameSession: 1,
      instructions: [expect.objectContaining({ state: 'deliveredSameSession' })],
    });
  });

  it('propagates a missing native live response issued during completion retry', async () => {
    const store = new LiveInterventionFileStore(projectCwd, REPORT_DIR);
    const schema = STRUCTURED_RESULT_SCHEMA;
    const config: WorkflowConfig = {
      name: 'live-intervention-completion-retry-structured-output-error',
      maxSteps: 1,
      initialStep: 'review',
      steps: [makeStep('review', {
        structuredOutput: { schemaRef: 'structured-result', schema },
        completionRetry: {
          minRetry: 0,
          maxRetry: 1,
          retryInstruction: 'Recheck the review gaps.',
        },
        outputContracts: [{ name: 'review.md', format: 'markdown', useJudge: false }],
        rules: [makeRule('done', 'COMPLETE')],
      })],
    };
    let reviewerCalls = 0;
    let judgeCalls = 0;
    const phaseStarts: (string | undefined)[] = [];
    const phaseCompletions: Array<{ id: string | undefined; status: string; error: string | undefined }> = [];
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      if (options.internalAgentName === 'review-completion-judge') {
        judgeCalls += 1;
        return makeResponse({
          persona: 'review-completion-judge',
          content: 'decision',
          structuredOutput: {
            complete: judgeCalls === 2,
            reason: judgeCalls === 2 ? 'closed' : 'missing consumer',
            missing_paths: judgeCalls === 2 ? [] : [{ path: 'consumer.ts', reason: 'not inspected' }],
          },
        });
      }

      reviewerCalls += 1;
      options.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: instruction,
      });
      options.onDispatch?.(options.permissionMode);
      if (reviewerCalls === 2) {
        await store.issue('completion retry中のlive応答を検証する');
      }
      return makeResponse({
        persona: typeof persona === 'string' ? persona : 'reviewer',
        content: reviewerCalls === 3 ? '{"result":"ignored"}' : `review-${reviewerCalls}`,
        sessionId: reviewerCalls >= 2 ? 'review-session-2' : 'review-session-1',
        ...(reviewerCalls === 3 ? {} : { structuredOutput: { result: `review-${reviewerCalls}` } }),
      });
    });

    engine = new WorkflowEngine(config, projectCwd, 'test task', createEngineOptions(projectCwd, store));
    engine.on('phase:start', (step, phase, _phaseName, _instruction, _promptParts, phaseExecutionId) => {
      if (step.name === 'review' && phase === 1) phaseStarts.push(phaseExecutionId);
    });
    engine.on('phase:complete', (step, phase, _phaseName, _content, status, error, phaseExecutionId) => {
      if (step.name === 'review' && phase === 1) phaseCompletions.push({ id: phaseExecutionId, status, error });
    });

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(reviewerCalls).toBe(3);
    expect(judgeCalls).toBe(1);
    expect(state.structuredOutputs.has('review')).toBe(false);
    expect(phaseStarts).toEqual(['review:1:1:1', 'review:1:1:2', 'review:1:1:3']);
    expect(phaseCompletions).toEqual([
      { id: 'review:1:1:1', status: 'done', error: undefined },
      { id: 'review:1:1:2', status: 'done', error: undefined },
      { id: 'review:1:1:3', status: 'error', error: expect.stringContaining('Structured output response is missing') },
    ]);
    expect(store.read()).toMatchObject({
      pending: 0,
      deliveredSameSession: 1,
      instructions: [expect.objectContaining({ state: 'deliveredSameSession' })],
    });
  });

  it.each([
    {
      label: 'keeps the initial response when retry structured output is missing',
      retryStructuredOutput: undefined,
      expectedContent: 'review-1',
      expectedStructuredOutput: { result: 'review-1' },
      expectedSessionId: 'review-session-1',
      expectedJudgeCalls: 1,
      expectedDiagnostic: 'Structured output response is missing',
    },
    {
      label: 'keeps the initial response when retry structured output violates the schema',
      retryStructuredOutput: { result: 1 },
      expectedContent: 'review-1',
      expectedStructuredOutput: { result: 'review-1' },
      expectedSessionId: 'review-session-1',
      expectedJudgeCalls: 1,
      expectedDiagnostic: '$.result must be string',
    },
    {
      label: 'adopts the retry response when retry structured output is valid',
      retryStructuredOutput: { result: 'review-2' },
      expectedContent: 'review-2',
      expectedStructuredOutput: { result: 'review-2' },
      expectedSessionId: 'review-session-2',
      expectedJudgeCalls: 2,
      expectedDiagnostic: undefined,
    },
  ])('uses the normal completion retry producer for $label', async ({
    retryStructuredOutput,
    expectedContent,
    expectedStructuredOutput,
    expectedSessionId,
    expectedJudgeCalls,
    expectedDiagnostic,
  }) => {
    const store = new LiveInterventionFileStore(projectCwd, REPORT_DIR);
    const config: WorkflowConfig = {
      name: 'live-intervention-normal-completion-retry-producer',
      maxSteps: 1,
      initialStep: 'review',
      steps: [makeStep('review', {
        structuredOutput: { schemaRef: 'structured-result', schema: STRUCTURED_RESULT_SCHEMA },
        completionRetry: {
          minRetry: 0,
          maxRetry: 1,
          retryInstruction: 'Recheck the review gaps.',
        },
        outputContracts: [{ name: 'review.md', format: 'markdown', useJudge: false }],
        rules: [makeRule('done', 'COMPLETE')],
      })],
    };
    let reviewerCalls = 0;
    let judgeCalls = 0;
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      if (options.internalAgentName === 'review-completion-judge') {
        judgeCalls += 1;
        return makeResponse({
          persona: 'review-completion-judge',
          content: 'decision',
          structuredOutput: {
            complete: judgeCalls === 2,
            reason: judgeCalls === 2 ? 'closed' : 'missing consumer',
            missing_paths: judgeCalls === 2 ? [] : [{ path: 'consumer.ts', reason: 'not inspected' }],
          },
        });
      }

      reviewerCalls += 1;
      options.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: instruction,
      });
      options.onDispatch?.(options.permissionMode);
      const structuredOutput = reviewerCalls === 1
        ? { result: 'review-1' }
        : retryStructuredOutput;
      return makeResponse({
        persona: typeof persona === 'string' ? persona : 'reviewer',
        content: `review-${reviewerCalls}`,
        sessionId: `review-session-${reviewerCalls}`,
        ...(structuredOutput === undefined ? {} : { structuredOutput }),
      });
    });

    engine = new WorkflowEngine(config, projectCwd, 'test task', createEngineOptions(projectCwd, store));
    const state = await engine.run();
    const reviewerCallRecords = vi.mocked(runAgent).mock.calls
      .filter(([, , options]) => options.internalAgentName !== 'review-completion-judge');

    expect(state.status).toBe('completed');
    expect(state.lastOutput).toMatchObject({
      content: expectedContent,
      sessionId: expectedSessionId,
    });
    expect(state.structuredOutputs.get('review')).toEqual(expectedStructuredOutput);
    expect(reviewerCalls).toBe(2);
    expect(judgeCalls).toBe(expectedJudgeCalls);
    expect(reviewerCallRecords[1]?.[2].sessionId).toBe('review-session-1');
    expect(runReportPhase).toHaveBeenCalledOnce();
    const phase2 = vi.mocked(runReportPhase).mock.calls[0]![2] as {
      completionRetryDiagnostic?: string;
    };
    if (expectedDiagnostic !== undefined) {
      expect(phase2.completionRetryDiagnostic).toEqual(expect.stringContaining('reviewer_retry_failed'));
      expect(phase2.completionRetryDiagnostic).toContain(expectedDiagnostic);
    } else {
      expect(phase2).not.toHaveProperty('completionRetryDiagnostic');
    }
  });

  it('drains an intervention issued during a Companion follow-up before the step completes', async () => {
    const store = new LiveInterventionFileStore(projectCwd, REPORT_DIR);
    const companionDiffReader = createCompanionDiffReader('current-digest');
    const config: WorkflowConfig = {
      name: 'live-intervention-companion',
      maxSteps: 1,
      initialStep: 'implement',
      companions: {
        reviewer: {
          name: 'reviewer',
          description: 'Review the implementation.',
          instruction: 'Review the implementation.',
          instructionRef: 'reviewer',
          intervalMs: 60_000,
        },
      },
      steps: [makeStep('implement', {
        companion: { fixed: ['reviewer'], pool: [] },
        rules: [makeRule('done', 'COMPLETE')],
      })],
    };
    let mainCalls = 0;
    let companionReviewCalls = 0;
    const reviewerCallRecords: Array<{ instruction: string; sessionId: string | undefined }> = [];
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      if (options.internalAgentName === 'reviewer') {
        companionReviewCalls += 1;
        return makeResponse({
          persona: 'reviewer',
          structuredOutput: {
            findings: [{
              severity: 'must_fix',
              file: 'src/changed.ts',
              line: 1,
              finding: 'Fix the changed implementation.',
            }],
            notes: null,
          },
        });
      }

      mainCalls += 1;
      reviewerCallRecords.push({ instruction, sessionId: options.sessionId });
      options.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: instruction,
      });
      if (mainCalls === 2) {
        await store.issue('Companion follow-up中に確認する');
      }
      options.onDispatch?.(options.permissionMode);
      return makeResponse({
        persona: typeof persona === 'string' ? persona : 'implementer',
        content: `implementation-${mainCalls}`,
        sessionId: `implementer-session-${mainCalls}`,
      });
    });

    engine = new WorkflowEngine(config, projectCwd, 'test task', {
      ...createEngineOptions(projectCwd, store),
      companionEnabled: true,
      companionProviders: { reviewer: { provider: 'mock' } },
      companionDiffReader,
    });
    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(companionReviewCalls).toBe(1);
    expect(mainCalls).toBe(3);
    expect(reviewerCallRecords[0]?.sessionId).toBeUndefined();
    expect(reviewerCallRecords[1]?.sessionId).toBe('implementer-session-1');
    expect(reviewerCallRecords[2]?.sessionId).toBe('implementer-session-2');
    expect(reviewerCallRecords[1]?.instruction).toContain('Fix the changed implementation.');
    expect(reviewerCallRecords[2]?.instruction).toContain('Companion follow-up中に確認する');
    expect(store.read()).toMatchObject({
      pending: 0,
      deliveredSameSession: 1,
      instructions: [expect.objectContaining({ state: 'deliveredSameSession' })],
    });
  });

  it('normalizes a native live response issued during a Companion follow-up', async () => {
    const store = new LiveInterventionFileStore(projectCwd, REPORT_DIR);
    const schema = STRUCTURED_RESULT_SCHEMA;
    const companionDiffReader = createCompanionDiffReader('current-digest');
    const config: WorkflowConfig = {
      name: 'live-intervention-companion-structured-output',
      maxSteps: 1,
      initialStep: 'implement',
      companions: {
        reviewer: {
          name: 'reviewer',
          description: 'Review the implementation.',
          instruction: 'Review the implementation.',
          instructionRef: 'reviewer',
          intervalMs: 60_000,
        },
      },
      steps: [makeStep('implement', {
        structuredOutput: { schemaRef: 'structured-result', schema },
        companion: { fixed: ['reviewer'], pool: [] },
        rules: [makeRule('done', 'COMPLETE')],
      })],
    };
    let mainCalls = 0;
    let companionReviewCalls = 0;
    const phaseStarts: (string | undefined)[] = [];
    const phaseCompletions: (string | undefined)[] = [];
    const mainCallRecords: Array<{ instruction: string; sessionId: string | undefined }> = [];
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      if (options.internalAgentName === 'reviewer') {
        companionReviewCalls += 1;
        return makeResponse({
          persona: 'reviewer',
          structuredOutput: {
            findings: [{
              severity: 'must_fix',
              file: 'src/changed.ts',
              line: 1,
              finding: 'Fix the changed implementation.',
            }],
            notes: null,
          },
        });
      }

      mainCalls += 1;
      mainCallRecords.push({ instruction, sessionId: options.sessionId });
      options.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: instruction,
      });
      if (mainCalls === 2) {
        await store.issue('Companion structured intervention');
      }
      options.onDispatch?.(options.permissionMode);
      return makeResponse({
        persona: typeof persona === 'string' ? persona : 'implementer',
        content: `implementation-${mainCalls}`,
        sessionId: `implementer-session-${mainCalls}`,
        structuredOutput: { result: mainCalls === 3 ? 'live' : `implementation-${mainCalls}` },
      });
    });

    engine = new WorkflowEngine(config, projectCwd, 'test task', {
      ...createEngineOptions(projectCwd, store),
      companionEnabled: true,
      companionProviders: { reviewer: { provider: 'mock' } },
      companionDiffReader,
    });
    engine.on('phase:start', (step, phase, _phaseName, _instruction, _promptParts, phaseExecutionId) => {
      if (step.name === 'implement' && phase === 1) phaseStarts.push(phaseExecutionId);
    });
    engine.on('phase:complete', (step, phase, _phaseName, _content, _status, _error, phaseExecutionId) => {
      if (step.name === 'implement' && phase === 1) phaseCompletions.push(phaseExecutionId);
    });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(mainCalls).toBe(3);
    expect(companionReviewCalls).toBe(1);
    expect(state.structuredOutputs.get('implement')).toEqual({ result: 'live' });
    expect(mainCallRecords[2]?.instruction).toContain('Companion structured intervention');
    expect(mainCallRecords[2]?.sessionId).toBe('implementer-session-2');
    expect(phaseStarts).toEqual(['implement:1:1:1', 'implement:1:1:2', 'implement:1:1:3']);
    expect(phaseCompletions).toEqual(phaseStarts);
    expect(store.read()).toMatchObject({
      pending: 0,
      deliveredSameSession: 1,
      instructions: [expect.objectContaining({ state: 'deliveredSameSession' })],
    });
  });

  it('propagates a missing native live response issued during a Companion follow-up', async () => {
    const store = new LiveInterventionFileStore(projectCwd, REPORT_DIR);
    const schema = STRUCTURED_RESULT_SCHEMA;
    const companionDiffReader = createCompanionDiffReader();
    const config: WorkflowConfig = {
      name: 'live-intervention-companion-structured-output-error',
      maxSteps: 1,
      initialStep: 'implement',
      companions: {
        reviewer: {
          name: 'reviewer',
          description: 'Review the implementation.',
          instruction: 'Review the implementation.',
          instructionRef: 'reviewer',
          intervalMs: 60_000,
        },
      },
      steps: [makeStep('implement', {
        structuredOutput: { schemaRef: 'structured-result', schema },
        companion: { fixed: ['reviewer'], pool: [] },
        rules: [makeRule('done', 'COMPLETE')],
      })],
    };
    let mainCalls = 0;
    let companionReviewCalls = 0;
    const phaseCompletions: Array<{ id: string | undefined; status: string; error: string | undefined }> = [];
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      if (options.internalAgentName === 'reviewer') {
        companionReviewCalls += 1;
        return makeResponse({
          persona: 'reviewer',
          structuredOutput: {
            findings: [{
              severity: 'must_fix',
              file: 'src/changed.ts',
              line: 1,
              finding: 'Fix the changed implementation.',
            }],
            notes: null,
          },
        });
      }

      mainCalls += 1;
      options.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: instruction,
      });
      if (mainCalls === 2) {
        await store.issue('Companion follow-up中のlive応答を検証する');
      }
      options.onDispatch?.(options.permissionMode);
      return makeResponse({
        persona: typeof persona === 'string' ? persona : 'implementer',
        content: mainCalls === 3 ? '{"result":"ignored"}' : `implementation-${mainCalls}`,
        sessionId: mainCalls >= 3 ? 'implementer-session-2' : `implementer-session-${mainCalls}`,
        ...(mainCalls === 3 ? {} : { structuredOutput: { result: `implementation-${mainCalls}` } }),
      });
    });

    engine = new WorkflowEngine(config, projectCwd, 'test task', {
      ...createEngineOptions(projectCwd, store),
      companionEnabled: true,
      companionProviders: { reviewer: { provider: 'mock' } },
      companionDiffReader,
    });
    engine.on('phase:complete', (step, phase, _phaseName, _content, status, error, phaseExecutionId) => {
      if (step.name === 'implement' && phase === 1) phaseCompletions.push({ id: phaseExecutionId, status, error });
    });

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(mainCalls).toBe(3);
    expect(companionReviewCalls).toBe(1);
    expect(state.structuredOutputs.has('implement')).toBe(false);
    expect(phaseCompletions).toEqual([
      { id: 'implement:1:1:1', status: 'done', error: undefined },
      { id: 'implement:1:1:2', status: 'done', error: undefined },
      { id: 'implement:1:1:3', status: 'error', error: expect.stringContaining('Structured output response is missing') },
    ]);
    expect(store.read()).toMatchObject({
      pending: 0,
      deliveredSameSession: 1,
      instructions: [expect.objectContaining({ state: 'deliveredSameSession' })],
    });
  });

  it.each(['error', 'rate_limited', 'blocked'] as const)(
    'propagates a live Companion callback %s response to the workflow status handling',
    async (status) => {
      const store = new LiveInterventionFileStore(projectCwd, REPORT_DIR);
      const companionDiffReader = createCompanionDiffReader();
      let mainCalls = 0;
      let companionReviewCalls = 0;
      vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
        if (options.internalAgentName === 'reviewer') {
          companionReviewCalls += 1;
          return makeResponse({
            persona: 'reviewer',
            structuredOutput: {
              findings: [{
                severity: 'must_fix',
                file: 'src/changed.ts',
                line: 1,
                finding: 'Fix the changed implementation.',
              }],
              notes: null,
            },
          });
        }

        mainCalls += 1;
        options.onPromptResolved?.({
          systemPrompt: typeof persona === 'string' ? persona : '',
          userInstruction: instruction,
        });
        if (mainCalls === 2) {
          await store.issue('live statusを確認する');
        }
        options.onDispatch?.(options.permissionMode);
        return makeResponse({
          persona: typeof persona === 'string' ? persona : 'implementer',
          status: mainCalls === 3 ? status : 'done',
          content: mainCalls === 3 ? `${status} live response` : `implementation-${mainCalls}`,
          error: mainCalls === 3 ? 'live failed' : undefined,
          sessionId: `implementer-session-${Math.min(mainCalls, 2)}`,
        });
      });

      engine = new WorkflowEngine(
        buildCompanionStatusConfig(`live-intervention-companion-${status}`),
        projectCwd,
        'test task',
        {
          ...createEngineOptions(projectCwd, store),
          companionEnabled: true,
          companionProviders: { reviewer: { provider: 'mock' } },
          companionDiffReader,
        },
      );
      const state = await engine.run();

      expect(state.status).toBe('aborted');
      expect(state.lastOutput).toMatchObject({
        status,
        error: 'live failed',
      });
      expect(state.companion).toMatchObject({
        completionFailure: true,
        reason: 'live failed',
      });
      expect(mainCalls).toBe(3);
      expect(companionReviewCalls).toBe(1);
      expect(store.read()).toMatchObject({
        pending: 0,
        deliveredSameSession: 1,
        instructions: [expect.objectContaining({ state: 'deliveredSameSession' })],
      });
    },
  );

  it.each(['error', 'rate_limited', 'blocked'] as const)(
    'uses the existing Companion fallback for a normal follow-up %s response',
    async (status) => {
      const store = new LiveInterventionFileStore(projectCwd, REPORT_DIR);
      const companionDiffReader = createCompanionDiffReader();
      let mainCalls = 0;
      let companionReviewCalls = 0;
      vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
        if (options.internalAgentName === 'reviewer') {
          companionReviewCalls += 1;
          return makeResponse({
            persona: 'reviewer',
            structuredOutput: {
              findings: [{
                severity: 'must_fix',
                file: 'src/changed.ts',
                line: 1,
                finding: 'Fix the changed implementation.',
              }],
              notes: null,
            },
          });
        }

        mainCalls += 1;
        options.onPromptResolved?.({
          systemPrompt: typeof persona === 'string' ? persona : '',
          userInstruction: instruction,
        });
        options.onDispatch?.(options.permissionMode);
        // error の follow-up はエンジンの fresh retry が 1 回走るため、再試行（3 回目）も失敗させる
        const shouldFail = status === 'error' ? mainCalls >= 2 : mainCalls === 2;
        return makeResponse({
          persona: typeof persona === 'string' ? persona : 'implementer',
          status: shouldFail ? status : 'done',
          content: shouldFail ? `${status} follow-up response` : 'initial implementation',
          error: shouldFail ? 'follow-up failed' : undefined,
          sessionId: `implementer-session-${mainCalls}`,
        });
      });

      engine = new WorkflowEngine(
        buildCompanionStatusConfig(`live-intervention-normal-companion-${status}`),
        projectCwd,
        'test task',
        {
          ...createEngineOptions(projectCwd, store),
          companionEnabled: true,
          companionProviders: { reviewer: { provider: 'mock' } },
          companionDiffReader,
        },
      );
      const state = await engine.run();

      expect(state.status).toBe('completed');
      expect(state.lastOutput).toMatchObject({
        status: 'done',
        content: 'initial implementation',
      });
      expect(state.companion).toMatchObject({
        completionFailure: true,
        reason: 'follow-up failed',
      });
      expect(mainCalls).toBe(status === 'error' ? 3 : 2);
      expect(companionReviewCalls).toBe(1);
      expect(store.read()).toMatchObject({
        pending: 0,
        deliveredSameSession: 0,
        instructions: [],
      });
    },
  );

  it.each([
    {
      label: 'single preserves the initial response when follow-up structured output is missing',
      policy: 'single' as const,
      failureAt: 2,
      failureKind: 'missing' as const,
      expectedContent: 'initial implementation',
      expectedStructuredOutput: { result: 'initial' },
      expectedRounds: 1,
      expectedMainCalls: 2,
      expectedReviewCalls: 1,
      expectsFailure: true,
    },
    {
      label: 'single preserves the initial response when follow-up structured output violates the schema',
      policy: 'single' as const,
      failureAt: 2,
      failureKind: 'schema' as const,
      expectedContent: 'initial implementation',
      expectedStructuredOutput: { result: 'initial' },
      expectedRounds: 1,
      expectedMainCalls: 2,
      expectedReviewCalls: 1,
      expectsFailure: true,
    },
    {
      label: 'single adopts a valid follow-up response',
      policy: 'single' as const,
      failureAt: undefined,
      failureKind: undefined,
      expectedContent: 'single fixed implementation',
      expectedStructuredOutput: { result: 'single-fixed' },
      expectedRounds: 1,
      expectedMainCalls: 2,
      expectedReviewCalls: 1,
      expectsFailure: false,
    },
    {
      label: 'loop preserves the latest valid response when the second follow-up structured output is missing',
      policy: 'loop' as const,
      failureAt: 3,
      failureKind: 'missing' as const,
      expectedContent: 'loop fixed implementation 1',
      expectedStructuredOutput: { result: 'loop-fixed-1' },
      expectedRounds: 2,
      expectedMainCalls: 3,
      expectedReviewCalls: 2,
      expectsFailure: true,
    },
    {
      label: 'loop preserves the latest valid response when the second follow-up structured output violates the schema',
      policy: 'loop' as const,
      failureAt: 3,
      failureKind: 'schema' as const,
      expectedContent: 'loop fixed implementation 1',
      expectedStructuredOutput: { result: 'loop-fixed-1' },
      expectedRounds: 2,
      expectedMainCalls: 3,
      expectedReviewCalls: 2,
      expectsFailure: true,
    },
    {
      label: 'loop adopts a valid second follow-up response',
      policy: 'loop' as const,
      failureAt: undefined,
      failureKind: undefined,
      expectedContent: 'loop fixed implementation 2',
      expectedStructuredOutput: { result: 'loop-fixed-2' },
      expectedRounds: 2,
      expectedMainCalls: 3,
      expectedReviewCalls: 3,
      expectsFailure: false,
    },
  ])('uses the normal Companion follow-up producer for $label', async ({
    policy,
    failureAt,
    failureKind,
    expectedContent,
    expectedStructuredOutput,
    expectedRounds,
    expectedMainCalls,
    expectedReviewCalls,
    expectsFailure,
  }) => {
    const store = new LiveInterventionFileStore(projectCwd, REPORT_DIR);
    const companionDiffReader = createCompanionDiffReader();
    const baseConfig = buildCompanionStatusConfig(
      `live-intervention-normal-companion-producer-${policy}-${failureKind ?? 'valid'}`,
    );
    const config: WorkflowConfig = {
      ...baseConfig,
      steps: [makeStep('implement', {
        structuredOutput: { schemaRef: 'structured-result', schema: STRUCTURED_RESULT_SCHEMA },
        companion: { fixed: ['reviewer'], pool: [] },
        rules: [makeRule('done', 'COMPLETE')],
      })],
    };
    const delegatedUsage = vi.fn();
    let mainCalls = 0;
    let companionReviewCalls = 0;
    const mainCallRecords: Array<{ readonly sessionId: string | undefined }> = [];
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      if (options.internalAgentName === 'reviewer') {
        companionReviewCalls += 1;
        const findings = policy === 'loop' && companionReviewCalls === 3
          ? []
          : [{
            severity: 'must_fix' as const,
            file: 'src/changed.ts',
            line: 1,
            finding: 'Fix the changed implementation.',
          }];
        return makeResponse({
          persona: 'reviewer',
          structuredOutput: { findings, notes: null },
        });
      }

      mainCalls += 1;
      mainCallRecords.push({ sessionId: options.sessionId });
      options.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: instruction,
      });
      options.onDispatch?.(options.permissionMode);
      const structuredOutput = mainCalls === failureAt
        ? failureKind === 'schema'
          ? { result: 1 }
          : undefined
        : {
          result: mainCalls === 1
            ? 'initial'
            : policy === 'single'
              ? 'single-fixed'
              : mainCalls === 2
                ? 'loop-fixed-1'
                : 'loop-fixed-2',
        };
      const content = mainCalls === 1
        ? 'initial implementation'
        : policy === 'single'
          ? 'single fixed implementation'
          : `loop fixed implementation ${mainCalls - 1}`;
      return makeResponse({
        persona: typeof persona === 'string' ? persona : 'implementer',
        content,
        sessionId: `implementer-session-${mainCalls}`,
        providerUsage: { totalTokens: mainCalls * 100, usageMissing: false },
        ...(structuredOutput === undefined ? {} : { structuredOutput }),
      });
    });

    engine = new WorkflowEngine(config, projectCwd, 'test task', {
      ...createEngineOptions(projectCwd, store),
      onDelegatedAgentUsage: delegatedUsage,
      companionEnabled: true,
      companionFixPolicy: policy,
      companionProviders: { reviewer: { provider: 'mock' } },
      companionDiffReader,
    });
    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(state.lastOutput).toMatchObject({ content: expectedContent });
    expect(state.structuredOutputs.get('implement')).toEqual(expectedStructuredOutput);
    expect(mainCalls).toBe(expectedMainCalls);
    expect(companionReviewCalls).toBe(expectedReviewCalls);
    expect(mainCallRecords.map(({ sessionId }) => sessionId)).toEqual(
      expectedMainCalls === 2
        ? [undefined, 'implementer-session-1']
        : [undefined, 'implementer-session-1', 'implementer-session-2'],
    );
    if (expectsFailure) {
      expect(delegatedUsage.mock.calls.filter(([context, result]) => (
        context.step === 'implement' && result.success === false
      )).map(([, result]) => result.usage?.totalTokens)).toEqual([failureAt! * 100]);
      expect(state.companion).toMatchObject({
        completionSettled: false,
        completionFailure: true,
        followUpRounds: expectedRounds,
        reason: expect.stringContaining(
          failureKind === 'schema' ? '$.result must be string' : 'Structured output response is missing',
        ),
      });
    } else {
      expect(state.companion).toMatchObject({
        completionSettled: true,
        followUpRounds: expectedRounds,
      });
      expect(state.companion).not.toHaveProperty('completionFailure');
      expect(state.companion).not.toHaveProperty('reason');
    }
  });

  it('propagates a missing native live response from a Companion follow-up inside completion retry', async () => {
    const store = new LiveInterventionFileStore(projectCwd, REPORT_DIR);
    const schema = STRUCTURED_RESULT_SCHEMA;
    const companionDiffReader = createCompanionDiffReader();
    const config: WorkflowConfig = {
      name: 'live-intervention-completion-retry-companion-structured-output-error',
      maxSteps: 1,
      initialStep: 'review',
      companions: {
        reviewer: {
          name: 'reviewer',
          description: 'Review the implementation.',
          instruction: 'Review the implementation.',
          instructionRef: 'reviewer',
          intervalMs: 60_000,
        },
      },
      steps: [makeStep('review', {
        structuredOutput: { schemaRef: 'structured-result', schema },
        companion: { fixed: ['reviewer'], pool: [] },
        completionRetry: {
          minRetry: 0,
          maxRetry: 1,
          retryInstruction: 'Recheck the review gaps.',
        },
        outputContracts: [{ name: 'review.md', format: 'markdown', useJudge: false }],
        rules: [makeRule('done', 'COMPLETE')],
      })],
    };
    let mainCalls = 0;
    let companionReviewCalls = 0;
    let judgeCalls = 0;
    const phaseCompletions: Array<{ id: string | undefined; status: string; error: string | undefined }> = [];
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      if (options.internalAgentName === 'review-completion-judge') {
        judgeCalls += 1;
        return makeResponse({
          persona: 'review-completion-judge',
          content: 'decision',
          structuredOutput: {
            complete: judgeCalls === 2,
            reason: judgeCalls === 2 ? 'closed' : 'missing consumer',
            missing_paths: judgeCalls === 2 ? [] : [{ path: 'consumer.ts', reason: 'not inspected' }],
          },
        });
      }
      if (options.internalAgentName === 'reviewer') {
        companionReviewCalls += 1;
        if (companionReviewCalls === 2) {
          await store.issue('completion retry内Companionのlive応答を検証する');
        }
        return makeResponse({
          persona: 'reviewer',
          structuredOutput: {
            findings: companionReviewCalls === 1 ? [] : [{
              severity: 'must_fix',
              file: 'src/changed.ts',
              line: 1,
              finding: 'Fix the changed implementation.',
            }],
            notes: null,
          },
        });
      }

      mainCalls += 1;
      options.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: instruction,
      });
      options.onDispatch?.(options.permissionMode);
      return makeResponse({
        persona: typeof persona === 'string' ? persona : 'reviewer',
        content: mainCalls === 4 ? '{"result":"ignored"}' : `review-${mainCalls}`,
        sessionId: mainCalls >= 3 ? 'review-session-3' : `review-session-${mainCalls}`,
        ...(mainCalls === 4 ? {} : { structuredOutput: { result: `review-${mainCalls}` } }),
      });
    });

    engine = new WorkflowEngine(config, projectCwd, 'test task', {
      ...createEngineOptions(projectCwd, store),
      companionEnabled: true,
      companionFixPolicy: 'loop',
      companionProviders: { reviewer: { provider: 'mock' } },
      companionDiffReader,
    });
    engine.on('phase:complete', (step, phase, _phaseName, _content, status, error, phaseExecutionId) => {
      if (step.name === 'review' && phase === 1) phaseCompletions.push({ id: phaseExecutionId, status, error });
    });

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(mainCalls).toBe(4);
    expect(companionReviewCalls).toBe(2);
    expect(judgeCalls).toBe(1);
    expect(state.structuredOutputs.has('review')).toBe(false);
    expect(phaseCompletions).toEqual([
      { id: 'review:1:1:1', status: 'done', error: undefined },
      { id: 'review:1:1:2', status: 'done', error: undefined },
      { id: 'review:1:1:3', status: 'done', error: undefined },
      { id: 'review:1:1:4', status: 'error', error: expect.stringContaining('Structured output response is missing') },
    ]);
    expect(store.read()).toMatchObject({
      pending: 0,
      deliveredSameSession: 1,
      instructions: [expect.objectContaining({ state: 'deliveredSameSession' })],
    });
  });

  it.each(['error', 'rate_limited', 'blocked'] as const)(
    'routes a live Companion callback %s response through completion retry fallback',
    async (status) => {
      const store = new LiveInterventionFileStore(projectCwd, REPORT_DIR);
      const schema = STRUCTURED_RESULT_SCHEMA;
      const companionDiffReader = createCompanionDiffReader();
      const config: WorkflowConfig = {
        name: `live-intervention-completion-retry-companion-${status}`,
        maxSteps: 1,
        initialStep: 'review',
        companions: {
          reviewer: {
            name: 'reviewer',
            description: 'Review the implementation.',
            instruction: 'Review the implementation.',
            instructionRef: 'reviewer',
            intervalMs: 60_000,
          },
        },
        steps: [makeStep('review', {
          structuredOutput: { schemaRef: 'structured-result', schema },
          companion: { fixed: ['reviewer'], pool: [] },
          completionRetry: {
            minRetry: 0,
            maxRetry: 1,
            retryInstruction: 'Recheck the review gaps.',
          },
          outputContracts: [{ name: 'review.md', format: 'markdown', useJudge: false }],
          rules: [makeRule('done', 'COMPLETE')],
        })],
      };
      let mainCalls = 0;
      let companionReviewCalls = 0;
      let judgeCalls = 0;
      const phaseCompletions: Array<{ id: string | undefined; status: string; error: string | undefined }> = [];
      vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
        if (options.internalAgentName === 'review-completion-judge') {
          judgeCalls += 1;
          return makeResponse({
            persona: 'review-completion-judge',
            content: 'decision',
            structuredOutput: {
              complete: false,
              reason: 'missing consumer',
              missing_paths: [{ path: 'consumer.ts', reason: 'not inspected' }],
            },
          });
        }
        if (options.internalAgentName === 'reviewer') {
          companionReviewCalls += 1;
          return makeResponse({
            persona: 'reviewer',
            structuredOutput: {
              findings: companionReviewCalls === 2 ? [{
                severity: 'must_fix',
                file: 'src/changed.ts',
                line: 1,
                finding: 'Fix the changed implementation.',
              }] : [],
              notes: null,
            },
          });
        }

        mainCalls += 1;
        options.onPromptResolved?.({
          systemPrompt: typeof persona === 'string' ? persona : '',
          userInstruction: instruction,
        });
        options.onDispatch?.(options.permissionMode);
        if (mainCalls === 3) {
          await store.issue('completion retry中のCompanion live statusを検証する');
        }
        return makeResponse({
          persona: typeof persona === 'string' ? persona : 'reviewer',
          status: mainCalls === 4 ? status : 'done',
          content: mainCalls === 4 ? `${status} live response` : `review-${mainCalls}`,
          error: mainCalls === 4 ? 'live failed' : undefined,
          sessionId: `review-session-${Math.min(mainCalls, 2)}`,
          ...(mainCalls === 4
            ? {}
            : { structuredOutput: { result: mainCalls === 1 ? 'initial' : mainCalls === 2 ? 'retry' : 'follow-up' } }),
        });
      });

      engine = new WorkflowEngine(config, projectCwd, 'test task', {
        ...createEngineOptions(projectCwd, store),
        companionEnabled: true,
        companionFixPolicy: 'single',
        companionProviders: { reviewer: { provider: 'mock' } },
        companionDiffReader,
      });
      engine.on('phase:complete', (step, phase, _phaseName, _content, statusValue, error, phaseExecutionId) => {
        if (step.name === 'review' && phase === 1) {
          phaseCompletions.push({ id: phaseExecutionId, status: statusValue, error });
        }
      });

      const state = await engine.run();
      const phase2 = vi.mocked(runReportPhase).mock.calls[0]![2] as { completionRetryDiagnostic?: string };

      expect(state.status).toBe('completed');
      expect(state.lastOutput).toMatchObject({
        status: 'done',
        content: 'review-1',
      });
      expect(state.structuredOutputs.get('review')).toEqual({ result: 'initial' });
      expect(mainCalls).toBe(4);
      expect(companionReviewCalls).toBe(2);
      expect(judgeCalls).toBe(1);
      expect(phase2.completionRetryDiagnostic).toContain('reviewer_retry_failed');
      expect(phase2.completionRetryDiagnostic).toContain('live failed');
      expect(phaseCompletions).toEqual([
        { id: 'review:1:1:1', status: 'done', error: undefined },
        { id: 'review:1:1:2', status: 'done', error: undefined },
        { id: 'review:1:1:3', status: 'done', error: undefined },
        { id: 'review:1:1:4', status, error: 'live failed' },
      ]);
      expect(store.read()).toMatchObject({
        pending: 0,
        deliveredSameSession: 1,
        instructions: [expect.objectContaining({ state: 'deliveredSameSession' })],
      });
    },
  );

  it('delivers a confirmed merge instruction to the next child agent step without a terminal warning', async () => {
    const runSlug = 'merge-delivery-run';
    const cloneCwd = join(projectCwd, '.takt', 'worktrees', 'merge');
    mkdirSync(cloneCwd, { recursive: true });
    const childPath = join(projectCwd, '.takt', 'workflows', 'merge-child.yaml');
    mkdirSync(join(projectCwd, '.takt', 'workflows'), { recursive: true });
    writeFileSync(childPath, stringifyYaml({
      name: 'merge-child', subworkflow: { callable: true }, max_steps: 3, initial_step: 'review',
      steps: [
        { name: 'review', persona: 'Review this change.', instruction: 'Review the merge.',
          rules: [{ condition: 'needs-fix', next: 'fix' }, { condition: 'approved', next: 'COMPLETE' }] },
        { name: 'fix', persona: 'Fix this change.', instruction: 'Fix the merge.',
          rules: [{ condition: 'done', next: 'COMPLETE' }] },
      ],
    }), 'utf8');
    const config: WorkflowConfig = {
      name: 'merge-parent', maxSteps: 5, initialStep: 'review-call',
      steps: [{ name: 'review-call', personaDisplayName: 'review-call', instruction: '',
        kind: 'workflow_call', call: childPath, rules: [makeRule('COMPLETE', 'COMPLETE')] }],
    };
    const runner = new TaskRunner(projectCwd);
    const task = runner.startPrMergeTask({
      prNumber: 1805, headBranch: 'feature/tell-merge', baseBranch: 'main', headSha: 'a'.repeat(40),
      headRepositoryUrl: 'https://example.com/owner/takt.git',
      headRepositoryPushUrls: ['https://example.com/owner/takt.git'],
      workflow: config.name, method: 'squash', worktreePath: cloneCwd,
      threatCheckMaxDiffBytes: 100_000,
    });
    runner.recordPrMergeClonePrepared(task.name);
    runner.updateRunningTaskExecution(task.name, { runSlug });
    const store = new LiveInterventionFileStore(projectCwd, runSlug);
    const content = 'Keep the agreed merge scope at the next agent step.';
    let issuing: ReturnType<typeof issueTellableRunningTask> | undefined;
    vi.mocked(runStatusJudgmentPhase).mockImplementationOnce(async () => {
      expect(vi.mocked(runAgent).mock.calls).toHaveLength(1);
      expect(store.read().instructions).toEqual([]);
      issuing = issueTellableRunningTask(projectCwd, runSlug, content);
      await issuing;
      expect(store.read()).toMatchObject({ pending: 1, deliveredNextStep: 0 });
      return { label: 'needs-fix', method: 'auto_select' };
    });
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) =>
      dispatchMockResponse(persona, instruction, options, makeResponse({ content: 'done', sessionId: 'merge-child-session' })));

    const result = await executeWorkflow(config, 'Merge PR #1805', cloneCwd, {
      projectCwd, provider: 'mock', reportDirName: runSlug,
      runPathsDirectory: join(projectCwd, '.takt', 'runs'), language: 'ja', outputMode: 'terminal',
    });

    expect(issuing).toBeDefined();
    await expect(issuing).resolves.toMatchObject({ instructionId: 1 });
    expect(result.success).toBe(true);
    const calls = vi.mocked(runAgent).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0]?.[1]).not.toContain(content);
    expect(calls[1]?.[1]).toContain(content);
    expect(calls[1]?.[2].cwd).toBe(cloneCwd);
    expect(store.read()).toMatchObject({
      pending: 0, deliveredNextStep: 1, deliveredSameSession: 0,
      unconsumedWarned: 0, terminalStatus: 'completed',
      instructions: [expect.objectContaining({ instructionId: 1, content, state: 'deliveredNextStep' })],
    });
    const events = readFileSync(store.getFilePath(), 'utf8').trim().split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events.find((event) => event.type === 'terminal')).toMatchObject({
      status: 'completed', unconsumedInstructionIds: [],
    });
    expect(mockOutputWarn.mock.calls.filter(([message]) => /未消化の追加指示/u.test(String(message)))).toEqual([]);
    expect(existsSync(join(cloneCwd, '.takt', 'runs', runSlug, 'interventions.jsonl'))).toBe(false);
  });

  it('passes project-side instructions from executeWorkflow into an engine running in a clone cwd', async () => {
    const cloneCwd = mkdtempSync(join(tmpdir(), 'takt-live-engine-clone-'));
    const store = new LiveInterventionFileStore(projectCwd, REPORT_DIR);
    const firstTurn = createDeferred<AgentResponse>();
    let firstTurnStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      firstTurnStarted = resolve;
    });

    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      if (vi.mocked(runAgent).mock.calls.length === 1) {
        options.onPromptResolved?.({
          systemPrompt: persona ?? '',
          userInstruction: instruction,
        });
        options.onDispatch?.(options.permissionMode);
        firstTurnStarted();
        return firstTurn.promise;
      }
      return dispatchMockResponse(
        persona,
        instruction,
        options,
        makeResponse({ content: 'clone follow-up completed', sessionId: 'clone-session' }),
      );
    });

    try {
      const runPromise = executeWorkflow(
        buildSingleStepConfig([makeRule('done', 'COMPLETE')]),
        'test task',
        cloneCwd,
        {
          projectCwd,
          provider: 'mock',
          reportDirName: REPORT_DIR,
          language: 'ja',
          outputMode: 'silent',
        },
      );
      await started;
      await store.issue('executeWorkflow reads the project queue');
      firstTurn.resolve(makeResponse({ content: 'clone initial response', sessionId: 'clone-session' }));

      const result = await runPromise;
      const calls = vi.mocked(runAgent).mock.calls;

      expect(result.success).toBe(true);
      expect(calls).toHaveLength(2);
      expect(calls[0]?.[2].cwd).toBe(cloneCwd);
      expect(calls[0]?.[2].projectCwd).toBe(projectCwd);
      expect(calls[1]?.[1]).toContain('executeWorkflow reads the project queue');
      expect(store.read()).toMatchObject({
        pending: 0,
        deliveredSameSession: 1,
        instructions: [expect.objectContaining({ state: 'deliveredSameSession' })],
      });
    } finally {
      if (existsSync(cloneCwd)) {
        rmSync(cloneCwd, { recursive: true, force: true });
      }
    }
  });

  it('reports unconsumed instructions from a completed executeWorkflow through the output adapter', async () => {
    const cloneCwd = mkdtempSync(join(tmpdir(), 'takt-live-engine-completed-'));
    const store = new LiveInterventionFileStore(projectCwd, REPORT_DIR);
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) =>
      dispatchMockResponse(
        persona,
        instruction,
        options,
        makeResponse({ content: 'completed response', sessionId: 'completed-session' }),
      ));
    vi.mocked(runStatusJudgmentPhase).mockImplementationOnce(async () => {
      await store.issue('completed instruction one', '2026-09-03T00:00:00.000Z');
      await store.issue('completed instruction two', '2026-09-03T00:00:01.000Z');
      return { label: 'done', method: 'auto_select' };
    });

    try {
      const result = await executeWorkflow(
        buildSingleStepConfig([
          makeRule('done', 'COMPLETE'),
          makeRule('other', 'fix'),
        ]),
        'completed executeWorkflow task',
        cloneCwd,
        {
          projectCwd,
          provider: 'mock',
          reportDirName: REPORT_DIR,
          language: 'ja',
          outputMode: 'terminal',
        },
      );
      const exactWarnings = mockOutputWarn.mock.calls.filter(([message]) => (
        message === '未消化の追加指示が 2 件あります'
      ));

      expect(result.success).toBe(true);
      expect(exactWarnings).toHaveLength(1);
      expect(store.read()).toMatchObject({
        pending: 0,
        unconsumedWarned: 2,
        terminalStatus: 'completed',
      });
    } finally {
      if (existsSync(cloneCwd)) {
        rmSync(cloneCwd, { recursive: true, force: true });
      }
    }
  });

  it('reports unconsumed instructions from a failed executeWorkflow through the output adapter', async () => {
    const cloneCwd = mkdtempSync(join(tmpdir(), 'takt-live-engine-failed-'));
    const store = new LiveInterventionFileStore(projectCwd, REPORT_DIR);
    let providerCalls = 0;
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      const response = await dispatchMockResponse(
        persona,
        instruction,
        options,
        makeResponse({ status: 'error', content: 'provider failed', error: 'provider failed' }),
      );
      // エンジンの fresh retry でも同じ error を返す。指示の発行は初回のみ（呼び出しごとの副作用ではない）
      if (providerCalls === 0) {
        await store.issue('failed instruction one', '2026-09-03T00:00:00.000Z');
        await store.issue('failed instruction two', '2026-09-03T00:00:01.000Z');
      }
      providerCalls += 1;
      return response;
    });

    try {
      const result = await executeWorkflow(
        buildSingleStepConfig([makeRule('done', 'COMPLETE')]),
        'failed executeWorkflow task',
        cloneCwd,
        {
          projectCwd,
          provider: 'mock',
          reportDirName: REPORT_DIR,
          language: 'ja',
          outputMode: 'terminal',
        },
      );
      const exactWarnings = mockOutputWarn.mock.calls.filter(([message]) => (
        message === '未消化の追加指示が 2 件あります'
      ));

      expect(result.success).toBe(false);
      expect(exactWarnings).toHaveLength(1);
      expect(store.read()).toMatchObject({
        pending: 0,
        unconsumedWarned: 2,
        terminalStatus: 'failed',
      });
    } finally {
      if (existsSync(cloneCwd)) {
        rmSync(cloneCwd, { recursive: true, force: true });
      }
    }
  });

  it.each([
    { outputMode: 'terminal' as const, language: 'ja' as const, warning: '未消化の追加指示が 2 件あります', expectedWarningCount: 1 },
    { outputMode: 'terminal' as const, language: 'en' as const, warning: 'There are 2 unconsumed additional instructions', expectedWarningCount: 1 },
    { outputMode: 'silent' as const, language: 'ja' as const, warning: '未消化の追加指示が 2 件あります', expectedWarningCount: 0 },
  ])('terminalizes bootstrap failure and respects the $outputMode output adapter', async ({
    outputMode,
    language,
    warning,
    expectedWarningCount,
  }) => {
    const cloneCwd = mkdtempSync(join(tmpdir(), `takt-live-engine-bootstrap-${outputMode}-`));
    const store = new LiveInterventionFileStore(projectCwd, REPORT_DIR);
    await store.issue('bootstrap instruction one', '2026-09-03T00:00:00.000Z');
    await store.issue('bootstrap instruction two', '2026-09-03T00:00:01.000Z');
    const publishBundle = vi.spyOn(workflowExecutionBundle, 'publishWorkflowExecutionBundle')
      .mockImplementationOnce(() => {
        throw new Error('deterministic bootstrap failure');
      });

    try {
      await expect(executeWorkflow(
        buildSingleStepConfig([makeRule('done', 'COMPLETE')]),
        'bootstrap executeWorkflow task',
        cloneCwd,
        {
          projectCwd,
          provider: 'mock',
          reportDirName: REPORT_DIR,
          language,
          outputMode,
        },
      )).rejects.toThrow('deterministic bootstrap failure');

      const exactWarnings = mockOutputWarn.mock.calls.filter(([message]) => (
        message === warning
      ));
      expect(exactWarnings).toHaveLength(expectedWarningCount);
      expect(store.read()).toMatchObject({
        pending: 0,
        unconsumedWarned: 2,
        terminalStatus: 'failed',
      });
    } finally {
      publishBundle.mockRestore();
      if (existsSync(cloneCwd)) {
        rmSync(cloneCwd, { recursive: true, force: true });
      }
    }
  });

  it('keeps bootstrap terminalization independent from a failed initial read', async () => {
    const cloneCwd = mkdtempSync(join(tmpdir(), 'takt-live-engine-bootstrap-read-'));
    const store = new LiveInterventionFileStore(projectCwd, REPORT_DIR);
    await store.issue('bootstrap read failure instruction one', '2026-09-03T00:00:00.000Z');
    await store.issue('bootstrap read failure instruction two', '2026-09-03T00:00:01.000Z');
    failLiveInterventionRead('next');
    const publishBundle = vi.spyOn(workflowExecutionBundle, 'publishWorkflowExecutionBundle')
      .mockImplementationOnce(() => {
        throw new Error('deterministic bootstrap read failure');
      });

    try {
      const failure = await executeWorkflow(
        buildSingleStepConfig([makeRule('done', 'COMPLETE')]),
        'bootstrap read failure task',
        cloneCwd,
        {
          projectCwd,
          provider: 'mock',
          reportDirName: REPORT_DIR,
          language: 'ja',
          outputMode: 'terminal',
        },
      ).then(
        () => {
          throw new Error('expected bootstrap execution to fail');
        },
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(AggregateError);
      expect(failure).toMatchObject({
        cause: expect.objectContaining({ message: 'deterministic bootstrap read failure' }),
      });
      expect((failure as AggregateError).errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ message: 'deterministic bootstrap read failure' }),
        expect.objectContaining({ message: 'deterministic live intervention read failure' }),
      ]));

      clearLiveInterventionReadFailure();
      const rawEvents = readFileSync(store.getFilePath(), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const exactWarnings = mockOutputWarn.mock.calls.filter(([message]) => (
        message === '未消化の追加指示が 2 件あります'
      ));

      expect(exactWarnings).toHaveLength(0);
      expect(store.read()).toMatchObject({ pending: 2 });
      expect(store.read().terminalStatus).toBeUndefined();
      expect(rawEvents).toHaveLength(2);
      expect(rawEvents.every((event) => event.type === 'issued')).toBe(true);
    } finally {
      clearLiveInterventionReadFailure();
      publishBundle.mockRestore();
      if (existsSync(cloneCwd)) {
        rmSync(cloneCwd, { recursive: true, force: true });
      }
    }
  });

  it('terminalizes a constructor failure after bootstrap without replacing the primary error', async () => {
    const cloneCwd = mkdtempSync(join(tmpdir(), 'takt-live-engine-constructor-'));
    const store = new LiveInterventionFileStore(projectCwd, REPORT_DIR);
    await store.issue('constructor instruction one', '2026-09-03T00:00:00.000Z');
    await store.issue('constructor instruction two', '2026-09-03T00:00:01.000Z');

    try {
      await expect(executeWorkflow(
        buildSingleStepConfig([makeRule('done', 'COMPLETE')]),
        'constructor executeWorkflow task',
        cloneCwd,
        {
          projectCwd,
          provider: 'mock',
          reportDirName: REPORT_DIR,
          language: 'ja',
          outputMode: 'terminal',
          restartPoint: {
            stack: [{
              workflow: 'live-intervention-engine',
              workflow_ref: 'live-intervention-engine',
              step: 'review',
              kind: 'agent',
            }],
          },
          initialIterationOverride: 1,
        },
      )).rejects.toThrow('Workflow engine cannot own both restartPoint and initialIteration');

      expect(mockOutputWarn).toHaveBeenCalledWith(getLabel('workflow.unconsumedLiveInstructions', 'ja', { count: '2' }));
      expect(store.read()).toMatchObject({
        pending: 0,
        unconsumedWarned: 2,
        terminalStatus: 'failed',
      });
    } finally {
      if (existsSync(cloneCwd)) {
        rmSync(cloneCwd, { recursive: true, force: true });
      }
    }
  });
});

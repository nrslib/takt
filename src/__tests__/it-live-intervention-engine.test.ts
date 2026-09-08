import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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
const liveInterventionReadFailure = vi.hoisted(() => ({ enabled: false }));

vi.mock('../infra/workflow/live-intervention-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../infra/workflow/live-intervention-store.js')>();
  type ActualStore = InstanceType<typeof actual.LiveInterventionFileStore>;

  class TestLiveInterventionFileStore extends actual.LiveInterventionFileStore {
    override read(): ReturnType<ActualStore['read']> {
      if (liveInterventionReadFailure.enabled) {
        liveInterventionReadFailure.enabled = false;
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
import { WorkflowEngine, type WorkflowEngineOptions } from '../core/workflow/index.js';
import { RuleEvaluator as ActualRuleEvaluator } from '../core/workflow/evaluation/RuleEvaluator.js';
import { runReportPhase, runStatusJudgmentPhase } from '../core/workflow/phase-runner.js';
import type { AgentResponse, WorkflowConfig } from '../core/models/index.js';
import type { LiveInterventionChannel } from '../core/workflow/live-intervention/types.js';
import { executeWorkflow } from '../features/tasks/execute/workflowExecution.js';
import * as workflowExecutionBundle from '../features/tasks/execute/workflowExecutionBundle.js';
import { LiveInterventionFileStore } from '../infra/workflow/live-intervention-store.js';
import { mockRuleEvaluation } from './rule-evaluator-test-double.js';
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

function failNextLiveInterventionRead(): void {
  liveInterventionReadFailure.enabled = true;
}

function clearLiveInterventionReadFailure(): void {
  liveInterventionReadFailure.enabled = false;
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

function createCompanionDiffReader() {
  let readCount = 0;
  return {
    readBaselineSha: vi.fn().mockResolvedValue('baseline-sha'),
    readDiff: vi.fn().mockImplementation(async () => {
      readCount += 1;
      const digest = `current-digest-${readCount}`;
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
    vi.mocked(mockRuleEvaluation).mockReturnValue({ index: 0, method: 'phase3_tag' });
    vi.mocked(runReportPhase).mockResolvedValue(undefined);
    vi.mocked(runStatusJudgmentPhase).mockResolvedValue({ label: 'done', method: 'auto_select' });
  });

  afterEach(() => {
    if (engine !== undefined) {
      cleanupWorkflowEngine(engine);
      engine = undefined;
    }
    if (existsSync(projectCwd)) {
      rmSync(projectCwd, { recursive: true, force: true });
    }
  });

  it('waits for the active Phase 1 turn and sends the complete history on the same session', async () => {
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
      createEngineOptions(projectCwd, store),
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
    expect(followUpPrompt).toContain('ユーザー');
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

  it('normalizes a non-native live response, stores it, and evaluates a structured rule', async () => {
    const store = new LiveInterventionFileStore(projectCwd, REPORT_DIR);
    const schema = {
      type: 'object',
      properties: { result: { type: 'string' } },
      required: ['result'],
      additionalProperties: false,
    };
    const config: WorkflowConfig = {
      name: 'live-intervention-structured-output',
      maxSteps: 1,
      initialStep: 'review',
      steps: [makeStep('review', {
        structuredOutput: { schema },
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
    expect(calls[1]?.[1]).toContain('Return exactly one fenced JSON block');
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
    const schema = {
      type: 'object',
      properties: { result: { type: 'string' } },
      required: ['result'],
      additionalProperties: false,
    };
    const config: WorkflowConfig = {
      name: 'live-intervention-native-structured-output',
      maxSteps: 1,
      initialStep: 'review',
      steps: [makeStep('review', {
        structuredOutput: { schema },
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
          rules: [makeRule('judge-selected-fix', 'fix')],
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
      workflowCallResolver: ({ step }) => step.call === childConfig.name ? childConfig : undefined,
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
      failNextLiveInterventionRead();
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
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      const response = await dispatchMockResponse(
        persona,
        instruction,
        options,
        makeResponse({ status: 'error', content: 'provider failed', error: 'provider failed' }),
      );
      await store.issue('未消化の一件目', '2026-09-03T00:00:00.000Z');
      await store.issue('未消化の二件目', '2026-09-03T00:00:01.000Z');
      failNextLiveInterventionRead();
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
    const schema = {
      type: 'object',
      properties: { result: { type: 'string' } },
      required: ['result'],
      additionalProperties: false,
    };
    const config: WorkflowConfig = {
      name: 'live-intervention-completion-retry-structured-output',
      maxSteps: 1,
      initialStep: 'review',
      steps: [makeStep('review', {
        structuredOutput: { schema },
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
    const schema = {
      type: 'object',
      properties: { result: { type: 'string' } },
      required: ['result'],
      additionalProperties: false,
    };
    const config: WorkflowConfig = {
      name: 'live-intervention-completion-retry-structured-output-error',
      maxSteps: 1,
      initialStep: 'review',
      steps: [makeStep('review', {
        structuredOutput: { schema },
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
        structuredOutput: { schema: STRUCTURED_RESULT_SCHEMA },
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
    const companionDiffReader = {
      readBaselineSha: vi.fn().mockResolvedValue('baseline-sha'),
      readDiff: vi.fn().mockResolvedValue({
        status: 'ok' as const,
        snapshot: {
          digest: 'current-digest',
          changedLines: 10,
          content: '+changed content\n',
          changedFiles: ['src/changed.ts'],
          fileFingerprints: { 'src/changed.ts': 'current-digest' },
          hunkFingerprints: { 'src/changed.ts:1-10': 'current-digest' },
          omittedBytes: 0,
          truncated: false,
        },
      }),
    };
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
    const schema = {
      type: 'object',
      properties: { result: { type: 'string' } },
      required: ['result'],
      additionalProperties: false,
    };
    const companionDiffReader = {
      readBaselineSha: vi.fn().mockResolvedValue('baseline-sha'),
      readDiff: vi.fn().mockResolvedValue({
        status: 'ok' as const,
        snapshot: {
          digest: 'current-digest',
          changedLines: 10,
          content: '+changed content\n',
          changedFiles: ['src/changed.ts'],
          fileFingerprints: { 'src/changed.ts': 'current-digest' },
          hunkFingerprints: { 'src/changed.ts:1-10': 'current-digest' },
          omittedBytes: 0,
          truncated: false,
        },
      }),
    };
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
        structuredOutput: { schema },
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
    const schema = {
      type: 'object',
      properties: { result: { type: 'string' } },
      required: ['result'],
      additionalProperties: false,
    };
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
        structuredOutput: { schema },
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
        return makeResponse({
          persona: typeof persona === 'string' ? persona : 'implementer',
          status: mainCalls === 2 ? status : 'done',
          content: mainCalls === 2 ? `${status} follow-up response` : 'initial implementation',
          error: mainCalls === 2 ? 'follow-up failed' : undefined,
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
      expect(mainCalls).toBe(2);
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
        structuredOutput: { schema: STRUCTURED_RESULT_SCHEMA },
        companion: { fixed: ['reviewer'], pool: [] },
        rules: [makeRule('done', 'COMPLETE')],
      })],
    };
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
        ...(structuredOutput === undefined ? {} : { structuredOutput }),
      });
    });

    engine = new WorkflowEngine(config, projectCwd, 'test task', {
      ...createEngineOptions(projectCwd, store),
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
    const schema = {
      type: 'object',
      properties: { result: { type: 'string' } },
      required: ['result'],
      additionalProperties: false,
    };
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
        structuredOutput: { schema },
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
      const schema = {
        type: 'object',
        properties: { result: { type: 'string' } },
        required: ['result'],
        additionalProperties: false,
      };
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
          structuredOutput: { schema },
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
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      const response = await dispatchMockResponse(
        persona,
        instruction,
        options,
        makeResponse({ status: 'error', content: 'provider failed', error: 'provider failed' }),
      );
      await store.issue('failed instruction one', '2026-09-03T00:00:00.000Z');
      await store.issue('failed instruction two', '2026-09-03T00:00:01.000Z');
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
    { outputMode: 'terminal' as const, expectedWarningCount: 1 },
    { outputMode: 'silent' as const, expectedWarningCount: 0 },
  ])('terminalizes bootstrap failure and respects the $outputMode output adapter', async ({
    outputMode,
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
          outputMode,
        },
      )).rejects.toThrow('deterministic bootstrap failure');

      const exactWarnings = mockOutputWarn.mock.calls.filter(([message]) => (
        message === '未消化の追加指示が 2 件あります'
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
    failNextLiveInterventionRead();
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

      expect(mockOutputWarn).toHaveBeenCalledWith('未消化の追加指示が 2 件あります');
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

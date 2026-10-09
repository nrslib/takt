import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createManagerConversationSession } from '../features/manager/conversationSession.js';
import { createGoalConfirmation } from '../features/manager/goalConfirmation.js';
import { verifyGoalConfirmation } from '../infra/goals/confirmation.js';
import { GoalConfirmationPayloadSchema, GoalCreateInputSchema } from '../infra/goals/schema.js';
import { goalRecord } from './helpers/goal-fixtures.js';
import { makeProvider } from './test-helpers.js';
import type { ManagerConversationPlan } from '../features/manager/conversationPlan.js';
import type { Provider, ProviderAgent } from '../infra/providers/types.js';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import * as mcpAdapters from '../infra/providers/mcp/index.js';
import type { Goal } from '../infra/goals/schema.js';
const answerDoubles = vi.hoisted(() => ({ update: vi.fn(), lock: vi.fn(), turn: vi.fn() }));
vi.mock('../infra/goals/store.js', () => ({ GoalStore: class {
  update = answerDoubles.update;
  async list() { return { goals: [], errors: [] }; }
} }));
vi.mock('../infra/goals/turn-lock.js', () => ({ withGoalTurns: answerDoubles.lock }));
vi.mock('../features/manager/completionTurn.js', () => ({ processGoalAnswers: answerDoubles.turn }));
vi.mock('../features/manager/autoRun.js', () => ({ ensureManagerRun: vi.fn(async () => {}) }));

const doubles = { call: vi.fn<ProviderAgent['call']>(), setup: vi.fn<Provider['setup']>() };

const cwd = '/test/manager-repository';
const summaryA = { objective: 'CSVを出力する', outOfScope: ['JSON出力'], acceptanceCriteria: ['CSVを取得できる'] };
const summaryB = { objective: 'JSONを出力する', outOfScope: ['CSV出力'], acceptanceCriteria: ['JSONを取得できる'] };

function response(summary: typeof summaryA | null, message = '要約を確認してください') {
  return { persona: 'manager', status: 'done' as const, timestamp: new Date('2026-10-05T12:00:00Z'), content: JSON.stringify({ message, summary }), structuredOutput: { message, summary }, sessionId: 'manager-session' };
}

function fixture() {
  const confirmation = createGoalConfirmation(cwd);
  const sign = vi.spyOn(confirmation, 'sign');
  const callTool = vi.fn<Client['callTool']>().mockImplementation(async ({ arguments: args }) => {
    const input = GoalCreateInputSchema.parse(args);
    const payload = GoalConfirmationPayloadSchema.parse(JSON.parse(input.confirmation.payload));
    const { id, projectRoot: _root, confirmedAt, confirmedBy, ...approvedSummary } = payload;
    const goal = { ...goalRecord(), ...approvedSummary, id, confirmation: { confirmedAt, confirmedBy } };
    return { content: [{ type: 'text', text: JSON.stringify({ goal }) }] };
  });
  const plan: ManagerConversationPlan = {
    ctx: {
      providerType: 'mock', model: undefined, lang: 'ja',
      provider: makeProvider({ supportsStructuredOutput: true, setup: doubles.setup }),
    },
    strategy: { systemPrompt: 'manager fixture', allowedTools: ['Read'] },
  };
  const session = createManagerConversationSession({ cwd, plan, confirmation, mcpClient: { callTool } });
  return { session, confirmation, sign, callTool, plan };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  doubles.setup.mockReturnValue({ call: doubles.call });
  doubles.call.mockImplementation(async (prompt) => response(prompt.includes('goalRegistered') ? null : summaryA));
  answerDoubles.update.mockReset();
  answerDoubles.turn.mockReset().mockResolvedValue(undefined);
  answerDoubles.lock.mockReset().mockImplementation(async (_cwd: string, _ids: string[], action: () => Promise<void>) => action());
});

it('saves an explicit TUI answer and its event before invoking the goal turn after lock release', async () => {
  const questionId = '650e8400-e29b-41d4-a716-446655440001';
  let saved: Goal = { ...goalRecord(), questions: [{ id: questionId, body: '形式はどれですか', status: 'pending' }] };
  let locked = false;
  answerDoubles.lock.mockImplementation(async (_cwd: string, _ids: string[], action: () => Promise<void>) => {
    locked = true;
    try { await action(); } finally { locked = false; }
  });
  answerDoubles.update.mockImplementation(async (_id: string, transform: (goal: Goal) => Goal) => {
    expect(locked).toBe(true); saved = transform(saved); return saved;
  });
  answerDoubles.turn.mockImplementation(async (_cwd: string, id: string) => {
    expect(locked).toBe(false);
    expect(id).toBe(saved.id);
    expect(saved.answerEvents?.[0]).toMatchObject({ questionId, answer: { text: 'JSON', source: 'tui' }, processed: false });
  });
  const { session, callTool } = fixture();
  const result = await session.answerQuestion({ goalId: saved.id, questionId, text: 'JSON' });
  expect(result.kind).toBe('reply');
  expect(answerDoubles.turn).toHaveBeenCalledOnce();
  expect(callTool).not.toHaveBeenCalled();
  expect(doubles.call).not.toHaveBeenCalled();
  await session.close();
});

it('does not invoke the manager answer turn when answer persistence fails', async () => {
  answerDoubles.update.mockRejectedValueOnce(new Error('answer publication failed'));
  const { session } = fixture();
  expect((await session.answerQuestion({ goalId: goalRecord().id, questionId: 'missing', text: 'JSON' })).kind).toBe('error');
  expect(answerDoubles.turn).not.toHaveBeenCalled();
  await session.close();
  expect((await session.answerQuestion({ goalId: goalRecord().id, questionId: 'missing', text: 'JSON' })).kind).toBe('error');
});

describe('manager conversation approval', () => {
  it.each(['structuredOutput', 'content'] as const)('preserves safe summaries from %s through signing and registration', async (format) => {
    const summary = { ...summaryA, objective: 'CSV\n列名\t値', outOfScope: ['JSON出力', '通知'],
      acceptanceCriteria: ['CSVを取得できる', '列名を含む'], startBranch: 'release', integrationBranch: 'main' };
    const reply = response(summary, '\u001b[31mCSVを出力する\u001b[0m');
    doubles.call.mockResolvedValueOnce({ ...reply, structuredOutput: format === 'content' ? undefined : reply.structuredOutput });
    const { session, sign, callTool, confirmation } = fixture();
    expect((await session.handleUserMessage({ text: '要件を整理してください' })).kind).toBe('reply');
    expect(session.getPendingSummary()?.summary).toEqual(summary);
    expect(sign).not.toHaveBeenCalled();
    const result = await session.approveSummary(session.getPendingSummary()!.revision);
    expect(result).toMatchObject({ kind: 'goal_registered', goal: summary });
    expect(sign).toHaveBeenCalledExactlyOnceWith(summary);
    const request = callTool.mock.calls[0]![0].arguments;
    expect(request).toMatchObject(summary);
    expect(() => verifyGoalConfirmation(request, confirmation.publicKey)).not.toThrow();
    expect(GoalConfirmationPayloadSchema.parse(JSON.parse(GoalCreateInputSchema.parse(request).confirmation.payload))).toMatchObject(summary);
  });

  describe.each(['structuredOutput', 'content'] as const)('display safety with %s', (format) => {
    it.each([
      { ...summaryA, objective: 'CSV\u0000出力' },
      { ...summaryA, objective: '\u001b[31mCSVを出力する\u001b[0m' },
      { ...summaryA, objective: 'CSV\u001b]0;title\u0007出力' },
      { ...summaryA, objective: 'CSV\u0085出力' },
      { ...summaryA, outOfScope: ['JSON出力', '通知\u0007'] },
      { ...summaryA, acceptanceCriteria: ['CSVを取得できる', '列名\u001b['] },
      { ...summaryA, startBranch: 'release\u0085' },
      { ...summaryA, integrationBranch: 'main\u0085' },
    ])('rejects unsafe summary %j and clears the previous approval without side effects', async (summary) => {
      const { session, sign, callTool } = fixture();
      await session.handleUserMessage({ text: 'CSV出力' });
      const old = session.getPendingSummary()!;
      const reply = response(summary);
      doubles.call.mockResolvedValueOnce({ ...reply, structuredOutput: format === 'content' ? undefined : reply.structuredOutput });
      expect((await session.handleUserMessage({ text: '要件を修正してください' })).kind).toBe('error');
      expect(session.getPendingSummary()).toBeNull();
      expect((await session.approveSummary(old.revision)).kind).toBe('error');
      expect((await session.approveSummary(old.revision + 1)).kind).toBe('error');
      expect(sign).not.toHaveBeenCalled();
      expect(callTool).not.toHaveBeenCalled();
    });
  });

  it('rejects a dismissed summary and does not let an old dismiss operation clear a newer summary', async () => {
    const { session, sign, callTool } = fixture();
    await session.handleUserMessage({ text: 'CSV出力' });
    const old = session.getPendingSummary()!;
    session.dismissSummary(old.revision);
    expect(session.getPendingSummary()).toBeNull();
    expect((await session.approveSummary(old.revision)).kind).toBe('error');
    expect(sign).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalled();
    doubles.call.mockResolvedValueOnce(response(summaryB));
    await session.handleUserMessage({ text: 'JSON出力' });
    const latest = session.getPendingSummary()!;
    session.dismissSummary(old.revision);
    expect(session.getPendingSummary()).toEqual(latest);
    await session.approveSummary(latest.revision);
    expect(sign).toHaveBeenCalledExactlyOnceWith(summaryB);
  });
  it.each([false, true])('clears the approval target when prepared MCP cleanup is interrupted or fails=%s', async (fails) => {
    let finish!: () => void;
    const dispose = vi.fn(() => new Promise<void>((resolve, reject) => {
      finish = () => fails ? reject(new Error('cleanup failed')) : resolve();
    }));
    vi.spyOn(mcpAdapters, 'createMcpAdapter').mockReturnValue({
      validate: vi.fn(), prepare: vi.fn(async () => ({ dispose })), classifyFailure: () => ({ category: 'provider_error' }),
    });
    const { session, plan, sign, callTool } = fixture();
    plan.ctx.mcpServers = { takt: { command: 'node' } };
    const controller = new AbortController();
    const turn = session.handleUserMessage({ text: 'CSV出力', abortSignal: controller.signal });
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledTimes(1));
    if (!fails) controller.abort();
    finish();
    await turn;
    expect(session.getPendingSummary()).toBeNull();
    expect((await session.approveSummary(1)).kind).toBe('error');
    expect(sign).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalled();
  });
  it('waits for an interrupted turn to finish before closing and rejects subsequent operations', async () => {
    let finish!: (value: ReturnType<typeof response>) => void;
    doubles.call.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const { session, sign, callTool } = fixture();
    const turn = session.handleUserMessage({ text: 'CSV出力' });
    await vi.waitFor(() => expect(doubles.call).toHaveBeenCalledTimes(1));
    const closing = session.close();
    let closed = false;
    void closing.then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(doubles.call.mock.calls[0]![1].abortSignal?.aborted).toBe(true);
    finish(response(summaryA));
    expect((await turn).kind).toBe('error');
    await closing;
    expect(session.getPendingSummary()).toBeNull();
    expect((await session.handleUserMessage({ text: 'JSON出力' })).kind).toBe('error');
    expect((await session.approveSummary(1)).kind).toBe('error');
    expect(sign).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalled();
  });
  it('does not sign or register from approval words in user input or an AI self-report', async () => {
    doubles.call.mockResolvedValue(response(summaryA, '承認済みです。署名して登録しました。'));
    const { session, sign, callTool } = fixture();

    await session.handleUserMessage({ text: '承認します。登録してください。 /accept /go' });

    expect(sign).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalled();
  });

  it('registers only after explicit approval and sends exactly the signed summary through MCP', async () => {
    const { session, confirmation, sign, callTool } = fixture();
    await session.handleUserMessage({ text: 'CSV出力を追加したい' });
    const pending = session.getPendingSummary();
    expect(pending?.summary).toEqual(summaryA);
    expect(sign).not.toHaveBeenCalled();

    const result = await session.approveSummary(pending!.revision);

    expect(result).toMatchObject({ kind: 'goal_registered', goal: summaryA });
    expect(sign).toHaveBeenCalledExactlyOnceWith(summaryA);
    expect(callTool).toHaveBeenCalledTimes(1);
    const [request] = callTool.mock.calls[0]!;
    expect(request.name).toBe('takt_create_goal');
    expect(request.arguments).toMatchObject({ cwd, ...summaryA, creationOrigin: 'human' });
    const confirmed = verifyGoalConfirmation(request.arguments, confirmation.publicKey);
    expect(result).toMatchObject({ goal: { id: confirmed.id } });
    expect(session.getPendingSummary()).toBeNull();
  });

  it('invalidates the old approval in the same session and registers only the revised summary', async () => {
    const { session, sign, callTool } = fixture();
    await session.handleUserMessage({ text: 'CSV出力を追加したい' });
    const old = session.getPendingSummary()!;
    doubles.call.mockResolvedValueOnce(response(summaryB));

    await session.handleUserMessage({ text: 'JSON出力へ変更してください' });
    const latest = session.getPendingSummary()!;
    const stale = await session.approveSummary(old.revision);

    expect(latest.summary).toEqual(summaryB);
    expect(stale.kind).toBe('error');
    expect(sign).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalled();
    await session.approveSummary(latest.revision);
    expect(sign).toHaveBeenCalledExactlyOnceWith(summaryB);
    expect(callTool.mock.calls[0]![0].arguments).toMatchObject(summaryB);
  });

  it('invalidates a displayed summary as soon as a new message starts', async () => {
    const { session, sign, callTool } = fixture();
    await session.handleUserMessage({ text: 'CSV出力' });
    const old = session.getPendingSummary()!;
    let settle!: (value: ReturnType<typeof response>) => void;
    doubles.call.mockImplementationOnce(() => new Promise((resolve) => { settle = resolve; }));
    const turn = session.handleUserMessage({ text: '要件を修正したい' });

    try {
      await vi.waitFor(() => expect(doubles.call).toHaveBeenCalledTimes(2));
      expect((await session.approveSummary(old.revision)).kind).toBe('error');
      expect(sign).not.toHaveBeenCalled();
      expect(callTool).not.toHaveBeenCalled();
    } finally {
      settle(response(summaryB));
      await turn;
    }
  });

  it('does not create an approval target from quoted JSON or code fences in conversation text', async () => {
    const quoted = JSON.stringify(summaryA);
    const message = [quoted, `> ${quoted}`, `\`\`\`json\n${quoted}\n\`\`\``, `~~~json\n${quoted}\n~~~`, `> > ${quoted}`, `\`\`\`json\n${quoted}`].join('\n');
    doubles.call.mockResolvedValueOnce(response(null, message));
    const { session, sign, callTool } = fixture();

    await session.handleUserMessage({ text: '引用を確認してください' });

    expect(session.getPendingSummary()).toBeNull();
    expect((await session.approveSummary(0)).kind).toBe('error');
    expect(sign).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalled();
  });

  it('reports a provider failure without leaving a previous summary available for approval', async () => {
    const { session, sign, callTool } = fixture();
    await session.handleUserMessage({ text: 'CSV出力' });
    doubles.call.mockResolvedValueOnce({ persona: 'manager', status: 'error', content: '', timestamp: new Date('2026-10-05T12:00:00Z'), error: 'provider failure' });

    const result = await session.handleUserMessage({ text: 'JSONに変更' });

    expect(result.kind).toBe('error');
    expect(session.getPendingSummary()).toBeNull();
    expect(sign).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalled();
  });

  it('does not let an interrupted late response replace the latest summary in the same session', async () => {
    const { session, sign } = fixture();
    let settle!: (value: ReturnType<typeof response>) => void;
    doubles.call.mockImplementationOnce(() => new Promise((resolve) => { settle = resolve; }));
    const controller = new AbortController();
    const oldTurn = session.handleUserMessage({ text: 'CSV出力', abortSignal: controller.signal });
    await vi.waitFor(() => expect(doubles.call).toHaveBeenCalledTimes(1));
    controller.abort();
    doubles.call.mockResolvedValueOnce(response(summaryB));

    try {
      await session.handleUserMessage({ text: 'JSON出力へ変更' });
      expect(session.getPendingSummary()?.summary).toEqual(summaryB);
    } finally {
      settle(response(summaryA));
      await oldTurn;
    }

    expect(session.getPendingSummary()?.summary).toEqual(summaryB);
    await session.approveSummary(session.getPendingSummary()!.revision);
    expect(sign).toHaveBeenCalledExactlyOnceWith(summaryB);
  });

  it.each([
    { ...summaryA, objective: '' },
    { ...summaryA, acceptanceCriteria: [] },
  ])('rejects an incomplete summary before making it available for approval: %j', async (summary) => {
    doubles.call.mockResolvedValueOnce(response(summary));
    const { session, sign, callTool } = fixture();

    const result = await session.handleUserMessage({ text: '要件を整理してください' });

    expect(result.kind).toBe('error');
    expect(session.getPendingSummary()).toBeNull();
    expect(sign).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalled();
  });

  it('reports an MCP error instead of announcing a registered goal', async () => {
    const { session, callTool } = fixture();
    await session.handleUserMessage({ text: 'CSV出力' });
    callTool.mockResolvedValueOnce({ isError: true, content: [{ type: 'text', text: 'registration failed' }] });

    const result = await session.approveSummary(session.getPendingSummary()!.revision);

    expect(result.kind).toBe('error');
  });

  it('rejects duplicate approval while the MCP registration is still pending', async () => {
    const { session, sign, callTool } = fixture();
    await session.handleUserMessage({ text: 'CSV出力' });
    const revision = session.getPendingSummary()!.revision;
    let finish!: (value: Awaited<ReturnType<Client['callTool']>>) => void;
    callTool.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const first = session.approveSummary(revision);
    let closed = false;
    let closing: Promise<void> | undefined;

    try {
      await vi.waitFor(() => expect(callTool).toHaveBeenCalledTimes(1));
      expect((await session.approveSummary(revision)).kind).toBe('error');
      expect(sign).toHaveBeenCalledTimes(1);
      expect(callTool).toHaveBeenCalledTimes(1);
      closing = session.close().then(() => { closed = true; });
      expect(closed).toBe(false);
    } finally {
      const payload = GoalConfirmationPayloadSchema.parse(JSON.parse(GoalCreateInputSchema.parse(callTool.mock.calls[0]![0].arguments).confirmation.payload));
      finish({ content: [{ type: 'text', text: JSON.stringify({ goal: { ...goalRecord(), ...summaryA, id: payload.id } }) }] });
      await first;
      await (closing ?? session.close());
      expect(closed).toBe(true);
    }
  });
});

it.each(['response', 'throw', 'startup'] as const)('returns registration and the failed initial turn together and permits retry: %s', async (failure) => {
  const { session, callTool } = fixture();
  await session.handleUserMessage({ text: 'CSV出力' });
  const error = 'injected initial turn failure';
  if (failure === 'response') doubles.call.mockResolvedValueOnce({ persona: 'manager', status: 'error', content: '', timestamp: new Date(), error });
  if (failure === 'throw') doubles.call.mockRejectedValueOnce(new Error(error));
  if (failure === 'startup') {
    const { ensureManagerRun } = await import('../features/manager/autoRun.js');
    vi.mocked(ensureManagerRun).mockRejectedValueOnce(new Error(error));
  }
  const result = await session.approveSummary(session.getPendingSummary()!.revision);
  expect(result).toMatchObject({ kind: 'goal_registered', goal: summaryA, turn: { kind: 'error', message: error } });
  expect(callTool).toHaveBeenCalledOnce();
  expect(session.getPendingSummary()).toBeNull();
  doubles.call.mockResolvedValueOnce(response(null, 'retry complete'));
  expect(await session.handleUserMessage({ text: '登録済みゴールの作業投入を再試行してください' })).toEqual({ kind: 'reply', message: 'retry complete' });
  expect(callTool).toHaveBeenCalledOnce();
  await session.close();
});

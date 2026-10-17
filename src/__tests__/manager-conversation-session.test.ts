import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { beforeEach,describe,expect,it,vi } from 'vitest';
import { assertStrictStructuredOutputSchema,validateStructuredOutputAgainstSchema } from '../core/workflow/engine/structured-output-schema-validator.js';
import * as conversationPlans from '../features/manager/conversationPlan.js';
import * as managerMcps from '../features/manager/managerMcp.js';
import { createRunEventManager } from '../features/manager/runEventManager.js';
import * as assignments from '../features/manager/assignment.js';
import type { ManagerConversationPlan } from '../features/manager/conversationPlan.js';
import { createManagerConversationSession } from '../features/manager/conversationSession.js';
import { ensureDaemon } from '../features/daemon/lifecycle.js';
import { ensureManagerRun } from '../features/manager/autoRun.js';
import type { Goal } from '../infra/goals/schema.js';
import { GoalCreateInputSchema } from '../infra/goals/schema.js';
import { createGoal } from '../infra/goals/service.js';
import * as mcpAdapters from '../infra/providers/mcp/index.js';
import type { Provider,ProviderAgent } from '../infra/providers/types.js';
import { goalRecord } from './helpers/goal-fixtures.js';
import { makeProvider } from './test-helpers.js';
vi.mock('../infra/goals/service.js', () => ({ createGoal: vi.fn() }));
const answerDoubles = vi.hoisted(() => ({ get: vi.fn(), list: vi.fn(), update: vi.fn(), invalidatePending: vi.fn() }));
vi.mock('../infra/task/runner.js', () => ({ TaskRunner: class { invalidatePendingGoalTasks = answerDoubles.invalidatePending; listTaskStateItems = () => []; } }));
const events = vi.hoisted(() => ({ read: vi.fn(), save: vi.fn(), remove: vi.fn(), removeGoal: vi.fn(), failure: vi.fn() }));
vi.mock('../infra/goals/events.js', () => ({ readManagerEvents: events.read, saveManagerEvent: events.save, deleteManagerEvent: events.remove, deleteGoalEvents: events.removeGoal }));
vi.mock('../features/manager/turnFailureNotification.js', () => ({ notifyManagerTurnFailure: events.failure }));
vi.mock('../infra/goals/store.js', () => ({ GoalStore: class {
    get = answerDoubles.get;
    update = answerDoubles.update;
    list = answerDoubles.list;
  } }));
vi.mock('../features/manager/autoRun.js', () => ({ ensureManagerRun: vi.fn(async () => {}) }));
vi.mock('../features/daemon/lifecycle.js', () => ({ ensureDaemon: vi.fn(async () => {}) }));

const doubles = { call: vi.fn<ProviderAgent['call']>(), setup: vi.fn<Provider['setup']>() };

const cwd = '/test/manager-repository';
const summaryA = { objective: 'CSVを出力する', outOfScope: ['JSON出力'], acceptanceCriteria: ['CSVを取得できる'], constraints: ['git commit 禁止'] };
const summaryB = { objective: 'JSONを出力する', outOfScope: ['CSV出力'], acceptanceCriteria: ['JSONを取得できる'], constraints: [] };

function response(summary: unknown, message = '要約を確認してください') {
  return { persona: 'manager', status: 'done' as const, timestamp: new Date('2026-10-05T12:00:00Z'), content: JSON.stringify({ message, summary }), structuredOutput: { message, summary }, sessionId: 'manager-session' };
}

function fixture(providerType: ManagerConversationPlan['ctx']['providerType'] = 'mock') {
  const register = vi.mocked(createGoal);
  register.mockImplementation(async ({ cwd: _cwd, ...input }) => ({ ...goalRecord(), ...input }));
  const plan: ManagerConversationPlan = {
    ctx: {
      providerType, model: undefined, lang: 'ja',
      provider: makeProvider({ supportsStructuredOutput: true, setup: doubles.setup }),
    },
    strategy: { systemPrompt: 'manager fixture' },
  };
  const session = createManagerConversationSession({ cwd, plan });
  return { session, register, plan };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  doubles.setup.mockReturnValue({ call: doubles.call });
  doubles.call.mockImplementation(async (prompt) => response(prompt.includes('goalRegistered') ? null : summaryA));
  events.read.mockReset().mockReturnValue([]); events.failure.mockResolvedValue(undefined);
  answerDoubles.update.mockReset().mockImplementation(async (_id: string, transform: (goal: Goal) => Goal) => transform(goalRecord()));
  answerDoubles.list.mockReset().mockResolvedValue({ goals: [], errors: [] });
  answerDoubles.get.mockReset().mockResolvedValue(goalRecord());
  answerDoubles.invalidatePending.mockReset();
});

describe('manager conversation approval', () => {
  it('prepares all MCP servers and calls the provider with full permissions and configured options', async () => {
    const dispose = vi.fn(async () => {});
    const prepare = vi.fn(async () => ({ dispose }));
    const validate = vi.fn();
    vi.spyOn(mcpAdapters, 'createMcpAdapter').mockReturnValue({
      validate, prepare, classifyFailure: () => ({ category: 'provider_error' }),
    });
    const { session, plan } = fixture();
    const servers = { manager: { command: 'node' }, browser: { command: '/browser-mcp' } };
    plan.ctx.mcpServers = servers;
    plan.ctx.providerOptions = { codex: { networkAccess: true } };
    try {
      expect((await session.handleUserMessage({ text: 'アプリを確認してください' })).kind).toBe('reply');
      expect(validate).toHaveBeenCalledWith(expect.objectContaining({ servers }));
      expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ servers }), {
        cwd, abortSignal: expect.any(AbortSignal), permissionMode: 'full',
      });
      const options = doubles.call.mock.calls[0]![1];
      expect(options).toMatchObject({ permissionMode: 'full', mcpServers: servers, providerOptions: plan.ctx.providerOptions });
      expect(options.allowedTools).toBeUndefined();
      expect(options.mcpOnlySideEffects).toBeUndefined();
      expect(dispose).toHaveBeenCalledOnce();
    } finally { await session.close(); }
  });

  it('passes a strict Codex conversation schema requiring both nullable branches to the provider', async () => {
    const { session } = fixture('codex');
    try {
      expect((await session.handleUserMessage({ text: 'CSV出力' })).kind).toBe('reply');
      const schema = doubles.call.mock.calls[0]![1].outputSchema!;
      expect(() => assertStrictStructuredOutputSchema(schema)).not.toThrow();
      const wireSummary = { ...summaryA, repositoryDirectory: null, startBranch: null, integrationBranch: null };
      expect(() => validateStructuredOutputAgainstSchema({ message: '確認', summary: wireSummary }, schema)).not.toThrow();
      expect(() => validateStructuredOutputAgainstSchema({ message: '相談', summary: null }, schema)).not.toThrow();
      for (const branch of ['startBranch', 'integrationBranch'] as const) {
        const missing: Record<string, unknown> = { ...wireSummary };
        delete missing[branch];
        expect(() => validateStructuredOutputAgainstSchema({ message: '確認', summary: missing }, schema)).toThrow();
        expect(() => validateStructuredOutputAgainstSchema({ message: '確認', summary: { ...wireSummary, [branch]: 'release' } }, schema)).not.toThrow();
      }
    } finally { await session.close(); }
  });

  describe.each(['structuredOutput', 'content'] as const)('Codex summaries from %s', (format) => {
    it.each([
      { branches: { repositoryDirectory: null, startBranch: null, integrationBranch: null }, expected: {} },
      { branches: { startBranch: null, integrationBranch: 'release' }, expected: { integrationBranch: 'release' } },
      { branches: { startBranch: 'release', integrationBranch: null }, expected: { startBranch: 'release' } },
      { branches: { startBranch: 'null', integrationBranch: 'main' }, expected: { startBranch: 'null', integrationBranch: 'main' } },
      { branches: {}, expected: {} },
    ])('normalizes only null branches before approval, direct registration: $branches', async ({ branches, expected }) => {
      const reply = response({ ...summaryA, ...branches });
      doubles.call.mockResolvedValueOnce({ ...reply, structuredOutput: format === 'content' ? undefined : reply.structuredOutput });
      const { session, register } = fixture('codex');
      try {
        expect((await session.handleUserMessage({ text: '要件を整理してください' })).kind).toBe('reply');
        const normalized = { ...summaryA, ...expected };
        expect(session.getPendingSummary()?.summary).toEqual(normalized);
        expect(register).not.toHaveBeenCalled();
        const result = await session.approveSummary(session.getPendingSummary()!.revision);
        expect(result).toMatchObject({ kind: 'goal_registered', goal: normalized });
        expect(register).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ cwd, ...normalized }));
        const request = GoalCreateInputSchema.parse(register.mock.calls[0]![0]);
        for (const branch of ['startBranch', 'integrationBranch'] as const) {
          const value = normalized[branch as keyof typeof normalized];
          if (value === undefined) {
            expect(request[branch]).toBeUndefined();
          } else {
            expect(request).toHaveProperty(branch, value);
          }
        }
      } finally { await session.close(); }
    });

    it('keeps a null summary unavailable for approval without registration', async () => {
      const reply = response(null, '相談を続けます');
      doubles.call.mockResolvedValueOnce({ ...reply, structuredOutput: format === 'content' ? undefined : reply.structuredOutput });
      const { session, register } = fixture('codex');
      try {
        expect(await session.handleUserMessage({ text: '相談' })).toEqual({ kind: 'reply', message: '相談を続けます' });
        expect(session.getPendingSummary()).toBeNull();
        expect((await session.approveSummary(1)).kind).toBe('error');
        expect(register).not.toHaveBeenCalled();
      } finally { await session.close(); }
    });

    it.each([
      { name: 'null objective', invalid: { objective: null } },
      { name: 'empty objective', invalid: { objective: '' } },
      { name: 'blank objective', invalid: { objective: '   ' } },
      { name: 'oversized objective', invalid: { objective: 'a'.repeat(128 * 1024 + 1) } },
      { name: 'empty acceptance criteria', invalid: { acceptanceCriteria: [] } },
      { name: 'unsafe display characters', invalid: { objective: 'CSV\u0000出力' } },
      { name: 'invalid branch', invalid: { integrationBranch: 'bad branch' } },
      { name: 'unknown summary property', invalid: { unexpected: 'value' } },
    ])('retains summary validation after null normalization and rejects $name', async ({ invalid }) => {
      const { session, register } = fixture('codex');
      try {
        await session.handleUserMessage({ text: 'CSV出力' });
        const old = session.getPendingSummary()!;
        const reply = response({ ...summaryA, repositoryDirectory: null, startBranch: null, integrationBranch: null, ...invalid });
        doubles.call.mockResolvedValueOnce({ ...reply, structuredOutput: format === 'content' ? undefined : reply.structuredOutput });
        expect((await session.handleUserMessage({ text: '修正してください' })).kind).toBe('error');
        expect(session.getPendingSummary()).toBeNull();
        expect((await session.approveSummary(old.revision)).kind).toBe('error');
        expect(register).not.toHaveBeenCalled();
      } finally { await session.close(); }
    });
  });

  it.each(['claude', 'claude-sdk'] as const)('preserves optional branches and receive validation for %s', async (providerType) => {
    const { session, register } = fixture(providerType);
    try {
      expect((await session.handleUserMessage({ text: 'CSV出力' })).kind).toBe('reply');
      const schema = doubles.call.mock.calls[0]![1].outputSchema!;
      expect(schema).not.toHaveProperty('$schema');
      expect(schema).toMatchObject({ properties: { message: { minLength: 1 } } });
      expect(() => validateStructuredOutputAgainstSchema({ message: '確認', summary: summaryA }, schema)).not.toThrow();
      expect(() => validateStructuredOutputAgainstSchema({ message: '確認', summary: { ...summaryA, startBranch: 'release', integrationBranch: 'main' } }, schema)).not.toThrow();
      expect(() => validateStructuredOutputAgainstSchema({ message: '確認', summary: { ...summaryA, repositoryDirectory: null, startBranch: null, integrationBranch: null } }, schema)).toThrow();
      expect(() => validateStructuredOutputAgainstSchema({ message: '', summary: summaryA }, schema)).toThrow();
      expect(() => validateStructuredOutputAgainstSchema({ message: '確認', summary: { ...summaryA, acceptanceCriteria: [] } }, schema)).toThrow();
      expect(() => validateStructuredOutputAgainstSchema({ message: '確認', summary: { ...summaryA, objective: 'a'.repeat(128 * 1024 + 1) } }, schema)).toThrow();
      expect((await session.approveSummary(session.getPendingSummary()!.revision)).kind).toBe('goal_registered');
      expect(register).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ cwd, ...summaryA }));
      expect(register).toHaveBeenCalledOnce();
      doubles.call.mockResolvedValueOnce(response({ ...summaryA, repositoryDirectory: null, startBranch: null, integrationBranch: null }));
      expect((await session.handleUserMessage({ text: '修正' })).kind).toBe('error');
      expect(session.getPendingSummary()).toBeNull();
      expect(register).toHaveBeenCalledOnce();
    } finally { await session.close(); }
  });

  it.each(['structuredOutput', 'content'] as const)('preserves safe summaries from %s through direct registration', async (format) => {
    const summary = { ...summaryA, objective: 'CSV\n列名\t値', outOfScope: ['JSON出力', '通知'],
      acceptanceCriteria: ['CSVを取得できる', '列名を含む'], startBranch: 'release', integrationBranch: 'main', constraints: [], };
    const reply = response(summary, '\u001b[31mCSVを出力する\u001b[0m');
    doubles.call.mockResolvedValueOnce({ ...reply, structuredOutput: format === 'content' ? undefined : reply.structuredOutput });
    const { session, register } = fixture();
    expect((await session.handleUserMessage({ text: '要件を整理してください' })).kind).toBe('reply');
    expect(session.getPendingSummary()?.summary).toEqual(summary);
    const result = await session.approveSummary(session.getPendingSummary()!.revision);
    expect(result).toMatchObject({ kind: 'goal_registered', goal: summary });
    expect(register).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ cwd, ...summary }));
    const request = register.mock.calls[0]![0];
    expect(request).toMatchObject(summary);
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
      const { session, register } = fixture();
      await session.handleUserMessage({ text: 'CSV出力' });
      const old = session.getPendingSummary()!;
      const reply = response(summary);
      doubles.call.mockResolvedValueOnce({ ...reply, structuredOutput: format === 'content' ? undefined : reply.structuredOutput });
      expect((await session.handleUserMessage({ text: '要件を修正してください' })).kind).toBe('error');
      expect(session.getPendingSummary()).toBeNull();
      expect((await session.approveSummary(old.revision)).kind).toBe('error');
      expect((await session.approveSummary(old.revision + 1)).kind).toBe('error');
      expect(register).not.toHaveBeenCalled();
    });
  });

  it('rejects a dismissed summary and does not let an old dismiss operation clear a newer summary', async () => {
    const { session, register } = fixture();
    await session.handleUserMessage({ text: 'CSV出力' });
    const old = session.getPendingSummary()!;
    session.dismissSummary(old.revision);
    expect(session.getPendingSummary()).toBeNull();
    expect((await session.approveSummary(old.revision)).kind).toBe('error');
    expect(register).not.toHaveBeenCalled();
    doubles.call.mockResolvedValueOnce(response(summaryB));
    await session.handleUserMessage({ text: 'JSON出力' });
    const latest = session.getPendingSummary()!;
    session.dismissSummary(old.revision);
    expect(session.getPendingSummary()).toEqual(latest);
    await session.approveSummary(latest.revision);
    expect(register).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ cwd, ...summaryB }));
  });
  it.each([false, true])('clears the approval target when prepared MCP cleanup is interrupted or fails=%s', async (fails) => {
    let finish!: () => void;
    const dispose = vi.fn(() => new Promise<void>((resolve, reject) => {
      finish = () => fails ? reject(new Error('cleanup failed')) : resolve();
    }));
    vi.spyOn(mcpAdapters, 'createMcpAdapter').mockReturnValue({
      validate: vi.fn(), prepare: vi.fn(async () => ({ dispose })), classifyFailure: () => ({ category: 'provider_error' }),
    });
    const { session, plan, register } = fixture();
    plan.ctx.mcpServers = { takt: { command: 'node' } };
    const controller = new AbortController();
    const turn = session.handleUserMessage({ text: 'CSV出力', abortSignal: controller.signal });
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledTimes(1));
    if (!fails) controller.abort();
    finish();
    await turn;
    expect(session.getPendingSummary()).toBeNull();
    expect((await session.approveSummary(1)).kind).toBe('error');
    expect(register).not.toHaveBeenCalled();
  });
  it('waits for an interrupted turn to finish before closing and rejects subsequent operations', async () => {
    let finish!: (value: ReturnType<typeof response>) => void;
    doubles.call.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const { session, register } = fixture();
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
    expect(register).not.toHaveBeenCalled();
  });
  it('does not register from approval words in user input or an AI self-report', async () => {
    doubles.call.mockResolvedValue(response(summaryA, '承認済みです。署名して登録しました。'));
    const { session, register } = fixture();

    await session.handleUserMessage({ text: '承認します。登録してください。 /accept /go' });

    expect(register).not.toHaveBeenCalled();
  });

  it('registers only after explicit approval and sends exactly the approved summary to the service', async () => {
    const { session, register } = fixture();
    await session.handleUserMessage({ text: 'CSV出力を追加したい' });
    const pending = session.getPendingSummary();
    expect(pending?.summary).toEqual(summaryA);

    const result = await session.approveSummary(pending!.revision);

    expect(result).toMatchObject({ kind: 'goal_registered', goal: summaryA });
    expect(register).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ cwd, ...summaryA }));
    expect(register).toHaveBeenCalledTimes(1);
    const [request] = register.mock.calls[0]!;
    expect(request).toMatchObject({ cwd, ...summaryA, id: expect.any(String) });
    expect(result).toMatchObject({ goal: { id: request.id } });
    expect(session.getPendingSummary()).toBeNull();
  });

  it('invalidates the old approval in the same session and registers only the revised summary', async () => {
    const { session, register } = fixture();
    await session.handleUserMessage({ text: 'CSV出力を追加したい' });
    const old = session.getPendingSummary()!;
    doubles.call.mockResolvedValueOnce(response(summaryB));

    await session.handleUserMessage({ text: 'JSON出力へ変更してください' });
    const latest = session.getPendingSummary()!;
    const stale = await session.approveSummary(old.revision);

    expect(latest.summary).toEqual(summaryB);
    expect(stale.kind).toBe('error');
    expect(register).not.toHaveBeenCalled();
    await session.approveSummary(latest.revision);
    expect(register).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ cwd, ...summaryB }));
    expect(register.mock.calls[0]![0]).toMatchObject(summaryB);
  });

  it('invalidates a displayed summary as soon as a new message starts', async () => {
    const { session, register } = fixture();
    await session.handleUserMessage({ text: 'CSV出力' });
    const old = session.getPendingSummary()!;
    let settle!: (value: ReturnType<typeof response>) => void;
    doubles.call.mockImplementationOnce(() => new Promise((resolve) => { settle = resolve; }));
    const turn = session.handleUserMessage({ text: '要件を修正したい' });

    try {
      await vi.waitFor(() => expect(doubles.call).toHaveBeenCalledTimes(2));
      expect((await session.approveSummary(old.revision)).kind).toBe('error');
      expect(register).not.toHaveBeenCalled();
    } finally {
      settle(response(summaryB));
      await turn;
    }
  });

  it('does not create an approval target from quoted JSON or code fences in conversation text', async () => {
    const quoted = JSON.stringify(summaryA);
    const message = [quoted, `> ${quoted}`, `\`\`\`json\n${quoted}\n\`\`\``, `~~~json\n${quoted}\n~~~`, `> > ${quoted}`, `\`\`\`json\n${quoted}`].join('\n');
    doubles.call.mockResolvedValueOnce(response(null, message));
    const { session, register } = fixture();

    await session.handleUserMessage({ text: '引用を確認してください' });

    expect(session.getPendingSummary()).toBeNull();
    expect((await session.approveSummary(0)).kind).toBe('error');
    expect(register).not.toHaveBeenCalled();
  });

  it('reports a provider failure without leaving a previous summary available for approval', async () => {
    const { session, register } = fixture();
    await session.handleUserMessage({ text: 'CSV出力' });
    doubles.call.mockResolvedValueOnce({ persona: 'manager', status: 'error', content: '', timestamp: new Date('2026-10-05T12:00:00Z'), error: 'provider failure' });

    const result = await session.handleUserMessage({ text: 'JSONに変更' });

    expect(result.kind).toBe('error');
    expect(session.getPendingSummary()).toBeNull();
    expect(register).not.toHaveBeenCalled();
  });

  it('waits for an interrupted provider call before starting a new conversation turn', async () => {
    const { session, register } = fixture();
    let settle!: (value: ReturnType<typeof response>) => void;
    doubles.call.mockImplementationOnce(() => new Promise((resolve) => { settle = resolve; }));
    const controller = new AbortController();
    const oldTurn = session.handleUserMessage({ text: 'CSV出力', abortSignal: controller.signal });
    await vi.waitFor(() => expect(doubles.call).toHaveBeenCalledOnce());
    controller.abort();
    expect((await session.handleUserMessage({ text: 'JSON出力へ変更' })).kind).toBe('error');
    expect(doubles.call).toHaveBeenCalledOnce();
    settle(response(summaryA));
    expect((await oldTurn).kind).toBe('error');
    expect(session.getPendingSummary()).toBeNull();
    doubles.call.mockResolvedValueOnce(response(summaryB));
    await session.handleUserMessage({ text: 'JSON出力へ変更' });
    await session.approveSummary(session.getPendingSummary()!.revision);
    expect(register).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ cwd, ...summaryB }));
    await session.close();
  });

  it.each([false, true])('does not restore an interrupted summary after repository resolution (new turn: %s)', async (newTurn) => {
    const assignment = { kind: 'repository' as const, repositoryDirectory: cwd, repositoryDirectories: [cwd] };
    vi.spyOn(assignments, 'resolveCurrentManagerAssignment').mockResolvedValue(assignment);
    let finish!: (repository: string) => void;
    const resolveRoot = vi.spyOn(assignments, 'resolveAssignedProjectRoot').mockResolvedValue(cwd)
      .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const { plan, register } = fixture();
    const session = createManagerConversationSession({ cwd, plan, assignment });
    const controller = new AbortController();
    const oldTurn = session.handleUserMessage({ text: 'CSV出力', abortSignal: controller.signal });
    try {
      await vi.waitFor(() => expect(resolveRoot).toHaveBeenCalledTimes(1));
      controller.abort();
      expect(session.getPendingSummary()).toBeNull();
      expect((await session.handleUserMessage({ text: 'JSON出力へ変更' })).kind).toBe('error');
      finish(cwd);
      expect((await oldTurn).kind).toBe('error');
      expect(session.getPendingSummary()).toBeNull();
      if (newTurn) {
        doubles.call.mockResolvedValueOnce(response(summaryB));
        expect((await session.handleUserMessage({ text: 'JSON出力へ変更' })).kind).toBe('reply');
        const latest = session.getPendingSummary();
        expect(latest?.summary).toEqual(summaryB);
        await session.approveSummary(latest!.revision);
        expect(register).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ cwd, ...summaryB }));
      } else {
        expect((await session.approveSummary(1)).kind).toBe('error');
        expect(register).not.toHaveBeenCalled();
      }
    } finally {
      finish?.(cwd);
      await session.close();
    }
  });

  it.each([
    { ...summaryA, objective: '' },
    { ...summaryA, acceptanceCriteria: [] },
  ])('rejects an incomplete summary before making it available for approval: %j', async (summary) => {
    doubles.call.mockResolvedValueOnce(response(summary));
    const { session, register } = fixture();

    const result = await session.handleUserMessage({ text: '要件を整理してください' });

    expect(result.kind).toBe('error');
    expect(session.getPendingSummary()).toBeNull();
    expect(register).not.toHaveBeenCalled();
  });

  it('reports a registration error instead of announcing a registered goal', async () => {
    const { session, register } = fixture();
    await session.handleUserMessage({ text: 'CSV出力' });
    register.mockRejectedValueOnce(new Error('registration failed'));

    const result = await session.approveSummary(session.getPendingSummary()!.revision);

    expect(result.kind).toBe('error');
  });

  it('rejects duplicate approval while the registration is still pending', async () => {
    const { session, register } = fixture();
    await session.handleUserMessage({ text: 'CSV出力' });
    const revision = session.getPendingSummary()!.revision;
    let finish!: (value: Goal) => void;
    register.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const first = session.approveSummary(revision);
    let closed = false;
    let closing: Promise<void> | undefined;

    try {
      await vi.waitFor(() => expect(register).toHaveBeenCalledTimes(1));
      expect((await session.approveSummary(revision)).kind).toBe('error');
      expect(register).toHaveBeenCalledTimes(1);
      closing = session.close().then(() => { closed = true; });
      expect(closed).toBe(false);
    } finally {
      finish({ ...goalRecord(), ...summaryA, id: register.mock.calls[0]![0].id });
      await first;
      await (closing ?? session.close());
      expect(closed).toBe(true);
    }
  });
});


it('saves a human answer as an inbox event without calling a second agent', async () => {
  const { session } = fixture(); const questionId = '550e8400-e29b-41d4-a716-446655440003';
  answerDoubles.update.mockImplementation(async (_id: string, transform: (goal: Goal) => Goal) => transform({ ...goalRecord(), questions: [{ id: questionId, recipient: 'human', status: 'pending', body: '形式はどれですか' }] }));
  expect((await session.answerQuestion({ goalId: goalRecord().id, questionId, text: 'CSV' })).kind).toBe('reply');
  expect(events.save).toHaveBeenCalledWith(cwd, expect.objectContaining({ kind: 'answer', questionId, answer: expect.objectContaining({ text: 'CSV', source: 'tui' }) }));
  expect(ensureDaemon).toHaveBeenCalledOnce();
  expect(ensureManagerRun).toHaveBeenCalledExactlyOnceWith(cwd);
  expect(events.save.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(ensureDaemon).mock.invocationCallOrder[0]!);
  expect(doubles.call).not.toHaveBeenCalled(); await session.close();
});

it('ensures the daemon after saving a resumed goal', async () => {
  const { session } = fixture();
  answerDoubles.get.mockResolvedValue({ ...goalRecord(), executionStatus: 'paused' });
  try {
    expect((await session.resumeGoal({ goalId: goalRecord().id })).kind).toBe('reply');
    expect(events.save).toHaveBeenCalledWith(cwd, { kind: 'resumed', goalId: goalRecord().id });
    expect(ensureDaemon).toHaveBeenCalledOnce();
    expect(ensureManagerRun).toHaveBeenCalledExactlyOnceWith(cwd);
    expect(events.save.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(ensureDaemon).mock.invocationCallOrder[0]!);
  } finally { await session.close(); }
});


it('includes saved run results in the next human turn, including a new session', async () => {
  const goal = { ...goalRecord(), workLog: [{ id: '550e8400-e29b-41d4-a716-446655440005', recordedAt: '2026-10-14T00:00:00Z', summary: 'task-X を取り込み、task-Y を投入しました' }] };
  answerDoubles.list.mockResolvedValue({ goals: [goal], errors: [] });
  for (let index = 0; index < 2; index++) {
    const { session } = fixture();
    await session.handleUserMessage({ text: '進捗を教えてください' });
    expect(doubles.call.mock.calls.at(-1)![0]).toContain(goal.workLog[0]!.summary);
    expect(doubles.call.mock.calls.at(-1)![0]).toContain(goal.objective);
    await session.close();
  }
});

it('reports an unavailable goal memory in the next turn instead of stopping unrelated work', async () => {
  const failure = new Error('Goal directory cannot be listed');
  answerDoubles.list.mockRejectedValue(failure);
  const { session } = fixture();
  expect((await session.handleUserMessage({ text: '進捗を確認してください' })).kind).toBe('reply');
  const prompt = doubles.call.mock.calls[0]![0];
  expect(prompt).toContain(failure.message);
  expect(prompt).toContain('diagnostics');
  await session.close();
});


it('bounds goal memory across assigned repositories with large objectives and work logs', async () => {
  const repositories = ['/project-a', '/project-b'];
  const assignment = { kind: 'workspace' as const, workspaceId: 'workspace', name: 'workspace', repositoryDirectories: repositories };
  vi.spyOn(assignments, 'resolveCurrentManagerAssignment').mockResolvedValue(assignment);
  const goals = Array.from({ length: 100 }, (_, index) => ({
    ...goalRecord(), id: `550e8400-e29b-41d4-a716-${String(index).padStart(12, '0')}`,
    objective: '目的'.repeat(30000),
    workLog: Array.from({ length: 100 }, (_, record) => ({
      id: `650e8400-e29b-41d4-a716-${String(record).padStart(12, '0')}`,
      recordedAt: '2026-10-14T00:00:00Z', summary: `作業${record}:` + '詳細'.repeat(20000),
    })),
  }));
  answerDoubles.list.mockResolvedValue({ goals, errors: [] });
  const { plan } = fixture();
  doubles.call.mockResolvedValue(response(null));
  const session = createManagerConversationSession({ cwd, plan, assignment: { kind: 'workspace', workspaceId: 'workspace' } });
  try {
    expect((await session.handleUserMessage({ text: '進捗' })).kind).toBe('reply');
    const prompt = doubles.call.mock.calls[0]![0];
    const memoryText = prompt.split('Goal memory (including run manager results): ')[1]!;
    expect(Buffer.byteLength(memoryText)).toBeLessThanOrEqual(64 * 1024);
    const memory = JSON.parse(memoryText);
    expect(memory.truncated).toBe(true);
    expect(memory.repositories.map((repository: { repositoryDirectory: string }) => repository.repositoryDirectory)).toEqual(repositories);
    expect(memory.repositories[0].goalCount).toBe(100);
    expect(memory.repositories[0].goals.length).toBeGreaterThan(0);
    expect(memory.repositories[0].goals.length).toBeLessThan(100);
    expect(prompt).not.toContain(goals[0]!.objective);
    expect(prompt).not.toContain(goals[0]!.workLog[99]!.summary);
    expect(memory.repositories[0].goals[0]).toMatchObject({ workLogCount: 100,
      references: { goal: `/project-a/.takt/goals/${goals[0]!.id}/goal.json` },
    });
    expect(memory.repositories[0].goals[0].workLog).toHaveLength(3);
  } finally { await session.close(); }
});

it.each(['result', 'throw'] as const)('retries prompt overflow from a provider %s once with a new session and keeps its result', async (failure) => {
  const { session, plan } = fixture();
  const dispose = vi.fn(async () => {});
  const prepare = vi.fn(async () => ({ dispose }));
  vi.spyOn(mcpAdapters, 'createMcpAdapter').mockReturnValue({ validate: vi.fn(), prepare, classifyFailure: () => ({ category: 'provider_error' }) });
  plan.ctx.mcpServers = { manager: { command: 'node' } };
  try {
    await session.handleUserMessage({ text: '最初の相談' });
    const message = 'Claude Code returned an error result: Prompt is too long';
    if (failure === 'throw') doubles.call.mockRejectedValueOnce(new Error(message));
    else doubles.call.mockResolvedValueOnce({ ...response(null), status: 'error', error: message });
    doubles.call.mockResolvedValueOnce({ ...response(summaryB, '再試行の結果'), sessionId: 'fresh-session' });
    expect(await session.handleUserMessage({ text: '続き' })).toEqual({ kind: 'reply', message: '再試行の結果' });
    expect(doubles.call).toHaveBeenCalledTimes(3);
    expect(doubles.call.mock.calls[1]![1].sessionId).toBe('manager-session');
    expect(doubles.call.mock.calls[2]![1].sessionId).toBeUndefined();
    expect(doubles.call.mock.calls[2]![0]).toBe(doubles.call.mock.calls[1]![0]);
    expect(doubles.call.mock.calls[2]![1].preparedMcp).toBe(doubles.call.mock.calls[1]![1].preparedMcp);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(dispose).toHaveBeenCalledTimes(2);
    expect(session.getPendingSummary()?.summary).toEqual(summaryB);
    await session.handleUserMessage({ text: 'その後' });
    expect(doubles.call.mock.calls[3]![1].sessionId).toBe('fresh-session');
  } finally { await session.close(); }
});

it.each(['result', 'throw'] as const)('returns the second overflow failure from a provider %s without a third attempt', async (failure) => {
  const { session } = fixture();
  try {
    await session.handleUserMessage({ text: '最初の相談' });
    const message = 'Prompt is too long';
    if (failure === 'throw') doubles.call.mockRejectedValue(new Error(message));
    else doubles.call.mockResolvedValue({ ...response(null), status: 'error', error: message });
    expect(await session.handleUserMessage({ text: '続き' })).toEqual({ kind: 'error', message });
    expect(doubles.call).toHaveBeenCalledTimes(3);
    expect(doubles.call.mock.calls[1]![1].sessionId).toBe('manager-session');
    expect(doubles.call.mock.calls[2]![1].sessionId).toBeUndefined();
    expect(session.getPendingSummary()).toBeNull();
  } finally { await session.close(); }
});

it('does not retry an overflow after the failed attempt already used a tool', async () => {
  const { session } = fixture();
  try {
    doubles.call.mockImplementationOnce(async (_prompt, options) => {
      options.onStream?.({ type: 'tool_use', data: { tool: 'mcp__takt__takt_enqueue_goal_task', id: 'tool-1', input: {} } });
      throw new Error('Prompt is too long');
    });
    expect(await session.handleUserMessage({ text: '相談' })).toEqual({ kind: 'error', message: 'Prompt is too long' });
    expect(doubles.call).toHaveBeenCalledOnce();
  } finally { await session.close(); }
});

it('does not retry unrelated provider failures or cancelled overflow calls', async () => {
  const { session } = fixture();
  try {
    doubles.call.mockRejectedValueOnce(new Error('unrelated provider failure'));
    expect((await session.handleUserMessage({ text: '相談' })).kind).toBe('error');
    expect(doubles.call).toHaveBeenCalledOnce();
    const controller = new AbortController();
    doubles.call.mockImplementationOnce(async () => { controller.abort(); throw new Error('Prompt is too long'); });
    expect((await session.handleUserMessage({ text: '続き', abortSignal: controller.signal })).kind).toBe('error');
    expect(doubles.call).toHaveBeenCalledTimes(2);
  } finally { await session.close(); }
});

it.each([false, true])('calls the provider without a sessionId for each daemon event while reusing MCP and preflight (overflow: %s)', async (overflow) => {
  const { plan } = fixture();
  const preflight = vi.fn(async () => {});
  plan.ctx.provider.preflight = preflight;
  vi.spyOn(conversationPlans, 'createManagerConversationPlan').mockReturnValue(plan);
  const dispose = vi.fn(async () => {});
  const connect = vi.spyOn(managerMcps, 'connectManagerMcp').mockResolvedValue({ client: new Client({ name: 'test', version: '1' }), servers: {}, dispose });
  vi.spyOn(mcpAdapters, 'createMcpAdapter').mockReturnValue({
    validate: vi.fn(), prepare: vi.fn(async () => ({ dispose: vi.fn(async () => {}) })),
    classifyFailure: () => ({ category: 'provider_error' }),
  });
  events.read.mockReturnValue(['task-a', 'task-b'].map((taskName) => ({ filePath: `/inbox/${taskName}.json`, event: {
    kind: 'completion', goalId: goalRecord().id, createdAt: '2026-10-14T00:00:00Z',
    taskName, runSlug: `run-${taskName}`, result: { success: true, interrupted: false },
  } })));
  doubles.call.mockResolvedValue(response(null, '処理完了'));
  if (overflow) doubles.call.mockResolvedValueOnce({ ...response(null), status: 'error', error: 'Prompt is too long' });
  const manager = createRunEventManager(cwd);
  try {
    expect(await manager.processPending(new AbortController().signal, 2)).toBe(true);
    expect(doubles.call).toHaveBeenCalledTimes(overflow ? 3 : 2);
    for (const [, options] of doubles.call.mock.calls) expect(options.sessionId).toBeUndefined();
    expect(JSON.parse(doubles.call.mock.calls[0]![0]).event.taskName).toBe('task-a');
    expect(JSON.parse(doubles.call.mock.calls.at(-1)![0]).event.taskName).toBe('task-b');
    expect(connect).toHaveBeenCalledOnce();
    expect(preflight).toHaveBeenCalledOnce();
    expect(events.remove).toHaveBeenCalledTimes(2);
  } finally { await manager.close(); }
  expect(dispose).toHaveBeenCalledOnce();
});

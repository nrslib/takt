import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentResponse } from '../core/models/types.js';
import type { ToolPermissionDecision, ToolPermissionDecisionRequest } from '../core/workflow/types.js';
import { createManagerConversationSession, type ManagerConversationSession } from '../features/manager/conversationSession.js';
import type { ManagerConversationPlan } from '../features/manager/conversationPlan.js';
import { addManagerRepository } from '../features/manager/workspaceOperations.js';
import { projectIdForCanonicalDirectory } from '../infra/config/global/projectRegistry.js';
import { listPendingInquiries } from '../infra/goals/pending-inquiries.js';
import { addGoalQuestion, answerGoalQuestion, withdrawGoalQuestion } from '../infra/goals/questions.js';
import type { GoalQuestionInput } from '../infra/goals/schema.js';
import { StandaloneInquiryStore, type InquiryOwner } from '../infra/goals/standalone-inquiries.js';
import { GoalStore } from '../infra/goals/store.js';
import type { ProviderAgent } from '../infra/providers/types.js';
import { parseCodexToolPermissionOutput, toCodexToolPermissionOutput } from '../infra/codex/tool-permission-hook-protocol.js';
import { prepareCodexToolPermissionHook } from '../infra/codex/tool-permission-hook.js';
import { goalRecord } from './helpers/goal-fixtures.js';
import { makeProvider } from './test-helpers.js';

const doubles = vi.hoisted(() => ({ judge: vi.fn(), notificationOptions: vi.fn(), slack: vi.fn() }));
vi.mock('../agents/agent-usecases.js', () => ({ executeIsolatedStructuredInternalAgent: doubles.judge }));
vi.mock('../features/manager/autoRun.js', () => ({ ensureManagerRun: vi.fn(async () => {}) }));
vi.mock('../infra/task/runner.js', () => ({ TaskRunner: class { listTaskStateItems = () => []; } }));
vi.mock('../infra/task/repositoryDirectory.js', () => ({ resolveGitRepositoryDirectory: (directory: string) => realpath(directory) }));
vi.mock('../features/manager/notifications.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../features/manager/notifications.js')>(),
  resolveManagerNotificationOptions: doubles.notificationOptions,
}));
vi.mock('../shared/utils/slackWebhook.js', () => ({ sendSlackNotification: doubles.slack }));

type Origin = 'goal' | 'workspace' | 'repository';
const workspaceId = '750e8400-e29b-41d4-a716-446655440001';
const otherWorkspaceId = '750e8400-e29b-41d4-a716-446655440002';
const reason = '出力先を確認してください';
const policy = { question: true, awaiting_merge: true, completed: true, progress: true, blocked: true, custom: false };
const sessions: ManagerConversationSession[] = [];

function judgment(decision: 'allow' | 'deny' | 'ask', confirmation: string | null): AgentResponse {
  return { persona: 'manager-permission-judge', status: 'done', timestamp: new Date(), content: '',
    structuredOutput: { decision, reason: confirmation } };
}

beforeEach(async () => {
  vi.resetAllMocks();
  doubles.judge.mockResolvedValue(judgment('ask', reason));
  doubles.notificationOptions.mockReturnValue({ policy, webhookUrl: undefined, mainMerge: 'approve' });
});
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()));
  vi.restoreAllMocks();
});

async function fixture(origin: Origin, providerType: 'claude-sdk' | 'codex' = 'claude-sdk') {
  const config = process.env.TAKT_CONFIG_DIR!;
  const repository = join(config, 'repository-a');
  const goalRepository = join(config, 'repository-b');
  const cwd = join(config, 'conversation');
  const toolCwd = join(config, 'tool-directory');
  await Promise.all([repository, goalRepository, cwd, toolCwd].map((directory) => mkdir(directory, { recursive: true })));
  const owner: InquiryOwner = origin === 'repository'
    ? { kind: 'repository', repositoryDirectory: repository }
    : { kind: 'workspace', workspaceId };
  const repositoryDirectories = origin === 'repository' ? [repository] : [repository, goalRepository];
  if (owner.kind === 'workspace') {
    const directory = join(config, 'workspaces', workspaceId);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'workspace.json'), JSON.stringify({ id: workspaceId, name: '承認の確認', repositoryDirectories }));
  }
  const goalStore = new GoalStore(goalRepository);
  if (origin === 'goal') await goalStore.create(goalRecord());
  const goal = origin === 'goal'
    ? { id: goalRecord().id, repositoryDirectory: goalRepository, constraints: [] }
    : undefined;
  const standalone = new StandaloneInquiryStore(config, owner);
  const request: ToolPermissionDecisionRequest = {
    toolName: 'Write', toolInput: { file_path: '/repo/result.txt', content: 'hello' }, cwd: toolCwd,
  };
  const call = vi.fn<ProviderAgent['call']>();
  const plan: ManagerConversationPlan = {
    ctx: { provider: makeProvider({ setup: () => ({ call }) }), providerType, model: undefined, lang: 'ja' },
    strategy: { systemPrompt: 'manager fixture' },
    permissionJudge: {
      resolution: { provider: providerType, model: undefined, providerOptions: {} },
      language: 'ja', systemPrompt: 'judge fixture', managerPersona: 'manager fixture', managerPolicy: 'manager policy',
    },
  };
  const createSession = () => {
    const session = createManagerConversationSession({ cwd, assignment: owner, plan });
    sessions.push(session);
    return session;
  };
  let session = createSession();
  const pending = () => listPendingInquiries(config, { ...owner, repositoryDirectories });
  const all = async () => origin === 'goal' ? (await goalStore.get(goal!.id)).questions ?? [] : standalone.list();
  const seed = async (input: GoalQuestionInput) => {
    if (origin !== 'goal') return standalone.create(input);
    let id: string | undefined;
    const saved = await goalStore.update(goal!.id, (current) => {
      const added = addGoalQuestion(current, input);
      id = added.questionId;
      return added.goal;
    });
    return saved.questions!.find((question) => question.id === id)!;
  };
  return {
    config, repository, goalRepository, cwd, goal, request, goalStore, standalone, pending, all, seed, call,
    get session() { return session; },
    async reopen() { await session.close(); session = createSession(); },
    async decide(operation = request) {
      let decision: ToolPermissionDecision | undefined;
      call.mockImplementationOnce(async (_prompt, options) => {
        if (options.onToolPermissionDecision === undefined) throw new Error('Permission handler is missing');
        decision = await options.onToolPermissionDecision(operation);
        return { persona: 'manager', status: 'done', timestamp: new Date(), content: '',
          structuredOutput: { message: '確認待ちです', summary: null } };
      });
      expect(await session.handleUserMessage({ text: 'ファイルの出力先を確認する', goal })).toMatchObject({ kind: 'reply' });
      expect(decision).toBeDefined();
      return decision!;
    },
    async readSavedFile(id: string) {
      const path = origin === 'goal' ? join(goalRepository, '.takt', 'goals', goal!.id, 'goal.json')
        : join(config, owner.kind === 'workspace' ? 'workspaces' : 'projects',
          owner.kind === 'workspace' ? owner.workspaceId : projectIdForCanonicalDirectory(await realpath(owner.repositoryDirectory)),
          'inquiries', `${id}.json`);
      return readFile(path, 'utf8');
    },
  };
}

describe('manager approval inquiry persistence', () => {
  describe.each(['workspace', 'repository'] as const)('%s hook approval persistence', (origin) => {
    it.each(['sequential', 'different operation'] as const)('preserves operation identity for %s requests', async (mode) => {
      const target = await fixture(origin, 'codex');
      const second = mode !== 'different operation' ? target.request : {
        ...target.request,
        ...(origin === 'workspace' ? { toolInput: { ...target.request.toolInput as Record<string, unknown>, content: 'different output' } }
          : { cwd: target.repository }),
      };
      const savedIds: string[] = [];
      const outputs: ReturnType<typeof parseCodexToolPermissionOutput>[] = [];
      const getOrCreate = StandaloneInquiryStore.prototype.getOrCreateApproval;
      const saveSpy = vi.spyOn(StandaloneInquiryStore.prototype, 'getOrCreateApproval').mockImplementation(async function (this: StandaloneInquiryStore, input) {
        const saved = await getOrCreate.call(this, input);
        savedIds.push(saved.id);
        return saved;
      });
      target.call.mockImplementationOnce(async (_prompt, options) => {
        const hook = await prepareCodexToolPermissionHook(options.onToolPermissionDecision!);
        const endpoint = /TAKT_CODEX_TOOL_PERMISSION_ENDPOINT='([^']+)'/u.exec(hook.definition.command)![1]!;
        const token = /TAKT_CODEX_TOOL_PERMISSION_TOKEN='([^']+)'/u.exec(hook.definition.command)![1]!;
        const send = async (operation: ToolPermissionDecisionRequest) => {
          const response = await fetch(endpoint, { method: 'POST', headers: { authorization: `Bearer ${token}` },
            body: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: operation.toolName,
              tool_input: operation.toolInput, cwd: operation.cwd }) });
          outputs.push(parseCodexToolPermissionOutput(await response.json()));
        };
        try { await send(target.request); await send(second); }
        finally { await hook.dispose(); }
        return { persona: 'manager', status: 'done', timestamp: new Date(), content: '',
          structuredOutput: { message: '確認待ちです', summary: null } };
      });
      expect(await target.session.handleUserMessage({ text: 'ファイルの出力先を確認する' })).toMatchObject({ kind: 'reply' });
      saveSpy.mockRestore();
      const saved = (await target.pending()).inquiries;
      expect(saved).toHaveLength(mode === 'different operation' ? 2 : 1);
      expect(new Set(savedIds).size).toBe(saved.length);
      expect(outputs).toHaveLength(2);
      for (const output of outputs) {
        expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
        expect(output.hookSpecificOutput.permissionDecisionReason).toContain(reason);
        expect(saved.some(({ question }) => output.hookSpecificOutput.permissionDecisionReason.includes(question.id))).toBe(true);
      }
      for (const { question } of saved) {
        expect(outputs.some((output) => output.hookSpecificOutput.permissionDecisionReason.includes(question.id))).toBe(true);
        expect(JSON.parse(await target.readSavedFile(question.id))).toEqual(question);
      }
    });
  });
  it.each(['goal', 'workspace', 'repository'] as const)('persists an approval for the %s owner and returns its saved ID and confirmation', async (origin) => {
    const target = await fixture(origin);
    const decision = await target.decide();
    const result = await target.pending();
    expect(result.errors).toEqual([]);
    expect(result.inquiries).toHaveLength(1);
    const inquiry = result.inquiries[0]!;
    expect(inquiry).toMatchObject({ kind: 'approval', goalId: target.goal?.id ?? null,
      question: { kind: 'approval', recipient: 'human', status: 'pending', body: expect.stringContaining(reason),
        operation: { toolName: 'Write', args: JSON.stringify(target.request.toolInput), cwd: target.request.cwd } } });
    expect(decision).toMatchObject({ decision: 'deny', reason: expect.stringContaining(inquiry.question.id) });
    expect(decision).toHaveProperty('reason', expect.stringContaining(reason));
    const saved: unknown = JSON.parse(await target.readSavedFile(inquiry.question.id));
    expect(saved).toEqual(origin === 'goal' ? expect.objectContaining({ questions: [inquiry.question] }) : inquiry.question);
    expect(doubles.slack).not.toHaveBeenCalled();
    if (origin === 'goal') {
      expect(inquiry).toHaveProperty('repositoryDirectory', target.goalRepository);
      expect((await target.standalone.list()).length).toBe(0);
      expect(await new GoalStore(target.repository).list()).toEqual({ goals: [], errors: [] });
    }
    const otherOwner: InquiryOwner = origin === 'repository'
      ? { kind: 'repository', repositoryDirectory: target.goalRepository }
      : { kind: 'workspace', workspaceId: otherWorkspaceId };
    expect((await listPendingInquiries(target.config, { ...otherOwner, repositoryDirectories: [] })).inquiries).toEqual([]);
    expect((await new StandaloneInquiryStore(target.config, { kind: 'repository', repositoryDirectory: target.cwd }).list())).toEqual([]);
    expect((await new StandaloneInquiryStore(target.config, { kind: 'repository', repositoryDirectory: target.request.cwd }).list())).toEqual([]);
  });

  it('returns the persisted ID through the Codex permission output', async () => {
    const target = await fixture('workspace', 'codex');
    const output = toCodexToolPermissionOutput(await target.decide());
    const saved = (await target.pending()).inquiries;
    expect(saved).toHaveLength(1);
    expect(output.hookSpecificOutput).toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: expect.stringContaining(saved[0]!.question.id) });
  });

  it.each(['before approval', 'after approval', 'failed addition'] as const)('saves for the owner at approval time when repository addition is %s', async (timing) => {
    const target = await fixture('repository');
    const initial = { kind: 'repository' as const, repositoryDirectory: target.repository, repositoryDirectories: [target.repository] };
    let workspace: Awaited<ReturnType<typeof addManagerRepository>>;
    let decision: ToolPermissionDecision | undefined;
    target.call.mockImplementationOnce(async (_prompt, options) => {
      options.onStream?.({ type: 'tool_use', data: { id: 'add-repository', tool: 'takt_add_workspace_repository', input: { repositoryDirectory: target.goalRepository } } });
      const add = async () => {
        if (timing === 'failed addition') {
          await expect(addManagerRepository(initial, join(target.config, 'missing-repository'), target.config)).rejects.toThrow();
          options.onStream?.({ type: 'tool_result', data: { id: 'add-repository', isError: true, content: '追加できません' } });
          return;
        }
        workspace = await addManagerRepository(initial, target.goalRepository, target.config);
        expect(workspace).toBeDefined();
        options.onStream?.({ type: 'tool_result', data: { id: 'add-repository', isError: false, content: JSON.stringify({ workspace }) } });
      };
      if (timing !== 'after approval') await add();
      decision = await options.onToolPermissionDecision!(target.request);
      if (timing === 'after approval') await add();
      return { persona: 'manager', status: 'done', timestamp: new Date(), content: '',
        structuredOutput: { message: '確認待ちです', summary: null } };
    });
    expect(await target.session.handleUserMessage({ text: '担当を追加して出力先を確認する' })).toMatchObject({ kind: 'reply' });
    const owner: InquiryOwner = timing === 'before approval' ? { kind: 'workspace', workspaceId: workspace!.id } : initial;
    const result = await listPendingInquiries(target.config, { ...owner, repositoryDirectories: [target.repository, target.goalRepository] });
    expect(result.errors).toEqual([]);
    expect(result.inquiries).toHaveLength(1);
    const saved = result.inquiries[0]!.question;
    expect(decision).toMatchObject({ decision: 'deny', reason: expect.stringContaining(saved.id) });
    expect(decision).toHaveProperty('reason', expect.stringContaining(reason));
    const directory = owner.kind === 'workspace' ? join(target.config, 'workspaces', owner.workspaceId)
      : join(target.config, 'projects', projectIdForCanonicalDirectory(await realpath(owner.repositoryDirectory)));
    expect(JSON.parse(await readFile(join(directory, 'inquiries', `${saved.id}.json`), 'utf8'))).toEqual(saved);
    if (workspace !== undefined) {
      const other: InquiryOwner = owner.kind === 'workspace' ? initial : { kind: 'workspace', workspaceId: workspace.id };
      expect(await new StandaloneInquiryStore(target.config, other).list()).toEqual([]);
    } else expect(await target.session.getAssignment()).toEqual(initial);
  });

  it.each(['notification update', 'delivery'] as const)('keeps the Goal approval and its ID when %s fails', async (failure) => {
    const target = await fixture('goal');
    doubles.notificationOptions.mockReturnValue({ policy: { ...policy, custom: true }, webhookUrl: 'https://example.test/notify', mainMerge: 'approve' });
    if (failure === 'notification update') {
      const update = GoalStore.prototype.update;
      vi.spyOn(GoalStore.prototype, 'update')
        .mockImplementationOnce(function (this: GoalStore, id, transform) { return update.call(this, id, transform); })
        .mockRejectedValueOnce(new Error('fixture notification update failure'));
    }
    const pendingAtDelivery: Awaited<ReturnType<typeof target.pending>>[] = [];
    doubles.slack.mockImplementation(async () => {
      pendingAtDelivery.push(await target.pending());
      throw new Error('fixture delivery failure');
    });
    const decision = await target.decide();
    const result = await target.pending();
    expect(result.errors).toEqual([]);
    expect(result.inquiries).toHaveLength(1);
    const saved = result.inquiries[0]!.question;
    expect(result.inquiries[0]).toMatchObject({ goalId: target.goal!.id, kind: 'approval', repositoryDirectory: target.goalRepository });
    expect(saved).toMatchObject({ status: 'pending', body: reason,
      operation: { toolName: target.request.toolName, args: JSON.stringify(target.request.toolInput), cwd: target.request.cwd } });
    expect(decision).toMatchObject({ decision: 'deny', reason: expect.stringContaining(saved.id) });
    expect(decision).toHaveProperty('reason', expect.stringContaining(reason));
    expect(decision).toHaveProperty('reason', expect.not.stringMatching(/保存.*失敗|fail.*sav/iu));
    expect(JSON.parse(await target.readSavedFile(saved.id))).toMatchObject({ questions: [saved] });
    if (failure === 'delivery') {
      expect(doubles.slack).toHaveBeenCalledOnce();
      expect(pendingAtDelivery).toEqual([result]);
    } else {
      expect(doubles.slack).not.toHaveBeenCalled();
      expect(GoalStore.prototype.update).toHaveBeenCalledTimes(2);
    }
  });

  it('keeps the persisted ID after Slack delivery fails', async () => {
    const target = await fixture('workspace');
    doubles.notificationOptions.mockReturnValue({ policy: { ...policy, custom: true }, webhookUrl: 'https://example.test/notify', mainMerge: 'approve' });
    let pendingAtDelivery: unknown;
    doubles.slack.mockImplementation(async () => {
      pendingAtDelivery = await target.pending();
      throw new Error('fixture delivery failure');
    });
    const decision = await target.decide();
    const saved = (await target.pending()).inquiries;
    expect(saved).toHaveLength(1);
    expect(decision).toMatchObject({ decision: 'deny', reason: expect.stringContaining(saved[0]!.question.id) });
    expect(decision).toHaveProperty('reason', expect.not.stringMatching(/保存.*失敗|fail.*sav/iu));
    expect(pendingAtDelivery).toMatchObject({ inquiries: [expect.objectContaining({ question: saved[0]!.question })] });
    expect(doubles.slack).toHaveBeenCalledOnce();
  });

  it.each(['goal update', 'standalone save'] as const)('denies with a save failure reason after %s fails', async (failure) => {
    const target = await fixture(failure === 'goal update' ? 'goal' : 'workspace');
    const error = new Error('fixture persistence unavailable');
    const spy = failure === 'goal update' ? vi.spyOn(GoalStore.prototype, 'update').mockRejectedValueOnce(error)
      : vi.spyOn(StandaloneInquiryStore.prototype, 'getOrCreateApproval').mockRejectedValueOnce(error);
    const decision = await target.decide();
    expect(decision).toMatchObject({ decision: 'deny', reason: expect.stringMatching(/保存.*失敗|fail.*sav/iu) });
    expect(decision).toHaveProperty('reason', expect.stringContaining(reason));
    spy.mockRestore();
    expect(await target.all()).toEqual([]);
    expect((await target.pending()).inquiries).toEqual([]);
  });

  it.each(['goal', 'workspace', 'repository'] as const)('reuses a pending approval from the %s store after recreating the conversation', async (origin) => {
    const target = await fixture(origin);
    const first = await target.decide();
    const saved = await target.all();
    expect(saved).toHaveLength(1);
    await target.reopen();
    doubles.judge.mockResolvedValue(judgment('ask', 'もう一度出力先を確認してください'));
    const second = await target.decide();
    const after = await target.all();
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(saved[0]!.id);
    for (const decision of [first, second]) expect(decision).toHaveProperty('reason', expect.stringContaining(saved[0]!.id));
    expect(second).toMatchObject({ decision: 'deny', reason: expect.stringContaining('もう一度出力先を確認してください') });
  });

  describe.each(['goal', 'workspace'] as const)('%s duplicate matching', (origin) => {
    it.each(['tool name', 'arguments', 'cwd'] as const)('creates another approval when %s differs', async (difference) => {
      const target = await fixture(origin);
      await target.decide();
      const changed = { ...target.request,
        ...(difference === 'tool name' ? { toolName: 'Edit' } : difference === 'arguments'
          ? { toolInput: { ...target.request.toolInput as Record<string, unknown>, content: 'different output' } }
          : { cwd: target.repository }) };
      const decision = await target.decide(changed);
      const saved = await target.all();
      expect(saved).toHaveLength(2);
      expect(new Set(saved.map((question) => question.id)).size).toBe(2);
      const latest = saved.find((question) => question.operation?.toolName === changed.toolName
        && question.operation.cwd === changed.cwd && question.operation.args === JSON.stringify(changed.toolInput))!;
      expect(decision).toHaveProperty('reason', expect.stringContaining(latest.id));
    });

    it.each(['answered', 'withdrawn', 'question'] as const)('does not reuse a matching %s inquiry', async (state) => {
      const target = await fixture(origin);
      const previous = await target.seed({ kind: state === 'question' ? 'question' : 'approval', body: reason,
        operation: { toolName: target.request.toolName, args: JSON.stringify(target.request.toolInput), cwd: target.request.cwd } });
      if (state !== 'question') {
        if (origin === 'goal') await target.goalStore.update(target.goal!.id, (current) => state === 'answered'
          ? answerGoalQuestion(current, previous.id, { decision: 'allow' }) : withdrawGoalQuestion(current, previous.id));
        else if (state === 'answered') await target.standalone.answer(previous.id, { decision: 'allow' });
        else await target.standalone.withdraw(previous.id);
      }
      const decision = await target.decide();
      const saved = await target.all();
      expect(saved).toHaveLength(2);
      const approval = saved.find((question) => question.id !== previous.id)!;
      expect(approval).toMatchObject({ kind: 'approval', status: 'pending' });
      expect(decision).toMatchObject({ decision: 'deny', reason: expect.stringContaining(approval.id) });
    });
  });

  it.each(['goal', 'workspace'] as const)('redacts sensitive body and arguments in the %s file while distinguishing raw argument digests', async (origin) => {
    const target = await fixture(origin);
    doubles.judge.mockResolvedValue(judgment('ask', 'token=alpha の送信を確認してください'));
    await target.decide({ ...target.request, toolInput: { token: 'alpha' } });
    await target.decide({ ...target.request, toolInput: { token: 'bravo' } });
    const saved = await target.all();
    expect(saved).toHaveLength(2);
    expect(new Set(saved.map((question) => question.operation!.argsDigest)).size).toBe(2);
    for (const question of saved) {
      expect(question.body).toContain('送信を確認してください');
      for (const value of [question.body, question.operation!.args]) {
        expect(value).toContain('[REDACTED]');
        expect(value).not.toMatch(/alpha|bravo/iu);
      }
      expect(await target.readSavedFile(question.id)).not.toMatch(/alpha|bravo/iu);
    }
  });

  it('preserves ordinary argument values that are not sensitive', async () => {
    const target = await fixture('workspace');
    doubles.judge.mockResolvedValue(judgment('ask', '表示名を確認してください'));
    await target.decide({ ...target.request, toolInput: { label: 'alpha' } });
    const saved = await target.all();
    expect(saved).toHaveLength(1);
    expect(JSON.parse(saved[0]!.operation!.args)).toEqual({ label: 'alpha' });
  });

  it.each(['allow', 'deny'] as const)('does not create inquiries for a normal %s judgment', async (decision) => {
    const target = await fixture('workspace');
    const expected = decision === 'allow' ? { decision } : { decision, reason: '通常の拒否理由' };
    doubles.judge.mockResolvedValue(judgment(decision, decision === 'allow' ? null : '通常の拒否理由'));
    expect(await target.decide()).toEqual(expected);
    expect(await target.all()).toEqual([]);
    expect(doubles.slack).not.toHaveBeenCalled();
  });
});

import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentResponse } from '../core/models/types.js';
import type { ToolPermissionDecision, ToolPermissionDecisionRequest } from '../core/workflow/types.js';
import { createManagerTurnExecutor, type ManagerTurnInput } from '../features/manager/turnExecutor.js';
import { resolveCurrentManagerAssignment } from '../features/manager/assignment.js';
import type { ManagerConversationPlan } from '../features/manager/conversationPlan.js';
import { createManagerToolPermissionHandler } from '../features/manager/toolPermissionDecision.js';
import { addManagerRepository } from '../features/manager/workspaceOperations.js';
import { projectIdForCanonicalDirectory } from '../infra/config/global/projectRegistry.js';
import { listPendingInquiries } from '../infra/goals/pending-inquiries.js';
import { addGoalQuestion, answerGoalQuestion, consumeGoalApproval, withdrawGoalQuestion } from '../infra/goals/questions.js';
import type { GoalAnswerInput, GoalQuestionInput } from '../infra/goals/schema.js';
import { StandaloneInquiryStore, type InquiryOwner } from '../infra/goals/standalone-inquiries.js';
import { GoalStore } from '../infra/goals/store.js';
import type { ProviderAgent } from '../infra/providers/types.js';
import { parseCodexToolPermissionOutput, toCodexToolPermissionOutput } from '../infra/codex/tool-permission-hook-protocol.js';
import { prepareCodexToolPermissionHook } from '../infra/codex/tool-permission-hook.js';
import { goalRecord } from './helpers/goal-fixtures.js';
import { makeProvider } from './test-helpers.js';

const doubles = vi.hoisted(() => ({ judge: vi.fn(), notificationOptions: vi.fn(), slack: vi.fn(), sha: vi.fn(), repository: vi.fn() }));
vi.mock('../agents/agent-usecases.js', () => ({ executeIsolatedStructuredInternalAgent: doubles.judge }));
vi.mock('../infra/goals/git-command.js', async (original) => ({
  ...await original<typeof import('../infra/goals/git-command.js')>(), resolveGoalBranchSha: doubles.sha,
}));
vi.mock('../features/manager/autoRun.js', () => ({ ensureManagerRun: vi.fn(async () => {}) }));
vi.mock('../infra/task/runner.js', () => ({ TaskRunner: class { listTaskStateItems = () => []; } }));
vi.mock('../infra/task/repositoryDirectory.js', () => ({ resolveGitRepositoryDirectory: doubles.repository }));
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

function judgment(decision: 'allow' | 'deny' | 'ask', confirmation: string | null): AgentResponse {
  return { persona: 'manager-permission-judge', status: 'done', timestamp: new Date(), content: '',
    structuredOutput: { decision, reason: confirmation } };
}

beforeEach(async () => {
  vi.resetAllMocks();
  doubles.judge.mockResolvedValue(judgment('ask', reason));
  doubles.sha.mockResolvedValue('a'.repeat(40));
  doubles.notificationOptions.mockReturnValue({ policy, webhookUrl: undefined, mainMerge: 'approve' });
});

function liveHandler(target: Awaited<ReturnType<typeof fixture>>) {
  const onDenial = vi.fn();
  const handler = createManagerToolPermissionHandler({
    plan: target.plan.permissionJudge!, provider: target.plan.ctx.providerType, cwd: target.cwd,
    configDirectory: target.config, owner: target.owner, goal: target.goal, instruction: '操作を確認する',
    abortSignal: new AbortController().signal, onDenial,
  });
  return { handler, onDenial };
}

function approvalInput(request: ToolPermissionDecisionRequest): GoalQuestionInput {
  return { kind: 'approval', body: reason,
    operation: { toolName: request.toolName, args: JSON.stringify(request.toolInput), cwd: request.cwd } };
}

function judgeRecords(): Record<string, unknown>[] {
  const instruction = doubles.judge.mock.calls.at(-1)?.[1];
  expect(instruction).toBeTypeOf('string');
  const records: Record<string, unknown>[] = [];
  const visit = (value: unknown): void => {
    if (value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const record = value as Record<string, unknown>;
    records.push(record);
    Object.values(record).forEach(visit);
  };
  visit(JSON.parse(instruction));
  return records;
}

describe('manager saved approval decisions', () => {
  it.each(['goal', 'workspace', 'repository'] as const)('allows a %s approval once after an external answer and persists consumption before returning', async (origin) => {
    const target = await fixture(origin);
    const { handler } = liveHandler(target);
    expect(await handler(target.request)).toMatchObject({ decision: 'deny' });
    const [pending] = await target.all();
    expect(pending).toMatchObject({ status: 'pending' });
    await target.answer(pending!.id, { decision: 'allow', scope: 'once' });
    doubles.judge.mockClear().mockResolvedValue(judgment('allow', null));

    expect(await handler(target.request)).toEqual({ decision: 'allow' });
    expect(doubles.judge).not.toHaveBeenCalled();
    const consumed = (await target.all()).find(({ id }) => id === pending!.id)!;
    expect(consumed).toMatchObject({ consumedAt: expect.any(String), answer: { decision: 'allow', scope: 'once' } });
    const saved = JSON.parse(await target.readSavedFile(pending!.id));
    expect(origin === 'goal' ? saved.questions : [saved]).toContainEqual(consumed);

    expect(await handler(target.request)).toMatchObject({ decision: 'deny' });
    const next = (await target.all()).filter(({ status }) => status === 'pending');
    expect(next).toHaveLength(1);
    expect(next[0]!.id).not.toBe(pending!.id);
    await target.answer(next[0]!.id, { decision: 'allow', scope: 'once' });
    doubles.judge.mockClear();
    expect(await handler(target.request)).toEqual({ decision: 'allow' });
    expect(doubles.judge).not.toHaveBeenCalled();
  });

  it.each(['goal', 'project', 'workspace', 'global'] as const)('reuses a matching %s approval without consuming it', async (scope) => {
    const target = await fixture('goal');
    const previous = await target.seed(approvalInput(target.request));
    await target.answer(previous.id, { decision: 'allow', scope });
    const { handler } = liveHandler(target);
    expect(await handler(target.request)).toEqual({ decision: 'allow' });
    expect(await handler(target.request)).toEqual({ decision: 'allow' });
    expect(doubles.judge).not.toHaveBeenCalled();
    expect((await target.all()).find(({ id }) => id === previous.id)?.consumedAt).toBeUndefined();
  });

  it.each(['goal', 'workspace', 'repository'] as const)('returns a saved %s denial and the human reason to the hook and manager', async (origin) => {
    const target = await fixture(origin);
    const previous = await target.seed(approvalInput(target.request));
    const humanReason = 'この出力先は使わないでください';
    await target.answer(previous.id, { decision: 'deny', text: humanReason });
    doubles.judge.mockResolvedValue(judgment('allow', null));
    const { handler, onDenial } = liveHandler(target);
    const decision = await handler(target.request);
    expect(decision).toMatchObject({ decision: 'deny', reason: expect.stringContaining(humanReason) });
    expect(toCodexToolPermissionOutput(decision).hookSpecificOutput.permissionDecisionReason).toContain(humanReason);
    expect(onDenial).toHaveBeenCalledWith(expect.stringContaining(humanReason));
    expect(doubles.judge).not.toHaveBeenCalled();
    expect(await target.all()).toHaveLength(1);
  });

  it.each(['tool name', 'arguments', 'cwd', 'secret value'] as const)('does not reuse a saved approval after changing %s on the same handler', async (difference) => {
    const target = await fixture('goal');
    const original = difference === 'secret value' ? { ...target.request, toolInput: { token: 'alpha' } } : target.request;
    const previous = await target.seed(approvalInput(original));
    await target.answer(previous.id, { decision: 'allow', scope: 'goal' });
    const { handler } = liveHandler(target);
    expect(await handler(original)).toEqual({ decision: 'allow' });
    const changed = { ...original, ...(difference === 'tool name' ? { toolName: 'Edit' }
      : difference === 'cwd' ? { cwd: target.repository }
        : { toolInput: difference === 'secret value' ? { token: 'bravo' } : { content: 'changed' } }) };
    expect(await handler(changed)).toMatchObject({ decision: 'deny' });
    expect(doubles.judge).toHaveBeenCalledOnce();
    expect((await target.all()).find(({ id }) => id === previous.id)?.consumedAt).toBeUndefined();
  });

  it('binds inquiries to the current goal branch SHA and invalidates approval when it changes', async () => {
    const target = await fixture('goal');
    const { handler } = liveHandler(target);
    await handler(target.request);
    const [pending] = await target.all();
    expect(pending!.targetSha).toBe('a'.repeat(40));
    await target.answer(pending!.id, { decision: 'allow', scope: 'goal' });
    expect(await handler(target.request)).toEqual({ decision: 'allow' });
    doubles.sha.mockResolvedValue('b'.repeat(40));
    expect(await handler(target.request)).toMatchObject({ decision: 'deny' });
    const next = (await target.all()).find(({ status }) => status === 'pending');
    expect(next!.targetSha).toBe('b'.repeat(40));
    expect(next!.id).not.toBe(pending!.id);
  });

  it('does not allow an approved operation if saving its consumption fails', async () => {
    const target = await fixture('goal');
    const previous = await target.seed(approvalInput(target.request));
    await target.answer(previous.id, { decision: 'allow', scope: 'once' });
    const { handler } = liveHandler(target);
    const update = vi.spyOn(GoalStore.prototype, 'update').mockRejectedValueOnce(new Error('consumption save failed'));
    doubles.judge.mockResolvedValue(judgment('allow', null));
    expect(await handler(target.request)).toMatchObject({ decision: 'deny' });
    update.mockRestore();
    expect((await target.all())[0]!.consumedAt).toBeUndefined();
    expect(await handler(target.request)).toEqual({ decision: 'allow' });
  });

  it('does not reuse an approval without a target SHA when the goal branch SHA cannot be resolved', async () => {
    const target = await fixture('goal');
    const previous = await target.seed({ ...approvalInput(target.request), targetSha: undefined });
    await target.answer(previous.id, { decision: 'allow', scope: 'once' });
    doubles.sha.mockRejectedValue(new Error('goal branch unavailable'));
    doubles.judge.mockResolvedValue(judgment('allow', null));
    const { handler } = liveHandler(target);

    expect(await handler(target.request)).toMatchObject({ decision: 'deny' });
    expect((await target.all()).find(({ id }) => id === previous.id)?.consumedAt).toBeUndefined();
  });

  it.each(['goal', 'workspace'] as const)('denies a %s approval when interrupted during consumption persistence', async (origin) => {
    const target = await fixture(origin);
    const previous = await target.seed(approvalInput(target.request));
    await target.answer(previous.id, { decision: 'allow', scope: 'once' });
    const controller = new AbortController();
    if (origin === 'goal') {
      const update = GoalStore.prototype.update;
      vi.spyOn(GoalStore.prototype, 'update').mockImplementationOnce(async function (this: GoalStore, id, transform) {
        const saved = await update.call(this, id, transform);
        controller.abort();
        return saved;
      });
    } else {
      const consume = StandaloneInquiryStore.prototype.consumeApproval;
      vi.spyOn(StandaloneInquiryStore.prototype, 'consumeApproval').mockImplementationOnce(async function (this: StandaloneInquiryStore, approval, consumedAt) {
        const saved = await consume.call(this, approval, consumedAt);
        controller.abort();
        return saved;
      });
    }
    const onDenial = vi.fn();
    const handler = createManagerToolPermissionHandler({
      plan: target.plan.permissionJudge!, provider: 'claude-sdk', cwd: target.cwd,
      configDirectory: target.config, owner: target.owner, goal: target.goal, instruction: '操作を確認する',
      abortSignal: controller.signal, onDenial,
    });
    const result = await handler(target.request);
    expect(result).toMatchObject({ decision: 'deny' });
    expect(onDenial).toHaveBeenCalledWith(result.decision === 'deny' ? result.reason : undefined);
    expect(doubles.judge).not.toHaveBeenCalled();
    expect((await target.all()).find(({ id }) => id === previous.id)?.consumedAt).toEqual(expect.any(String));
  });

  it('keeps a saved denial effective when a matching allowed answer also exists', async () => {
    const target = await fixture('goal');
    const denied = await target.seed(approvalInput(target.request));
    await target.answer(denied.id, { decision: 'deny', text: '人が拒否しました' });
    const allowed = await target.seed(approvalInput(target.request));
    await target.answer(allowed.id, { decision: 'allow', scope: 'once' });
    const { handler } = liveHandler(target);
    expect(await handler(target.request)).toMatchObject({ decision: 'deny', reason: expect.stringContaining('人が拒否しました') });
    expect(doubles.judge).not.toHaveBeenCalled();
    expect((await target.all()).find(({ id }) => id === allowed.id)?.consumedAt).toBeUndefined();
  });

  it('preserves classifier refusal even when the operation has a saved approval', async () => {
    const target = await fixture('workspace');
    const request = { ...target.request, toolName: 'Agent' };
    const previous = await target.seed(approvalInput(request));
    await target.answer(previous.id, { decision: 'allow', scope: 'once' });
    const { handler } = liveHandler(target);
    expect(await handler(request)).toMatchObject({ decision: 'deny' });
    expect(doubles.judge).not.toHaveBeenCalled();
    expect((await target.all())[0]!.consumedAt).toBeUndefined();
  });
});

async function putPermission(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

async function permissionSources(target: Awaited<ReturnType<typeof fixture>>) {
  const project = join(target.config, 'manager-permissions', 'projects',
    `${projectIdForCanonicalDirectory(await realpath(target.goalRepository))}.md`);
  return [
    { scope: 'global', filePath: join(target.config, 'manager-permissions.md'), content: '## 許可\r\n- 全体の原文  \r\n' },
    { scope: 'workspace', filePath: join(target.config, 'workspaces', workspaceId, 'manager-permissions.md'), content: '## 毎回確認\n- 担当の原文\n' },
    { scope: 'project', filePath: project, content: '## 拒否\n- 対象プロジェクトの原文\n' },
  ];
}

describe('manager permission judge persisted context', () => {
  it('selects the project from the tool cwd and reloads workspace permissions after assignment changes', async () => {
    const target = await fixture('workspace');
    const sources = await permissionSources(target);
    await Promise.all(sources.map(({ filePath, content }) => putPermission(filePath, content)));
    const otherWorkspaceFile = join(target.config, 'workspaces', otherWorkspaceId, 'manager-permissions.md');
    await putPermission(join(dirname(otherWorkspaceFile), 'workspace.json'), JSON.stringify({
      id: otherWorkspaceId, name: '切替先', repositoryDirectories: [target.repository, target.goalRepository],
    }));
    await putPermission(otherWorkspaceFile, '## 拒否\n- 切替先の担当原文\n');
    const wrongProjectFile = join(target.config, 'manager-permissions', 'projects',
      `${projectIdForCanonicalDirectory(await realpath(target.repository))}.md`);
    await putPermission(wrongProjectFile, '## 許可\n- 先頭プロジェクトの許可\n');
    let owner = target.owner;
    const handler = createManagerToolPermissionHandler({
      plan: target.plan.permissionJudge!, provider: 'claude-sdk', cwd: target.cwd, configDirectory: target.config,
      get owner() { return owner; }, instruction: '操作を確認する', abortSignal: new AbortController().signal, onDenial: vi.fn(),
    });
    const cwd = join(target.goalRepository, 'src');
    await mkdir(cwd);
    doubles.judge.mockResolvedValue(judgment('deny', '入力を確認しました'));
    await handler({ ...target.request, cwd });
    let files = judgeRecords().filter(({ filePath }) => typeof filePath === 'string');
    expect(files).toContainEqual(expect.objectContaining(sources[2]!));
    expect(files).toContainEqual(expect.objectContaining(sources[1]!));
    expect(files.map(({ filePath }) => filePath)).not.toContain(wrongProjectFile);
    owner = { kind: 'workspace', workspaceId: otherWorkspaceId };
    await handler({ ...target.request, cwd });
    files = judgeRecords().filter(({ filePath }) => typeof filePath === 'string');
    expect(files).toContainEqual(expect.objectContaining({ scope: 'workspace', filePath: otherWorkspaceFile, content: '## 拒否\n- 切替先の担当原文\n' }));
    expect(files.map(({ filePath }) => filePath)).not.toContain(sources[1]!.filePath);
    expect(files).toContainEqual(expect.objectContaining(sources[2]!));
  });

  it('passes current scoped original text with source paths and excludes unrelated projects and goals', async () => {
    const target = await fixture('goal');
    const sources = await permissionSources(target);
    await Promise.all(sources.map(({ filePath, content }) => putPermission(filePath, content)));
    const otherProject = join(target.config, 'manager-permissions', 'projects',
      `${projectIdForCanonicalDirectory(await realpath(target.repository))}.md`);
    await putPermission(otherProject, '## 許可\n- 他プロジェクトの許可\n');
    const goalText = '  対象ゴールだけの許可原文\n二行目  ';
    const previous = await target.seed(approvalInput({ ...target.request, toolInput: { content: '別操作' } }));
    await target.answer(previous.id, { decision: 'allow', scope: 'goal', text: goalText });
    const otherGoal = { ...goalRecord(), id: otherWorkspaceId };
    const unrelated = addGoalQuestion(otherGoal, approvalInput(target.request));
    await target.goalStore.create(answerGoalQuestion(unrelated.goal, unrelated.questionId,
      { decision: 'allow', scope: 'goal', text: '他ゴールの許可' }));
    const { handler } = liveHandler(target);
    doubles.judge.mockResolvedValue(judgment('deny', '入力を確認しました'));
    await handler(target.request);
    const files = judgeRecords().filter((entry) => typeof entry.filePath === 'string' && typeof entry.content === 'string');
    for (const source of sources) expect(files).toContainEqual(expect.objectContaining(source));
    expect(files).toContainEqual(expect.objectContaining({ scope: 'goal',
      filePath: join(target.goalRepository, '.takt', 'goals', target.goal!.id, 'goal.json'),
      content: expect.stringContaining(goalText) }));
    expect(files.map(({ filePath }) => filePath)).not.toContain(otherProject);
    expect(new Set(files.filter(({ scope }) => scope === 'goal').map(({ filePath }) => filePath)))
      .toEqual(new Set([join(target.goalRepository, '.takt', 'goals', target.goal!.id, 'goal.json')]));
    for (const { content } of files) expect(content).not.toMatch(/他ゴール|他プロジェクト/u);
    const changed = sources[0]!.content + '- 追記された許可原文\n';
    await putPermission(sources[0]!.filePath, changed);
    await handler(target.request);
    expect(judgeRecords()).toContainEqual(expect.objectContaining({ ...sources[0], content: changed }));
  });

  it('passes only the goal-scoped answer when project and goal answers have identical text', async () => {
    const target = await fixture('goal');
    const text = 'ログの確認を許可する';
    const otherOperation = approvalInput({ ...target.request, toolInput: { content: '別操作' } });
    const goalApproval = await target.seed(otherOperation);
    await target.answer(goalApproval.id, { decision: 'allow', scope: 'goal', text });
    const projectApproval = await target.seed(otherOperation);
    await target.answer(projectApproval.id, { decision: 'allow', scope: 'project', text });
    const { handler } = liveHandler(target);
    doubles.judge.mockResolvedValue(judgment('deny', '入力を確認しました'));

    await handler(target.request);

    expect(doubles.judge).toHaveBeenCalledOnce();
    const input = JSON.parse(doubles.judge.mock.calls[0]![1]) as {
      scopedPermissions: { scope: string; filePath: string; content: string; inquiryId?: string }[];
    };
    expect(input.scopedPermissions).toContainEqual(expect.objectContaining({
      scope: 'goal', filePath: join(target.goalRepository, '.takt', 'goals', target.goal!.id, 'goal.json'),
      content: text, inquiryId: goalApproval.id,
    }));
    expect(input.scopedPermissions.map(({ inquiryId }) => inquiryId)).not.toContain(projectApproval.id);
  });

  it('passes matching withdrawn and consumed answers without mixing in another operation', async () => {
    const target = await fixture('goal');
    const consumed = await target.seed(approvalInput(target.request));
    await target.answer(consumed.id, { decision: 'allow', scope: 'once', text: '一度だけの回答' });
    await target.goalStore.update(target.goal!.id, (current) => consumeGoalApproval(current, consumed.id, '2026-10-19T01:00:00.000Z'));
    const withdrawn = await target.seed(approvalInput(target.request));
    await target.goalStore.update(target.goal!.id, (current) => withdrawGoalQuestion(current, withdrawn.id, '取り下げ理由'));
    const other = await target.seed(approvalInput({ ...target.request, toolInput: { content: '無関係な操作' } }));
    const { handler } = liveHandler(target);
    await handler(target.request);
    const records = judgeRecords().filter(({ id }) => typeof id === 'string');
    const expected = (await target.all()).filter(({ id }) => id === consumed.id || id === withdrawn.id);
    for (const question of expected) expect(records).toContainEqual(expect.objectContaining(question));
    expect(records.map(({ id }) => id)).not.toContain(other.id);
  });

  it.each(['non-regular source', 'oversized file', 'oversized UTF-8 file'] as const)('asks a human on %s even when the judge allows', async (failure) => {
    const target = await fixture('workspace');
    const path = join(target.config, 'manager-permissions.md');
    if (failure === 'non-regular source') await mkdir(path);
    else await writeFile(path, failure === 'oversized UTF-8 file' ? 'あ'.repeat(2731) : 'a'.repeat(8193));
    doubles.judge.mockResolvedValue(judgment('allow', null));
    const { handler, onDenial } = liveHandler(target);
    const decision = await handler(target.request);
    expect(decision).toMatchObject({ decision: 'deny' });
    const [pending] = await target.all();
    expect(pending).toMatchObject({ kind: 'approval', status: 'pending' });
    expect(decision).toHaveProperty('reason', expect.stringContaining(pending!.id));
    expect(onDenial).toHaveBeenCalledWith(expect.stringContaining(pending!.id));
    const values = judgeRecords().flatMap((record) => Object.values(record)).filter((value): value is string => typeof value === 'string');
    expect(values.some((value) => value.includes(path))).toBe(true);
    expect(values.some((value) => /read|regular|budget|exceed|読|上限/iu.test(value))).toBe(true);
  });

  it('does not bypass a permission read failure with a previously allowed approval', async () => {
    const target = await fixture('goal');
    const previous = await target.seed(approvalInput(target.request));
    await target.answer(previous.id, { decision: 'allow', scope: 'once' });
    await mkdir(join(target.config, 'manager-permissions.md'));
    doubles.judge.mockResolvedValue(judgment('allow', null));
    const { handler } = liveHandler(target);
    expect(await handler(target.request)).toMatchObject({ decision: 'deny' });
    expect((await target.all()).find(({ id }) => id === previous.id)?.consumedAt).toBeUndefined();
  });

  it('passes a file at exactly 8192 bytes without truncating its original text', async () => {
    const target = await fixture('workspace');
    const filePath = join(target.config, 'manager-permissions.md');
    const content = 'a'.repeat(8192);
    await writeFile(filePath, content);
    doubles.judge.mockResolvedValue(judgment('allow', null));
    const { handler } = liveHandler(target);
    expect(await handler(target.request)).toEqual({ decision: 'allow' });
    expect(judgeRecords()).toContainEqual(expect.objectContaining({ scope: 'global', filePath, content }));
  });

  it('includes goal permission text in the byte budget and asks instead of using partial permissions', async () => {
    const target = await fixture('goal');
    const sources = await permissionSources(target);
    await Promise.all(sources.map(({ filePath }) => putPermission(filePath, 'a'.repeat(8192))));
    for (let index = 0; index < 2; index++) {
      const previous = await target.seed(approvalInput({ ...target.request, toolInput: { index } }));
      await target.answer(previous.id, { decision: 'allow', scope: 'goal', text: 'b'.repeat(5000) });
    }
    doubles.judge.mockResolvedValue(judgment('allow', null));
    const { handler } = liveHandler(target);
    const decision = await handler(target.request);
    expect(decision).toMatchObject({ decision: 'deny' });
    expect((await target.all()).filter(({ status }) => status === 'pending')).toHaveLength(1);
    expect(doubles.judge).toHaveBeenCalledOnce();
    const values = judgeRecords().flatMap((record) => Object.values(record)).filter((value): value is string => typeof value === 'string');
    expect(values.some((value) => /budget|exceed|limit|上限|制限/iu.test(value))).toBe(true);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function fixture(origin: Origin, providerType: 'claude-sdk' | 'codex' = 'claude-sdk') {
  const config = process.env.TAKT_CONFIG_DIR!;
  const repository = join(config, 'repository-a');
  const goalRepository = join(config, 'repository-b');
  const cwd = join(config, 'conversation');
  const toolCwd = join(goalRepository, 'tool-directory');
  await Promise.all([repository, goalRepository, cwd, toolCwd].map((directory) => mkdir(directory, { recursive: true })));
  doubles.repository.mockImplementation(async (directory: string) => {
    const canonical = await realpath(directory);
    const root = [repository, goalRepository].find((candidate) => canonical === candidate || canonical.startsWith(`${candidate}${sep}`));
    if (root === undefined) throw new Error(`Not a repository fixture: ${directory}`);
    return root;
  });
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
  let executor = createManagerTurnExecutor(cwd, plan);
  const input: ManagerTurnInput = { prompt: 'ファイルの出力先を確認する', instruction: 'ファイルの出力先を確認する',
    sessionId: undefined, assignment: owner, configDirectory: config, abortSignal: new AbortController().signal, goal };
  const pending = () => listPendingInquiries(config, { ...owner, repositoryDirectories });
  const all = async () => origin === 'goal' ? (await goalStore.get(goal!.id)).questions ?? [] : standalone.list();
  const seed = async (input: GoalQuestionInput) => {
    if (origin !== 'goal') return standalone.create(input);
    let id: string | undefined;
    const saved = await goalStore.update(goal!.id, (current) => {
      const added = addGoalQuestion(current, { targetSha: 'a'.repeat(40), ...input });
      id = added.questionId;
      return added.goal;
    });
    return saved.questions!.find((question) => question.id === id)!;
  };
  return {
    config, repository, goalRepository, cwd, goal, owner, plan, request, goalStore, standalone, pending, all, seed, call,
    async answer(id: string, answer: GoalAnswerInput) {
      if (origin === 'goal') await goalStore.update(goal!.id, (current) => answerGoalQuestion(current, id, answer));
      else await standalone.answer(id, answer);
    },
    get executor() { return executor; }, input,
    async reopen() { executor = createManagerTurnExecutor(cwd, plan); },
    async decide(operation = request) {
      let decision: ToolPermissionDecision | undefined;
      call.mockImplementationOnce(async (_prompt, options) => {
        if (options.onToolPermissionDecision === undefined) throw new Error('Permission handler is missing');
        decision = await options.onToolPermissionDecision(operation);
        return { persona: 'manager', status: 'done', timestamp: new Date(), content: '',
          structuredOutput: { message: '確認待ちです', summary: null } };
      });
      expect(await executor.execute(input)).toMatchObject({ message: '確認待ちです', summary: null });
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
      expect(await target.executor.execute(target.input)).toMatchObject({ message: '確認待ちです', summary: null });
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
    const turnResult = await target.executor.execute({ ...target.input, prompt: '担当を追加して出力先を確認する', instruction: '担当を追加して出力先を確認する' });
    expect(turnResult).toMatchObject({ message: '確認待ちです', summary: null });
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
    } else expect(await resolveCurrentManagerAssignment(turnResult.assignment!, target.config)).toEqual(initial);
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
    doubles.judge.mockResolvedValue(judgment('allow', null));
    const second = await target.decide();
    const after = await target.all();
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(saved[0]!.id);
    for (const decision of [first, second]) expect(decision).toHaveProperty('reason', expect.stringContaining(saved[0]!.id));
    expect(second).toMatchObject({ decision: 'deny' });
    expect(doubles.judge).toHaveBeenCalledOnce();
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

    it.each(['withdrawn', 'question'] as const)('does not reuse a matching %s inquiry', async (state) => {
      const target = await fixture(origin);
      const previous = await target.seed({ kind: state === 'question' ? 'question' : 'approval', body: reason,
        operation: { toolName: target.request.toolName, args: JSON.stringify(target.request.toolInput), cwd: target.request.cwd } });
      if (state !== 'question') {
        if (origin === 'goal') await target.goalStore.update(target.goal!.id, (current) => withdrawGoalQuestion(current, previous.id));
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

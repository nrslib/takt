import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EpicSchema, type Epic, type EpicMember } from '../infra/epics/schema.js';
import {
  abortEpic, addEpicMember, assertRepositoryHasNoActiveEpics, completeEpic, createEpic,
  getEpic, getEpicVerificationRecovery, listEpics, recordEpicVerificationResult,
  refreshEpicTargets, removeEpicMember, replaceEpicMember, startEpicVerification, updateEpicDefinition,
} from '../infra/epics/service.js';
import { epicDefinition, epicWorkspaceId, secondGoalId, verificationResultFor } from './helpers/epic-fixtures.js';
import { goalRecord } from './helpers/goal-fixtures.js';

const doubles = vi.hoisted(() => ({ records: new Map<string, unknown>(), workspace: vi.fn(), member: vi.fn(), targets: vi.fn(), lock: vi.fn() }));
vi.mock('../infra/config/global/workspaceRegistry.js', () => ({ readWorkspace: doubles.workspace }));
vi.mock('../infra/epics/lock.js', () => ({ withWorkspaceEpicLock: doubles.lock }));
vi.mock('../infra/epics/targets.js', async (original) => ({
  ...await original<typeof import('../infra/epics/targets.js')>(), resolveEpicMember: doubles.member, resolveEpicTargets: doubles.targets,
}));
vi.mock('../infra/epics/store.js', () => ({
  EpicStore: class {
    constructor(_directory: string, private readonly workspaceId: string) {}
    async create(input: Epic) {
      if (doubles.records.has(input.id)) throw new Error('Duplicate Epic');
      const epic = this.validate(input);
      doubles.records.set(epic.id, structuredClone(epic));
      return epic;
    }
    async get(id: string) {
      const epic = EpicSchema.parse(structuredClone(doubles.records.get(id)));
      if (epic.workspaceId !== this.workspaceId) throw new Error('Workspace mismatch');
      return epic;
    }
    save(input: Epic) {
      const epic = this.validate(input);
      if (!doubles.records.has(epic.id)) throw new Error('Missing Epic');
      doubles.records.set(epic.id, structuredClone(epic));
      return epic;
    }
    async list() {
      return { epics: [...doubles.records.values()].map((value) => EpicSchema.parse(value)).filter((epic) => epic.workspaceId === this.workspaceId), errors: [] };
    }
    private validate(input: Epic) {
      const epic = EpicSchema.parse(input);
      if (epic.workspaceId !== this.workspaceId) throw new Error('Workspace mismatch');
      return epic;
    }
  },
}));

const owner = { globalConfigDirectory: '/configuration', workspaceId: epicWorkspaceId };
const member = { repositoryDirectory: '/repositories/api', goalId: goalRecord().id };

beforeEach(() => {
  vi.resetAllMocks();
  doubles.records.clear();
  doubles.workspace.mockResolvedValue({ id: owner.workspaceId, name: '連携', repositoryDirectories: [member.repositoryDirectory] });
  doubles.lock.mockImplementation(async (_directory: string, _workspaceId: string, action: () => Promise<unknown>) => action());
  doubles.member.mockImplementation(async (_workspace: unknown, input: EpicMember) => ({ ...input }));
  doubles.targets.mockImplementation(async (_workspace: unknown, members: EpicMember[]) => {
    if (members.length === 0) throw new Error('Empty members');
    return members.map((entry) => ({ ...entry, targetSha: 'b'.repeat(40) }));
  });
});

async function create() {
  const epic = await createEpic({ ...owner, ...epicDefinition(), reason: '連携確認を依頼した' });
  return { ...owner, epicId: epic.id };
}

describe('Epic public operations', () => {
  it('creates and reads workspace-owned definitions through the storage boundary', async () => {
    const context = await create();
    expect(await getEpic(context)).toMatchObject({ ...epicDefinition(), workspaceId: owner.workspaceId, status: 'active' });
    expect((await listEpics(owner)).map(({ id }) => id)).toEqual([context.epicId]);
    expect(doubles.lock).toHaveBeenCalledWith(owner.globalConfigDirectory, owner.workspaceId, expect.any(Function));
    doubles.workspace.mockResolvedValueOnce(undefined);
    await expect(createEpic({ ...owner, ...epicDefinition(), reason: '存在しない担当' })).rejects.toThrow();
    expect(doubles.records.size).toBe(1);
  });

  it('adds, replaces and removes member references with recorded reasons', async () => {
    const context = await create();
    await addEpicMember({ ...context, member, reason: '追加する' });
    await expect(addEpicMember({ ...context, member, reason: '重複追加' })).rejects.toThrow();
    const replacement = { ...member, goalId: secondGoalId };
    await replaceEpicMember({ ...context, member, replacement, reason: '修正用ゴールに置換する' });
    expect((await getEpic(context)).members).toEqual([replacement]);
    await removeEpicMember({ ...context, member: replacement, reason: '対象から外す' });
    const saved = await getEpic(context);
    expect(saved.members).toEqual([]);
    expect(saved.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: '追加する', member }),
      expect.objectContaining({ reason: '修正用ゴールに置換する', member, replacement }),
      expect.objectContaining({ reason: '対象から外す', member: replacement }),
    ]));
  });

  it('validates membership before invalidating an existing definition', async () => {
    const context = await create();
    const before = await getEpic(context);
    doubles.member.mockRejectedValueOnce(new Error('Not assigned'));
    await expect(addEpicMember({ ...context, member, reason: '担当外を追加' })).rejects.toThrow();
    expect(await getEpic(context)).toEqual(before);
  });

  it('preserves path whitespace when passing a member to repository resolution', async () => {
    const context = await create();
    const spaced = { ...member, repositoryDirectory: '/repositories/api ' };
    doubles.workspace.mockResolvedValueOnce({ id: owner.workspaceId, name: '連携', repositoryDirectories: [spaced.repositoryDirectory] });
    await addEpicMember({ ...context, member: spaced, reason: '末尾に空白を含むリポジトリを追加' });
    expect(doubles.member).toHaveBeenCalledWith(expect.objectContaining({ repositoryDirectories: [spaced.repositoryDirectory] }), spaced);
    expect((await getEpic(context)).members).toEqual([spaced]);
  });

  it('updates a definition and refreshes fixed targets without changing an identical definition', async () => {
    const context = await create();
    const before = await getEpic(context);
    await updateEpicDefinition({ ...context, changes: epicDefinition(), reason: '同じ定義を照合' });
    expect(await getEpic(context)).toEqual(before);
    await updateEpicDefinition({ ...context, changes: { objective: '新しい目的' }, reason: '目的を更新' });
    await addEpicMember({ ...context, member, reason: '追加' });
    await refreshEpicTargets({ ...context, reason: '対象確定' });
    expect(await getEpic(context)).toMatchObject({ objective: '新しい目的', targets: [{ ...member, targetSha: 'b'.repeat(40) }] });
  });

  it('records, finalizes and aborts verification while preserving member references', async () => {
    const context = await create();
    await addEpicMember({ ...context, member, reason: '追加' });
    await expect(assertRepositoryHasNoActiveEpics(owner, member.repositoryDirectory)).rejects.toThrow();
    const run = await startEpicVerification(context);
    expect(await getEpicVerificationRecovery(context)).toEqual([run]);
    await recordEpicVerificationResult({ ...context, result: verificationResultFor(run) });
    expect(await getEpicVerificationRecovery(context)).toEqual([]);
    expect((await completeEpic(context)).status).toBe('completed');
    await expect(assertRepositoryHasNoActiveEpics(owner, member.repositoryDirectory)).resolves.toBeUndefined();
    expect((await abortEpic({ ...context, reason: '中止する' })).status).toBe('aborted');
    expect((await getEpic(context)).members).toEqual([member]);
  });

  it('invalidates evidence with the observed resolution failure before refusing completion', async () => {
    const context = await create();
    await addEpicMember({ ...context, member, reason: '追加' });
    const run = await startEpicVerification(context);
    await recordEpicVerificationResult({ ...context, result: verificationResultFor(run) });
    const failure = new Error('Goal file cannot be read');
    doubles.targets.mockRejectedValueOnce(failure);
    await expect(completeEpic(context)).rejects.toBe(failure);
    const saved = await getEpic(context);
    expect(saved.currentEvidence).toBeUndefined();
    expect(saved.status).toBe('active');
    expect(saved.verificationRuns[0]?.invalidationReason).toContain(failure.message);
  });

  it.each([true, false])('preserves evidence and running state after missing Terraform result rejection with requiresApply=%s', async (requiresApply) => {
    const definition = epicDefinition();
    const epic = await createEpic({ ...owner, ...definition, verificationProcedure: {
      ...definition.verificationProcedure, terraform: { requiresApply },
    }, reason: 'Terraform の確認を依頼した' });
    const context = { ...owner, epicId: epic.id };
    await addEpicMember({ ...context, member, reason: '追加' });
    const terraform = requiresApply
      ? { phase: 'post_apply' as const, applyStatus: 'applied' as const, artifactReferences: ['artifact://terraform/state'] }
      : { phase: 'plan' as const, applyStatus: 'not_applied' as const, artifactReferences: ['artifact://terraform/plan'] };
    const first = await startEpicVerification(context);
    await recordEpicVerificationResult({ ...context, result: { ...verificationResultFor(first), terraform } });
    const second = await startEpicVerification(context);
    const before = await getEpic(context);
    const stored = structuredClone(doubles.records.get(epic.id));
    await expect(recordEpicVerificationResult({ ...context, result: verificationResultFor(second) })).rejects.toThrow();
    expect(doubles.records.get(epic.id)).toEqual(stored);
    expect(await getEpic(context)).toEqual(before);
    expect(await listEpics(owner)).toContainEqual(before);
    expect(await getEpicVerificationRecovery(context)).toEqual([second]);
    await expect(completeEpic(context)).rejects.toThrow();
    await recordEpicVerificationResult({ ...context, result: { ...verificationResultFor(second), terraform } });
    expect((await completeEpic(context)).status).toBe('completed');
  });

  it.each(['definition', 'add', 'remove', 'replace', 'targets', 'verification', 'result', 'completion'] as const)(
    'preserves detached completed history when refusing %s operations', async (operation) => {
      const context = await create();
      await addEpicMember({ ...context, member, reason: '追加' });
      const run = await startEpicVerification(context);
      const result = verificationResultFor(run);
      await recordEpicVerificationResult({ ...context, result });
      await completeEpic(context);
      const before = await getEpic(context);
      const replacement = { repositoryDirectory: '/repositories/ui', goalId: secondGoalId };
      doubles.workspace.mockResolvedValue({ id: owner.workspaceId, name: '連携', repositoryDirectories: [replacement.repositoryDirectory] });
      const operations = {
        definition: () => updateEpicDefinition({ ...context, changes: { objective: '追加確認' }, reason: '変更' }),
        add: () => addEpicMember({ ...context, member: replacement, reason: '追加' }),
        remove: () => removeEpicMember({ ...context, member, reason: '削除' }),
        replace: () => replaceEpicMember({ ...context, member, replacement, reason: '置換' }),
        targets: () => refreshEpicTargets({ ...context, reason: '対象更新' }),
        verification: () => startEpicVerification(context),
        result: () => recordEpicVerificationResult({ ...context, result }),
        completion: () => completeEpic(context),
      };
      await expect(operations[operation]()).rejects.toThrow();
      expect(await getEpic(context)).toEqual(before);
      expect(await listEpics(owner)).toContainEqual(before);
    },
  );
});

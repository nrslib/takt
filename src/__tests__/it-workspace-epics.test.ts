import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createWorkspace, readWorkspace, removeWorkspaceRepository,
} from '../infra/config/global/workspaceRegistry.js';
import {
  abortEpic, addEpicMember, completeEpic, createEpic, getEpic, getEpicVerificationRecovery,
  listEpics, recordEpicVerificationResult, refreshEpicTargets, removeEpicMember,
  replaceEpicMember, startEpicVerification, updateEpicDefinition,
} from '../infra/epics/index.js';
import { GoalStore } from '../infra/goals/store.js';
import { GitHubProvider } from '../infra/github/GitHubProvider.js';
import { GitLabProvider } from '../infra/gitlab/GitLabProvider.js';
import { addManagerRepository, removeManagerRepository } from '../features/manager/workspaceOperations.js';
import type { ManagerAssignment } from '../features/manager/startupResolution.js';
import {
  completedEpicGoal, epicDefinition, secondGoalId, verificationResultFor,
} from './helpers/epic-fixtures.js';
import { goalRecord } from './helpers/goal-fixtures.js';

vi.mock('node:crypto', async (original) => {
  const actual = await original<typeof import('node:crypto')>();
  return { ...actual, randomUUID: vi.fn(actual.randomUUID) };
});

describe('workspace Epic service and lifecycle', () => {
  let root: string;
  let repositoryA: string;
  let repositoryB: string;
  let globalConfigDirectory: string;
  let workspaceId: string;
  let epicId: string;
  let goalSha: string;
  let targetSha: string;
  let assignment: ManagerAssignment;
  let template: { directory: string; goalSha: string; targetSha: string } | undefined;

  function git(directory: string, ...args: string[]): string {
    return execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  }

  function commit(directory: string, message: string): string {
    git(directory, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-m', message);
    return git(directory, 'rev-parse', 'HEAD');
  }

  function repository(name: string): string {
    const directory = join(root, name);
    mkdirSync(directory);
    git(directory, 'init', '-b', 'main');
    commit(directory, 'initial');
    return directory;
  }

  function repositoryArtifacts(directory: string): { path: string; bytes: Buffer }[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? repositoryArtifacts(path) : [{ path, bytes: readFileSync(path) }];
    }).sort((left, right) => left.path.localeCompare(right.path));
  }

  function preventPrMutations() {
    return [
      vi.spyOn(GitHubProvider.prototype, 'createPullRequest').mockImplementation(() => { throw new Error('Unexpected PR creation'); }),
      vi.spyOn(GitHubProvider.prototype, 'closePr').mockImplementation(() => { throw new Error('Unexpected PR close'); }),
      vi.spyOn(GitLabProvider.prototype, 'createPullRequest').mockImplementation(() => { throw new Error('Unexpected MR creation'); }),
      vi.spyOn(GitLabProvider.prototype, 'closePr').mockImplementation(() => { throw new Error('Unexpected MR close'); }),
    ];
  }

  const owner = () => ({ globalConfigDirectory, workspaceId });
  const context = () => ({ ...owner(), epicId });
  const memberA = () => ({ repositoryDirectory: repositoryA, goalId: goalRecord().id });
  const memberB = () => ({ repositoryDirectory: repositoryB, goalId: goalRecord().id });
  const read = () => getEpic(context());

  async function addFirstMember(): Promise<void> {
    await addEpicMember({ ...context(), member: memberA(), reason: 'API の取り込みを確認する' });
  }

  async function successfulVerification() {
    const run = await startEpicVerification(context());
    const result = verificationResultFor(run);
    await recordEpicVerificationResult({ ...context(), result });
    return { run, result };
  }

  async function completedEpic() {
    await addFirstMember();
    const verification = await successfulVerification();
    await completeEpic(context());
    expect((await read()).status).toBe('completed');
    return verification;
  }

  beforeEach(async () => {
    vi.mocked(randomUUID).mockImplementation((await vi.importActual<typeof import('node:crypto')>('node:crypto')).randomUUID);
    const isolatedDirectory = process.env.TAKT_CONFIG_DIR;
    if (isolatedDirectory === undefined) throw new Error('Isolated test configuration is required');
    globalConfigDirectory = isolatedDirectory;
    root = realpathSync(mkdtempSync(join(tmpdir(), 'takt-epics-')));
    if (template === undefined) {
      repositoryA = repository('api');
      repositoryB = repository('ui');
      goalSha = git(repositoryA, 'rev-parse', 'HEAD');
      targetSha = commit(repositoryA, 'integrated goal');
      await new GoalStore(repositoryA).create(completedEpicGoal(targetSha, goalSha));
      const uiSha = git(repositoryB, 'rev-parse', 'HEAD');
      await new GoalStore(repositoryB).create(completedEpicGoal(uiSha, uiSha));
      git(repositoryA, 'branch', goalRecord().branch, goalSha);
      git(repositoryB, 'branch', goalRecord().branch, uiSha);
      template = { directory: realpathSync(mkdtempSync(join(tmpdir(), 'takt-epic-template-'))), goalSha, targetSha };
      cpSync(repositoryA, join(template.directory, 'api'), { recursive: true });
      cpSync(repositoryB, join(template.directory, 'ui'), { recursive: true });
    } else {
      repositoryA = join(root, 'api');
      repositoryB = join(root, 'ui');
      cpSync(join(template.directory, 'api'), repositoryA, { recursive: true });
      cpSync(join(template.directory, 'ui'), repositoryB, { recursive: true });
      goalSha = template.goalSha;
      targetSha = template.targetSha;
    }
    const workspace = await createWorkspace({ globalConfigDirectory, name: '連携', repositoryDirectories: [repositoryA, repositoryB] });
    workspaceId = workspace.id;
    assignment = { kind: 'workspace', workspaceId, name: workspace.name, repositoryDirectories: workspace.repositoryDirectories };
    epicId = (await createEpic({ ...owner(), ...epicDefinition(), reason: '連携確認を依頼した' })).id;
  }, 120_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.mocked(randomUUID).mockImplementation((await vi.importActual<typeof import('node:crypto')>('node:crypto')).randomUUID);
    rmSync(root, { recursive: true, force: true });
  });

  afterAll(() => {
    if (template !== undefined) rmSync(template.directory, { recursive: true, force: true });
  });

  it('saves distinct Epic IDs and reloads both definitions through the public service', async () => {
    const second = await createEpic({ ...owner(), ...epicDefinition(), objective: '画面連携', reason: '画面も確認する' });
    expect(second.id).not.toBe(epicId);
    expect((await getEpic({ ...owner(), epicId: second.id })).objective).toBe('画面連携');
    expect((await read()).objective).toBe(epicDefinition().objective);
    expect((await listEpics(owner())).map((epic) => epic.id).sort()).toEqual([epicId, second.id].sort());
  });

  it('rejects a generated Epic ID collision without overwriting the saved record', async () => {
    const before = await read();
    vi.mocked(randomUUID).mockReturnValue(epicId as ReturnType<typeof randomUUID>);
    await expect(createEpic({ ...owner(), ...epicDefinition(), objective: '別の目的', reason: '重複作成' })).rejects.toThrow();
    expect(await read()).toEqual(before);
  });

  it('records member additions and removals with the target and reason', async () => {
    await addFirstMember();
    const added = await read();
    expect(added.members).toEqual([memberA()]);
    expect(added.changes).toContainEqual(expect.objectContaining({ member: memberA(), reason: 'API の取り込みを確認する' }));
    await removeEpicMember({ ...context(), member: memberA(), reason: '対象範囲から外した' });
    const removed = await read();
    expect(removed.members).toEqual([]);
    expect(removed.changes).toContainEqual(expect.objectContaining({ member: memberA(), reason: '対象範囲から外した' }));
  });

  it('keeps repository goals, task artifacts and Git refs unchanged through Epic creation and completion', async () => {
    const prMutations = preventPrMutations();
    const directories = [repositoryA, repositoryB];
    const artifacts = directories.map((directory) => repositoryArtifacts(join(directory, '.takt')));
    const refs = directories.map((directory) => git(directory, 'for-each-ref'));
    epicId = (await createEpic({ ...owner(), ...epicDefinition(), reason: '既存ゴールの連携だけを確認する' })).id;
    await addFirstMember();
    await addEpicMember({ ...context(), member: memberB(), reason: '画面の連携も確認する' });
    await successfulVerification();
    await completeEpic(context());
    expect((await read()).status).toBe('completed');
    expect(directories.map((directory) => repositoryArtifacts(join(directory, '.takt')))).toEqual(artifacts);
    expect(directories.map((directory) => git(directory, 'for-each-ref'))).toEqual(refs);
    for (const operation of prMutations) expect(operation).not.toHaveBeenCalled();
  });

  it.each(['unassigned', 'missing', 'duplicate'] as const)('rejects a %s member without changing successful evidence', async (invalid) => {
    await completedEpic();
    const before = await read();
    const outside = invalid === 'unassigned' ? repository('outside') : repositoryA;
    if (invalid === 'unassigned') await new GoalStore(outside).create(completedEpicGoal(targetSha, goalSha));
    const member = { repositoryDirectory: outside, goalId: invalid === 'missing' ? secondGoalId : goalRecord().id };
    await expect(addEpicMember({ ...context(), member, reason: '不正な対象' })).rejects.toThrow();
    expect(await read()).toEqual(before);
  });

  it('normalizes repository aliases before rejecting duplicate members', async () => {
    await completedEpic();
    const before = await read();
    const alias = join(root, 'alias');
    symlinkSync(repositoryA, alias, 'dir');
    await expect(addEpicMember({ ...context(), member: { ...memberA(), repositoryDirectory: alias }, reason: '別名での追加' })).rejects.toThrow();
    expect(await read()).toEqual(before);
  });

  it('checks persisted workspace membership after an earlier assignment was captured', async () => {
    await removeWorkspaceRepository(globalConfigDirectory, workspaceId, repositoryB);
    expect(assignment.repositoryDirectories).toContain(repositoryB);
    const before = await read();
    await expect(addEpicMember({ ...context(), member: memberB(), reason: '担当解除後の追加' })).rejects.toThrow();
    expect(await read()).toEqual(before);
  });

  it.each(['', '   '])('rejects a member change without a nonempty reason: %j', async (reason) => {
    const before = await read();
    await expect(addEpicMember({ ...context(), member: memberA(), reason })).rejects.toThrow();
    expect(await read()).toEqual(before);
  });

  it('rejects verification and completion of an empty member set', async () => {
    const before = await read();
    await expect(startEpicVerification(context())).rejects.toThrow();
    await expect(completeEpic(context())).rejects.toThrow();
    expect(await read()).toEqual(before);
  });

  it('pins integrated targetSha instead of goalSha or the current main tip', async () => {
    const mainSha = commit(repositoryA, 'unrelated main change');
    expect(new Set([goalSha, targetSha, mainSha]).size).toBe(3);
    await addFirstMember();
    const run = await startEpicVerification(context());
    expect(run.targets).toEqual([{ ...memberA(), targetSha }]);
  });

  it('keeps both goal-to-SHA associations for members in the same repository', async () => {
    const secondTarget = commit(repositoryA, 'second integrated goal');
    await new GoalStore(repositoryA).create({ ...completedEpicGoal(secondTarget, goalSha), id: secondGoalId });
    await addFirstMember();
    await addEpicMember({ ...context(), member: { ...memberA(), goalId: secondGoalId }, reason: '同じリポジトリの別ゴール' });
    const run = await startEpicVerification(context());
    expect(run.targets).toHaveLength(2);
    expect(run.targets).toEqual(expect.arrayContaining([
      { ...memberA(), targetSha },
      { ...memberA(), goalId: secondGoalId, targetSha: secondTarget },
    ]));
  });

  it('keeps current evidence after unrelated main advancement on the same Epic', async () => {
    await completedEpic();
    const before = await read();
    commit(repositoryA, 'unrelated main advancement');
    await refreshEpicTargets({ ...context(), reason: '固定対象を照合した' });
    expect(await read()).toMatchObject({
      targets: before.targets, revision: before.revision, status: before.status, currentEvidence: before.currentEvidence,
    });
    await completeEpic(context());
    expect(await read()).toMatchObject({
      targets: before.targets, revision: before.revision, status: before.status, currentEvidence: before.currentEvidence,
    });
  });

  it('matches the same target set regardless of result ordering', async () => {
    await addFirstMember();
    await addEpicMember({ ...context(), member: memberB(), reason: '画面も確認する' });
    const { result } = await successfulVerification();
    await completeEpic(context());
    const before = await read();
    await recordEpicVerificationResult({ ...context(), result: { ...result, targets: [...result.targets].reverse() } });
    await completeEpic(context());
    expect(await read()).toEqual(before);
  });

  it('persists all verification evidence and completes only after explicit finalization', async () => {
    await addFirstMember();
    const { run, result } = await successfulVerification();
    const saved = await read();
    expect(saved.status).toBe('active');
    expect(saved.currentEvidence?.result).toEqual(result);
    expect(saved.verificationRuns).toContainEqual(expect.objectContaining({ id: run.id, result }));
    expect((await listEpics(owner())).find((epic) => epic.id === epicId)).toEqual(saved);
    await completeEpic(context());
    expect((await read()).status).toBe('completed');
  });

  it.each(['created', 'awaiting_merge', 'aborted'] as const)('rejects verification and completion with a %s member', async (state) => {
    const store = new GoalStore(repositoryA);
    await store.update(goalRecord().id, (goal) => ({
      ...goal,
      status: state === 'awaiting_merge' ? 'awaiting_merge' : 'created',
      executionStatus: state === 'aborted' ? 'aborted' : 'active',
    }));
    await addFirstMember();
    await expect(startEpicVerification(context())).rejects.toThrow();
    await expect(completeEpic(context())).rejects.toThrow();
    expect((await read()).status).toBe('active');
  });

  it('requires evidence for the current definition even when every goal is completed', async () => {
    await addFirstMember();
    await expect(completeEpic(context())).rejects.toThrow();
    expect((await read()).status).toBe('active');
  });

  it('does not complete a failed verification even when every acceptance result says passed', async () => {
    await addFirstMember();
    const run = await startEpicVerification(context());
    await recordEpicVerificationResult({ ...context(), result: { ...verificationResultFor(run), outcome: 'failed' } });
    await expect(completeEpic(context())).rejects.toThrow();
    expect((await read()).status).toBe('active');
  });

  it.each(['active', 'aborted'] as const)('rechecks a member that became %s after successful verification before finalizing', async (executionStatus) => {
    await addFirstMember();
    await successfulVerification();
    await new GoalStore(repositoryA).update(goalRecord().id, (goal) => ({ ...goal, status: 'created', executionStatus }));
    await expect(completeEpic(context())).rejects.toThrow();
    expect((await read()).status).toBe('active');
  });

  it.each(['failed', 'missing', 'unknown'] as const)('rejects completion with a %s acceptance result', async (condition) => {
    await addFirstMember();
    const run = await startEpicVerification(context());
    const result = {
      ...verificationResultFor(run),
      acceptanceResults: condition === 'missing' ? [{ criterionId: 'api', outcome: 'passed' as const }] : [
        { criterionId: 'api', outcome: 'passed' as const },
        { criterionId: condition === 'unknown' ? 'unrelated' : 'ui', outcome: condition === 'failed' ? 'failed' as const : 'passed' as const },
      ],
    };
    // 条件不足は記録時または完了時に拒否できるが、完了の成功にはできない。
    await recordEpicVerificationResult({ ...context(), result }).catch((error: unknown) => { expect(error).toBeInstanceOf(Error); });
    await expect(completeEpic(context())).rejects.toThrow();
    expect((await read()).status).toBe('active');
  });

  it('rejects missing environment evidence without changing the running verification', async () => {
    await addFirstMember();
    const run = await startEpicVerification(context());
    const before = await read();
    const invalid: Record<string, unknown> = {
      ...verificationResultFor(run),
    };
    delete invalid.environment;
    await expect(recordEpicVerificationResult({ ...context(), result: invalid })).rejects.toThrow();
    expect(await read()).toEqual(before);
    await expect(completeEpic(context())).rejects.toThrow();
  });

  it.each(['plan', 'post_apply'] as const)('requires applied Terraform verification rather than %s evidence alone', async (phase) => {
    await addFirstMember();
    await updateEpicDefinition({ ...context(), changes: {
      verificationProcedure: { ...epicDefinition().verificationProcedure, terraform: { requiresApply: true } },
    }, reason: '適用後の確認が必要' });
    const run = await startEpicVerification(context());
    const result = {
      ...verificationResultFor(run),
      terraform: { phase, applyStatus: 'not_applied' as const, artifactReferences: ['artifact://terraform/plan'] },
    };
    await recordEpicVerificationResult({ ...context(), result }).catch((error: unknown) => { expect(error).toBeInstanceOf(Error); });
    await expect(completeEpic(context())).rejects.toThrow();
    expect((await read()).status).toBe('active');
  });

  it('allows completion with recorded Terraform application and post-apply verification', async () => {
    await addFirstMember();
    await updateEpicDefinition({ ...context(), changes: {
      verificationProcedure: { ...epicDefinition().verificationProcedure, terraform: { requiresApply: true } },
    }, reason: '適用後の確認が必要' });
    const run = await startEpicVerification(context());
    const result = {
      ...verificationResultFor(run),
      terraform: { phase: 'post_apply' as const, applyStatus: 'applied' as const, artifactReferences: ['artifact://terraform/applied-state'] },
    };
    await recordEpicVerificationResult({ ...context(), result });
    await completeEpic(context());
    expect((await read()).currentEvidence?.result?.terraform).toEqual(result.terraform);
    expect((await read()).status).toBe('completed');
  });

  it.each(['add', 'remove', 'criteria', 'procedure', 'targets'] as const)('invalidates completed evidence after a %s change and can verify the same Epic again', async (change) => {
    const { run, result } = await completedEpic();
    const before = await read();
    const reason = `再確認が必要: ${change}`;
    if (change === 'add') {
      await addEpicMember({ ...context(), member: memberB(), reason });
    } else if (change === 'remove') {
      await removeEpicMember({ ...context(), member: memberA(), reason });
    } else if (change === 'criteria') {
      await updateEpicDefinition({ ...context(), changes: {
        acceptanceCriteria: [
          { id: 'api', description: '更新した API が応答する' },
          epicDefinition().acceptanceCriteria[1]!,
        ],
      }, reason });
    } else if (change === 'procedure') {
      await updateEpicDefinition({ ...context(), changes: {
        verificationProcedure: { version: 2, steps: ['新しい手順で API と画面を確認する'] },
      }, reason });
    } else {
      const replacementSha = commit(repositoryA, 'new fixed integration target');
      await new GoalStore(repositoryA).update(goalRecord().id, (goal) => ({
        ...goal, completion: { ...goal.completion!, targetSha: replacementSha },
      }));
      await refreshEpicTargets({ ...context(), reason });
    }
    const changed = await read();
    expect(changed.status).toBe('active');
    expect(changed.revision).toBeGreaterThan(before.revision);
    expect(changed.currentEvidence).toBeUndefined();
    expect(changed.verificationRuns).toContainEqual(expect.objectContaining({
      id: run.id, result, invalidationReason: reason,
    }));
    expect(changed.changes).toContainEqual(expect.objectContaining({ reason }));
    await expect(completeEpic(context())).rejects.toThrow();
    if (change === 'remove') await addFirstMember();
    await successfulVerification();
    await completeEpic(context());
    expect((await read()).id).toBe(epicId);
    expect((await read()).status).toBe('completed');
  });

  it('classifies a delayed pre-change result as stale without replacing a newer running verification', async () => {
    await addFirstMember();
    const old = await startEpicVerification(context());
    await updateEpicDefinition({ ...context(), changes: {
      verificationProcedure: { version: 2, steps: ['新手順で確認する'] },
    }, reason: '検証中に手順を改訂した' });
    const current = await startEpicVerification(context());
    const result = verificationResultFor(old);
    await recordEpicVerificationResult({ ...context(), result });
    const saved = await read();
    expect(saved.status).toBe('active');
    expect(saved.currentEvidence).toBeUndefined();
    expect(saved.runningVerification?.id).toBe(current.id);
    expect(saved.verificationRuns).toContainEqual(expect.objectContaining({ id: old.id, status: 'stale', result }));
    await expect(completeEpic(context())).rejects.toThrow();
  });

  it.each(['revision', 'runId', 'targets', 'procedureVersion'] as const)('rejects mismatched %s without consuming the current verification', async (field) => {
    await addFirstMember();
    const run = await startEpicVerification(context());
    const result = {
      ...verificationResultFor(run),
      ...(field === 'revision' ? { revision: run.revision + 1 } : {}),
      ...(field === 'runId' ? { runId: secondGoalId } : {}),
      ...(field === 'targets' ? { targets: [{ ...memberA(), targetSha: goalSha }] } : {}),
      ...(field === 'procedureVersion' ? { procedureVersion: run.procedureVersion + 1 } : {}),
    };
    const before = await read();
    await expect(recordEpicVerificationResult({ ...context(), result })).rejects.toThrow();
    expect(await read()).toEqual(before);
  });

  it.each(['result', 'completion'] as const)('rechecks fixed goal targets at %s registration without an explicit refresh', async (boundary) => {
    await addFirstMember();
    const run = await startEpicVerification(context());
    const result = verificationResultFor(run);
    if (boundary === 'completion') await recordEpicVerificationResult({ ...context(), result });
    const replacementSha = commit(repositoryA, 'changed integration');
    await new GoalStore(repositoryA).update(goalRecord().id, (goal) => ({
      ...goal, completion: { ...goal.completion!, targetSha: replacementSha },
    }));
    if (boundary === 'result') {
      const registered = await recordEpicVerificationResult({ ...context(), result });
      const saved = await read();
      expect(saved).toEqual(registered);
      expect(saved.status).toBe('active');
      expect(saved.currentEvidence).toBeUndefined();
      expect(saved.targets).toEqual([{ ...memberA(), targetSha: replacementSha }]);
      expect(saved.revision).toBeGreaterThan(run.revision);
      expect(saved.verificationRuns).toContainEqual(expect.objectContaining({ id: run.id, status: 'stale', result }));
    }
    await expect(completeEpic(context())).rejects.toThrow();
    expect((await read()).status).toBe('active');
    expect((await read()).currentEvidence).toBeUndefined();
  });

  it('uses a new execution ID for another verification and preserves the previous result', async () => {
    await addFirstMember();
    const { run, result } = await successfulVerification();
    const next = await startEpicVerification(context());
    expect(next.id).not.toBe(run.id);
    const before = await read();
    expect(before.verificationRuns).toContainEqual(expect.objectContaining({ id: run.id, result }));
    expect(before.currentEvidence?.result).toEqual(result);
    expect(before.runningVerification).toEqual(next);
    expect(before.verificationRuns).toHaveLength(2);
    await expect(completeEpic(context())).rejects.toThrow();
    expect(await read()).toEqual(before);
    expect(await listEpics(owner())).toContainEqual(before);
    expect(await getEpicVerificationRecovery(context())).toEqual([next]);

    const workspaceBefore = await readWorkspace(globalConfigDirectory, workspaceId);
    await expect(removeManagerRepository(assignment, repositoryA, globalConfigDirectory)).rejects.toThrow();
    expect(await readWorkspace(globalConfigDirectory, workspaceId)).toEqual(workspaceBefore);
    expect(await read()).toEqual(before);

    await recordEpicVerificationResult({ ...context(), result: verificationResultFor(next) });
    expect(await getEpicVerificationRecovery(context())).toEqual([]);
    const completed = await completeEpic(context());
    expect(completed.status).toBe('completed');
    expect(completed.verificationRuns).toHaveLength(2);
    expect(completed.verificationRuns).toContainEqual(expect.objectContaining({ id: run.id, result }));
    await removeManagerRepository(assignment, repositoryA, globalConfigDirectory);
    expect((await readWorkspace(globalConfigDirectory, workspaceId))?.repositoryDirectories).not.toContain(repositoryA);
    expect(await read()).toEqual(completed);
  });

  it('rejects a generated run ID collision without replacing past evidence', async () => {
    await addFirstMember();
    const { run } = await successfulVerification();
    const before = await read();
    vi.mocked(randomUUID).mockReturnValue(run.id as ReturnType<typeof randomUUID>);
    await expect(startEpicVerification(context())).rejects.toThrow();
    expect(await read()).toEqual(before);
  });

  it('applies duplicate results and completion only once across public reads', async () => {
    const { result } = await completedEpic();
    const before = await read();
    await recordEpicVerificationResult({ ...context(), result });
    await completeEpic(context());
    await listEpics(owner());
    await recordEpicVerificationResult({ ...context(), result });
    await completeEpic(context());
    expect(await read()).toEqual(before);
  });

  it('rejects conflicting content for an already recorded execution ID', async () => {
    await addFirstMember();
    const { result } = await successfulVerification();
    const before = await read();
    await expect(recordEpicVerificationResult({ ...context(), result: { ...result, outcome: 'failed' } })).rejects.toThrow();
    expect(await read()).toEqual(before);
  });

  it('preserves running state on normal reads and exposes it for explicit restart recovery', async () => {
    await addFirstMember();
    const run = await startEpicVerification(context());
    const before = await read();
    await listEpics(owner());
    expect(await read()).toEqual(before);
    expect((await read()).runningVerification?.id).toBe(run.id);
    vi.resetModules();
    const restarted = await import('../infra/epics/index.js');
    expect(await restarted.getEpic(context())).toEqual(before);
    const recovery = await restarted.getEpicVerificationRecovery(context());
    expect(recovery).toContainEqual(expect.objectContaining({ id: run.id }));
    const after = await read();
    expect(after.status).toBe('active');
    expect(after.currentEvidence).toBeUndefined();
    expect(after.verificationRuns).toHaveLength(before.verificationRuns.length);
    await expect(completeEpic(context())).rejects.toThrow();
  });

  it('replaces an aborted member with a correction goal without reopening the old goal', async () => {
    await new GoalStore(repositoryA).update(goalRecord().id, (goal) => ({ ...goal, status: 'created', executionStatus: 'aborted' }));
    await addFirstMember();
    await expect(completeEpic(context())).rejects.toThrow();
    const old = await new GoalStore(repositoryA).get(goalRecord().id);
    await new GoalStore(repositoryA).create({ ...completedEpicGoal(targetSha, goalSha), id: secondGoalId });
    await replaceEpicMember({ ...context(), member: memberA(), replacement: { ...memberA(), goalId: secondGoalId }, reason: '修正用ゴールに置換する' });
    expect((await read()).members).toEqual([{ ...memberA(), goalId: secondGoalId }]);
    expect((await read()).changes).toContainEqual(expect.objectContaining({ reason: '修正用ゴールに置換する' }));
    await successfulVerification();
    await completeEpic(context());
    expect((await read()).status).toBe('completed');
    expect(await new GoalStore(repositoryA).get(goalRecord().id)).toEqual(old);
  });

  it('invalidates completion when replacing a completed member and leaves that goal completed', async () => {
    const { run } = await completedEpic();
    const old = await new GoalStore(repositoryA).get(goalRecord().id);
    await new GoalStore(repositoryA).create({ ...completedEpicGoal(targetSha, goalSha), id: secondGoalId });
    await replaceEpicMember({ ...context(), member: memberA(), replacement: { ...memberA(), goalId: secondGoalId }, reason: '完了後の修正' });
    expect((await read()).status).toBe('active');
    expect((await read()).currentEvidence).toBeUndefined();
    expect((await read()).verificationRuns).toContainEqual(expect.objectContaining({ id: run.id, invalidationReason: '完了後の修正' }));
    expect(await new GoalStore(repositoryA).get(goalRecord().id)).toEqual(old);
  });

  it('keeps goal records, PR references and repository refs unchanged when the Epic is aborted', async () => {
    const prMutations = preventPrMutations();
    await addFirstMember();
    await addEpicMember({ ...context(), member: memberB(), reason: '画面も対象にする' });
    const paths = [repositoryA, repositoryB].map((directory) => join(directory, '.takt', 'goals', goalRecord().id, 'goal.json'));
    const records = paths.map((path) => readFileSync(path));
    const refs = [repositoryA, repositoryB].map((directory) => git(directory, 'for-each-ref'));
    await abortEpic({ ...context(), reason: '連携確認を中止する' });
    const saved = await read();
    expect(saved.status).toBe('aborted');
    expect(saved.members).toEqual([memberA(), memberB()]);
    expect(saved.changes).toContainEqual(expect.objectContaining({ reason: '連携確認を中止する' }));
    expect(paths.map((path) => readFileSync(path))).toEqual(records);
    expect([repositoryA, repositoryB].map((directory) => git(directory, 'for-each-ref'))).toEqual(refs);
    for (const operation of prMutations) expect(operation).not.toHaveBeenCalled();
  });

  it('rejects repository removal for an active Epic even when the child goal is completed', async () => {
    await addFirstMember();
    expect((await new GoalStore(repositoryA).get(goalRecord().id)).status).toBe('completed');
    const before = await readWorkspace(globalConfigDirectory, workspaceId);
    await expect(removeManagerRepository(assignment, repositoryA, globalConfigDirectory)).rejects.toThrow(epicId);
    expect(await readWorkspace(globalConfigDirectory, workspaceId)).toEqual(before);
  });

  it.each(['remove member', 'complete', 'abort'] as const)('allows repository removal after %s and preserves the Epic history', async (operation) => {
    await addFirstMember();
    if (operation === 'remove member') {
      await removeEpicMember({ ...context(), member: memberA(), reason: '担当解除のために参照を削除する' });
    } else if (operation === 'complete') {
      await successfulVerification();
      await completeEpic(context());
    } else {
      await successfulVerification();
      await abortEpic({ ...context(), reason: '担当変更のため中止する' });
    }
    const before = await read();
    await removeManagerRepository(assignment, repositoryA, globalConfigDirectory);
    expect((await readWorkspace(globalConfigDirectory, workspaceId))?.repositoryDirectories).not.toContain(repositoryA);
    expect(await read()).toEqual(before);
    expect(await listEpics(owner())).toContainEqual(before);
  });

  it('preserves completed history after removal and permits definition changes after assignment is restored', async () => {
    const { result } = await completedEpic();
    await removeManagerRepository(assignment, repositoryA, globalConfigDirectory);
    const before = await read();
    const operations = [
      () => updateEpicDefinition({ ...context(), changes: { objective: '追加確認' }, reason: '目的変更' }),
      () => addEpicMember({ ...context(), member: memberB(), reason: 'メンバー追加' }),
      () => removeEpicMember({ ...context(), member: memberA(), reason: 'メンバー削除' }),
      () => replaceEpicMember({ ...context(), member: memberA(), replacement: memberB(), reason: '置換' }),
      () => refreshEpicTargets({ ...context(), reason: '対象更新' }),
      () => startEpicVerification(context()),
      () => recordEpicVerificationResult({ ...context(), result }),
      () => completeEpic(context()),
    ];
    for (const operation of operations) {
      await expect(operation()).rejects.toThrow();
      expect(await read()).toEqual(before);
    }
    expect(await listEpics(owner())).toContainEqual(before);
    await addManagerRepository(assignment, repositoryA, globalConfigDirectory);
    const changed = await updateEpicDefinition({ ...context(), changes: { objective: '追加確認' }, reason: '担当を戻して再確認する' });
    expect(changed.status).toBe('active');
    expect(changed.currentEvidence).toBeUndefined();
    expect(changed.verificationRuns).toContainEqual(expect.objectContaining({ id: result.runId, result: before.currentEvidence?.result }));
  });

  it('preserves both concurrent member additions', async () => {
    await Promise.all([
      addEpicMember({ ...context(), member: memberA(), reason: 'API を追加する' }),
      addEpicMember({ ...context(), member: memberB(), reason: '画面を追加する' }),
    ]);
    const saved = await read();
    expect(saved.members).toHaveLength(2);
    expect(saved.members).toEqual(expect.arrayContaining([memberA(), memberB()]));
    expect(saved.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: 'API を追加する' }),
      expect.objectContaining({ reason: '画面を追加する' }),
    ]));
  });

  it('serializes member addition with repository removal so an active reference never becomes unassigned', async () => {
    const [addition, removal] = await Promise.allSettled([
      addEpicMember({ ...context(), member: memberA(), reason: '解除操作と同時に追加する' }),
      removeManagerRepository(assignment, repositoryA, globalConfigDirectory),
    ]);
    expect([addition.status, removal.status].sort()).toEqual(['fulfilled', 'rejected']);
    const workspace = await readWorkspace(globalConfigDirectory, workspaceId);
    const epic = await read();
    if (addition.status === 'fulfilled') {
      expect(epic.members).toContainEqual(memberA());
      expect(workspace?.repositoryDirectories).toContain(repositoryA);
    } else {
      expect(epic.members).not.toContainEqual(memberA());
      expect(workspace?.repositoryDirectories).not.toContain(repositoryA);
    }
  });
});

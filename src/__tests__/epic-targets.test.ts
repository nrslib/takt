import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveEpicMember, resolveEpicTargets } from '../infra/epics/targets.js';
import { memberKey, normalizeTargets, sameTargets } from '../infra/epics/targetIdentity.js';
import { completedEpicGoal, epicWorkspaceId, secondGoalId } from './helpers/epic-fixtures.js';
import { goalRecord } from './helpers/goal-fixtures.js';

const doubles = vi.hoisted(() => ({ resolve: vi.fn(), get: vi.fn() }));
vi.mock('../infra/task/repositoryDirectory.js', () => ({ resolveGitRepositoryDirectory: doubles.resolve }));
vi.mock('../infra/goals/store.js', () => ({ GoalStore: class { getSync = doubles.get; } }));

const member = { repositoryDirectory: '/repositories/api', goalId: goalRecord().id };
const target = { ...member, targetSha: 'b'.repeat(40) };
const workspace = { id: epicWorkspaceId, name: '連携', repositoryDirectories: [member.repositoryDirectory] };

beforeEach(() => {
  vi.resetAllMocks();
  doubles.resolve.mockResolvedValue(member.repositoryDirectory);
  doubles.get.mockReturnValue(completedEpicGoal(target.targetSha, 'a'.repeat(40)));
});

describe('Epic member and target resolution', () => {
  it('distinguishes repositories and goals in the member identity', () => {
    expect(memberKey(member)).not.toBe(memberKey({ ...member, goalId: secondGoalId }));
    expect(memberKey(member)).not.toBe(memberKey({ ...member, repositoryDirectory: '/repositories/ui' }));
  });

  it('compares targets without depending on ordering and rejects duplicate identities', () => {
    const second = { ...target, goalId: secondGoalId, targetSha: 'c'.repeat(40) };
    expect(sameTargets([target, second], [second, target])).toBe(true);
    expect(sameTargets([target], [{ ...target, targetSha: 'c'.repeat(40) }])).toBe(false);
    expect(() => normalizeTargets([target, target])).toThrow();
  });

  it('normalizes member directories before checking assignment and goal existence', async () => {
    expect(await resolveEpicMember(workspace, { ...member, repositoryDirectory: '/alias' })).toEqual(member);
    expect(doubles.resolve).toHaveBeenCalledWith('/alias');
    expect(doubles.get).toHaveBeenCalledWith(member.goalId);
  });

  it('rejects unassigned and missing members', async () => {
    doubles.resolve.mockResolvedValueOnce('/repositories/outside');
    await expect(resolveEpicMember(workspace, member)).rejects.toThrow();
    expect(doubles.get).not.toHaveBeenCalled();
    doubles.get.mockImplementation(() => { throw new Error('Missing goal'); });
    await expect(resolveEpicMember(workspace, member)).rejects.toThrow();
  });

  it('derives targets exclusively from completed goal integration evidence', async () => {
    expect(await resolveEpicTargets(workspace, [member])).toEqual([target]);
    await expect(resolveEpicTargets(workspace, [])).rejects.toThrow();
    doubles.get.mockReturnValue({ ...goalRecord(), completion: completedEpicGoal(target.targetSha, 'a'.repeat(40)).completion });
    await expect(resolveEpicTargets(workspace, [member])).rejects.toThrow();
    doubles.get.mockReturnValue({ ...completedEpicGoal(target.targetSha, 'a'.repeat(40)), executionStatus: 'aborted' });
    await expect(resolveEpicTargets(workspace, [member])).rejects.toThrow();
  });
});

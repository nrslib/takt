import { isDeepStrictEqual } from 'node:util';
import type { Workspace } from '../config/global/workspaceRegistry.js';
import { GoalStore } from '../goals/store.js';
import { resolveGitRepositoryDirectory } from '../task/repositoryDirectory.js';
import type { EpicMember, EpicTarget } from './schema.js';

export function memberKey(member: EpicMember): string {
  return JSON.stringify([member.repositoryDirectory, member.goalId]);
}

export function normalizeTargets(targets: readonly EpicTarget[]): EpicTarget[] {
  const normalized = targets.map((target) => ({ ...target })).sort((left, right) => memberKey(left).localeCompare(memberKey(right)));
  if (new Set(normalized.map(memberKey)).size !== normalized.length) throw new Error('Duplicate Epic target');
  return normalized;
}

export function sameTargets(left: readonly EpicTarget[], right: readonly EpicTarget[]): boolean {
  return isDeepStrictEqual(normalizeTargets(left), normalizeTargets(right));
}

export async function resolveEpicMember(workspace: Workspace, member: EpicMember): Promise<EpicMember> {
  const repositoryDirectory = await resolveGitRepositoryDirectory(member.repositoryDirectory);
  if (!workspace.repositoryDirectories.includes(repositoryDirectory)) throw new Error(`Repository is not assigned to workspace: ${repositoryDirectory}`);
  new GoalStore(repositoryDirectory).getSync(member.goalId);
  return { repositoryDirectory, goalId: member.goalId };
}

export async function resolveEpicTargets(workspace: Workspace, members: readonly EpicMember[]): Promise<EpicTarget[]> {
  if (members.length === 0) throw new Error('Epic members must not be empty');
  const resolved = await Promise.all(members.map((member) => resolveEpicMember(workspace, member)));
  const targets = resolved.map((member) => {
    const goal = new GoalStore(member.repositoryDirectory).getSync(member.goalId);
    if (goal.status !== 'completed' || goal.executionStatus === 'aborted' || goal.completion?.targetSha === undefined) {
      throw new Error(`Epic member is not completed: ${member.goalId}`);
    }
    return { ...member, targetSha: goal.completion.targetSha };
  });
  return normalizeTargets(targets);
}

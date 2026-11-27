import type { Workspace } from '../config/global/workspaceRegistry.js';
import { GoalStore } from '../goals/store.js';
import { resolveGitRepositoryDirectory } from '../task/repositoryDirectory.js';
import type { EpicMember, EpicTarget } from './schema.js';
import { normalizeTargets } from './targetIdentity.js';

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

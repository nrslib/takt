import { addWorkspaceRepository, createWorkspace, generateWorkspaceName, removeWorkspaceRepository, renameWorkspace, type Workspace } from '../../infra/config/global/workspaceRegistry.js';
import { resolveGitRepositoryDirectory } from '../../infra/task/repositoryDirectory.js';
import { GoalStore } from '../../infra/goals/store.js';
import type { ManagerAssignment } from './startupResolution.js';

export async function addManagerRepository(assignment: ManagerAssignment, repositoryDirectory: string, globalConfigDirectory: string): Promise<Workspace | undefined> {
  const repository = await resolveGitRepositoryDirectory(repositoryDirectory);
  if (assignment.kind === 'repository' && repository === assignment.repositoryDirectory) return undefined;
  return assignment.kind === 'workspace'
    ? addWorkspaceRepository(globalConfigDirectory, assignment.workspaceId, repository)
    : createWorkspace({ globalConfigDirectory, name: generateWorkspaceName([assignment.repositoryDirectory, repository]),
      repositoryDirectories: [assignment.repositoryDirectory, repository] });
}

export async function removeManagerRepository(assignment: ManagerAssignment, repositoryDirectory: string, globalConfigDirectory: string): Promise<Workspace> {
  if (assignment.kind !== 'workspace') throw new Error('Manager does not belong to a workspace');
  const repository = assignment.repositoryDirectories.includes(repositoryDirectory)
    ? repositoryDirectory : await resolveGitRepositoryDirectory(repositoryDirectory);
  if (!assignment.repositoryDirectories.includes(repository)) throw new Error(`Repository is not assigned to this manager: ${repository}`);
  const { goals, errors } = await new GoalStore(repository).list();
  if (errors.length > 0) throw new Error(`Cannot read goals before removing repository: ${errors.map(({ goalId }) => goalId).join(', ')}`);
  const unfinished = goals.filter((goal) => goal.status !== 'completed' && goal.executionStatus !== 'aborted');
  if (unfinished.length > 0) throw new Error(`Repository has unfinished goals: ${unfinished.map((goal) => goal.id).join(', ')}`);
  return removeWorkspaceRepository(globalConfigDirectory, assignment.workspaceId, repository);
}

export async function renameManagerWorkspace(assignment: ManagerAssignment, name: string, globalConfigDirectory: string): Promise<Workspace> {
  if (assignment.kind !== 'workspace') throw new Error('Manager does not belong to a workspace');
  return renameWorkspace(globalConfigDirectory, assignment.workspaceId, name);
}

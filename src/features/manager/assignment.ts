import { findWorkspaceForRepository, readWorkspace } from '../../infra/config/global/workspaceRegistry.js';
import { resolveGitRepositoryDirectory } from '../../infra/task/repositoryDirectory.js';
import { GoalStore } from '../../infra/goals/store.js';
import type { ManagerAssignment } from './startupResolution.js';

export type ManagerAssignmentIdentity =
  | { readonly kind: 'repository'; readonly repositoryDirectory: string }
  | { readonly kind: 'workspace'; readonly workspaceId: string };
export const MANAGER_ASSIGNMENT_ENV = 'TAKT_MANAGER_ASSIGNMENT';

export async function resolveCurrentManagerAssignment(identity: ManagerAssignmentIdentity, globalConfigDirectory: string): Promise<ManagerAssignment> {
  const workspace = identity.kind === 'workspace'
    ? await readWorkspace(globalConfigDirectory, identity.workspaceId)
    : await findWorkspaceForRepository(globalConfigDirectory, identity.repositoryDirectory);
  if (workspace !== undefined) return {
    kind: 'workspace', workspaceId: workspace.id, name: workspace.name, repositoryDirectories: workspace.repositoryDirectories,
  };
  if (identity.kind === 'workspace') throw new Error(`Workspace does not exist: ${identity.workspaceId}`);
  return { ...identity, repositoryDirectories: [identity.repositoryDirectory] };
}

export async function resolveAssignedProjectRoot(cwd: string, assignment: ManagerAssignment): Promise<string> {
  const root = await resolveGitRepositoryDirectory(cwd);
  if (!assignment.repositoryDirectories.includes(root)) throw new Error(`Git repository is not assigned to this manager: ${root} (cwd: ${cwd})`);
  return root;
}

export async function findAssignedGoalRepository(goalId: string, assignment: ManagerAssignment): Promise<string> {
  const matches: string[] = [];
  for (const directory of assignment.repositoryDirectories) {
    const { goals, errors } = await new GoalStore(directory).list();
    if (errors.some((error) => error.goalId === goalId)) throw new Error(`Cannot read goal ${goalId}: ${directory}`);
    if (goals.some((goal) => goal.id === goalId)) matches.push(directory);
  }
  if (matches.length !== 1) throw new Error(`Goal must belong to one assigned repository: ${goalId}`);
  return matches[0]!;
}

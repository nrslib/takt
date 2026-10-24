import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { findWorkspaceForRepository, readWorkspaceRegistry, type Workspace } from '../../infra/config/global/workspaceRegistry.js';
import { isGitRepository, resolveGitRepositoryDirectory } from '../../infra/task/repositoryDirectory.js';

export type ManagerAssignment =
  | { readonly kind: 'repository'; readonly repositoryDirectory: string; readonly repositoryDirectories: readonly string[] }
  | { readonly kind: 'workspace'; readonly workspaceId: string; readonly name: string; readonly repositoryDirectories: readonly string[] };
export interface ManagerExecutionContext {
  readonly assignment: ManagerAssignment & { readonly startupRepositoryDirectory?: string };
  readonly cwd: string;
}
export type ManagerStartupResolution =
  | { readonly kind: 'ready'; readonly context: ManagerExecutionContext }
  | { readonly kind: 'selection'; readonly workspaces: readonly Workspace[] };

export function createWorkspaceManagerContext(workspace: Workspace, globalConfigDirectory: string): ManagerExecutionContext {
  return {
    cwd: workspace.repositoryDirectories[0] ?? join(globalConfigDirectory, 'workspaces', workspace.id),
    assignment: { kind: 'workspace', workspaceId: workspace.id, name: workspace.name, repositoryDirectories: workspace.repositoryDirectories },
  };
}

export async function resolveManagerStartup(startupDirectory: string, globalConfigDirectory: string): Promise<ManagerStartupResolution> {
  const directory = await realpath(startupDirectory);
  if (!await isGitRepository(directory)) return { kind: 'selection', workspaces: await readWorkspaceRegistry(globalConfigDirectory) };
  const repositoryDirectory = await resolveGitRepositoryDirectory(directory);
  const workspace = await findWorkspaceForRepository(globalConfigDirectory, repositoryDirectory);
  if (workspace === undefined) return {
    kind: 'ready',
    context: { cwd: repositoryDirectory, assignment: { kind: 'repository', repositoryDirectory, repositoryDirectories: [repositoryDirectory] } },
  };
  const context = createWorkspaceManagerContext(workspace, globalConfigDirectory);
  return {
    kind: 'ready',
    context: { ...context, assignment: { ...context.assignment, startupRepositoryDirectory: repositoryDirectory } },
  };
}

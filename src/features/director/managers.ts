import { listDaemonProjects } from '../daemon/projects.js';
import { resolveCurrentManagerAssignment } from '../manager/assignment.js';
import type { ManagerAssignment } from '../manager/startupResolution.js';
import { conversationId } from '../../infra/conversations/identity.js';
import { readWorkspaceRegistry } from '../../infra/config/global/workspaceRegistry.js';

export async function listDirectorManagers(configDirectory: string): Promise<ManagerAssignment[]> {
  const managers = new Map<string, ManagerAssignment>();
  for (const workspace of await readWorkspaceRegistry(configDirectory)) {
    const assignment = { kind: 'workspace' as const, workspaceId: workspace.id, name: workspace.name,
      repositoryDirectories: workspace.repositoryDirectories };
    managers.set(conversationId(assignment), assignment);
  }
  for (const repositoryDirectory of await listDaemonProjects(configDirectory)) {
    const assignment = await resolveCurrentManagerAssignment({ kind: 'repository', repositoryDirectory }, configDirectory);
    managers.set(conversationId(assignment), assignment);
  }
  return [...managers.values()];
}

export async function resolveDirectorManager(configDirectory: string, id: string): Promise<ManagerAssignment> {
  const assignment = (await listDirectorManagers(configDirectory)).find((candidate) => conversationId(candidate) === id);
  if (assignment === undefined) throw new Error('Manager is outside the daemon assignment');
  return assignment;
}

import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { resolveCurrentManagerAssignment } from '../manager/assignment.js';
import type { ManagerAssignment } from '../manager/startupResolution.js';
import { conversationId } from '../../infra/conversations/identity.js';
import { readProjectRegistry } from '../../infra/config/global/projectRegistry.js';
import { readWorkspaceRegistry } from '../../infra/config/global/workspaceRegistry.js';
import { createLogger } from '../../shared/utils/debug.js';
import { getErrorMessage } from '../../shared/utils/error.js';
import { sanitizeSensitiveText } from '../../shared/utils/sensitiveText.js';

const log = createLogger('director');

interface DirectorManagerList {
  managers: ManagerAssignment[];
  errors: { repositoryDirectory: string; reason: string }[];
}

export async function listDirectorManagers(configDirectory: string): Promise<DirectorManagerList> {
  const workspaces = await readWorkspaceRegistry(configDirectory);
  const registry = await readProjectRegistry(configDirectory);
  for (const warning of registry.warnings) log.warn('Invalid project registration', { warning });
  const registeredDirectories = new Map(registry.projects.map((project) => [project.canonicalDirectory, project]));
  const directories = new Set(registry.projects
    .filter((project) => project.managerUsed === true)
    .map((project) => project.canonicalDirectory));
  const managers = new Map<string, ManagerAssignment>();
  const errors: DirectorManagerList['errors'] = [];
  for (const workspace of workspaces) {
    const assignment = { kind: 'workspace' as const, workspaceId: workspace.id, name: workspace.name,
      repositoryDirectories: workspace.repositoryDirectories };
    managers.set(conversationId(assignment), assignment);
    for (const directory of workspace.repositoryDirectories) directories.add(directory);
  }
  for (const repositoryDirectory of [...directories].sort()) {
    try {
      const canonical = await realpath(repositoryDirectory);
      if (!(await stat(canonical)).isDirectory()) throw new Error(`Not a project directory: ${canonical}`);
      await access(canonical, constants.R_OK | constants.X_OK);
      if (registeredDirectories.get(repositoryDirectory)?.available === false
        || registeredDirectories.get(canonical)?.available === false) {
        throw new Error('Project directory is unavailable or has changed identity');
      }
      const assignment = await resolveCurrentManagerAssignment({ kind: 'repository', repositoryDirectory: canonical }, configDirectory);
      managers.set(conversationId(assignment), assignment);
    } catch (error) {
      errors.push({ repositoryDirectory, reason: sanitizeSensitiveText(getErrorMessage(error)) });
    }
  }
  return { managers: [...managers.values()], errors };
}

export async function resolveDirectorManager(configDirectory: string, id: string): Promise<ManagerAssignment> {
  const { managers } = await listDirectorManagers(configDirectory);
  const assignment = managers.find((candidate) => conversationId(candidate) === id);
  if (assignment === undefined) throw new Error('Manager is outside the daemon assignment');
  return assignment;
}

import { isAbsolute } from 'node:path';
import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { registerProject } from '../../infra/config/global/projectRegistry.js';
import { conversationId } from '../../infra/conversations/identity.js';
import { withManagerLifecycleLock, withManagerLifecycleLocks } from '../../infra/conversations/managerLifecycleLock.js';
import { DirectorManagerStateStore } from '../../infra/director/managerState.js';
import { isGoalFinished } from '../../infra/goals/activity.js';
import { readDirectorManagerGoals } from '../../infra/director/managerGoals.js';
import { resolveGitRepositoryDirectory } from '../../infra/task/gitRepositoryDirectory.js';
import type { DaemonConversations } from '../daemon/conversationState.js';
import { routeAssignment, type DaemonRouting } from '../daemon/routing.js';

export async function addDirectorManager(conversations: Pick<DaemonConversations, 'routing' | 'ensure'>,
  repositoryDirectory: string, signal: AbortSignal): Promise<{ managerId: string }> {
  signal.throwIfAborted();
  if (!isAbsolute(repositoryDirectory)) throw new Error('Repository directory must be an absolute path');
  const directory = await resolveGitRepositoryDirectory(repositoryDirectory);
  signal.throwIfAborted();
  const configDirectory = conversations.routing.directory;
  const route = (await conversations.routing.routes()).find((entry) => entry.repositoryDirectory === directory);
  const assignment = route === undefined ? { kind: 'repository' as const, repositoryDirectory: directory } : routeAssignment(route);
  await conversations.ensure(assignment, signal);
  await registerProject({ globalConfigDirectory: configDirectory, projectDirectory: directory, command: 'director', managerUsed: true, signal });
  const managerId = conversationId(assignment);
  await new DirectorManagerStateStore(configDirectory).setFired(managerId, false, signal);
  return { managerId };
}

export async function fireDirectorManager(routing: DaemonRouting, managerId: string, signal: AbortSignal): Promise<{ managerId: string }> {
  signal.throwIfAborted();
  return withManagerLifecycleLock(routing.directory, managerId, signal, async () => {
    const states = new DirectorManagerStateStore(routing.directory);
    const assignment = (await routing.assignments()).find((manager) => conversationId(manager) === managerId);
    if (assignment === undefined || assignment.kind === 'daemon' || await states.isFired(managerId)) {
      throw new Error('Manager is outside the daemon assignment');
    }
    const display = await routing.display(assignment);
    const repositories: Array<{ directory: string; canonical: string }> = [];
    for (const directory of display.repositoryDirectories) {
      signal.throwIfAborted();
      const canonical = await realpath(directory);
      if (!(await stat(canonical)).isDirectory()) throw new Error('Assigned repository is not a directory');
      await access(canonical, constants.R_OK | constants.X_OK);
      if (await resolveGitRepositoryDirectory(canonical) !== canonical
        || !await routing.permits({ kind: 'repository', repositoryDirectory: canonical }, managerId)) {
        throw new Error('Assigned repository has changed identity');
      }
      repositories.push({ directory, canonical });
    }
    const fire = async () => {
      for (const { directory, canonical } of repositories) {
        for await (const goal of readDirectorManagerGoals(canonical, signal)) {
          if (!isGoalFinished(goal)) throw new Error(`Cannot fire manager: unfinished goal ${goal.id} in ${directory}`);
        }
      }
      await states.setFired(managerId, true, signal);
      return { managerId };
    };
    return assignment.kind === 'repository' ? fire()
      : withManagerLifecycleLocks(routing.directory, repositories.map(({ canonical }) =>
        conversationId({ kind: 'repository', repositoryDirectory: canonical })), signal, fire);
  });
}

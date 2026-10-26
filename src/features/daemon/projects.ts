import { realpath, stat } from 'node:fs/promises';
import { readProjectRegistry } from '../../infra/config/global/projectRegistry.js';
import { readWorkspaceRegistry } from '../../infra/config/global/workspaceRegistry.js';
import { GoalStore } from '../../infra/goals/store.js';
import { readManagerEvents } from '../../infra/goals/events.js';
import { TaskStore } from '../../infra/task/store.js';
import { createLogger } from '../../shared/utils/debug.js';
import { getErrorMessage } from '../../shared/utils/error.js';
import { sanitizeSensitiveText } from '../../shared/utils/sensitiveText.js';

const log = createLogger('daemon');

export async function listDaemonProjects(globalConfigDirectory: string): Promise<readonly string[]> {
  const registry = await readProjectRegistry(globalConfigDirectory);
  for (const warning of registry.warnings) log.warn('Invalid project registration', { warning });
  const directories = new Set(registry.projects
    .filter((project) => project.managerUsed === true && project.available)
    .map((project) => project.canonicalDirectory));
  for (const workspace of await readWorkspaceRegistry(globalConfigDirectory)) {
    for (const directory of workspace.repositoryDirectories) {
      try {
        const canonical = await realpath(directory);
        if (!(await stat(canonical)).isDirectory()) throw new Error(`Not a project directory: ${canonical}`);
        const registered = registry.projects.find((project) => project.canonicalDirectory === canonical);
        if (registered !== undefined && !registered.available) {
          log.warn('Workspace project registration is unavailable', { directory });
          continue;
        }
        directories.add(canonical);
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR'))) throw error;
        log.warn('Workspace project is unavailable', { directory });
      }
    }
  }
  return [...directories].sort();
}

export async function hasDaemonProjectWork(cwd: string, onReadError?: (error: unknown) => void): Promise<boolean> {
  const { goals, errors } = await new GoalStore(cwd).list();
  for (const failure of errors) {
    log.error('Cannot read goal', { goalId: failure.goalId, error: sanitizeSensitiveText(failure.error.message) });
    onReadError?.(failure.error);
  }
  const hasGoalOrEventWork = goals.some((goal) => goal.status !== 'completed' && goal.executionStatus !== 'aborted')
    || readManagerEvents(cwd).length > 0;
  try {
    const hasTaskWork = new TaskStore(cwd).read().tasks.some((task) => task.status === 'pending' || task.status === 'running');
    return hasGoalOrEventWork || hasTaskWork;
  } catch (error) {
    log.error('Cannot read daemon project tasks', { cwd, error: sanitizeSensitiveText(getErrorMessage(error)) });
    onReadError?.(error);
    // Unreadable tasks cannot establish work; readable goals and events still can.
    return hasGoalOrEventWork;
  }
}

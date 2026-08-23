import type { PersistedTaskOrderRevision } from '../../features/tasks/orderRevision.js';

export const MOCK_CREATED_TASK_DIR = '.takt/tasks/created-order';

export function createPersistedTaskOrderRevisionMock(
  projectDir: string,
  taskDir: string | undefined,
): PersistedTaskOrderRevision {
  const taskDirRelative = taskDir ?? MOCK_CREATED_TASK_DIR;
  return {
    taskDirRelative,
    taskDir: `${projectDir}/${taskDirRelative}`,
    created: taskDir === undefined,
    rollback: () => undefined,
  };
}

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { TaskRunner } from '../../infra/task/runner.js';
import { serializeTaskListItemForJson } from '../../infra/task/listSerializer.js';
import { safeExternalErrorMessage } from '../../shared/utils/safeExternalErrorMessage.js';
import { selectTasksForDeletion } from '../tasks/list/taskDeleteSelection.js';
import { executeTaskDeletion } from '../tasks/list/taskDeleteExecution.js';
import { assertCwdAllowedByMcpRoot, type McpOperationDependencies } from './operations.js';
import { jsonResult } from './response.js';
import type { CleanupTasksInput } from './schemas.js';

export function cleanupTaktTasks(input: CleanupTasksInput, deps: McpOperationDependencies): CallToolResult {
  try {
    assertCwdAllowedByMcpRoot(input.cwd, deps.allowedProjectRoot);
    const tasks = selectTasksForDeletion(new TaskRunner(input.cwd).listAllTaskItems(), {
      status: input.statuses, goal: input.goalId, branch: input.branch,
    });
    if (input.confirm !== true) {
      return jsonResult({ tasks: tasks.map(serializeTaskListItemForJson) });
    }
    const results = executeTaskDeletion(tasks);
    return jsonResult({ results: results.map(({ task, success, error }) => ({
      task: serializeTaskListItemForJson(task), success,
      ...(error === undefined ? {} : { error: safeExternalErrorMessage(error) }),
    })) }, results.some((result) => !result.success));
  } catch (error) {
    return jsonResult({ error: safeExternalErrorMessage(error) }, true);
  }
}

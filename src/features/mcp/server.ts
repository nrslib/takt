import * as fs from 'node:fs';
import * as process from 'node:process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { packageVersion } from '../../shared/package-info.js';
import {
  listGoalsInputSchema,
  getGoalInputSchema,
  enqueueTaskInputSchema,
  getRunInputSchema,
  listTasksInputSchema,
  tellRunInputSchema,
  enqueueGoalTaskInputSchema,
  mergeGoalTaskInputSchema,
  completeGoalInputSchema,
  goalDiffInputSchema,
  goalHistoryInputSchema,
  askGoalQuestionInputSchema,
  getGoalQuestionInputSchema,
  notifyGoalInputSchema,
  goalWriteInputSchema, withdrawGoalQuestionInputSchema, recordGoalWorkLogInputSchema, listGoalRecordsInputSchema,
} from './schemas.js';
import {
  listTaktGoals,
  getTaktGoal,
  enqueueTaktTask,
  getTaktRun,
  listTaktTasks,
  tellTaktRun,
  type McpOperationDependencies,
} from './operations.js';
import { enqueueTaktGoalTask, listTaktWorkflows } from './goalOperations.js';
import { requeueTaktGoalTask, retryTaktGoalTask } from './goalTaskRetryOperations.js';
import { requeueGoalTaskInputSchema, retryGoalTaskInputSchema } from './goalTaskRetrySchemas.js';
import { removeGoalTaskInputSchema } from './goalTaskRemovalSchemas.js';
import { removeTaktGoalTask } from './goalTaskRemovalOperations.js';
import { askTaktGoalQuestion, listTaktGoalQuestions, getTaktGoalQuestion, withdrawTaktGoalQuestion } from './goalQuestionOperations.js';
import { notifyTaktGoal } from './goalNotificationOperations.js';
import { recordTaktGoalWorkLog, listTaktGoalRecords } from './goalWorkLogOperations.js';
import { mergeTaktGoalTask, completeTaktGoal, checkTaktGoalCompletion } from './goalIntegrationOperations.js';
import { getTaktGoalDiff, getTaktGoalHistory, getTaktGoalRelation } from './goalReadOperations.js';
import { assertCwdAllowedByMcpRoot, errorResult, jsonResult } from './operations.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createLogger } from '../../shared/utils/debug.js';
import { getErrorMessage } from '../../shared/utils/error.js';
import { sanitizeSensitiveText } from '../../shared/utils/sensitiveText.js';

import { z } from 'zod';
import { getGlobalConfigDir } from '../../infra/config/paths.js';
import { resolveAssignedProjectRoot, resolveCurrentManagerAssignment, type ManagerAssignmentIdentity } from '../manager/assignment.js';
import { addManagerRepository, removeManagerRepository, renameManagerWorkspace } from '../manager/workspaceOperations.js';

const log = createLogger('mcp-server');

export type TaktMcpToolSet = 'all' | 'read-only' | 'manager';

/**
 * The read-only task-state tools are also used to build the interactive
 * provider allowlist. Keep this list beside the MCP registration so exposing
 * a new read-only tool cannot leave the interactive permission path behind.
 */
export const TAKT_MCP_READ_ONLY_TOOL_NAMES = [
  'takt_list_tasks',
  'takt_get_run',
  'takt_list_goals',
  'takt_get_goal',
] as const;

export const TAKT_MCP_MANAGER_TOOL_NAMES = [
  ...TAKT_MCP_READ_ONLY_TOOL_NAMES,
  'takt_add_workspace_repository', 'takt_remove_workspace_repository', 'takt_rename_workspace',
  'takt_enqueue_goal_task', 'takt_list_workflows',
  'takt_requeue_goal_task', 'takt_retry_goal_task',
  'takt_remove_goal_task',
  'takt_merge_goal_task', 'takt_complete_goal', 'takt_check_goal_completion',
  'takt_get_goal_diff', 'takt_get_goal_history', 'takt_get_goal_relation',
  'takt_ask_goal_question', 'takt_list_goal_questions', 'takt_get_goal_question',
  'takt_withdraw_goal_question', 'takt_notify_goal',
  'takt_record_goal_work_log', 'takt_list_goal_work_log', 'takt_list_goal_operations',
] as const;

export interface TaktMcpServerOptions {
  managerAssignment?: ManagerAssignmentIdentity;
  goalEventContext?: import('../../infra/goals/operations.js').GoalEventContext;
  goalTurnOwners?: import('../../infra/goals/turn-lock.js').GoalTurnOwners;
  allowedProjectRoot?: string;
  toolSet?: TaktMcpToolSet;
  includeReferenceMarkers?: boolean;
}

function buildMcpOperationDependencies(
  deps: McpOperationDependencies,
  options: TaktMcpServerOptions,
): McpOperationDependencies {
  return {
    ...deps,
    allowedProjectRoot: fs.realpathSync(options.allowedProjectRoot ?? process.cwd()),
    includeReferenceMarkers: options.includeReferenceMarkers,
    goalTurnOwners: options.goalTurnOwners ?? deps.goalTurnOwners,
    goalEventContext: options.goalEventContext ?? deps.goalEventContext,
    readOnly: options.toolSet === 'read-only',
  };
}

async function startManagerEventRecovery(cwd: string): Promise<void> {
  const { recoverManagerEvents } = await import('../manager/completionTurn.js');
  void recoverManagerEvents(cwd).catch((error: unknown) => {
    log.error('Failed to recover manager events', { error: sanitizeSensitiveText(getErrorMessage(error)) });
  });
}

export function createTaktMcpServer(
  deps: McpOperationDependencies = {},
  options: TaktMcpServerOptions = {},
): McpServer {
  const operationDeps = buildMcpOperationDependencies(deps, options);
  const globalConfigDirectory = getGlobalConfigDir();
  let managerIdentity: ManagerAssignmentIdentity = options.managerAssignment ?? { kind: 'repository', repositoryDirectory: operationDeps.allowedProjectRoot! };
  const currentAssignment = () => resolveCurrentManagerAssignment(managerIdentity, globalConfigDirectory);
  const projectInput = <T extends { cwd: string }>(input: T, currentDeps: McpOperationDependencies): T =>
    options.toolSet === 'manager' ? { ...input, cwd: currentDeps.allowedProjectRoot! } : input;
  const operation = async (cwd: string, errorContext: string, action: (deps: McpOperationDependencies) => CallToolResult | Promise<CallToolResult>, launchAfterOperation = true, recoverAfterOperation = false): Promise<CallToolResult> => {
    try {
      const currentDeps = options.toolSet === 'manager'
        ? { ...operationDeps, allowedProjectRoot: await resolveAssignedProjectRoot(cwd, await currentAssignment()) }
        : operationDeps;
      assertCwdAllowedByMcpRoot(cwd, currentDeps.allowedProjectRoot);
      const projectCwd = projectInput({ cwd }, currentDeps).cwd;
      if (operationDeps.readOnly !== true && operationDeps.goalTurnOwners === undefined) {
        await startManagerEventRecovery(projectCwd);
      }
      try { return await action(currentDeps); }
      finally {
        if (recoverAfterOperation && operationDeps.readOnly !== true && operationDeps.goalTurnOwners === undefined) {
          await startManagerEventRecovery(projectCwd);
        }
        if (launchAfterOperation && operationDeps.readOnly !== true && operationDeps.goalTurnOwners === undefined) {
          const { ensureManagerRun } = await import('../manager/autoRun.js');
          await ensureManagerRun(projectCwd);
        }
      }
    } catch (error) { return errorResult(errorContext, error); }
  };
  const server = new McpServer({
    name: 'takt',
    version: packageVersion,
  });
  if (options.toolSet === 'manager') {
    const workspaceOperation = async (action: () => Promise<unknown>): Promise<CallToolResult> => {
      try { return jsonResult({ workspace: await action() }); }
      catch (error) { return errorResult('Workspace operation failed', error); }
    };
    server.registerTool('takt_add_workspace_repository', {
      title: 'Add an assigned repository', description: 'Add a Git repository to the manager workspace, creating a workspace when needed.',
      inputSchema: { repositoryDirectory: z.string().min(1) },
    }, (input) => workspaceOperation(async () => {
      const workspace = await addManagerRepository(await currentAssignment(), input.repositoryDirectory, globalConfigDirectory);
      if (workspace !== undefined) managerIdentity = { kind: 'workspace', workspaceId: workspace.id };
      return workspace;
    }));
    server.registerTool('takt_remove_workspace_repository', {
      title: 'Remove an assigned repository', description: 'Remove an assigned repository without unfinished goals.',
      inputSchema: { repositoryDirectory: z.string().min(1) },
    }, (input) => workspaceOperation(async () => removeManagerRepository(await currentAssignment(), input.repositoryDirectory, globalConfigDirectory)));
    server.registerTool('takt_rename_workspace', {
      title: 'Rename the assigned workspace', description: 'Change the saved name of the manager workspace.',
      inputSchema: { name: z.string().trim().min(1) },
    }, (input) => workspaceOperation(async () => renameManagerWorkspace(await currentAssignment(), input.name, globalConfigDirectory)));
  }
  if (options.toolSet !== 'read-only') server.registerTool('takt_list_workflows', {
    title: 'List workflows', description: 'Read workflow names and descriptions.', inputSchema: listGoalsInputSchema,
  }, (input) => operation(input.cwd, 'Workflow list failed', (deps) => listTaktWorkflows(projectInput(input, deps), deps)));
  if (options.toolSet !== 'read-only') {
    server.registerTool('takt_record_goal_work_log', {
      title: 'Record manager work', description: 'Append a short account of submitted, integrated or abandoned work and its reasons. Available in conversation and event turns.', inputSchema: recordGoalWorkLogInputSchema,
    }, (input, extra) => operation(input.cwd, 'Goal work log failed', (deps) => recordTaktGoalWorkLog(projectInput(input, deps), deps, extra.signal), false));
    server.registerTool('takt_list_goal_work_log', {
      title: 'Read manager work', description: 'Read the saved manager work log.', inputSchema: listGoalRecordsInputSchema,
    }, (input) => operation(input.cwd, 'Goal work log read failed', (deps) => listTaktGoalRecords(projectInput(input, deps), deps, 'workLog'), false));
    server.registerTool('takt_list_goal_operations', {
      title: 'Read goal operations', description: 'Read saved operation names, arguments, pending or completed state, and results. Defaults to the current event when present.', inputSchema: listGoalRecordsInputSchema,
    }, (input) => operation(input.cwd, 'Goal operation read failed', (deps) => listTaktGoalRecords(projectInput(input, deps), deps, 'operations'), false));
    server.registerTool('takt_ask_goal_question', {
      title: 'Ask a goal question', description: 'Save a pending question, optional choices, recommendation and dependent work keys. Returns the saved question ID.',
      inputSchema: askGoalQuestionInputSchema,
    }, (input, extra) => operation(input.cwd, 'Goal question failed', (deps) => askTaktGoalQuestion(projectInput(input, deps), deps, extra.signal)));
    server.registerTool('takt_list_goal_questions', {
      title: 'List goal questions', description: 'Read saved questions, including their answer status and answer content.',
      inputSchema: getGoalInputSchema,
    }, (input) => operation(input.cwd, 'Goal question list failed', (deps) => listTaktGoalQuestions(projectInput(input, deps), deps), false));
    server.registerTool('takt_get_goal_question', {
      title: 'Read a goal question', description: 'Read a saved question and its answer by ID.',
      inputSchema: getGoalQuestionInputSchema,
    }, (input) => operation(input.cwd, 'Goal question read failed', (deps) => getTaktGoalQuestion(projectInput(input, deps), deps), false));
    server.registerTool('takt_withdraw_goal_question', {
      title: 'Withdraw a goal question', description: 'Withdraw a pending question when it is resolved without a human answer.',
      inputSchema: withdrawGoalQuestionInputSchema,
    }, (input, extra) => operation(input.cwd, 'Goal question withdrawal failed', (deps) => withdrawTaktGoalQuestion(projectInput(input, deps), deps, extra.signal)));
    server.registerTool('takt_notify_goal', {
      title: 'Notify a goal event', description: 'Save and deliver a blocked or custom event that a human should know, with optional severity.',
      inputSchema: notifyGoalInputSchema,
    }, (input, extra) => operation(input.cwd, 'Goal notification failed', (deps) => notifyTaktGoal(projectInput(input, deps), deps, extra.signal)));
    server.registerTool('takt_enqueue_goal_task', {
      title: 'Enqueue goal work', description: 'Enqueue ready work locally from the goal branch. Instructions must be self-contained and must not request merging.',
      inputSchema: enqueueGoalTaskInputSchema,
    }, (input, extra) => operation(input.cwd, 'Goal task enqueue failed', (deps) => enqueueTaktGoalTask(projectInput(input, deps), deps, extra.signal), false, true));
    server.registerTool('takt_requeue_goal_task', {
      title: 'Requeue stopped goal work', description: 'Resume the same failed or exceeded goal task from its saved stopping position, with an optional additional note. A failed task may instead restart from startStep; if the saved position cannot be used, the call fails with the reason and the accepted startStep values.',
      inputSchema: requeueGoalTaskInputSchema,
    }, (input, extra) => operation(input.cwd, 'Goal task requeue failed', (deps) => requeueTaktGoalTask(projectInput(input, deps), deps, extra.signal), false, true));
    server.registerTool('takt_retry_goal_task', {
      title: 'Retry corrected goal work', description: 'Save corrected canonical instructions and return the same failed goal task to pending, optionally restarting from startStep. If the saved position cannot be used and startStep is omitted, the call fails with the reason and the accepted startStep values.',
      inputSchema: retryGoalTaskInputSchema,
    }, (input, extra) => operation(input.cwd, 'Goal task retry failed', (deps) => retryTaktGoalTask(projectInput(input, deps), deps, extra.signal), false, true));
    server.registerTool('takt_merge_goal_task', {
      title: 'Merge reviewed goal work', description: 'Merge a task result into its saved goal branch after checking ownership and the reviewed SHA. Returns conflicts or checked-out worktree locations without moving the target.',
      inputSchema: mergeGoalTaskInputSchema,
    }, (input, extra) => operation(input.cwd, 'Goal merge failed', (deps) => mergeTaktGoalTask(projectInput(input, deps), deps, extra.signal), true, true));
    server.registerTool('takt_remove_goal_task', {
      title: 'Remove goal work',
      description: 'Cancel pending goal work or clean up stopped or merged work with a required reason. Running and unmerged completed tasks are rejected.',
      inputSchema: removeGoalTaskInputSchema,
    }, (input, extra) => operation(input.cwd, 'Goal task removal failed', (deps) => removeTaktGoalTask(projectInput(input, deps), deps, extra.signal), false));
    server.registerTool('takt_complete_goal', {
      title: 'Complete a reviewed goal', description: 'Apply repository manager.main_merge permission to the reviewed goal SHA and acceptance evidence. Auto merges or saves human merge instructions; conflicts keep the goal open.',
      inputSchema: completeGoalInputSchema,
    }, (input, extra) => operation(input.cwd, 'Goal completion failed', (deps) => completeTaktGoal(projectInput(input, deps), deps, extra.signal), true, true));
    server.registerTool('takt_check_goal_completion', {
      title: 'Check a human goal merge', description: 'Complete a waiting goal only when the saved approved SHA is included in its saved target branch.',
      inputSchema: goalWriteInputSchema,
    }, (input, extra) => operation(input.cwd, 'Goal completion check failed', (deps) => checkTaktGoalCompletion(projectInput(input, deps), deps, extra.signal), true, true));
    server.registerTool('takt_get_goal_diff', {
      title: 'Read goal differences', description: 'Return bounded file counts and optionally a literal file patch, with explicit truncation. Compares task result against goal, or goal against integration target.',
      inputSchema: goalDiffInputSchema,
    }, (input, extra) => operation(input.cwd, 'Goal diff failed', (deps) => getTaktGoalDiff(projectInput(input, deps), deps, extra.signal), false));
    server.registerTool('takt_get_goal_history', {
      title: 'Read goal history', description: 'Return bounded commit history for a goal or its task result, with explicit message and count truncation.',
      inputSchema: goalHistoryInputSchema,
    }, (input, extra) => operation(input.cwd, 'Goal history failed', (deps) => getTaktGoalHistory(projectInput(input, deps), deps, extra.signal), false));
    server.registerTool('takt_get_goal_relation', {
      title: 'Read goal containment', description: 'Return compared SHAs, containment in the integration target, and the number of goal commits ahead of that target.',
      inputSchema: getGoalInputSchema,
    }, (input, extra) => operation(input.cwd, 'Goal relation failed', (deps) => getTaktGoalRelation(projectInput(input, deps), deps, extra.signal), false));
  }

  if (options.toolSet === undefined || options.toolSet === 'all') {
    server.registerTool(
      'takt_enqueue_task',
      {
        title: 'Enqueue TAKT task',
        description: 'Save a pending TAKT task into .takt/tasks.yaml. Optionally link an existing issue or create one. Explicit draftPr overrides project and global draft settings; omission preserves inheritance. Success returns saved worktree, autoPr, and draftPr (null when omitted). Run queued tasks with `takt run` or monitor continuously with `takt watch`.',
        inputSchema: enqueueTaskInputSchema,
      },
      (input, extra) => operation(input.cwd, 'Task enqueue failed', (deps) => enqueueTaktTask(projectInput(input, deps), deps, extra.signal)),
    );
  }

  server.registerTool(
    TAKT_MCP_READ_ONLY_TOOL_NAMES[2],
    {
      title: 'List TAKT goals',
      description: 'Read goals saved in .takt/goals/. Invalid saved records return individual errors alongside healthy goals. Path, access, and traversal identity failures remain whole-tool errors.',
      inputSchema: listGoalsInputSchema,
    },
    (input) => operation(input.cwd, 'Goal list failed', (deps) => listTaktGoals(projectInput(input, deps), deps)),
  );

  server.registerTool(
    TAKT_MCP_READ_ONLY_TOOL_NAMES[3],
    {
      title: 'Get a TAKT goal',
      description: 'Read all saved information for the specified goal ID.',
      inputSchema: getGoalInputSchema,
    },
    (input) => operation(input.cwd, 'Goal read failed', (deps) => getTaktGoal(projectInput(input, deps), deps)),
  );

  server.registerTool(
    TAKT_MCP_READ_ONLY_TOOL_NAMES[0],
    {
      title: 'List TAKT tasks',
      description: 'Read a compact summary of project tasks and their run state. Individual worktree or run failures return that task\'s available basic information with an error while preserving the other tasks. Invalid worktree references are not read. Queue or cwd access failures remain whole-tool errors. Logs and report contents are not loaded.',
      inputSchema: listTasksInputSchema,
    },
    (input) => operation(input.cwd, 'Task list failed', (deps) => listTaktTasks(projectInput(input, deps), deps)),
  );

  server.registerTool(
    TAKT_MCP_READ_ONLY_TOOL_NAMES[1],
    {
      title: 'Get TAKT run details',
      description: 'Read the selected run current step, phase, step logs, reports, and live intervention delivery state.',
      inputSchema: getRunInputSchema,
    },
    (input) => operation(input.cwd, 'Run read failed', (deps) => getTaktRun(projectInput(input, deps), deps)),
  );

  if (options.toolSet === undefined || options.toolSet === 'all') {
    server.registerTool(
      'takt_tell_run',
      {
        title: 'Send an instruction to a running TAKT task',
        description: 'Append an additional instruction to a running worktree-clone run after rechecking its identity and status.',
        inputSchema: tellRunInputSchema,
      },
      (input) => operation(input.cwd, 'Run tell failed', (deps) => tellTaktRun(projectInput(input, deps), deps)),
    );
  }

  return server;
}

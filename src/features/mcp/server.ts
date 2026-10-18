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
  cleanupTasksInputSchema,
  tellRunInputSchema,
  tellGoalRunInputSchema,
  enqueueGoalTaskInputSchema,
  mergeGoalTaskInputSchema,
  completeGoalInputSchema,
  reopenGoalInputSchema,
  goalDiffInputSchema,
  goalHistoryInputSchema,
  askGoalQuestionInputSchema,
  getGoalQuestionInputSchema,
  listGoalQuestionsInputSchema,
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
import { cleanupTaktTasks } from './taskCleanupOperations.js';
import { requeueTaktGoalTask, retryTaktGoalTask } from './goalTaskRetryOperations.js';
import { requeueGoalTaskInputSchema, retryGoalTaskInputSchema } from './goalTaskRetrySchemas.js';
import { removeGoalTaskInputSchema } from './goalTaskRemovalSchemas.js';
import { removeTaktGoalTask } from './goalTaskRemovalOperations.js';
import { tellTaktGoalRun } from './goalTellOperations.js';
import { askTaktGoalQuestion, listTaktGoalQuestions, getTaktGoalQuestion, withdrawTaktGoalQuestion } from './goalQuestionOperations.js';
import { notifyTaktGoal } from './goalNotificationOperations.js';
import { recordTaktGoalWorkLog, listTaktGoalRecords } from './goalWorkLogOperations.js';
import { mergeTaktGoalTask, completeTaktGoal, checkTaktGoalCompletion, reopenTaktGoal } from './goalIntegrationOperations.js';
import { getTaktGoalDiff, getTaktGoalHistory, getTaktGoalRelation } from './goalReadOperations.js';
import { assertCwdAllowedByMcpRoot, errorResult } from './operations.js';
import { workspaceResult } from './workspaceResponse.js';
import type { Workspace } from '../../infra/config/global/workspaceRegistry.js';
import type { ListTasksInput } from './schemas.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { z } from 'zod';
import { getGlobalConfigDir } from '../../infra/config/paths.js';
import { resolveAssignedProjectRoot, resolveCurrentManagerAssignment, type ManagerAssignmentIdentity } from '../manager/assignment.js';
import { addManagerRepository, removeManagerRepository, renameManagerWorkspace } from '../manager/workspaceOperations.js';


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
  'takt_reopen_goal',
  'takt_tell_run',
  'takt_get_goal_diff', 'takt_get_goal_history', 'takt_get_goal_relation',
  'takt_ask_goal_question', 'takt_list_goal_questions', 'takt_get_goal_question',
  'takt_withdraw_goal_question', 'takt_notify_goal',
  'takt_record_goal_work_log', 'takt_list_goal_work_log',
] as const;

export interface TaktMcpServerOptions {
  managerAssignment?: ManagerAssignmentIdentity;
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
    readOnly: options.toolSet === 'read-only',
  };
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
  const operation = async (cwd: string, errorContext: string, action: (deps: McpOperationDependencies) => CallToolResult | Promise<CallToolResult>, launchAfterOperation = true): Promise<CallToolResult> => {
    try {
      const currentDeps = options.toolSet === 'manager'
        ? { ...operationDeps, allowedProjectRoot: await resolveAssignedProjectRoot(cwd, await currentAssignment()) }
        : operationDeps;
      assertCwdAllowedByMcpRoot(cwd, currentDeps.allowedProjectRoot);
      const projectCwd = projectInput({ cwd }, currentDeps).cwd;
      try { return await action(currentDeps); }
      finally {
        if (launchAfterOperation && operationDeps.readOnly !== true) {
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
  const workspaceOperation = async (
    action: () => Promise<Workspace | undefined>,
    input: Pick<ListTasksInput, 'limit' | 'offset' | 'path' | 'textOffset' | 'maxBytes'> = {},
  ): Promise<CallToolResult> => {
    try { return workspaceResult(await action(), input); }
    catch (error) { return errorResult('Workspace operation failed', error); }
  };
  const workspaceRetrieval = 'Responses fit 64 KiB, with explicit truncation. Managers can read the current workspace with takt_list_tasks view workspace and offset/limit (1-50), or path name or repositoryDirectories.N (saved index) and textOffset/maxBytes for text. cwd must be absolute and does not select the workspace.';
  if (options.toolSet === 'manager') {
    server.registerTool('takt_tell_run', {
      title: 'Send an instruction to running goal work',
      description: 'Send an additional instruction to the running task selected by goalId and taskName, and save its original text in the goal work log. Responses fit 64 KiB, with explicit truncation. Read saved instructions with takt_get_run, runSlug and view instructions using offset/limit (1-50), or select instructionId and offset/maxBytes for forward UTF-8 text. Follow nextOffset for continuation. Read the saved work log with takt_get_goal path workLog.summary, recordId and textOffset/maxBytes.',
      inputSchema: tellGoalRunInputSchema,
    }, (input, extra) => operation(input.cwd, 'Goal run tell failed', (deps) => tellTaktGoalRun(projectInput(input, deps), deps, extra.signal), false));
    server.registerTool('takt_add_workspace_repository', {
      title: 'Add an assigned repository', description: `Add a Git repository to the manager workspace, creating a workspace when needed. ${workspaceRetrieval}`,
      inputSchema: { repositoryDirectory: z.string().min(1) },
    }, (input) => workspaceOperation(async () => {
      const workspace = await addManagerRepository(await currentAssignment(), input.repositoryDirectory, globalConfigDirectory);
      if (workspace !== undefined) managerIdentity = { kind: 'workspace', workspaceId: workspace.id };
      return workspace;
    }));
    server.registerTool('takt_remove_workspace_repository', {
      title: 'Remove an assigned repository', description: `Remove an assigned repository without unfinished goals. ${workspaceRetrieval}`,
      inputSchema: { repositoryDirectory: z.string().min(1) },
    }, (input) => workspaceOperation(async () => removeManagerRepository(await currentAssignment(), input.repositoryDirectory, globalConfigDirectory)));
    server.registerTool('takt_rename_workspace', {
      title: 'Rename the assigned workspace', description: `Change the saved name of the manager workspace. ${workspaceRetrieval}`,
      inputSchema: { name: z.string().trim().min(1) },
    }, (input) => workspaceOperation(async () => renameManagerWorkspace(await currentAssignment(), input.name, globalConfigDirectory)));
  }
  if (options.toolSet !== 'read-only') server.registerTool('takt_list_workflows', {
    title: 'List workflows', description: 'Read workflow names and descriptions. Responses fit 64 KiB, with explicit truncation. Use offset/limit for continuation.', inputSchema: listGoalsInputSchema.omit({ errorOffset: true }),
  }, (input) => operation(input.cwd, 'Workflow list failed', (deps) => listTaktWorkflows(projectInput(input, deps), deps)));
  if (options.toolSet !== 'read-only') {
    server.registerTool('takt_record_goal_work_log', {
      title: 'Record manager work', description: 'Append a short account of submitted, integrated or abandoned work and its reasons. Available in conversation and event turns. Returns the saved entry and count within 64 KiB, with explicit truncation. Read the entry with takt_get_goal path workLog.summary, recordId and textOffset/maxBytes.', inputSchema: recordGoalWorkLogInputSchema,
    }, (input, extra) => operation(input.cwd, 'Goal work log failed', (deps) => recordTaktGoalWorkLog(projectInput(input, deps), deps, extra.signal), false));
    server.registerTool('takt_list_goal_work_log', {
      title: 'Read manager work', description: 'Read recent manager work in reverse saved order with optional limit (1-50) and offset. Read full entries with takt_get_goal path workLog, recordId, and a text field path. Responses fit 64 KiB, with explicit truncation.', inputSchema: listGoalRecordsInputSchema,
    }, (input) => operation(input.cwd, 'Goal work log read failed', (deps) => listTaktGoalRecords(projectInput(input, deps), deps), false));
    server.registerTool('takt_ask_goal_question', {
      title: 'Ask a goal question', description: 'Save a pending question, optional choices and recommendation. Returns the saved question ID. Responses fit 64 KiB. Read saved content with takt_get_goal_question and questionId.',
      inputSchema: askGoalQuestionInputSchema,
    }, (input, extra) => operation(input.cwd, 'Goal question failed', (deps) => askTaktGoalQuestion(projectInput(input, deps), deps, extra.signal)));
    server.registerTool('takt_list_goal_questions', {
      title: 'List goal questions', description: 'Read pending questions first, then other saved questions, with offset/limit. Retrieve one question by questionId with takt_get_goal_question. Responses fit 64 KiB, with explicit truncation.',
      inputSchema: listGoalQuestionsInputSchema,
    }, (input) => operation(input.cwd, 'Goal question list failed', (deps) => listTaktGoalQuestions(projectInput(input, deps), deps), false));
    server.registerTool('takt_get_goal_question', {
      title: 'Read a goal question', description: 'Read a question and answer by questionId. Select path body, recommendation, answer.text or options.N and textOffset/maxBytes to retrieve omitted text. Responses fit 64 KiB, with explicit truncation.',
      inputSchema: getGoalQuestionInputSchema,
    }, (input) => operation(input.cwd, 'Goal question read failed', (deps) => getTaktGoalQuestion(projectInput(input, deps), deps), false));
    server.registerTool('takt_withdraw_goal_question', {
      title: 'Withdraw a goal question', description: 'Withdraw a pending question when it is resolved without a human answer. Returns saved state and IDs within 64 KiB. Read the saved question with takt_get_goal_question and questionId.',
      inputSchema: withdrawGoalQuestionInputSchema,
    }, (input, extra) => operation(input.cwd, 'Goal question withdrawal failed', (deps) => withdrawTaktGoalQuestion(projectInput(input, deps), deps, extra.signal)));
    server.registerTool('takt_notify_goal', {
      title: 'Notify a goal event', description: 'Save and deliver a blocked or custom event that a human should know, with optional severity. Returns saved state and notificationId within 64 KiB, with explicit truncation. Read saved text with takt_get_goal path notifications.body, recordId and textOffset/maxBytes.',
      inputSchema: notifyGoalInputSchema,
    }, (input, extra) => operation(input.cwd, 'Goal notification failed', (deps) => notifyTaktGoal(projectInput(input, deps), deps, extra.signal)));
    server.registerTool('takt_enqueue_goal_task', {
      title: 'Enqueue goal work', description: 'Enqueue ready work locally from the goal branch. Instructions must be self-contained and must not request merging. Responses fit 64 KiB, with explicit truncation. Read saved work with takt_list_tasks offset/limit.',
      inputSchema: enqueueGoalTaskInputSchema,
    }, (input, extra) => operation(input.cwd, 'Goal task enqueue failed', (deps) => enqueueTaktGoalTask(projectInput(input, deps), deps, extra.signal), false));
    server.registerTool('takt_requeue_goal_task', {
      title: 'Requeue stopped goal work', description: 'Resume the same failed or exceeded goal task from its saved stopping position, with an optional additional note. A failed task may instead restart from startStep; if the saved position cannot be used, the call fails with the reason and the accepted startStep values. Responses fit 64 KiB, with explicit truncation. Read task state with takt_list_tasks offset/limit and saved records with takt_list_goal_work_log offset/limit. Read record text with takt_get_goal path workLog.summary, recordId and textOffset/maxBytes.',
      inputSchema: requeueGoalTaskInputSchema,
    }, (input, extra) => operation(input.cwd, 'Goal task requeue failed', (deps) => requeueTaktGoalTask(projectInput(input, deps), deps, extra.signal), false));
    server.registerTool('takt_retry_goal_task', {
      title: 'Retry corrected goal work', description: 'Save corrected canonical instructions and return the same failed goal task to pending, optionally restarting from startStep. If the saved position cannot be used and startStep is omitted, the call fails with the reason and the accepted startStep values. Responses fit 64 KiB, with explicit truncation. Read task state with takt_list_tasks offset/limit and saved records with takt_list_goal_work_log offset/limit. Read record text with takt_get_goal path workLog.summary, recordId and textOffset/maxBytes.',
      inputSchema: retryGoalTaskInputSchema,
    }, (input, extra) => operation(input.cwd, 'Goal task retry failed', (deps) => retryTaktGoalTask(projectInput(input, deps), deps, extra.signal), false));
    server.registerTool('takt_merge_goal_task', {
      title: 'Merge reviewed goal work', description: 'Merge a task result into its saved goal branch after checking ownership and the reviewed SHA. Returns conflicts or checked-out worktree locations without moving the target. Responses fit 64 KiB, with explicit truncation. Read saved completion fields with takt_get_goal path and textOffset/maxBytes.',
      inputSchema: mergeGoalTaskInputSchema,
    }, (input, extra) => operation(input.cwd, 'Goal merge failed', (deps) => mergeTaktGoalTask(projectInput(input, deps), deps, extra.signal), true));
    server.registerTool('takt_remove_goal_task', {
      title: 'Remove goal work',
      description: 'Cancel pending goal work or clean up stopped or merged work with a required reason. Running and unmerged completed tasks are rejected. Responses fit 64 KiB, with explicit truncation. Read removal records with takt_list_goal_work_log offset/limit, and full reasons with takt_get_goal path workLog.summary, recordId and textOffset/maxBytes. Confirm task absence with takt_list_tasks offset/limit.',
      inputSchema: removeGoalTaskInputSchema,
    }, (input, extra) => operation(input.cwd, 'Goal task removal failed', (deps) => removeTaktGoalTask(projectInput(input, deps), deps, extra.signal), false));
    server.registerTool('takt_complete_goal', {
      title: 'Complete a reviewed goal', description: 'Apply repository manager.main_merge permission to the reviewed goal SHA and acceptance evidence. Auto merges or saves human merge instructions; conflicts keep the goal open. Responses fit 64 KiB, with explicit truncation. Read saved completion fields with takt_get_goal path and textOffset/maxBytes.',
      inputSchema: completeGoalInputSchema,
    }, (input, extra) => operation(input.cwd, 'Goal completion failed', (deps) => completeTaktGoal(projectInput(input, deps), deps, extra.signal), true));
    server.registerTool('takt_reopen_goal', {
      title: 'Reopen a waiting goal', description: 'Return an unmerged awaiting-merge goal to created with a required reason saved in its work log. Preserves completion evidence. Rejects completed, created, aborted or paused goals and approved SHAs already included in the target; use takt_check_goal_completion for an included SHA. Responses fit 64 KiB, with explicit truncation. Read saved reasons with takt_get_goal path workLog.summary, recordId and textOffset/maxBytes, and completion fields with path.',
      inputSchema: reopenGoalInputSchema,
    }, (input, extra) => operation(input.cwd, 'Goal reopen failed', (deps) => reopenTaktGoal(projectInput(input, deps), deps, extra.signal), true));
    server.registerTool('takt_check_goal_completion', {
      title: 'Check a human goal merge', description: 'Complete a waiting goal only when the saved approved SHA is included in its saved target branch. Responses fit 64 KiB, with explicit truncation. Read saved completion fields with takt_get_goal path and textOffset/maxBytes.',
      inputSchema: goalWriteInputSchema,
    }, (input, extra) => operation(input.cwd, 'Goal completion check failed', (deps) => checkTaktGoalCompletion(projectInput(input, deps), deps, extra.signal), true));
    server.registerTool('takt_get_goal_diff', {
      title: 'Read goal differences', description: 'Return bounded file counts and optionally a literal file patch, with explicit truncation. Compares task result against goal, or goal against integration target. Responses fit 64 KiB, with explicit truncation. Reduce limit or select file to retrieve omitted details.',
      inputSchema: goalDiffInputSchema,
    }, (input, extra) => operation(input.cwd, 'Goal diff failed', (deps) => getTaktGoalDiff(projectInput(input, deps), deps, extra.signal), false));
    server.registerTool('takt_get_goal_history', {
      title: 'Read goal history', description: 'Return bounded commit history for a goal or its task result, with explicit message and count truncation. Responses fit 64 KiB, with explicit truncation. Reduce limit or select taskName to narrow the history.',
      inputSchema: goalHistoryInputSchema,
    }, (input, extra) => operation(input.cwd, 'Goal history failed', (deps) => getTaktGoalHistory(projectInput(input, deps), deps, extra.signal), false));
    server.registerTool('takt_get_goal_relation', {
      title: 'Read goal containment', description: 'Return compared SHAs, containment in the integration target, and the number of goal commits ahead of that target. Responses fit 64 KiB, with explicit truncation. Read saved fields with takt_get_goal path.',
      inputSchema: goalWriteInputSchema,
    }, (input, extra) => operation(input.cwd, 'Goal relation failed', (deps) => getTaktGoalRelation(projectInput(input, deps), deps, extra.signal), false));
  }

  if (options.toolSet === 'all') {
    server.registerTool('takt_cleanup_tasks', {
      title: 'Clean up stopped tasks',
      description: 'Select stopped tasks by statuses, goalId or branch; at least one filter and a reason are required. Running tasks are excluded. Branch alone selects completed tasks. Without confirm true, return the selected tasks without deleting anything. With confirm true, use the same cleanup as the task list. Responses fit 64 KiB with explicit truncation.',
      inputSchema: cleanupTasksInputSchema,
    }, (input) => operation(input.cwd, 'Task cleanup failed', (deps) => cleanupTaktTasks(input, deps), false));
  }

  if (options.toolSet === undefined || options.toolSet === 'all') {
    server.registerTool(
      'takt_enqueue_task',
      {
        title: 'Enqueue TAKT task',
        description: 'Save a pending TAKT task into .takt/tasks.yaml. Optionally link an existing issue or create one. Explicit draftPr overrides project and global draft settings; omission preserves inheritance. Success returns saved worktree, autoPr, and draftPr (null when omitted). Run queued tasks with `takt run` or monitor continuously with `takt watch`. Responses fit 64 KiB, with explicit truncation. Read saved task state with takt_list_tasks offset/limit.',
        inputSchema: enqueueTaskInputSchema,
      },
      (input, extra) => operation(input.cwd, 'Task enqueue failed', (deps) => enqueueTaktTask(projectInput(input, deps), deps, extra.signal)),
    );
  }

  server.registerTool(
    TAKT_MCP_READ_ONLY_TOOL_NAMES[2],
    {
      title: 'List TAKT goals',
      description: 'Read goals saved in .takt/goals/. Invalid saved records return individual errors alongside healthy goals. Path, access, and traversal identity failures remain whole-tool errors. Responses fit 64 KiB, with explicit truncation. Use offset for healthy goals and errorOffset for errors, both defaulting to 0. Optional limit (1-50, default 50) bounds each collection. Pass nextOffset as offset and errorPage.nextOffset as errorOffset for continuation, or use takt_get_goal for one healthy goal.',
      inputSchema: listGoalsInputSchema,
    },
    (input) => operation(input.cwd, 'Goal list failed', (deps) => listTaktGoals(projectInput(input, deps), deps)),
  );

  server.registerTool(
    TAKT_MCP_READ_ONLY_TOOL_NAMES[3],
    {
      title: 'Get a TAKT goal',
      description: 'Read goal state, completion, pending questions and recent work. Select saved fields with path, optionally recordId, offset/limit or textOffset/maxBytes to retrieve omitted content. Responses fit 64 KiB, with explicit truncation.',
      inputSchema: getGoalInputSchema,
    },
    (input) => operation(input.cwd, 'Goal read failed', (deps) => getTaktGoal(projectInput(input, deps), deps)),
  );

  server.registerTool(
    TAKT_MCP_READ_ONLY_TOOL_NAMES[0],
    {
      title: 'List TAKT tasks',
      description: `Read a compact summary of project tasks and their run state. Individual worktree or run failures return that task's available basic information with an error while preserving the other tasks. Invalid worktree references are not read. Queue or cwd access failures remain whole-tool errors. Logs and report contents are not loaded. Responses fit 64 KiB, with explicit truncation. Use offset/limit for continuation. Optional view workspace is manager only. ${workspaceRetrieval}`,
      inputSchema: listTasksInputSchema,
    },
    (input) => input.view === 'workspace' ? workspaceOperation(async () => {
      if (options.toolSet !== 'manager') throw new Error('Workspace view is only available to managers');
      const assignment = await currentAssignment();
      if (assignment.kind !== 'workspace') throw new Error('Manager does not belong to a workspace');
      return { id: assignment.workspaceId, name: assignment.name, repositoryDirectories: assignment.repositoryDirectories };
    }, input) : operation(input.cwd, 'Task list failed', (deps) => listTaktTasks(projectInput(input, deps), deps)),
  );

  server.registerTool(
    TAKT_MCP_READ_ONLY_TOOL_NAMES[1],
    {
      title: 'Get TAKT run details',
      description: 'Read run metadata and body-free step/report lists with offset/limit. Task text is omitted by default. Use view task with offset/maxBytes for forward UTF-8 task text; pass task.nextOffset as offset to continue. Use view log and optional stepIndex (default last) for a log tail, or view report and report filename for one report. Use view instructions with offset/limit (1-50) to list saved instructions, then instructionId and offset/maxBytes for their forward UTF-8 text. Text uses offset/maxBytes; log offset counts backwards from the end. Follow nextOffset to retrieve omitted content. Responses fit 64 KiB, with explicit truncation.',
      inputSchema: getRunInputSchema,
    },
    (input) => operation(input.cwd, 'Run read failed', (deps) => getTaktRun(projectInput(input, deps), deps)),
  );

  if (options.toolSet === undefined || options.toolSet === 'all') {
    server.registerTool(
      'takt_tell_run',
      {
        title: 'Send an instruction to a running TAKT task',
        description: 'Append an additional instruction to a running worktree-clone run after rechecking its identity and status. Responses fit 64 KiB, with explicit truncation. Read task state with takt_list_tasks offset/limit, and run state with takt_get_run and runSlug. Read saved instructions with takt_get_run, runSlug and view instructions using offset/limit (1-50), or select instructionId and offset/maxBytes for forward UTF-8 text. Follow nextOffset for continuation.',
        inputSchema: tellRunInputSchema,
      },
      (input) => operation(input.cwd, 'Run tell failed', (deps) => tellTaktRun(projectInput(input, deps), deps)),
    );
  }

  return server;
}

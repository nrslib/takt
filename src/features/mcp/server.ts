import * as fs from 'node:fs';
import * as process from 'node:process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { packageVersion } from '../../shared/package-info.js';
import {
  createGoalInputSchema,
  listGoalsInputSchema,
  getGoalInputSchema,
  enqueueTaskInputSchema,
  getRunInputSchema,
  listTasksInputSchema,
  tellRunInputSchema,
  enqueueGoalTaskInputSchema,
  recordGoalDecisionInputSchema,
} from './schemas.js';
import {
  createTaktGoal,
  listTaktGoals,
  getTaktGoal,
  enqueueTaktTask,
  getTaktRun,
  listTaktTasks,
  tellTaktRun,
  type McpOperationDependencies,
} from './operations.js';
import { enqueueTaktGoalTask, listTaktWorkflows, recordTaktGoalDecision } from './goalOperations.js';
import { assertCwdAllowedByMcpRoot, errorResult } from './operations.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createLogger } from '../../shared/utils/debug.js';
import { getErrorMessage } from '../../shared/utils/error.js';
import { sanitizeSensitiveText } from '../../shared/utils/sensitiveText.js';

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
  'takt_create_goal', ...TAKT_MCP_READ_ONLY_TOOL_NAMES,
  'takt_enqueue_goal_task', 'takt_list_workflows', 'takt_record_goal_decision',
] as const;

export interface TaktMcpServerOptions {
  goalTurnOwners?: import('../../infra/goals/turn-lock.js').GoalTurnOwners;
  goalConfirmationPublicKey?: string;
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
    goalConfirmationPublicKey: options.goalConfirmationPublicKey,
    allowedProjectRoot: fs.realpathSync(options.allowedProjectRoot ?? process.cwd()),
    includeReferenceMarkers: options.includeReferenceMarkers,
    goalTurnOwners: options.goalTurnOwners ?? deps.goalTurnOwners,
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
  const operation = async (cwd: string, errorContext: string, action: () => CallToolResult | Promise<CallToolResult>): Promise<CallToolResult> => {
    try {
      assertCwdAllowedByMcpRoot(cwd, operationDeps.allowedProjectRoot);
      if (operationDeps.readOnly !== true && operationDeps.goalTurnOwners === undefined) {
        await startManagerEventRecovery(cwd);
      }
      try { return await action(); }
      finally {
        if (operationDeps.readOnly !== true && operationDeps.goalTurnOwners === undefined) {
          await startManagerEventRecovery(cwd);
          const { ensureManagerRun } = await import('../manager/autoRun.js');
          await ensureManagerRun(cwd);
        }
      }
    } catch (error) { return errorResult(errorContext, error); }
  };
  const server = new McpServer({
    name: 'takt',
    version: packageVersion,
  });
  if (options.toolSet !== 'read-only') server.registerTool('takt_list_workflows', {
    title: 'List workflows', description: 'Read workflow names and descriptions.', inputSchema: listGoalsInputSchema,
  }, (input) => operation(input.cwd, 'Workflow list failed', () => listTaktWorkflows(input, operationDeps)));
  if (options.toolSet !== 'read-only') {
    server.registerTool('takt_enqueue_goal_task', {
      title: 'Enqueue goal work', description: 'Enqueue ready work locally from the goal branch. Instructions must be self-contained and must not request merging.',
      inputSchema: enqueueGoalTaskInputSchema,
    }, (input, extra) => operation(input.cwd, 'Goal task enqueue failed', () => enqueueTaktGoalTask(input, operationDeps, extra.signal)));
    server.registerTool('takt_record_goal_decision', {
      title: 'Record a goal decision', description: 'Record integration or completion reasoning without applying Git operations or completing the goal.',
      inputSchema: recordGoalDecisionInputSchema,
    }, (input) => operation(input.cwd, 'Goal decision failed', () => recordTaktGoalDecision(input, operationDeps)));
  }

  if (options.toolSet !== 'read-only') {
    server.registerTool(
      'takt_create_goal',
      {
        title: 'Create a local TAKT goal',
        description: 'Register a goal and create its local Git branch. Requires a human-reviewed summary signed with the host trusted Ed25519 key.',
        inputSchema: createGoalInputSchema,
      },
      (input) => operation(input.cwd, 'Goal creation failed', () => createTaktGoal(input, operationDeps)),
    );
  }
  if (options.toolSet === undefined || options.toolSet === 'all') {
    server.registerTool(
      'takt_enqueue_task',
      {
        title: 'Enqueue TAKT task',
        description: 'Save a pending TAKT task into .takt/tasks.yaml. Optionally link an existing issue or create one. Explicit draftPr overrides project and global draft settings; omission preserves inheritance. Success returns saved worktree, autoPr, and draftPr (null when omitted). Run queued tasks with `takt run` or monitor continuously with `takt watch`.',
        inputSchema: enqueueTaskInputSchema,
      },
      (input, extra) => operation(input.cwd, 'Task enqueue failed', () => enqueueTaktTask(input, operationDeps, extra.signal)),
    );
  }

  server.registerTool(
    TAKT_MCP_READ_ONLY_TOOL_NAMES[2],
    {
      title: 'List TAKT goals',
      description: 'Read goals saved in .takt/goals/. Invalid saved records return individual errors alongside healthy goals. Path, access, and traversal identity failures remain whole-tool errors.',
      inputSchema: listGoalsInputSchema,
    },
    (input) => operation(input.cwd, 'Goal list failed', () => listTaktGoals(input, operationDeps)),
  );

  server.registerTool(
    TAKT_MCP_READ_ONLY_TOOL_NAMES[3],
    {
      title: 'Get a TAKT goal',
      description: 'Read all saved information for the specified goal ID.',
      inputSchema: getGoalInputSchema,
    },
    (input) => operation(input.cwd, 'Goal read failed', () => getTaktGoal(input, operationDeps)),
  );

  server.registerTool(
    TAKT_MCP_READ_ONLY_TOOL_NAMES[0],
    {
      title: 'List TAKT tasks',
      description: 'Read a compact summary of project tasks and their run state. Individual worktree or run failures return that task\'s available basic information with an error while preserving the other tasks. Invalid worktree references are not read. Queue or cwd access failures remain whole-tool errors. Logs and report contents are not loaded.',
      inputSchema: listTasksInputSchema,
    },
    (input) => operation(input.cwd, 'Task list failed', () => listTaktTasks(input, operationDeps)),
  );

  server.registerTool(
    TAKT_MCP_READ_ONLY_TOOL_NAMES[1],
    {
      title: 'Get TAKT run details',
      description: 'Read the selected run current step, phase, step logs, reports, and live intervention delivery state.',
      inputSchema: getRunInputSchema,
    },
    (input) => operation(input.cwd, 'Run read failed', () => getTaktRun(input, operationDeps)),
  );

  if (options.toolSet === undefined || options.toolSet === 'all') {
    server.registerTool(
      'takt_tell_run',
      {
        title: 'Send an instruction to a running TAKT task',
        description: 'Append an additional instruction to a running worktree-clone run after rechecking its identity and status.',
        inputSchema: tellRunInputSchema,
      },
      (input) => operation(input.cwd, 'Run tell failed', () => tellTaktRun(input, operationDeps)),
    );
  }

  return server;
}

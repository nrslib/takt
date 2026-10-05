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

export type TaktMcpToolSet = 'all' | 'read-only';

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

export interface TaktMcpServerOptions {
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
  };
}

export function createTaktMcpServer(
  deps: McpOperationDependencies = {},
  options: TaktMcpServerOptions = {},
): McpServer {
  const operationDeps = buildMcpOperationDependencies(deps, options);
  const server = new McpServer({
    name: 'takt',
    version: packageVersion,
  });

  if (options.toolSet !== 'read-only') {
    server.registerTool(
      'takt_create_goal',
      {
        title: 'Create a local TAKT goal',
        description: 'Register a goal and create its local Git branch. Requires a human-reviewed summary signed with the host trusted Ed25519 key.',
        inputSchema: createGoalInputSchema,
      },
      (input) => createTaktGoal(input, operationDeps),
    );
    server.registerTool(
      'takt_enqueue_task',
      {
        title: 'Enqueue TAKT task',
        description: 'Save a pending TAKT task into .takt/tasks.yaml. Optionally link an existing issue or create one. Explicit draftPr overrides project and global draft settings; omission preserves inheritance. Success returns saved worktree, autoPr, and draftPr (null when omitted). Run queued tasks with `takt run` or monitor continuously with `takt watch`.',
        inputSchema: enqueueTaskInputSchema,
      },
      (input, extra) => enqueueTaktTask(input, operationDeps, extra.signal),
    );
  }

  server.registerTool(
    TAKT_MCP_READ_ONLY_TOOL_NAMES[2],
    {
      title: 'List TAKT goals',
      description: 'Read goals saved in .takt/goals/. Invalid saved records return individual errors alongside healthy goals. Path, access, and traversal identity failures remain whole-tool errors.',
      inputSchema: listGoalsInputSchema,
    },
    (input) => listTaktGoals(input, operationDeps),
  );

  server.registerTool(
    TAKT_MCP_READ_ONLY_TOOL_NAMES[3],
    {
      title: 'Get a TAKT goal',
      description: 'Read all saved information for the specified goal ID.',
      inputSchema: getGoalInputSchema,
    },
    (input) => getTaktGoal(input, operationDeps),
  );

  server.registerTool(
    TAKT_MCP_READ_ONLY_TOOL_NAMES[0],
    {
      title: 'List TAKT tasks',
      description: 'Read a compact summary of project tasks and their run state. Individual worktree or run failures return that task\'s available basic information with an error while preserving the other tasks. Invalid worktree references are not read. Queue or cwd access failures remain whole-tool errors. Logs and report contents are not loaded.',
      inputSchema: listTasksInputSchema,
    },
    (input) => listTaktTasks(input, operationDeps),
  );

  server.registerTool(
    TAKT_MCP_READ_ONLY_TOOL_NAMES[1],
    {
      title: 'Get TAKT run details',
      description: 'Read the selected run current step, phase, step logs, reports, and live intervention delivery state.',
      inputSchema: getRunInputSchema,
    },
    (input) => getTaktRun(input, operationDeps),
  );

  if (options.toolSet !== 'read-only') {
    server.registerTool(
      'takt_tell_run',
      {
        title: 'Send an instruction to a running TAKT task',
        description: 'Append an additional instruction to a running worktree-clone run after rechecking its identity and status.',
        inputSchema: tellRunInputSchema,
      },
      (input) => tellTaktRun(input, operationDeps),
    );
  }

  return server;
}

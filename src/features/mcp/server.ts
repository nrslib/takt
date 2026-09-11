import * as fs from 'node:fs';
import * as process from 'node:process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { packageVersion } from '../../shared/package-info.js';
import {
  enqueueTaskInputSchema,
  getRunInputSchema,
  listTasksInputSchema,
  tellRunInputSchema,
} from './schemas.js';
import {
  enqueueTaktTask,
  getTaktRun,
  listTaktTasks,
  tellTaktRun,
  type McpOperationDependencies,
} from './operations.js';

export type TaktMcpToolSet = 'all' | 'read-only';

export interface TaktMcpServerOptions {
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
      'takt_enqueue_task',
      {
        title: 'Enqueue TAKT task',
        description: 'Save a pending TAKT task into .takt/tasks.yaml. Optionally link an existing issue or create one. Run queued tasks with `takt run` or monitor continuously with `takt watch`.',
        inputSchema: enqueueTaskInputSchema,
      },
      (input, extra) => enqueueTaktTask(input, operationDeps, extra.signal),
    );
  }

  server.registerTool(
    'takt_list_tasks',
    {
      title: 'List TAKT tasks',
      description: 'Read a compact summary of project tasks and their run state. Logs and report contents are not loaded.',
      inputSchema: listTasksInputSchema,
    },
    (input) => listTaktTasks(input, operationDeps),
  );

  server.registerTool(
    'takt_get_run',
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

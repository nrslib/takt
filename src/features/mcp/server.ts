import * as fs from 'node:fs';
import * as process from 'node:process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { packageVersion } from '../../shared/package-info.js';
import { enqueueTaskInputSchema } from './schemas.js';
import {
  enqueueTaktTask,
  type McpOperationDependencies,
} from './operations.js';

export interface TaktMcpServerOptions {
  allowedProjectRoot?: string;
}

function buildMcpOperationDependencies(
  deps: McpOperationDependencies,
  options: TaktMcpServerOptions,
): McpOperationDependencies {
  return {
    ...deps,
    allowedProjectRoot: fs.realpathSync(options.allowedProjectRoot ?? process.cwd()),
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

  server.registerTool(
    'takt_enqueue_task',
    {
      title: 'Enqueue TAKT task',
      description: 'Save a pending TAKT task into .takt/tasks.yaml. Optionally link an existing issue or create one. Run queued tasks with `takt run` or monitor continuously with `takt watch`.',
      inputSchema: enqueueTaskInputSchema,
    },
    (input, extra) => enqueueTaktTask(input, operationDeps, extra.signal),
  );

  return server;
}

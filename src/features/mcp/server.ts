import * as fs from 'node:fs';
import * as process from 'node:process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { packageVersion } from '../../shared/package-info.js';
import {
  createIssueAndEnqueueTaskInputSchema,
  enqueueTaskInputSchema,
  runNextTaskInputSchema,
} from './schemas.js';
import {
  createIssueAndEnqueueTaktTask,
  enqueueTaktTask,
  runNextTaktTask,
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
      description: 'Save a pending TAKT task into .takt/tasks.yaml.',
      inputSchema: enqueueTaskInputSchema,
    },
    (input) => enqueueTaktTask(input, operationDeps),
  );

  server.registerTool(
    'takt_create_issue_and_enqueue_task',
    {
      title: 'Create issue and enqueue TAKT task',
      description: 'Create an issue with the configured issue provider, then save a pending TAKT task with the issue number.',
      inputSchema: createIssueAndEnqueueTaskInputSchema,
    },
    (input) => createIssueAndEnqueueTaktTask(input, operationDeps),
  );

  server.registerTool(
    'takt_run_next_task',
    {
      title: 'Run next TAKT task',
      description: 'Claim and execute the next pending TAKT task.',
      inputSchema: runNextTaskInputSchema,
    },
    (input) => runNextTaktTask(input, operationDeps),
  );

  return server;
}

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

export function createTaktMcpServer(deps: McpOperationDependencies = {}): McpServer {
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
    (input) => enqueueTaktTask(input, deps),
  );

  server.registerTool(
    'takt_create_issue_and_enqueue_task',
    {
      title: 'Create issue and enqueue TAKT task',
      description: 'Create an issue with the configured issue provider, then save a pending TAKT task with the issue number.',
      inputSchema: createIssueAndEnqueueTaskInputSchema,
    },
    (input) => createIssueAndEnqueueTaktTask(input, deps),
  );

  server.registerTool(
    'takt_run_next_task',
    {
      title: 'Run next TAKT task',
      description: 'Claim and execute the next pending TAKT task.',
      inputSchema: runNextTaskInputSchema,
    },
    (input) => runNextTaktTask(input, deps),
  );

  return server;
}

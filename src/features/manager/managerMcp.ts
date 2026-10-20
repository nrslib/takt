import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpServerConfig } from '../../core/models/index.js';
import { packageVersion } from '../../shared/package-info.js';
import { buildChildProcessEnv } from '../../shared/utils/child-process-env.js';
import { getSlackWebhookUrl, WEBHOOK_ENV_KEY } from '../../shared/utils/slackWebhook.js';

import { MANAGER_ASSIGNMENT_ENV, type ManagerAssignmentIdentity } from './assignment.js';
import { startManagerMcpConnection } from './managerMcpConnection.js';

export const TAKT_MANAGER_MCP_SERVER_NAME = 'takt_mgr_9f92c6ea76364b51a45846a08ee7ad09';

interface ManagerMcpOptions {
  enableGoalExecutionTools: boolean;
}

export async function prepareManagerMcp(assignment?: ManagerAssignmentIdentity) {
  const moduleUrl = new URL('../../app/mcp/index.js', import.meta.url);
  const builtPath = fileURLToPath(moduleUrl);
  const entryArgs = existsSync(builtPath)
    ? [builtPath]
    : ['--import', createRequire(import.meta.url).resolve('tsx/esm'), fileURLToPath(new URL('../../app/mcp/index.ts', import.meta.url))];
  const args = [...entryArgs, '--tool-set', 'manager'];
  const configDir = buildChildProcessEnv().TAKT_CONFIG_DIR;
  const webhook = getSlackWebhookUrl();
  const env: Record<string, string> = {
    ...(configDir === undefined ? {} : { TAKT_CONFIG_DIR: configDir }),
    ...(webhook === undefined ? {} : { [WEBHOOK_ENV_KEY]: webhook }),
    ...(assignment === undefined ? {} : { [MANAGER_ASSIGNMENT_ENV]: JSON.stringify(assignment) }),
  };
  const servers: Record<string, McpServerConfig> = { [TAKT_MANAGER_MCP_SERVER_NAME]: { type: 'stdio', command: process.execPath, args, env } };
  return { command: process.execPath, args, env, servers };
}

export async function connectManagerMcp(
  cwd: string,
  assignment?: ManagerAssignmentIdentity,
  userServers?: Record<string, McpServerConfig>,
  options?: ManagerMcpOptions,
) {
  const connection = options?.enableGoalExecutionTools === true ? await startManagerMcpConnection(cwd, assignment) : undefined;
  let client: Client | undefined;
  let transport: StdioClientTransport | StreamableHTTPClientTransport | undefined;
  const dispose = async (): Promise<void> => {
    connection?.invalidate();
    try { await client?.close(); }
    finally {
      try { await transport?.close(); }
      finally { await connection?.dispose(); }
    }
  };
  try {
    client = new Client({ name: 'takt-manager', version: packageVersion });
    let servers: Record<string, McpServerConfig>;
    if (connection === undefined) {
      const prepared = await prepareManagerMcp(assignment);
      servers = prepared.servers;
      transport = new StdioClientTransport({ command: prepared.command, args: prepared.args, env: prepared.env, cwd, stderr: 'pipe' });
    } else {
      servers = { [TAKT_MANAGER_MCP_SERVER_NAME]: connection.config };
      transport = new StreamableHTTPClientTransport(new URL(connection.config.url), { requestInit: { headers: connection.config.headers } });
    }
    await client.connect(transport);
    return { client, servers: { ...userServers, ...servers }, dispose };
  } catch (error) {
    try { await dispose(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Manager MCP startup and cleanup failed'); }
    throw error;
  }
}

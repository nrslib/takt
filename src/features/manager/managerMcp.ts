import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { McpServerConfig } from '../../core/models/index.js';
import { packageVersion } from '../../shared/package-info.js';
import { buildChildProcessEnv } from '../../shared/utils/child-process-env.js';
import { GOAL_TURN_OWNERS_ENV, type GoalTurnOwners } from '../../infra/goals/turn-lock.js';
import { getSlackWebhookUrl, WEBHOOK_ENV_KEY } from '../../shared/utils/slackWebhook.js';
import { GOAL_EVENT_CONTEXT_ENV, type GoalEventContext } from '../../infra/goals/operations.js';

import { MANAGER_ASSIGNMENT_ENV, type ManagerAssignmentIdentity } from './assignment.js';

export const TAKT_MANAGER_MCP_SERVER_NAME = 'takt_mgr_9f92c6ea76364b51a45846a08ee7ad09';

export async function prepareManagerMcp(owners?: GoalTurnOwners, context?: GoalEventContext, assignment?: ManagerAssignmentIdentity) {
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
    ...(owners === undefined ? {} : { [GOAL_TURN_OWNERS_ENV]: JSON.stringify(owners) }),
    ...(assignment === undefined ? {} : { [MANAGER_ASSIGNMENT_ENV]: JSON.stringify(assignment) }),
    ...(context === undefined ? {} : { [GOAL_EVENT_CONTEXT_ENV]: JSON.stringify(context) }),
  };
  const servers: Record<string, McpServerConfig> = { [TAKT_MANAGER_MCP_SERVER_NAME]: { type: 'stdio', command: process.execPath, args, env } };
  return { command: process.execPath, args, env, servers };
}

export async function connectManagerMcp(cwd: string, owners?: GoalTurnOwners, context?: GoalEventContext, assignment?: ManagerAssignmentIdentity) {
  const prepared = await prepareManagerMcp(owners, context, assignment);
  const client = new Client({ name: 'takt-manager', version: packageVersion });
  const transport = new StdioClientTransport({
    command: prepared.command, args: prepared.args, env: prepared.env, cwd, stderr: 'pipe',
  });
  const dispose = async (): Promise<void> => {
    try { await client.close(); }
    finally { await transport.close(); }
  };
  try {
    await client.connect(transport);
    return { client, servers: prepared.servers, dispose };
  } catch (error) {
    try { await dispose(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Manager MCP startup and cleanup failed'); }
    throw error;
  }
}

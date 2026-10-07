import { existsSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { McpServerConfig } from '../../core/models/index.js';
import { packageVersion } from '../../shared/package-info.js';
import { buildChildProcessEnv } from '../../shared/utils/child-process-env.js';
import { GOAL_TURN_OWNERS_ENV, type GoalTurnOwners } from '../../infra/goals/turn-lock.js';

export const TAKT_MANAGER_MCP_SERVER_NAME = 'takt_mgr_9f92c6ea76364b51a45846a08ee7ad09';

export async function prepareManagerMcp(publicKey: string, owners?: GoalTurnOwners) {
  const directory = await mkdtemp(join(tmpdir(), 'takt-manager-'));
  const dispose = () => rm(directory, { recursive: true, force: true });
  try {
    const keyPath = join(directory, 'confirmation-public.pem');
    await writeFile(keyPath, publicKey, { mode: 0o600 });
    const moduleUrl = new URL('../../app/mcp/index.js', import.meta.url);
    const builtPath = fileURLToPath(moduleUrl);
    const entryArgs = existsSync(builtPath)
      ? [builtPath]
      : ['--import', createRequire(import.meta.url).resolve('tsx/esm'), fileURLToPath(new URL('../../app/mcp/index.ts', import.meta.url))];
    const args = [...entryArgs, '--tool-set', 'manager', '--goal-confirmation-public-key', keyPath];
    const configDir = buildChildProcessEnv().TAKT_CONFIG_DIR;
    const env: Record<string, string> = {
      ...(configDir === undefined ? {} : { TAKT_CONFIG_DIR: configDir }),
      ...(owners === undefined ? {} : { [GOAL_TURN_OWNERS_ENV]: JSON.stringify(owners) }),
    };
    const servers: Record<string, McpServerConfig> = { [TAKT_MANAGER_MCP_SERVER_NAME]: { type: 'stdio', command: process.execPath, args, env } };
    return { command: process.execPath, args, env, servers, dispose };
  } catch (error) {
    try { await dispose(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Manager MCP startup and cleanup failed'); }
    throw error;
  }
}

export async function connectManagerMcp(cwd: string, publicKey: string, owners?: GoalTurnOwners) {
  const prepared = await prepareManagerMcp(publicKey, owners);
  const client = new Client({ name: 'takt-manager', version: packageVersion });
  const transport = new StdioClientTransport({
    command: prepared.command, args: prepared.args, env: prepared.env, cwd, stderr: 'pipe',
  });
  const dispose = async (): Promise<void> => {
    try { await client.close(); }
    finally {
      try { await transport.close(); }
      finally { await prepared.dispose(); }
    }
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

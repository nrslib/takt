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

export async function connectManagerMcp(cwd: string, publicKey: string) {
  const directory = await mkdtemp(join(tmpdir(), 'takt-manager-'));
  const client = new Client({ name: 'takt-manager', version: packageVersion });
  let transport: StdioClientTransport | undefined;
  const dispose = async (): Promise<void> => {
    try { await client.close(); }
    finally {
      try { await transport?.close(); }
      finally { await rm(directory, { recursive: true, force: true }); }
    }
  };
  try {
    const keyPath = join(directory, 'confirmation-public.pem');
    await writeFile(keyPath, publicKey, { mode: 0o600 });
    const moduleUrl = new URL('../../app/mcp/index.js', import.meta.url);
    const builtPath = fileURLToPath(moduleUrl);
    const entryArgs = existsSync(builtPath)
      ? [builtPath]
      : ['--import', createRequire(import.meta.url).resolve('tsx/esm'), fileURLToPath(new URL('../../app/mcp/index.ts', import.meta.url))];
    const args = [...entryArgs, '--tool-set', 'manager', '--goal-confirmation-public-key', keyPath];
    const servers: Record<string, McpServerConfig> = { takt: { type: 'stdio', command: process.execPath, args } };
    transport = new StdioClientTransport({ command: process.execPath, args, cwd, stderr: 'pipe' });
    await client.connect(transport);
    return { client, servers, dispose };
  } catch (error) {
    try { await dispose(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Manager MCP startup and cleanup failed'); }
    throw error;
  }
}

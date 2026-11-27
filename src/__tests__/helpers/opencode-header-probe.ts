import { execFileSync, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { OpencodeClient } from '@opencode-ai/sdk/v2';
import { OpenCode } from '@opencode/client';
import { vi } from 'vitest';
import { resolveRuntimeEnvironment } from '../../infra/config/runtime-provider/provider-environment.js';
import { resolveMcpAssignment } from '../../infra/config/runtime-provider/mcp-assignment.js';
import { createOpenCodeMcpAdapter } from '../../infra/providers/mcp/opencode.js';
import { installManagedSdk } from '../../infra/managed-providers/package.js';
import { acquireOpenCodeClient, resetSharedServerPool } from '../../../dist/infra/opencode/server-pool.js';
import * as spawnModule from '../../../dist/shared/utils/spawn.js';

export async function probeOpenCodeHeaders(executable: string, generation: 'v1' | 'v2', tenantSource: 'fixed' | 'legacy') {
  const command = resolve(executable);
  const version = execFileSync(command, ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim();
  const temp = resolve('.tmp');
  await mkdir(temp, { recursive: true });
  const root = await mkdtemp(join(temp, 'opencode-header-'));
  const originalEnv = process.env;
  const children: ChildProcess[] = [];
  const nativeClients: ReturnType<typeof OpenCode.make>[] = [];
  const startups: { content: string; args: readonly string[]; output: string }[] = [];
  const received: IncomingHttpHeaders[] = [];
  const mcp = createServer(async (request, response) => {
    if (request.method !== 'POST') { response.writeHead(405).end(); return; }
    received.push(request.headers);
    let body = '';
    for await (const chunk of request) body += String(chunk);
    const rpc = JSON.parse(body) as { id?: number; method?: string; params?: { protocolVersion?: string } };
    if (rpc.id === undefined) { response.writeHead(202).end(); return; }
    const result = rpc.method === 'initialize'
      ? { protocolVersion: rpc.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'probe', version: '1' } }
      : { tools: [] };
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
  });
  const spawn = spawnModule.crossSpawn;
  const spy = vi.spyOn(spawnModule, 'crossSpawn').mockImplementation((...args) => {
    const child = spawn(...args);
    children.push(child);
    const startup = { content: String(args[2].env?.OPENCODE_CONFIG_CONTENT), args: args[1], output: '' };
    startups.push(startup);
    if (generation === 'v2') {
      const port = args[1].find((arg) => arg.startsWith('--port='))?.slice('--port='.length);
      const password = args[2].env?.OPENCODE_PASSWORD;
      if (port === undefined || password === undefined) throw new Error('Missing OpenCode pool connection');
      nativeClients.push(OpenCode.make({ baseUrl: `http://127.0.0.1:${port}`,
        headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` } }));
    }
    child.stdout?.on('data', (chunk) => { startup.output += String(chunk); });
    child.stderr?.on('data', (chunk) => { startup.output += String(chunk); });
    return child;
  });
  try {
    process.env = {
      ...(originalEnv.PATH === undefined ? {} : { PATH: originalEnv.PATH }),
      HOME: root, XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, XDG_CACHE_HOME: root,
      TAKT_CONFIG_DIR: join(root, 'takt'), TAKT_OPENCODE_VERSION: generation, TAKT_OPENCODE_PATH: command,
      OPENCODE_DISABLE_AUTOUPDATE: 'true', OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_CONFIG_PROJECT_DISABLE: '1',
      MCP_HEADER_ACCESS: 'synthetic-access-fragment.signature-fragment', MCP_HEADER_KEY: 'synthetic-key-fragment',
    };
    await installManagedSdk('opencode', {});
    await new Promise<void>((done) => mcp.listen(0, '127.0.0.1', done));
    const address = mcp.address();
    if (address === null || typeof address === 'string') throw new Error('Missing MCP address');
    const observations = [];
    let previousClient;
    for (const [project, tenant, reverse] of [['a', 'tenant-a', false], ['same-a', 'tenant-a', true], ['b', 'tenant-b', false]] as const) {
      const cwd = join(root, project);
      await mkdir(join(cwd, '.takt'), { recursive: true });
      const headers = {
        Authorization: 'Bearer ${env:MCP_HEADER_ACCESS}', 'X-Key': '${env:MCP_HEADER_KEY}',
        'X-Tenant': tenantSource === 'fixed' ? tenant : '${TENANT}',
      };
      await writeFile(join(cwd, '.takt/runtime.yaml'), JSON.stringify({ version: 1, mcp: {
        servers: { probe: { type: 'http', url: `http://127.0.0.1:${address.port}/mcp`,
          headers: reverse ? Object.fromEntries(Object.entries(headers).reverse()) : headers } },
        defaults: { servers: ['probe'] },
      } }));
      process.env.TENANT = tenant;
      const environment = resolveRuntimeEnvironment({ projectCwd: cwd, legacy: {
        provider: undefined, providerSource: 'default', model: undefined, modelSource: 'default',
        personaProviders: undefined, providerRouting: undefined, autoRouting: undefined, providerOptions: undefined,
      }, legacySignals: [] });
      const section = environment.providerEnvironment.mcpAssignment;
      if (section === undefined) throw new Error('Missing project MCP assignment');
      const servers = resolveMcpAssignment(section, {
        persona: 'coder', tags: [], stepQualifiedName: 'default/implement',
        isWorkflowCallNode: false, isInternalAgent: false,
      });
      const prepared = await createOpenCodeMcpAdapter().prepare(servers, { cwd });
      try {
        const acquired = await acquireOpenCodeClient(undefined, undefined, undefined, undefined, undefined, prepared);
        try {
          const start = received.length;
          const session = await acquired.client.session.create({ directory: cwd }, { signal: AbortSignal.timeout(10_000) });
          if (session.data?.id === undefined) throw new Error('OpenCode did not create a session');
          const deadline = Date.now() + 10_000;
          let connected = false;
          do {
            if (generation === 'v1') {
              const native = acquired.client as unknown as Pick<OpencodeClient, 'mcp'>;
              const status = await native.mcp.status({ directory: cwd }, { signal: AbortSignal.timeout(10_000) });
              connected = status.data?.probe?.status === 'connected';
            } else {
              const status = await nativeClients.at(-1)!.mcp.list({ location: { directory: cwd } }, { signal: AbortSignal.timeout(10_000) });
              connected = status.data.some((entry) => entry.name === 'probe' && entry.status.status === 'connected');
            }
            if (!connected) await delay(50);
          } while (!connected && Date.now() < deadline);
          observations.push({ tenant, connected, reused: previousClient === acquired.client,
            headers: received.slice(start), identity: prepared.identity });
          previousClient = acquired.client;
        } finally { acquired.release(); }
      } finally { await prepared.dispose(); }
    }
    return { version, observations, startups };
  } finally {
    const closed = children.map((child) => child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve() : new Promise<void>((done) => child.once('exit', () => done())));
    resetSharedServerPool();
    try { await Promise.all(closed); }
    finally {
      spy.mockRestore();
      process.env = originalEnv;
      mcp.closeAllConnections();
      await new Promise<void>((done) => mcp.close(() => done()));
      await rm(root, { recursive: true, force: true });
    }
  }
}

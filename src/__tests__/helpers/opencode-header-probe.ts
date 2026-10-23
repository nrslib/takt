import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { OpenCode } from '@opencode/client';
import { interpolateMcpEnv } from '../../infra/config/runtime-provider/mcp-schema.js';
import { createOpenCodeMcpAdapter } from '../../infra/providers/mcp/opencode.js';
import { buildV2ServerConfig } from '../../infra/opencode/v2-config.js';

export async function probeOpenCodeHeaders(executable: string, generation: 'v1' | 'v2') {
  const command = resolve(executable);
  const version = execFileSync(command, ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim();
  const root = await mkdtemp(join(tmpdir(), 'takt-opencode-header-'));
  let received = false;
  const mcp = createServer(async (request, response) => {
    received ||= request.headers.authorization === 'Bearer synthetic-access-fragment.signature-fragment'
      && request.headers['x-key'] === 'synthetic-key-fragment';
    if (request.method !== 'POST') { response.writeHead(405).end(); return; }
    let body = '';
    for await (const chunk of request) body += String(chunk);
    const rpc = JSON.parse(body) as { id?: number; method?: string; params?: { protocolVersion?: string } };
    if (rpc.id === undefined) { response.writeHead(202).end(); return; }
    const result = rpc.method === 'initialize'
      ? { protocolVersion: rpc.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'probe', version: '1' } }
      : { tools: [] };
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
  });
  try {
    await new Promise<void>((done) => mcp.listen(0, '127.0.0.1', done));
    const address = mcp.address();
    if (address === null || typeof address === 'string') throw new Error('Missing MCP address');
    const secrets = { MCP_HEADER_ACCESS: 'synthetic-access-fragment.signature-fragment', MCP_HEADER_KEY: 'synthetic-key-fragment' };
    const server = interpolateMcpEnv({
      type: 'http', url: `http://127.0.0.1:${address.port}/mcp`, headers: {
        Authorization: 'Bearer ${env:MCP_HEADER_ACCESS}', 'X-Key': '${env:MCP_HEADER_KEY}',
      }
    }, secrets);
    const prepared = await createOpenCodeMcpAdapter().prepare({ enabled: true, servers: { probe: server }, serverNames: ['probe'], identity: 'probe' }, { cwd: root });
    const config = generation === 'v1' ? { mcp: prepared.serverConfig } : buildV2ServerConfig(undefined, undefined,
      fileURLToPath(new URL('../../../dist/infra/opencode/plugins/v2-session', import.meta.url)), prepared.serverConfig);
    const content = JSON.stringify(config);
    const args = ['serve', '--hostname=127.0.0.1', '--port=0'];
    const child = spawn(command, args, {
      cwd: root, env: {
        ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }), HOME: root,
        XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, XDG_CACHE_HOME: root, ...secrets,
        OPENCODE_CONFIG_CONTENT: content, OPENCODE_DISABLE_AUTOUPDATE: 'true',
        ...(generation === 'v2' ? { OPENCODE_PASSWORD: 'synthetic-server-password' } : {}),
      }
    });
    let output = '';
    let spawnError: Error | undefined;
    child.once('error', (error) => { spawnError = error; });
    child.stdout.on('data', (chunk) => { output += String(chunk); });
    child.stderr.on('data', (chunk) => { output += String(chunk); });
    try {
      const started = Date.now();
      let baseUrl: string | undefined;
      while (Date.now() - started < 25_000 && child.exitCode === null && spawnError === undefined) {
        baseUrl = /http:\/\/127\.0\.0\.1:\d+/.exec(output)?.[0];
        if (baseUrl !== undefined) break;
        await delay(50);
      }
      if (spawnError !== undefined) throw spawnError;
      if (baseUrl === undefined) throw new Error(`OpenCode did not start: ${output}`);
      let connected = false;
      if (generation === 'v1') {
        const status = await fetch(`${baseUrl}/mcp?directory=${encodeURIComponent(root)}`, { signal: AbortSignal.timeout(10_000) }).then((response) => response.json()) as { probe?: { status?: string } };
        connected = status.probe?.status === 'connected';
      } else {
        const client = OpenCode.make({ baseUrl, headers: { Authorization: `Basic ${Buffer.from('opencode:synthetic-server-password').toString('base64')}` } });
        const location = { directory: root };
        await client.session.create({ location, agent: 'takt' }, { signal: AbortSignal.timeout(10_000) });
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const status = await client.mcp.list({ location }, { signal: AbortSignal.timeout(10_000) });
          connected = status.data.some((entry) => entry.name === 'probe' && entry.status.status === 'connected');
          if (connected) break;
          await delay(50);
        }
      }
      return { version, received, connected, content, args, output };
    } finally {
      if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
        const closed = new Promise<void>((done) => child.once('close', () => done()));
        child.kill('SIGTERM');
        const timer = setTimeout(() => child.kill('SIGKILL'), 1000);
        await closed;
        clearTimeout(timer);
      }
      await prepared.dispose();
    }
  } finally {
    mcp.closeAllConnections();
    await new Promise<void>((done) => mcp.close(() => done()));
    await rm(root, { recursive: true, force: true });
  }
}

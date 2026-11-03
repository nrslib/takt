import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCursorMcpAdapter } from '../infra/providers/mcp/cursor.js';
import { interpolateMcpEnv } from '../infra/config/runtime-provider/mcp-schema.js';
import { callCursor } from '../infra/cursor/client.js';

const cli = process.env.TAKT_CURSOR_MCP_TEST_CLI;
const projectKey = (path: string) => path.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
const fixture = `const fs=require('fs');
fs.appendFileSync(process.env.PROBE_LOG,JSON.stringify({name:process.argv[2],cwd:process.cwd(),target:fs.readFileSync('target.txt','utf8')})+'\\n');
require('readline').createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.id===undefined)return;
const result=r.method==='initialize'?{protocolVersion:r.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:process.argv[2],version:'1'}}:{tools:[]};
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n');});`;

describe.skipIf(cli === undefined)('Cursor native runtime exclusions', () => {
  let root: string;
  let workspace: string;
  let data: string;
  let log: string;
  let environment: Record<string, string>;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'cursor-native-')));
    workspace = join(root, 'workspace');
    data = join(root, 'original-data');
    log = join(root, 'connections.ndjson');
    mkdirSync(join(workspace, '.git'), { recursive: true });
    execFileSync('git', ['init', '--quiet', workspace]);
    mkdirSync(join(workspace, '.cursor'));
    mkdirSync(join(root, '.cursor'));
    writeFileSync(log, '');
    writeFileSync(join(workspace, 'target.txt'), 'original-target');
    writeFileSync(join(workspace, 'service-a.cjs'), fixture);
    writeFileSync(join(workspace, 'service-b.cjs'), fixture);
    environment = { PATH: process.env.PATH!, HOME: root, USERPROFILE: root, CURSOR_DATA_DIR: data,
      AGENT_CLI_CREDENTIAL_STORE: 'file', NO_COLOR: '1' };
    for (const [name, value] of Object.entries(environment)) vi.stubEnv(name, value);
  });
  afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

  async function native(args: string[], cwd: string, env: NodeJS.ProcessEnv = environment): Promise<string> {
    const { stdout } = await promisify(execFile)(cli!, args, { cwd, env, encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024 });
    return stdout;
  }

  it.each([
    ['global', 'approved', false], ['project', 'approved', false], ['project', 'unapproved', false],
    ['global', 'approved', true], ['project', 'approved', true], ['project', 'unapproved', true], ['project', 'stale', true],
  ] as const)('excludes only the target in %s config with %s approval (partial=%s)', async (source, approval, partial) => {
    const server = (name: string, relative: boolean) => ({ args: [relative ? 'service-a.cjs' : join(workspace, 'service-a.cjs'), name],
      env: { PROBE_LOG: log }, command: process.execPath });
    const definitions = { mcpServers: { datadog: server('datadog', false), github: server('github', source === 'project') } };
    const globalFile = join(root, '.cursor', 'mcp.json');
    const projectFile = join(workspace, '.cursor', 'mcp.json');
    writeFileSync(globalFile, source === 'global' ? JSON.stringify(definitions) : '{"mcpServers":{}}');
    writeFileSync(projectFile, source === 'project' ? '// project configuration\n' + JSON.stringify(definitions) : '{"mcpServers":{}}');
    if (source === 'project' && approval !== 'unapproved') await native(['mcp', 'enable', 'github'], workspace);
    if (approval === 'stale') {
      definitions.mcpServers.github.args = ['service-b.cjs', 'github'];
      writeFileSync(projectFile, JSON.stringify(definitions));
    }
    const management = join(data, 'projects', projectKey(workspace));
    mkdirSync(management, { recursive: true });
    writeFileSync(join(management, 'mcp-disabled.json'), '["previously-disabled"]');
    writeFileSync(join(management, 'mcp-auth.json'), JSON.stringify({ datadog: { tokens: { access_token: 'excluded-token', token_type: 'Bearer' } } }));
    const originalFiles = [globalFile, projectFile, join(management, 'mcp-disabled.json'), join(management, 'mcp-auth.json')];
    if (existsSync(join(management, 'mcp-approvals.json'))) originalFiles.push(join(management, 'mcp-approvals.json'));
    const originals = originalFiles.map((file) => [file, readFileSync(file, 'utf8')] as const);
    const runtimeTarget = interpolateMcpEnv({ type: 'http', url: 'https://excluded.invalid', headers: { Authorization: 'Token ${env:X}' } }, { X: 'synthetic-reference' });
    const assigned = { datadog: runtimeTarget, ...(partial ? { echo: server('echo', false) } : {}) };
    const prepared = await createCursorMcpAdapter().prepare({ enabled: true, servers: assigned, serverNames: Object.keys(assigned), identity: 'native' }, { cwd: workspace });
    const effectiveWorkspace = prepared.configRoot ?? workspace;
    const effectiveEnv = { ...environment, ...prepared.env };
    try {
      if (partial) {
        writeFileSync(join(effectiveWorkspace, 'target.txt'), 'runtime-target');
        // The adapter must leave runtime approval to Cursor's existing approval mechanism.
        const beforeApproval = await native(['--workspace', effectiveWorkspace, 'mcp', 'list'], workspace, effectiveEnv);
        expect(beforeApproval).toContain('echo: not loaded (needs approval)');
        await native(['mcp', 'enable', 'echo'], effectiveWorkspace, effectiveEnv);
      } else expect(prepared.configRoot).toBeUndefined();
      writeFileSync(log, '');
      const listed = await native(['--workspace', effectiveWorkspace, 'mcp', 'list'], workspace, effectiveEnv);
      if (source === 'global' || !partial) expect(listed).toContain('datadog: disabled');
      else expect(JSON.parse(readFileSync(join(effectiveWorkspace, '.cursor', 'mcp.json'), 'utf8')).mcpServers)
        .not.toHaveProperty('datadog');
      const githubReady = approval === 'approved';
      expect(listed).toContain(githubReady ? 'github: ready' : 'github: not loaded (needs approval)');
      if (partial) expect(listed).toContain('echo: ready');
      const connections = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as { name: string; cwd: string; target: string });
      expect(connections.map((entry) => entry.name).sort()).toEqual([...(githubReady ? ['github'] : []), ...(partial ? ['echo'] : [])].sort());
      if (githubReady) expect(connections.find((entry) => entry.name === 'github'))
        .toMatchObject({ cwd: source === 'project' || !partial ? workspace : effectiveWorkspace,
          target: source === 'project' || !partial ? 'original-target' : 'runtime-target' });
      if (partial) expect(connections.find((entry) => entry.name === 'echo')).toMatchObject({ cwd: effectiveWorkspace, target: 'runtime-target' });
      for (const [file, value] of originals) expect(readFileSync(file, 'utf8')).toBe(value);
      const authPath = join(prepared.env!.CURSOR_DATA_DIR!, 'projects', projectKey(effectiveWorkspace), 'mcp-auth.json');
      expect(JSON.parse(readFileSync(authPath, 'utf8'))).toEqual({});
    } finally { await prepared.dispose(); }
    expect(existsSync(prepared.env!.CURSOR_DATA_DIR!)).toBe(false);
    if (partial) expect(existsSync(effectiveWorkspace)).toBe(false);
    // The next execution uses the original store, without the temporary disable entry.
    const original = await native(['mcp', 'list'], workspace);
    expect(original).toContain(source === 'global' ? 'datadog: ready' : 'datadog: not loaded (needs approval)');
  }, 45_000);

  it.each([false, true])('preserves retained HTTP credentials without copying excluded credentials (partial=%s)', async (partial) => {
    const requests: { url: string | undefined; authorization: string | undefined; method: string | undefined }[] = [];
    const http = createServer(async (request, response) => {
      const body: Buffer[] = [];
      for await (const chunk of request) body.push(Buffer.from(chunk));
      const message = body.length === 0 ? undefined : JSON.parse(Buffer.concat(body).toString()) as {
        id?: number; method?: string; params?: { protocolVersion?: string };
      };
      requests.push({ url: request.url, authorization: request.headers.authorization, method: message?.method });
      if (request.method === 'POST' && message?.id !== undefined) {
        const result = message.method === 'initialize'
          ? { protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'authenticated', version: '1' } }
          : { tools: [] };
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
      } else { response.writeHead(202); response.end(); }
    });
    await new Promise<void>((done) => { http.listen(0, '127.0.0.1', done); });
    try {
      const address = http.address();
      if (address === null || typeof address === 'string') throw new Error('Missing HTTP fixture address');
      const url = `http://127.0.0.1:${address.port}`;
      writeFileSync(join(workspace, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: {
        datadog: { url: `${url}/excluded` }, github: { url: `${url}/retained` },
      } }));
      await native(['mcp', 'enable', 'github'], workspace);
      await native(['mcp', 'enable', 'datadog'], workspace);
      const management = join(data, 'projects', projectKey(workspace));
      const authFile = join(management, 'mcp-auth.json');
      const originalAuth = JSON.stringify({
        github: { tokens: { access_token: 'retained-access', token_type: 'Bearer' } },
        datadog: { tokens: { access_token: 'excluded-access', token_type: 'Bearer' } },
      });
      writeFileSync(authFile, originalAuth);
      expect(await native(['mcp', 'list'], workspace)).toContain('github: ready');
      expect(requests.some((request) => request.url === '/retained' && request.method === 'initialize' && request.authorization === 'Bearer retained-access')).toBe(true);
      requests.length = 0;
      const datadog = interpolateMcpEnv({ type: 'http', url: `${url}/excluded`, headers: { Authorization: '${env:X}' } }, { X: 'synthetic' });
      const assigned = { datadog, ...(partial ? { echo: { command: process.execPath, args: ['unused-runtime.js'] } } : {}) };
      const prepared = await createCursorMcpAdapter().prepare({ enabled: true, servers: assigned, serverNames: Object.keys(assigned), identity: 'auth' }, { cwd: workspace });
      try {
        const effectiveWorkspace = prepared.configRoot ?? workspace;
        const listed = await native(['--workspace', effectiveWorkspace, 'mcp', 'list'], workspace, { ...environment, ...prepared.env });
        expect(listed).toContain('github: ready');
        expect(requests.some((request) => request.url === '/retained' && request.method === 'initialize' && request.authorization === 'Bearer retained-access')).toBe(true);
        expect(requests.filter((request) => request.url === '/excluded')).toEqual([]);
        const copiedAuth = JSON.parse(readFileSync(join(prepared.env!.CURSOR_DATA_DIR!, 'projects', projectKey(effectiveWorkspace), 'mcp-auth.json'), 'utf8'));
        expect(copiedAuth.github.tokens.access_token).toBe('retained-access');
        expect(copiedAuth).not.toHaveProperty('datadog');
        expect(readFileSync(authFile, 'utf8')).toBe(originalAuth);
      } finally { await prepared.dispose(); }
    } finally { await new Promise<void>((done, reject) => { http.close((error) => error ? reject(error) : done()); }); }
  }, 45_000);

  it('disposes the prepared management data after a real client startup failure', async () => {
    const datadog = interpolateMcpEnv({ type: 'http', url: 'https://excluded.invalid', headers: { Authorization: '${env:X}' } }, { X: 'synthetic' });
    const prepared = await createCursorMcpAdapter().prepare({ enabled: true, servers: { datadog }, serverNames: ['datadog'], identity: 'failure' }, { cwd: workspace });
    const response = await callCursor('test', 'prompt', { cwd: workspace, cursorCliPath: join(root, 'missing-cursor'), preparedMcp: prepared });
    expect(response.status).toBe('error');
    expect(existsSync(prepared.env!.CURSOR_DATA_DIR!)).toBe(false);
  });
});

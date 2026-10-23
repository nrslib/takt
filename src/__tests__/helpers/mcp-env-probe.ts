import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm, readdir, readFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import '../../infra/codex/codex-spawn-guard.js';

export async function probeMcpHeaders(
  provider: 'codex' | 'claude-inline' | 'claude-file' | 'claude-sdk',
  executable: string,
  nativeConfig?: Record<string, unknown> | ((url: string, env: Record<string, string>, cwd: string) => Promise<{
    config: Record<string, unknown>; configOverrides?: string[]; env?: Record<string, string>;
  }>),
): Promise<{ exitCode: number | null; received: boolean; shellOutput: string; output: string; argv: string[]; secretInArtifacts?: boolean; providerHasSecrets?: boolean; mcpRequests?: number; excludedRequests?: number }> {
  const root = await mkdtemp(join(tmpdir(), 'takt-header-probe-'));
  const token = 'synthetic-access-fragment.signature-fragment';
  let received = false;
  let shellOutput = '';
  let rounds = 0;
  let mcpRequests = 0;
  let excludedRequests = 0;
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += String(chunk);
    if (request.url?.startsWith('/mcp')) {
      mcpRequests++;
      if (request.url.endsWith('/excluded')) excludedRequests++;
      received ||= request.headers.authorization === `Bearer ${token}`
        && (provider !== 'codex' || request.headers['x-key'] === 'synthetic-key-fragment');
      if (request.method !== 'POST') { response.writeHead(405).end(); return; }
      const rpc = JSON.parse(body) as { id?: number; method?: string; params?: { protocolVersion?: string } };
      if (rpc.id === undefined) { response.writeHead(202).end(); return; }
      const result = rpc.method === 'initialize'
        ? { protocolVersion: rpc.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'probe', version: '1' } }
        : { tools: [] };
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
      return;
    }
    if (provider !== 'codex') {
      const message = { id: 'msg_probe', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const event of [
        { type: 'message_start', message },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
      ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      response.end();
      return;
    }
    if (request.method !== 'POST' || body.length === 0) { response.writeHead(404).end(); return; }
    const input = JSON.parse(body) as { input?: { type?: string; output?: string }[]; tools?: { name?: string }[] };
    for (const item of input.input ?? []) if (item.type === 'function_call_output') shellOutput = String(item.output);
    const toolNames = input.tools?.map((tool) => tool.name) ?? [];
    const tool = toolNames.includes('shell_command') ? 'shell_command' : 'exec_command';
    const command = 'printf "header-secret=%s key-secret=%s\\n" "${MCP_HEADER_ACCESS-unset}" "${MCP_HEADER_KEY-unset}"';
    const item = rounds++ === 0
      ? { type: 'function_call', id: 'fc_probe', call_id: 'call_probe', name: tool, arguments: JSON.stringify(tool === 'shell_command' ? { command, workdir: root } : { cmd: command, workdir: root }) }
      : { type: 'message', id: 'msg_probe', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] };
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const event of [
      { type: 'response.created', response: { id: `resp_${rounds}` } },
      { type: 'response.output_item.added', output_index: 0, item },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id: `resp_${rounds}`, status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 } } } },
    ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    response.end();
  });
  try {
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Missing probe address');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const env = {
      ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }), HOME: root, USERPROFILE: root, CODEX_HOME: root,
      XDG_CONFIG_HOME: root, CLAUDE_CONFIG_DIR: root,
      MCP_HEADER_ACCESS: token, MCP_HEADER_KEY: 'synthetic-key-fragment',
      ANTHROPIC_API_KEY: 'synthetic-probe-key', ANTHROPIC_BASE_URL: baseUrl,
      DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
    };
    if (provider === 'claude-sdk') {
      const { query } = await import('@anthropic-ai/claude-agent-sdk');
      const abortController = new AbortController();
      const timer = setTimeout(() => abortController.abort(), 25_000);
      let output = '';
      let exitCode = 0;
      try {
        for await (const message of query({ prompt: 'probe', options: {
          cwd: root, env, abortController, model: 'claude-sonnet-4-6',
          ...(executable === 'default' ? {} : { pathToClaudeCodeExecutable: resolve(executable) }), strictMcpConfig: true,
          mcpServers: { probe: { type: 'http', url: `${baseUrl}/mcp`, headers: { Authorization: 'Bearer ${MCP_HEADER_ACCESS}' } } },
          stderr: (data) => { output += data; },
        } })) output += JSON.stringify(message);
      } catch (error) {
        exitCode = 1;
        output += String(error);
      } finally {
        clearTimeout(timer);
      }
      return { exitCode, output, received, shellOutput, argv: [] };
    }
    let argv: string[];
    let result: { exitCode: number | null; output: string; providerHasSecrets?: boolean };
    if (provider === 'codex') {
      const originalEnvironment = process.env;
      let prepared: { config: Record<string, unknown>; configOverrides?: string[]; env?: Record<string, string> };
      try {
        process.env = { ...env };
        prepared = typeof nativeConfig === 'function' ? await nativeConfig(`${baseUrl}/mcp`, env, root) : {
        config: structuredClone(nativeConfig ?? {
          mcp_servers: { probe: { url: `${baseUrl}/mcp`, bearer_token_env_var: 'MCP_HEADER_ACCESS', env_http_headers: { 'X-Key': 'MCP_HEADER_KEY' } } },
          shell_environment_policy: { filters: { MCP_HEADER_ACCESS: 'exclude', MCP_HEADER_KEY: 'exclude' } },
        }), configOverrides: undefined,
      };
      } finally { process.env = originalEnvironment; }
      const config = prepared.config;
      const servers = config.mcp_servers as Record<string, { url?: string }> | undefined;
      if (typeof nativeConfig !== 'function') for (const entry of Object.values(servers ?? {})) entry.url = `${baseUrl}/mcp`;
      const wrapper = join(root, 'codex-probe.mjs');
      const argvPath = join(root, 'argv.json');
      await writeFile(wrapper, `#!${process.execPath}\nimport {spawn} from 'node:child_process';\nimport {writeFileSync,appendFileSync} from 'node:fs';\nwriteFileSync(${JSON.stringify(argvPath)},JSON.stringify(process.argv.slice(2)),{mode:0o600});\nconst child=spawn(${JSON.stringify(resolve(executable))},process.argv.slice(2),{stdio:['inherit','inherit','pipe']});\nchild.stderr.on('data',(data)=>{appendFileSync(${JSON.stringify(join(root, 'stderr.log'))},data);process.stderr.write(data);});\nchild.on('error',()=>process.exit(1));\nchild.on('exit',(code)=>process.exit(code??1));\n`);
      await chmod(wrapper, 0o700);
      const { Codex } = await import('@openai/codex-sdk');
      const providerEnv = prepared.env ?? env;
      const providerHasSecrets = providerEnv.MCP_HEADER_ACCESS === token && providerEnv.MCP_HEADER_KEY === 'synthetic-key-fragment';
      const codex = new Codex({ codexPathOverride: wrapper, env: providerEnv,
        config: config as import('@openai/codex-sdk').CodexOptions['config'],
        configOverrides: [...(prepared.configOverrides ?? []),
          'model_provider="probe"', `model_providers.probe={name="probe",base_url="${baseUrl}",wire_api="responses"}`,
          'features.shell_snapshot=false', 'allow_login_shell=false', 'sandbox_mode="danger-full-access"'],
      });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 25_000);
      result = { exitCode: 0, output: '' };
      try {
        const thread = codex.startThread({ workingDirectory: root, skipGitRepoCheck: true });
        const turn = await thread.runStreamed('probe', { signal: controller.signal });
        for await (const event of turn.events) {
          result.output += JSON.stringify(event);
          if (event.type === 'turn.failed') result.exitCode = 1;
        }
      } catch (error) {
        result = { exitCode: 1, output: result.output + String(error) };
      } finally { clearTimeout(timer); }
      argv = JSON.parse(await readFile(argvPath, 'utf8')) as string[];
      result = { ...result, providerHasSecrets };
    } else {
      const config = { mcpServers: { probe: { type: 'http', url: `${baseUrl}/mcp`, headers: { Authorization: 'Bearer ${MCP_HEADER_ACCESS}' } } } };
      let configArg = JSON.stringify(config);
      if (provider === 'claude-file') {
        configArg = join(root, 'mcp.json');
        await writeFile(configArg, JSON.stringify(config), { mode: 0o600 });
      }
      argv = ['--bare', '-p', 'probe', '--model', 'claude-sonnet-4-6', '--output-format', 'json', '--strict-mcp-config', '--mcp-config', configArg];
      result = await new Promise<{ exitCode: number | null; output: string }>((done, reject) => {
      const child = spawn(executable.includes('/') ? resolve(executable) : executable, argv, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', (chunk) => { output += String(chunk); });
      child.stderr.on('data', (chunk) => { output += String(chunk); });
      const timer = setTimeout(() => child.kill('SIGTERM'), 25_000);
      const killTimer = setTimeout(() => child.kill('SIGKILL'), 27_000);
      child.once('error', (error) => { clearTimeout(timer); clearTimeout(killTimer); reject(error); });
      child.once('close', (exitCode) => { clearTimeout(timer); clearTimeout(killTimer); done({ exitCode, output }); });
      });
    }
    let secretInArtifacts = false;
    for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const contents = await readFile(join(entry.parentPath, entry.name));
      if (['synthetic-access-fragment', 'signature-fragment', 'synthetic-key-fragment'].some((fragment) => contents.includes(fragment))) {
        secretInArtifacts = true;
      }
    }
    return { ...result, received, shellOutput, argv, secretInArtifacts, mcpRequests, excludedRequests };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await probeMcpHeaders(process.argv[2] as Parameters<typeof probeMcpHeaders>[0], process.argv[3]!);
  process.stdout.write(JSON.stringify(result).replaceAll('synthetic-access-fragment.signature-fragment', '<synthetic-token>'));
}

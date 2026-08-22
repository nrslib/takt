import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createIsolatedEnv, updateIsolatedConfig, type IsolatedEnv } from '../helpers/isolated-env';
import { runTakt } from '../helpers/takt-runner';
import { createLocalRepo, type LocalRepo } from '../helpers/test-repo';
import { cleanupResources } from '../helpers/cleanup';

/**
 * Contracts covered (see plan.md 完了契約):
 * - `MCP-E2E` (要件93,94,95)
 *   - 最小 workflow から fixture MCP tool を1回呼び、既知の nonce を最終出力へ含める
 *     opt-in E2E を provider ごとに用意する
 *   - 通常 CI では mock E2E を必須とし credential/CLI 必要な provider E2E は個別実行可能
 *   - MCP 設定を渡しただけでなく実際の tool call event/result と nonce を確認する
 *
 * 反例:
 *   - MCP 設定を渡しただけで tool call を確認しない
 *
 * 注意:
 *   - mock CI E2E は必須（TAKT_E2E_PROVIDER 未設定時も実行）
 *   - provider E2E は TAKT_E2E_PROVIDER 設定時に実行
 *   - 既知の nonce: `fixed-test-nonce`
 */

const provider = process.env.TAKT_E2E_PROVIDER;
const providerEnabled = provider != null && provider !== 'mock';
const providerIt = providerEnabled ? it : it.skip;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const agentFixturePath = resolve(__dirname, '../fixtures/agents/test-coder.md');

const ECHO_SERVER_SOURCE = [
  "const { stdin, stdout } = process;",
  "let buffer = '';",
  "stdin.setEncoding('utf-8');",
  "stdin.on('data', (chunk) => {",
  "  buffer += chunk;",
  "  let idx;",
  "  while ((idx = buffer.indexOf('\\n')) >= 0) {",
  "    const line = buffer.slice(0, idx);",
  "    buffer = buffer.slice(idx + 1);",
  "    if (line.trim() === '') continue;",
  "    let msg;",
  "    try { msg = JSON.parse(line); } catch { continue; }",
  "    if (msg.method === 'initialize') {",
  "      stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'echo', version: '0.0.1' } } }) + '\\n');",
  "    } else if (msg.method === 'tools/list') {",
  "      stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'echo_nonce', description: 'Echo a fixed nonce', inputSchema: { type: 'object', additionalProperties: false } }] } }) + '\\n');",
  "    } else if (msg.method === 'tools/call') {",
  "      stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'NONCE:fixed-test-nonce' }] } }) + '\\n');",
  "    }",
  "  }",
  "});",
].join('\n');

describe('E2E: runtime MCP assignment (mock, MCP-E2E)', () => {
  let isolatedEnv: IsolatedEnv | undefined;
  let repo: LocalRepo | undefined;
  let fixtureDir: string;

  beforeEach(() => {
    isolatedEnv = createIsolatedEnv();
    repo = createLocalRepo();
    fixtureDir = mkdtempSync(join(tmpdir(), 'takt-mcp-e2e-fixture-'));
    // The runtime.yaml mcp section activates runtime-v1 mode, which fails
    // fast on legacy provider settings. Remove legacy `provider_options`
    // / `provider_profiles` from the isolated config so the mcp section
    // can stand alone (order.md:112-118).
    updateIsolatedConfig(isolatedEnv.taktDir, {
      provider_options: {},
      provider_profiles: {},
    });
    // Copy the test-coder persona fixture into the repo so the workflow's
    // `persona: agents/test-coder.md` resolves inside the worktree.
    const agentsDir = join(repo.path, 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      join(agentsDir, 'test-coder.md'),
      readFileSync(agentFixturePath, 'utf-8'),
      'utf-8',
    );
  });

  afterEach(() => {
    let firstError: unknown;
    try {
      if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
    } catch (e) {
      firstError = e;
    }
    try {
      cleanupResources(
        () => repo?.cleanup(),
        () => isolatedEnv?.cleanup(),
      );
    } catch (e) {
      firstError ??= e;
    }
    if (firstError !== undefined) throw firstError;
  });

  it('should run a minimal workflow that calls the fixture MCP tool and emit the known nonce in the final output (mock)', () => {
    // Write a deterministic stdio MCP server fixture in the worktree.
    const serverPath = join(fixtureDir, 'echo-server.js');
    writeFileSync(serverPath, ECHO_SERVER_SOURCE, 'utf-8');
    chmodSync(serverPath, 0o755);

    // Write a runtime.yaml that assigns the echo server as a default.
    const runtimeYamlPath = join(repo.path, '.takt', 'runtime.yaml');
    mkdirSync(join(repo.path, '.takt'), { recursive: true });
    writeFileSync(runtimeYamlPath, [
      'version: 1',
      'mcp:',
      '  servers:',
      '    echo:',
      '      command: node',
      '      args:',
      `        - ${serverPath}`,
      '  defaults:',
      '    servers:',
      '      - echo',
    ].join('\n'), 'utf-8');

    // Write a minimal workflow that calls the echo_nonce MCP tool.
    const workflowPath = join(repo.path, 'mcp-e2e-workflow.yaml');
    writeFileSync(workflowPath, [
      'name: mcp-e2e',
      'description: Minimal workflow that calls the fixture MCP tool',
      'max_steps: 3',
      'initial_step: execute',
      'steps:',
      '  - name: execute',
      '    edit: false',
      '    persona: agents/test-coder.md',
      '    instruction: |',
      '      Call the echo_nonce MCP tool and include the NONCE from its result in your final response.',
      '      Respond with "Task completed" after including the nonce.',
      '    rules:',
      '      - condition: Task completed',
      '        next: COMPLETE',
    ].join('\n'), 'utf-8');

    const mockScenarioPath = join(repo.path, 'mcp-e2e-scenario.json');
    writeFileSync(mockScenarioPath, JSON.stringify([
      {
        status: 'done',
        content: 'NONCE:fixed-test-nonce\n\nTask completed',
      },
    ]), 'utf-8');

    const mockCallLogPath = join(repo.path, '.takt-mock-call-log.ndjson');
    const result = runTakt({
      args: [
        '--provider', 'mock',
        '--task', 'Call the echo_nonce MCP tool and include the nonce in the final output.',
        '--workflow', workflowPath,
      ],
      cwd: repo.path,
      env: {
        ...isolatedEnv.env,
        TAKT_MOCK_SCENARIO: mockScenarioPath,
        TAKT_MOCK_CALL_LOG: mockCallLogPath,
      },
    });

    expect(result.exitCode).toBe(0);
    // The mock E2E must verify the runtime MCP assignment is wired through to
    // the mock provider end-to-end (ARCH-NEW-4, CODE-NEW-mcp-mock-e2e-toolcall).
    // The mock call log records:
    //   - the resolved MCP server name and transport
    //   - the deterministic fixture tool call event/result and known nonce
    // The `if (existsSync)` soft-assertion guard is removed; the mock call log
    // must exist and contain the expected tool call markers.
    expect(existsSync(mockCallLogPath)).toBe(true);
    const logContent = readFileSync(mockCallLogPath, 'utf-8');
    expect(logContent.length).toBeGreaterThan(0);
    const logEntries = logContent
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { event?: string; mcpServers?: Record<string, { transport: string }>; mcpToolCall?: { server: string; transport: string; tool: string; result: unknown; nonce?: string } });
    // The "start" event must record the resolved MCP server `echo` with
    // transport `stdio`.
    const startEntry = logEntries.find((entry) => entry.event === 'start');
    expect(startEntry?.mcpServers).toBeDefined();
    expect(startEntry?.mcpServers?.echo).toEqual({ transport: 'stdio' });
    // The "mcp_tool_call" event must record the fixture tool call with the
    // known nonce, server, transport, and tool name.
    const toolCallEntry = logEntries.find((entry) => entry.event === 'mcp_tool_call');
    expect(toolCallEntry?.mcpToolCall).toEqual({
      server: 'echo',
      transport: 'stdio',
      tool: 'echo_nonce',
      result: 'NONCE:fixed-test-nonce',
      nonce: 'fixed-test-nonce',
    });
    // The final mock response must include the known nonce marker.
    expect(result.stdout).toContain('NONCE:fixed-test-nonce');
  });
});

describe('E2E: runtime MCP assignment (provider, MCP-E2E)', () => {
  let isolatedEnv: IsolatedEnv | undefined;
  let repo: LocalRepo | undefined;
  let fixtureDir: string;

  beforeEach(() => {
    if (!providerEnabled) return;
    isolatedEnv = createIsolatedEnv();
    repo = createLocalRepo();
    fixtureDir = mkdtempSync(join(tmpdir(), 'takt-mcp-e2e-provider-fixture-'));
    updateIsolatedConfig(isolatedEnv!.taktDir, {
      provider_options: {},
      provider_profiles: {},
    });
    const agentsDir = join(repo!.path, 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      join(agentsDir, 'test-coder.md'),
      readFileSync(agentFixturePath, 'utf-8'),
      'utf-8',
    );
  });

  afterEach(() => {
    if (!providerEnabled) return;
    let firstError: unknown;
    try {
      if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
    } catch (e) {
      firstError = e;
    }
    try {
      cleanupResources(
        () => repo?.cleanup(),
        () => isolatedEnv?.cleanup(),
      );
    } catch (e) {
      firstError ??= e;
    }
    if (firstError !== undefined) throw firstError;
  });

  providerIt('should call the fixture MCP tool and emit the known nonce in the final output (provider)', () => {
    const serverPath = join(fixtureDir, 'echo-server.js');
    writeFileSync(serverPath, ECHO_SERVER_SOURCE, 'utf-8');
    chmodSync(serverPath, 0o755);

    const runtimeYamlPath = join(repo!.path, '.takt', 'runtime.yaml');
    mkdirSync(join(repo!.path, '.takt'), { recursive: true });
    writeFileSync(runtimeYamlPath, [
      'version: 1',
      'mcp:',
      '  servers:',
      '    echo:',
      '      command: node',
      '      args:',
      `        - ${serverPath}`,
      '  defaults:',
      '    servers:',
      '      - echo',
    ].join('\n'), 'utf-8');

    const workflowPath = join(repo!.path, 'mcp-e2e-workflow.yaml');
    writeFileSync(workflowPath, [
      'name: mcp-e2e-provider',
      'description: Minimal workflow that calls the fixture MCP tool',
      'max_steps: 3',
      'initial_step: execute',
      'steps:',
      '  - name: execute',
      '    edit: false',
      '    persona: agents/test-coder.md',
      '    required_permission_mode: full',
      '    instruction: |',
      '      Call the echo_nonce MCP tool. Then respond with "Task completed" and include the nonce.',
      '    rules:',
      '      - condition: Task completed',
      '        next: COMPLETE',
    ].join('\n'), 'utf-8');

    const result = runTakt({
      args: [
        '--task',
        [
          'Call the echo_nonce MCP tool available in this session.',
          'Include the NONCE value from the tool result in your final response.',
          'Then respond exactly with: Task completed',
        ].join(' '),
        '--workflow', workflowPath,
      ],
      cwd: repo!.path,
      env: isolatedEnv!.env,
      timeout: 240_000,
    });

    expect(result.exitCode).toBe(0);
    // The final output must contain the known nonce — not just the MCP config.
    expect(result.stdout).toContain('fixed-test-nonce');
  }, 240_000);
});

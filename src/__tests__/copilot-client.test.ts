/**
 * Tests for GitHub Copilot CLI client
 */

import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSpawn, mockMkdtemp, mockReadFile, mockRm } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockMkdtemp: vi.fn(),
  mockReadFile: vi.fn(),
  mockRm: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: mockSpawn,
}));

vi.mock('node:fs/promises', () => ({
  mkdtemp: mockMkdtemp,
  readFile: mockReadFile,
  rm: mockRm,
}));

import { callCopilot, callCopilotCustom, extractSessionIdFromShareFile } from '../infra/copilot/client.js';
import { formatTaskStateReferenceMarker } from '../shared/task-state-reference.js';

type SpawnScenario = {
  stdout?: string;
  stderr?: string;
  code?: number | null;
  signal?: NodeJS.Signals | null;
  error?: Partial<NodeJS.ErrnoException> & { message: string };
};

type MockChildProcess = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
};

function createMockChildProcess(): MockChildProcess {
  const child = new EventEmitter() as MockChildProcess;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn(() => true);
  return child;
}

function mockSpawnWithScenario(scenarios: SpawnScenario | SpawnScenario[]): void {
  let attempt = 0;
  mockSpawn.mockImplementation((_cmd: string, _args: string[], _options: object) => {
    const scenario = Array.isArray(scenarios) ? scenarios[attempt++] : scenarios;
    if (scenario === undefined) throw new Error('Missing Copilot spawn scenario');
    const child = createMockChildProcess();

    queueMicrotask(() => {
      if (scenario.stdout) {
        child.stdout.emit('data', Buffer.from(scenario.stdout, 'utf-8'));
      }
      if (scenario.stderr) {
        child.stderr.emit('data', Buffer.from(scenario.stderr, 'utf-8'));
      }

      if (scenario.error) {
        const error = Object.assign(new Error(scenario.error.message), scenario.error);
        child.emit('error', error);
        return;
      }

      child.emit(
        'close',
        scenario.code === undefined ? 0 : scenario.code,
        scenario.signal === undefined ? null : scenario.signal,
      );
    });

    return child;
  });
}

describe('callCopilot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.COPILOT_GITHUB_TOKEN;
    delete process.env.COPILOT_ALLOW_ALL;
    delete process.env.COPILOT_MCP_CONFIG;
    delete process.env.TAKT_OBSERVABILITY;
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    mockMkdtemp.mockResolvedValue('/tmp/takt-copilot-XXXXXX');
    mockReadFile.mockResolvedValue(
      '# 🤖 Copilot CLI Session\n\n> **Session ID:** `aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`\n',
    );
    mockRm.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('should invoke copilot with required args including --silent, --no-color', async () => {
    const onActivity = vi.fn();
    mockSpawnWithScenario({
      stdout: 'Implementation complete. All tests pass.',
      code: 0,
    });

    const result = await callCopilot('coder', 'implement feature', {
      cwd: '/repo',
      model: 'claude-sonnet-4.6',
      sessionId: 'sess-prev',
      permissionMode: 'full',
      copilotGithubToken: 'gh-token',
      onActivity,
    });

    expect(result.status).toBe('done');
    expect(result.content).toBe('Implementation complete. All tests pass.');
    expect(result.sessionId).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(onActivity).toHaveBeenCalledOnce();

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [command, args, options] = mockSpawn.mock.calls[0] as [string, string[], { env?: NodeJS.ProcessEnv; stdio?: unknown }];

    expect(command).toBe('copilot');
    expect(args).toContain('-p');
    expect(args).toContain('--silent');
    expect(args).toContain('--no-color');
    expect(args).toContain('--no-auto-update');
    expect(args).toContain('--output-format=json');
    expect(args).toContain('--model');
    expect(args).toContain('--resume');
    expect(args).toContain('--yolo');
    expect(args).toContain('--share');
    expect(options.env?.COPILOT_GITHUB_TOKEN).toBe('gh-token');
    expect(options.stdio).toEqual(['ignore', 'pipe', 'pipe']);
  });

  it('does not pass a --model flag to Copilot CLI when the model is unspecified', async () => {
    mockSpawnWithScenario({
      stdout: 'done',
      code: 0,
    });

    const result = await callCopilot('coder', 'implement feature', { cwd: '/repo' });

    expect(result.status).toBe('done');
    const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
    expect(args).not.toContain('--model');
  });

  it('should use --allow-all-tools --no-ask-user for edit permission mode (no --autopilot)', async () => {
    mockSpawnWithScenario({
      stdout: 'done',
      code: 0,
    });

    await callCopilot('coder', 'implement feature', {
      cwd: '/repo',
      permissionMode: 'edit',
    });

    const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
    expect(args).toContain('--allow-all-tools');
    expect(args).toContain('--no-ask-user');
    expect(args).not.toContain('--yolo');
    expect(args).not.toContain('--autopilot');
  });

  it('allows reads and denies writes and shell in ordinary readonly mode without restricting MCP tools', async () => {
    mockSpawnWithScenario({
      stdout: 'done',
      code: 0,
    });

    const preparedMcp = {
      args: ['--additional-mcp-config=@/tmp/task-state.json'],
      dispose: vi.fn().mockResolvedValue(undefined),
    };
    const result = await callCopilot('coder', 'read task state', {
      cwd: '/repo',
      permissionMode: 'readonly',
      preparedMcp,
    });

    const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
    expect(result.status).toBe('done');
    expect(result.content).toBe('done');
    expect(args).toEqual(expect.arrayContaining([
      '--allow-tool=read', '--deny-tool=write', '--deny-tool=shell', ...preparedMcp.args,
    ]));
    expect(args.some((arg) => arg.startsWith('--available-tools'))).toBe(false);
    expect(args).not.toContain('--yolo');
    expect(args).not.toContain('--allow-all-tools');
    expect(args).not.toContain('--no-ask-user');
    expect(args).not.toContain('--autopilot');
  });

  it.each([
    { custom: false, sessionId: undefined },
    { custom: false, sessionId: 'sess-prev' },
    { custom: true, sessionId: undefined },
    { custom: true, sessionId: 'sess-prev' },
  ])('restricts internal readonly tools and returns CLI content (custom=$custom, sessionId=$sessionId)', async ({ custom, sessionId }) => {
    mockSpawnWithScenario({ stdout: 'verification passed\n' });
    const options = {
      cwd: '/repo',
      permissionMode: 'readonly' as const,
      internalAgentIsolation: 'strict-readonly' as const,
      sessionId,
    };

    const result = custom
      ? await callCopilotCustom('verifier', 'read verification.txt', 'Interpret verification artifacts.', options)
      : await callCopilot('verifier', 'read verification.txt', options);

    expect(result.status).toBe('done');
    expect(result.content).toBe('verification passed');
    const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
    expect(args).toEqual(expect.arrayContaining([
      '--allow-tool=read', '--deny-tool=write', '--deny-tool=shell', '--available-tools=view,glob,grep',
    ]));
    if (sessionId) {
      expect(args.slice(args.indexOf('--resume'), args.indexOf('--resume') + 2)).toEqual(['--resume', sessionId]);
    } else {
      expect(args).not.toContain('--resume');
    }
    expect(args[1]).toBe(custom
      ? 'Interpret verification artifacts.\n\nread verification.txt'
      : 'read verification.txt');
    expect(args).not.toContain('--yolo');
    expect(args).not.toContain('--allow-all-tools');
    expect(args).toContain('--share');
    expect(mockRm).toHaveBeenCalledWith('/tmp/takt-copilot-XXXXXX', { recursive: true, force: true });
  });

  it('removes inherited allow-all only from the readonly child while preserving credentials and observability', async () => {
    vi.stubEnv('COPILOT_ALLOW_ALL', 'true');
    vi.stubEnv('GH_TOKEN', 'parent-gh-token');
    vi.stubEnv('COPILOT_GITHUB_TOKEN', 'parent-copilot-token');
    mockSpawnWithScenario({ stdout: 'done' });

    await callCopilot('verifier', 'read verification.txt', {
      cwd: '/repo',
      permissionMode: 'readonly',
      copilotGithubToken: 'explicit-copilot-token',
      childProcessEnv: { TAKT_OBSERVABILITY: '{"enabled":true}' },
    });

    const [, , options] = mockSpawn.mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv }];
    expect(options.env).not.toBe(process.env);
    expect(options.env).not.toHaveProperty('COPILOT_ALLOW_ALL');
    expect(options.env.GH_TOKEN).toBe('parent-gh-token');
    expect(options.env.COPILOT_GITHUB_TOKEN).toBe('explicit-copilot-token');
    expect(options.env.TAKT_OBSERVABILITY).toBe('{"enabled":true}');
    expect(process.env.COPILOT_ALLOW_ALL).toBe('true');
    expect(process.env.COPILOT_GITHUB_TOKEN).toBe('parent-copilot-token');
  });

  it.each(['edit', 'full', undefined] as const)('preserves permissions and inherited allow-all outside readonly (%s)', async (permissionMode) => {
    vi.stubEnv('COPILOT_ALLOW_ALL', 'true');
    mockSpawnWithScenario({ stdout: 'done' });

    await callCopilot('coder', 'implement feature', {
      cwd: '/repo',
      permissionMode,
      internalAgentIsolation: 'strict-readonly',
    });

    const [, args, options] = mockSpawn.mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv }];
    expect(options.env.COPILOT_ALLOW_ALL).toBe('true');
    expect(args.some((arg) => arg.startsWith('--deny-tool') || arg.startsWith('--available-tools'))).toBe(false);
    expect(args).not.toContain('--allow-tool=read');
    expect(args.includes('--yolo')).toBe(permissionMode === 'full');
    expect(args.includes('--allow-all-tools')).toBe(permissionMode === 'edit');
    expect(args.includes('--no-ask-user')).toBe(permissionMode === 'edit');
  });

  it('returns readonly CLI errors without retrying with elevated permissions', async () => {
    mockSpawnWithScenario({ stderr: 'tool permission configuration failed', code: 1 });

    const result = await callCopilot('verifier', 'read verification.txt', {
      cwd: '/repo',
      permissionMode: 'readonly',
      internalAgentIsolation: 'strict-readonly',
    });

    expect(result.status).toBe('error');
    expect(result.error).toContain('tool permission configuration failed');
    expect(mockSpawn).toHaveBeenCalledOnce();
    const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
    expect(args).toContain('--deny-tool=write');
    expect(args).toContain('--deny-tool=shell');
    expect(args).not.toContain('--yolo');
    expect(mockRm).toHaveBeenCalledWith('/tmp/takt-copilot-XXXXXX', { recursive: true, force: true });
  });

  it('should not inject COPILOT_GITHUB_TOKEN when copilotGithubToken is undefined', async () => {
    mockSpawnWithScenario({
      stdout: 'done',
      code: 0,
    });

    const result = await callCopilot('coder', 'implement feature', {
      cwd: '/repo',
    });

    expect(result.status).toBe('done');

    const [, , options] = mockSpawn.mock.calls[0] as [string, string[], { env?: NodeJS.ProcessEnv }];
    expect(options.env).not.toBe(process.env);
    expect(options.env?.COPILOT_GITHUB_TOKEN).toBeUndefined();
  });

  it('passes only run-local observability snapshot to copilot child env', async () => {
    process.env.TAKT_OBSERVABILITY = '{"enabled":false}';
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://ambient-user:pass@collector.example.test';
    mockSpawnWithScenario({
      stdout: 'done',
      code: 0,
    });

    await callCopilot('coder', 'implement feature', {
      cwd: '/repo',
      childProcessEnv: {
        TAKT_OBSERVABILITY: '{"enabled":true}',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://snapshot-collector.example.test',
      },
    });

    const [, , options] = mockSpawn.mock.calls[0] as [string, string[], { env?: NodeJS.ProcessEnv }];
    expect(options.env?.TAKT_OBSERVABILITY).toBe('{"enabled":true}');
    expect(options.env?.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('https://snapshot-collector.example.test');
  });

  it('should use custom CLI path when copilotCliPath is specified', async () => {
    mockSpawnWithScenario({
      stdout: 'done',
      code: 0,
    });

    await callCopilot('coder', 'implement', {
      cwd: '/repo',
      copilotCliPath: '/custom/bin/copilot',
    });

    const [command] = mockSpawn.mock.calls[0] as [string];
    expect(command).toBe('/custom/bin/copilot');
  });

  it('should not include --autopilot or --max-autopilot-continues flags', async () => {
    mockSpawnWithScenario({
      stdout: 'done',
      code: 0,
    });

    await callCopilot('coder', 'implement', {
      cwd: '/repo',
      permissionMode: 'readonly',
    });

    const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
    expect(args).not.toContain('--max-autopilot-continues');
    expect(args).not.toContain('--autopilot');
  });

  it('should prepend system prompt to user prompt', async () => {
    mockSpawnWithScenario({
      stdout: 'reviewed',
      code: 0,
    });

    const systemPrompt = 'custom system prompt';
    const userPrompt = 'custom user prompt';
    await callCopilot('reviewer', userPrompt, {
      cwd: '/repo',
      systemPrompt,
    });

    const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
    const promptIndex = args.indexOf('-p');
    expect(promptIndex).toBeGreaterThan(-1);
    expect(args[promptIndex + 1]).toBe(`${systemPrompt}\n\n${userPrompt}`);
  });

  it('should return structured error when copilot binary is not found', async () => {
    mockSpawnWithScenario({
      error: { code: 'ENOENT', message: 'spawn copilot ENOENT' },
    });

    const result = await callCopilot('coder', 'implement feature', { cwd: '/repo' });

    expect(result.status).toBe('error');
    expect(result.content).toContain('copilot binary not found');
    expect(result.content).toContain('npm install -g @github/copilot');
  });

  it('should classify authentication errors', async () => {
    mockSpawnWithScenario({
      code: 1,
      stderr: 'Authentication required. Not logged in.',
    });

    const result = await callCopilot('coder', 'implement feature', { cwd: '/repo' });

    expect(result.status).toBe('error');
    expect(result.content).toContain('Copilot authentication failed');
    expect(result.content).toContain('TAKT_COPILOT_GITHUB_TOKEN');
  });

  it('should classify a session.error rate limit after eight retries', async () => {
    vi.useFakeTimers();
    const filler = JSON.stringify({ type: 'session.mcp_server_status_changed', data: { padding: 'x'.repeat(2000) } });
    const sessionError = JSON.stringify({
      type: 'session.error',
      data: {
        errorType: 'rate_limit',
        errorCode: 'rate_limited',
        message: "You've hit your rate limit. Please wait for your limit to reset in 4 hours 23 minutes.",
        statusCode: 429,
      },
    });
    mockSpawnWithScenario({ code: 1, stdout: `${filler}\n${sessionError}\n` });

    const pending = callCopilot('coder', 'implement feature', { cwd: '/repo' });
    await vi.advanceTimersByTimeAsync(121_000);
    const result = await pending;

    expect(result.status).toBe('rate_limited');
    expect(result.errorKind).toBe('rate_limit');
    expect(result.error).toContain("You've hit your rate limit");
    expect(result.rateLimitInfo?.provider).toBe('copilot');
    expect(mockSpawn).toHaveBeenCalledTimes(9);
  });

  it('should exhaust eight capped delays before returning a stderr rate limit', async () => {
    vi.useFakeTimers();
    mockSpawnWithScenario({
      code: 1,
      stderr: 'Error: Rate limit exceeded after 5 retries. Please try again later.',
    });

    const onStream = vi.fn();
    const pending = callCopilot('coder', 'implement feature', { cwd: '/repo', onStream });
    await vi.advanceTimersByTimeAsync(0);
    for (const [index, delay] of [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000].entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(mockSpawn).toHaveBeenCalledTimes(index + 1);
      expect(onStream.mock.calls.filter(([event]) => event.type === 'result')).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(mockSpawn).toHaveBeenCalledTimes(index + 2);
    }
    const result = await pending;

    expect(result.status).toBe('rate_limited');
    expect(result.error).toContain('Rate limit exceeded');
    expect(result.errorKind).toBe('rate_limit');
    expect(onStream.mock.calls.filter(([event]) => event.type === 'result')).toHaveLength(1);
  });

  it.each(['statusCode', 'errorType', 'errorCode', 'stderr'] as const)(
    '%s の429を2回再試行し実行制約と成功結果を保持する', async (channel) => {
      vi.useFakeTimers();
      const failure = channel === 'stderr'
        ? { code: 1, stderr: 'HTTP 429: Too Many Requests' }
        : { code: 1, stdout: `${JSON.stringify({ type: 'session.error', data: {
          [channel]: channel === 'statusCode' ? 429 : channel === 'errorType' ? 'rate_limit' : 'rate_limited',
          message: 'request rejected',
        } })}\n` };
      mockSpawnWithScenario([failure, failure, { stdout: 'final answer' }]);
      const onStream = vi.fn();
      const pending = callCopilot('coder', 'original prompt', {
        cwd: '/repo', model: 'claude-sonnet-4.6', sessionId: 'original-session', permissionMode: 'readonly',
        preparedMcp: { args: ['--additional-mcp-config=@/tmp/mcp.json'], dispose: vi.fn(async () => {}) }, onStream,
      });
      await vi.advanceTimersByTimeAsync(999);
      expect(mockSpawn).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(mockSpawn).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1999);
      expect(mockSpawn).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      const result = await pending;
      expect(result).toMatchObject({ status: 'done', content: 'final answer' });
      expect(result.errorKind).toBeUndefined();
      expect(mockSpawn).toHaveBeenCalledTimes(3);
      for (const [, args] of mockSpawn.mock.calls) {
        expect(args).toEqual(expect.arrayContaining([
          '-p', 'original prompt', '--model', 'claude-sonnet-4.6', '--resume', 'original-session',
          '--allow-tool=read', '--deny-tool=write', '--deny-tool=shell', '--additional-mcp-config=@/tmp/mcp.json',
        ]));
        expect(args).not.toContain('--yolo');
        expect(args).not.toContain('--allow-all-tools');
      }
      const results = onStream.mock.calls.filter(([event]) => event.type === 'result');
      expect(results).toHaveLength(1);
      expect(results[0]?.[0].data.success).toBe(true);
      expect(mockRm).toHaveBeenCalled();
    },
  );

  it('終了コード0でもsession.errorの429を部分回答より優先して再試行する', async () => {
    vi.useFakeTimers();
    const throttled = [
      { type: 'assistant.message', data: { content: 'partial answer' } },
      { type: 'session.error', data: { statusCode: 429, message: 'request rejected' } },
    ].map((event) => JSON.stringify(event)).join('\n');
    mockSpawnWithScenario([
      { code: 0, stdout: `${throttled}\n` },
      { code: 0, stdout: `${throttled}\n` },
      { code: 0, stdout: 'final answer' },
    ]);
    const onStream = vi.fn();
    const pending = callCopilot('coder', 'original prompt', { cwd: '/repo', onStream });
    await vi.advanceTimersByTimeAsync(3_000);

    expect(await pending).toMatchObject({ status: 'done', content: 'final answer' });
    expect(mockSpawn).toHaveBeenCalledTimes(3);
    expect(onStream.mock.calls.filter(([event]) => event.type === 'result')).toEqual([
      [expect.objectContaining({ data: expect.objectContaining({ success: true, result: 'final answer' }) })],
    ]);
  });

  it('終了コード0の429でもstderrが利用枠の使い切りを示せば再試行しない', async () => {
    vi.useFakeTimers();
    mockSpawnWithScenario([
      {
        code: 0,
        stdout: `${JSON.stringify({ type: 'session.error', data: { statusCode: 429, message: 'request rejected' } })}\n`,
        stderr: 'Your workspace is out of credits. Add credits to continue.',
      },
      { stdout: 'unexpected retry' },
    ]);

    const pending = callCopilot('coder', 'prompt', { cwd: '/repo' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await pending).toMatchObject({ status: 'rate_limited', content: '', errorKind: 'rate_limit' });
    expect(mockSpawn).toHaveBeenCalledOnce();
  });

  it('成功時のstderrに利用枠の警告があっても回答を返す', async () => {
    mockSpawnWithScenario({
      code: 0,
      stdout: `${JSON.stringify({ type: 'assistant.message', data: { content: 'final answer' } })}\n`,
      stderr: 'Your workspace is out of credits. Add credits to continue.',
    });

    expect(await callCopilot('coder', 'prompt', { cwd: '/repo' })).toMatchObject({
      status: 'done', content: 'final answer',
    });
    expect(mockSpawn).toHaveBeenCalledOnce();
  });

  it.each([
    { event: 'tool.execution_start', code: 0 },
    { event: 'tool.execution_complete', code: 0 },
    { event: 'tool.execution_start', code: 1 },
    { event: 'tool.execution_complete', code: 1 },
  ] as const)('$eventの後に終了コード$codeで429が起きたら同じ操作を再実行しない', async ({ event, code }) => {
    vi.useFakeTimers();
    const tool = JSON.stringify({ type: event, data: { toolCallId: 'write-1', toolName: 'write' } });
    const throttled = JSON.stringify({ type: 'session.error', data: { statusCode: 429, message: 'request rejected' } });
    mockSpawnWithScenario([
      { code, stdout: `${tool}\n${throttled}\n` },
      { stdout: 'duplicate operation' },
    ]);

    const pending = callCopilot('coder', 'edit file', { cwd: '/repo' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await pending).toMatchObject({ status: 'rate_limited', errorKind: 'rate_limit' });
    expect(mockSpawn).toHaveBeenCalledOnce();
  });

  it('改行前のツール実行イベントも異常終了時に保持して429の再試行を防ぐ', async () => {
    vi.useFakeTimers();
    const tool = JSON.stringify({ type: 'tool.execution_complete', data: { toolCallId: 'shell-1', toolName: 'shell' } });
    mockSpawnWithScenario([
      { code: 1, stdout: tool, stderr: 'HTTP 429: Too Many Requests' },
      { stdout: 'duplicate operation' },
    ]);

    const pending = callCopilot('coder', 'run shell', { cwd: '/repo' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await pending).toMatchObject({ status: 'rate_limited', errorKind: 'rate_limit' });
    expect(mockSpawn).toHaveBeenCalledOnce();
  });

  it('429で失敗した試行のshareセッションを成功結果へ混入させない', async () => {
    vi.useFakeTimers();
    const shareFiles = new Map<string, string>();
    mockMkdtemp.mockImplementation(async () => `/tmp/takt-copilot-attempt-${mockMkdtemp.mock.calls.length}`);
    mockReadFile.mockImplementation(async (path: string) => {
      const content = shareFiles.get(path);
      if (content === undefined) throw Object.assign(new Error('share file missing'), { code: 'ENOENT' });
      return content;
    });
    mockRm.mockImplementation(async (directory: string) => {
      for (const path of shareFiles.keys()) if (path.startsWith(`${directory}/`)) shareFiles.delete(path);
    });
    mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
      const child = createMockChildProcess();
      const attempt = mockSpawn.mock.calls.length;
      const share = args[args.indexOf('--share') + 1];
      if (attempt === 1) shareFiles.set(share!, '> **Session ID:** `aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`');
      queueMicrotask(() => {
        if (attempt === 1) child.stderr.emit('data', Buffer.from('HTTP 429: Too Many Requests'));
        else child.stdout.emit('data', Buffer.from(`${JSON.stringify({ type: 'result', sessionId: 'final-session', data: { result: 'final answer' } })}\n`));
        child.emit('close', attempt === 1 ? 1 : 0, null);
      });
      return child;
    });
    const pending = callCopilot('coder', 'prompt', { cwd: '/repo' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toMatchObject({ status: 'done', content: 'final answer', sessionId: 'final-session' });
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    expect(shareFiles.size).toBe(0);
  });

  it.each([
    'usage_limit_exceeded',
    'HTTP 429: Your workspace is out of credits. Add credits to continue.',
    'You hit your spend cap set in your workspace. Increase your spend cap to continue. HTTP 429',
  ])('構造化429と使い切りが混在したら即終了する: %s', async (message) => {
    mockSpawnWithScenario({ code: 1, stdout: `${JSON.stringify({ type: 'session.error', data: { statusCode: 429, message } })}\n` });
    expect(await callCopilot('coder', 'prompt', { cwd: '/repo' })).toMatchObject({ status: 'rate_limited', content: '', errorKind: 'rate_limit' });
    expect(mockSpawn).toHaveBeenCalledOnce();
  });

  it.each([
    { channel: 'session.error', exhausted: true },
    { channel: 'session.error', exhausted: false },
    { channel: 'stderr', exhausted: true },
    { channel: 'stderr', exhausted: false },
    { channel: 'combined', exhausted: true },
    { channel: 'combined', exhausted: false },
  ])('$channelの週次上限は即終了し一般的な429は再試行する (exhausted=$exhausted)', async ({ channel, exhausted }) => {
    vi.useFakeTimers();
    const message = exhausted ? "You've reached your weekly rate limit" : 'request rejected';
    const failure: SpawnScenario = {
      code: 1,
      stdout: channel === 'stderr' ? undefined : `${JSON.stringify({
        type: 'session.error',
        data: { errorType: 'rate_limit', statusCode: 429, message: channel === 'combined' ? 'request rejected' : message },
      })}\n`,
      stderr: channel === 'stderr' ? `HTTP 429: ${exhausted ? message : 'Too Many Requests'}`
        : channel === 'combined' && exhausted ? message : undefined,
    };
    mockSpawnWithScenario([failure, { stdout: 'final answer' }]);
    const onStream = vi.fn();

    const pending = callCopilot('coder', 'prompt', { cwd: '/repo', onStream });
    await vi.advanceTimersByTimeAsync(0);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    if (exhausted) {
      const results = onStream.mock.calls.filter(([event]) => event.type === 'result');
      expect(results).toHaveLength(1);
      expect(results[0]?.[0].data).toMatchObject({ success: false, result: '', error: expect.stringContaining(message) });
      const result = await pending;
      expect(result).toMatchObject({ status: 'rate_limited', content: '', errorKind: 'rate_limit' });
      expect(result.error).toContain(message);
      expect(mockRm).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(121_000);
      expect(mockSpawn).toHaveBeenCalledTimes(1);
    } else {
      await vi.advanceTimersByTimeAsync(999);
      expect(mockSpawn).toHaveBeenCalledTimes(1);
      expect(onStream.mock.calls.filter(([event]) => event.type === 'result')).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      const result = await pending;
      expect(result).toMatchObject({ status: 'done', content: 'final answer' });
      expect(result.errorKind).toBeUndefined();
      expect(mockSpawn).toHaveBeenCalledTimes(2);
      const results = onStream.mock.calls.filter(([event]) => event.type === 'result');
      expect(results).toHaveLength(1);
      expect(results[0]?.[0].data.success).toBe(true);
    }
  });

  it('成功したassistant.messageの週次上限文言を通常の本文として返す', async () => {
    const content = "You've reached your weekly rate limit";
    mockSpawnWithScenario({ code: 0, stdout: `${JSON.stringify({ type: 'assistant.message', data: { content } })}\n` });

    const result = await callCopilot('coder', 'prompt', { cwd: '/repo' });

    expect(result).toMatchObject({ status: 'done', content });
    expect(result.errorKind).toBeUndefined();
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it.each(['usage_limit_exceeded', "You've reached your weekly rate limit"])(
    '429の再試行中に使い切りを受けたら追加起動しない: %s', async (message) => {
      vi.useFakeTimers();
      mockSpawnWithScenario(['HTTP 429: Too Many Requests', `HTTP 429: ${message}`].map((stderr) => ({ code: 1, stderr })));
      const onStream = vi.fn();
      const pending = callCopilot('coder', 'prompt', { cwd: '/repo', onStream });
      await vi.advanceTimersByTimeAsync(1000);
      expect(onStream.mock.calls.filter(([event]) => event.type === 'result')).toHaveLength(1);
      expect(await pending).toMatchObject({ status: 'rate_limited', errorKind: 'rate_limit' });
      await vi.advanceTimersByTimeAsync(121_000);
      expect(mockSpawn).toHaveBeenCalledTimes(2);
    },
  );

  it('429の待機中に中断したら追加起動せず一時資源を解放する', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    mockSpawnWithScenario({ code: 1, stderr: 'HTTP 429: Too Many Requests' });
    const pending = callCopilot('coder', 'prompt', { cwd: '/repo', abortSignal: controller.signal });
    await vi.advanceTimersByTimeAsync(500);
    controller.abort();
    await vi.advanceTimersByTimeAsync(121_000);
    const result = await pending;
    expect(result.status).toBe('error');
    expect(result.error).toContain('aborted');
    expect(mockSpawn).toHaveBeenCalledOnce();
    expect(mockRm).toHaveBeenCalled();
  });

  it('should keep non rate limit session.error exits as error', async () => {
    const sessionError = JSON.stringify({
      type: 'session.error',
      data: { errorType: 'model', errorCode: 'model_unavailable', message: 'model unavailable', statusCode: 400 },
    });
    mockSpawnWithScenario({ code: 1, stdout: `${sessionError}\n` });

    const result = await callCopilot('coder', 'implement feature', { cwd: '/repo' });

    expect(result.status).toBe('error');
  });

  it.each([
    {
      label: '実出力どおりの3フィールド',
      data: {
        errorType: 'quota',
        errorCode: 'quota_exceeded',
        message: 'You have exceeded your monthly quota (Request ID: 0000:1111:2222:3333)',
        statusCode: 402,
      },
    },
    { label: 'statusCode 402 (数値) のみ', data: { statusCode: 402, message: 'request rejected: quota' } },
    { label: "statusCode '402' (文字列) のみ", data: { statusCode: '402', message: 'request rejected: quota' } },
    { label: "errorType 'quota' のみ", data: { errorType: 'quota', message: 'request rejected: quota' } },
    { label: "errorCode 'quota_exceeded' のみ", data: { errorCode: 'quota_exceeded', message: 'request rejected: quota' } },
    {
      label: "statusCode 402 と errorType 'rate_limit' の混在",
      data: { statusCode: 402, errorType: 'rate_limit', message: 'request rejected: quota' },
    },
  ])('終了コード1のsession.errorが月間クォータ切れを示したら再試行せずrate_limitedを返す: $label', async ({ data }) => {
    vi.useFakeTimers();
    mockSpawnWithScenario([
      { code: 1, stdout: `${JSON.stringify({ type: 'session.error', data })}\n` },
      { stdout: 'unexpected retry' },
    ]);
    const onStream = vi.fn();

    const pending = callCopilot('coder', 'implement feature', { cwd: '/repo', onStream });
    await vi.advanceTimersByTimeAsync(121_000);
    const result = await pending;

    expect(result.status).toBe('rate_limited');
    expect(result.errorKind).toBe('rate_limit');
    expect(result.content).toBe('');
    expect(result.error).toContain(data.message);
    expect(result.rateLimitInfo?.provider).toBe('copilot');
    const results = onStream.mock.calls.filter(([event]) => event.type === 'result');
    expect(results).toHaveLength(1);
    expect(results[0]?.[0].data).toMatchObject({ success: false, error: expect.stringContaining(data.message) });
    expect(mockSpawn).toHaveBeenCalledOnce();
  });

  it('終了コード0でもsession.errorの月間クォータ切れを再試行せずrate_limitedを返す', async () => {
    vi.useFakeTimers();
    const message = 'You have exceeded your monthly quota (Request ID: 0000:1111:2222:3333)';
    const quotaExceeded = [
      { type: 'assistant.message', data: { content: 'partial answer' } },
      { type: 'session.error', data: { errorType: 'quota', errorCode: 'quota_exceeded', message, statusCode: 402 } },
    ].map((event) => JSON.stringify(event)).join('\n');
    mockSpawnWithScenario([
      { code: 0, stdout: `${quotaExceeded}\n` },
      { code: 0, stdout: 'unexpected retry' },
    ]);

    const pending = callCopilot('coder', 'implement feature', { cwd: '/repo' });
    await vi.advanceTimersByTimeAsync(121_000);
    const result = await pending;

    expect(result.status).toBe('rate_limited');
    expect(result.errorKind).toBe('rate_limit');
    expect(result.content).toBe('');
    expect(result.error).toContain(message);
    expect(result.rateLimitInfo?.provider).toBe('copilot');
    expect(mockSpawn).toHaveBeenCalledOnce();
  });

  it('429のsession.errorの後に月間クォータ切れのsession.errorが続いたら使い切りを優先して再試行しない', async () => {
    vi.useFakeTimers();
    const message = 'You have exceeded your monthly quota (Request ID: 0000:1111:2222:3333)';
    const errors = [
      { type: 'session.error', data: { errorType: 'rate_limit', statusCode: 429, message: 'request rejected' } },
      { type: 'session.error', data: { errorType: 'quota', errorCode: 'quota_exceeded', message, statusCode: 402 } },
    ].map((event) => JSON.stringify(event)).join('\n');
    mockSpawnWithScenario([
      { code: 1, stdout: `${errors}\n` },
      { stdout: 'unexpected retry' },
    ]);

    const pending = callCopilot('coder', 'implement feature', { cwd: '/repo' });
    await vi.advanceTimersByTimeAsync(121_000);
    const result = await pending;

    expect(result.status).toBe('rate_limited');
    expect(result.errorKind).toBe('rate_limit');
    expect(result.error).toContain(message);
    expect(mockSpawn).toHaveBeenCalledOnce();
  });

  it('session.errorがなくstderrに402やquotaの文言があるだけならerrorのままにする', async () => {
    mockSpawnWithScenario({ code: 1, stderr: 'HTTP 402: You have exceeded your monthly quota' });

    const result = await callCopilot('coder', 'implement feature', { cwd: '/repo' });

    expect(result.status).toBe('error');
    expect(result.errorKind).toBeUndefined();
    expect(mockSpawn).toHaveBeenCalledOnce();
  });

  it('should classify non-zero exits with detail', async () => {
    mockSpawnWithScenario({
      code: 2,
      stderr: 'unexpected failure',
    });

    const result = await callCopilot('coder', 'implement feature', { cwd: '/repo' });

    expect(result.status).toBe('error');
    expect(result.content).toContain('code 2');
    expect(result.content).toContain('unexpected failure');
  });

  it('should distinguish signal termination from a numeric exit code', async () => {
    mockSpawnWithScenario({
      code: null,
      signal: 'SIGTERM',
    });

    const result = await callCopilot('coder', 'implement feature', { cwd: '/repo' });

    expect(result.status).toBe('error');
    expect(result.content).toContain('signal SIGTERM');
    expect(result.content).not.toContain('code 0');
  });

  it('should report a close event with neither code nor signal', async () => {
    mockSpawnWithScenario({
      code: null,
      signal: null,
    });

    const result = await callCopilot('coder', 'implement feature', { cwd: '/repo' });

    expect(result.status).toBe('error');
    expect(result.content).toContain('no exit code or signal');
    expect(result.content).not.toContain('unknown');
  });

  it('should return error when stdout is empty', async () => {
    mockSpawnWithScenario({
      stdout: '',
      code: 0,
    });

    const result = await callCopilot('coder', 'implement feature', { cwd: '/repo' });

    expect(result.status).toBe('error');
    expect(result.content).toContain('copilot returned empty output');
  });

  it('should emit a failed result onStream event when stdout is empty', async () => {
    mockSpawnWithScenario({
      stdout: '',
      code: 0,
    });

    const onStream = vi.fn();
    const result = await callCopilot('coder', 'implement feature', {
      cwd: '/repo',
      onStream,
    });

    expect(result.status).toBe('error');
    expect(result.content).toContain('copilot returned empty output');
    expect(onStream).toHaveBeenCalledTimes(1);
    expect(onStream).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'result',
        data: expect.objectContaining({
          success: false,
        }),
      }),
    );
  });

  it('should return plain text content (no JSON parsing needed)', async () => {
    const output = 'Here is the implementation:\n\n```typescript\nconsole.log("hello");\n```';
    mockSpawnWithScenario({
      stdout: output,
      code: 0,
    });

    const result = await callCopilot('coder', 'implement feature', { cwd: '/repo' });

    expect(result.status).toBe('done');
    expect(result.content).toBe(output);
  });

  it('should call onStream callback with text and result events on success', async () => {
    mockSpawnWithScenario({
      stdout: 'stream content',
      code: 0,
    });

    const onStream = vi.fn();
    await callCopilot('coder', 'implement', {
      cwd: '/repo',
      onStream,
    });

    expect(onStream).toHaveBeenCalledTimes(2);
    expect(onStream).toHaveBeenNthCalledWith(1, {
      type: 'text',
      data: { text: 'stream content' },
    });
    expect(onStream).toHaveBeenNthCalledWith(2, {
      type: 'result',
      data: expect.objectContaining({
        result: 'stream content',
        success: true,
      }),
    });
  });

  it('should call onStream callback with error result on failure', async () => {
    mockSpawnWithScenario({
      error: { code: 'ENOENT', message: 'spawn copilot ENOENT' },
    });

    const onStream = vi.fn();
    await callCopilot('coder', 'implement', {
      cwd: '/repo',
      onStream,
    });

    expect(onStream).toHaveBeenCalledWith({
      type: 'result',
      data: expect.objectContaining({
        success: false,
        error: expect.stringContaining('copilot binary not found'),
      }),
    });
  });

  it('should handle abort signal', async () => {
    const controller = new AbortController();

    mockSpawn.mockImplementation(() => {
      const child = createMockChildProcess();

      queueMicrotask(() => {
        controller.abort();
        child.emit('close', null, 'SIGTERM');
      });

      return child;
    });

    const result = await callCopilot('coder', 'implement', {
      cwd: '/repo',
      abortSignal: controller.signal,
    });

    expect(result.status).toBe('error');
    expect(result.content).toContain('Copilot execution aborted');
  });

  it('should report abort even when stderr already contains rate limit text', async () => {
    const controller = new AbortController();

    mockSpawn.mockImplementation(() => {
      const child = createMockChildProcess();

      queueMicrotask(() => {
        child.stderr.emit('data', Buffer.from('Rate limit exceeded, retrying (1/5)', 'utf-8'));
        controller.abort();
        child.emit('close', null, 'SIGTERM');
      });

      return child;
    });

    const result = await callCopilot('coder', 'implement', {
      cwd: '/repo',
      abortSignal: controller.signal,
    });

    expect(result.status).toBe('error');
    expect(result.content).toContain('Copilot execution aborted');
  });

  it('should fall back to options.sessionId when share file extraction fails', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT'));
    mockSpawnWithScenario({
      stdout: 'done',
      code: 0,
    });

    const result = await callCopilot('coder', 'implement', {
      cwd: '/repo',
      sessionId: 'fallback-session-id',
    });

    expect(result.status).toBe('done');
    expect(result.sessionId).toBe('fallback-session-id');
    expect(mockRm).toHaveBeenCalledWith('/tmp/takt-copilot-XXXXXX', { recursive: true, force: true });
  });

  it('should extract session ID from --share file on success', async () => {
    mockReadFile.mockResolvedValue(
      '# Session\n\n> **Session ID:** `12345678-abcd-1234-ef01-123456789012`\n',
    );
    mockSpawnWithScenario({
      stdout: 'hello',
      code: 0,
    });

    const result = await callCopilot('coder', 'implement', {
      cwd: '/repo',
    });

    expect(result.status).toBe('done');
    expect(result.sessionId).toBe('12345678-abcd-1234-ef01-123456789012');
  });

  it('should terminate, force-kill, await close, and clean up once when stdout overflows', async () => {
    vi.stubEnv('TAKT_COPILOT_FORCE_KILL_DELAY_MS', '10');
    let child: MockChildProcess | undefined;
    mockSpawn.mockImplementation(() => {
      child = createMockChildProcess();
      queueMicrotask(() => {
        child!.stdout.emit('data', Buffer.alloc(10 * 1024 * 1024 + 1));
      });
      return child;
    });
    let settled = false;
    const call = callCopilot('coder', 'implement', { cwd: '/repo' });
    void call.finally(() => {
      settled = true;
    });

    await vi.waitFor(() => expect(child?.kill).toHaveBeenCalledWith('SIGTERM'));
    expect(settled).toBe(false);
    expect(mockRm).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(child?.kill).toHaveBeenCalledWith('SIGKILL'));
    child?.emit('close', null, 'SIGKILL');
    const result = await call;

    expect(result.status).toBe('error');
    expect(result.content).toContain('Copilot CLI output exceeded buffer limit');
    expect(mockRm).toHaveBeenCalledTimes(1);
  });

  it('should await close before cleaning up when stderr overflows', async () => {
    let child: MockChildProcess | undefined;
    mockSpawn.mockImplementation(() => {
      child = createMockChildProcess();
      queueMicrotask(() => {
        child!.stderr.emit('data', Buffer.alloc(10 * 1024 * 1024 + 1));
      });
      return child;
    });
    let settled = false;
    const call = callCopilot('coder', 'implement', { cwd: '/repo' });
    void call.finally(() => {
      settled = true;
    });

    await vi.waitFor(() => expect(child?.kill).toHaveBeenCalledWith('SIGTERM'));
    expect(settled).toBe(false);
    expect(mockRm).not.toHaveBeenCalled();
    child?.emit('close', null, 'SIGTERM');
    const result = await call;

    expect(result.status).toBe('error');
    expect(result.content).toContain('Copilot CLI output exceeded buffer limit');
    expect(mockRm).toHaveBeenCalledTimes(1);
  });

  it('should return error when abort signal is already aborted before call', async () => {
    const controller = new AbortController();
    controller.abort();

    mockSpawn.mockImplementation(() => {
      const child = createMockChildProcess();
      queueMicrotask(() => {
        child.emit('close', null, 'SIGTERM');
      });
      return child;
    });

    const result = await callCopilot('coder', 'implement', {
      cwd: '/repo',
      abortSignal: controller.signal,
    });

    expect(result.status).toBe('error');
    expect(result.content).toContain('Copilot execution aborted');
  });

  it('should proceed without session extraction when mkdtemp fails', async () => {
    mockMkdtemp.mockRejectedValue(new Error('ENOSPC'));
    mockSpawnWithScenario({
      stdout: 'done',
      code: 0,
    });

    const result = await callCopilot('coder', 'implement', {
      cwd: '/repo',
      sessionId: 'existing-session-id',
    });

    expect(result.status).toBe('done');
    expect(result.sessionId).toBe('existing-session-id');
  });

  it('should create a missing TMPDIR before preparing the share file', async () => {
    const originalTmpDir = process.env.TMPDIR;
    const parentDir = mkdtempSync(join(tmpdir(), 'takt-copilot-missing-tmp-parent-'));
    const missingTmpDir = join(parentDir, 'missing', 'tmp');
    process.env.TMPDIR = missingTmpDir;
    mockMkdtemp.mockImplementationOnce(async (prefix: string) => {
      expect(prefix).toBe(join(missingTmpDir, 'takt-copilot-'));
      expect(existsSync(missingTmpDir)).toBe(true);
      return join(missingTmpDir, 'takt-copilot-share');
    });
    mockSpawnWithScenario({
      stdout: 'done',
      code: 0,
    });

    try {
      const result = await callCopilot('coder', 'implement feature', { cwd: '/repo' });

      expect(result.status).toBe('done');
      expect(mockMkdtemp).toHaveBeenCalledWith(join(missingTmpDir, 'takt-copilot-'));
    } finally {
      if (originalTmpDir === undefined) {
        delete process.env.TMPDIR;
      } else {
        process.env.TMPDIR = originalTmpDir;
      }
      rmSync(parentDir, { recursive: true, force: true });
    }
  });

  it('should continue without --share when TMPDIR cannot be created', async () => {
    const originalTmpDir = process.env.TMPDIR;
    const parentDir = mkdtempSync(join(tmpdir(), 'takt-copilot-invalid-tmp-parent-'));
    const fileTmpDir = join(parentDir, 'tmp-file');
    writeFileSync(fileTmpDir, 'not a directory\n', 'utf-8');
    process.env.TMPDIR = fileTmpDir;
    mockSpawnWithScenario({
      stdout: 'done',
      code: 0,
    });

    try {
      const result = await callCopilot('coder', 'implement feature', { cwd: '/repo' });
      const [, args] = mockSpawn.mock.calls[0] as [string, string[]];

      expect(result.status).toBe('done');
      expect(mockMkdtemp).not.toHaveBeenCalled();
      expect(mockSpawn).toHaveBeenCalledTimes(1);
      expect(args).not.toContain('--share');
    } finally {
      if (originalTmpDir === undefined) {
        delete process.env.TMPDIR;
      } else {
        process.env.TMPDIR = originalTmpDir;
      }
      rmSync(parentDir, { recursive: true, force: true });
    }
  });

  it('should redact credentials from error stderr', async () => {
    mockSpawnWithScenario({
      code: 2,
      stderr: 'config error: secret ghp_abcdefghijklmnopqrstuvwxyz1234567890 is wrong',
    });

    const result = await callCopilot('coder', 'implement', { cwd: '/repo' });

    expect(result.status).toBe('error');
    expect(result.content).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz1234567890');
    expect(result.content).toContain('[REDACTED]');
  });

  it('streams complete JSONL events before process completion and flushes the final partial line once', async () => {
    const child = createMockChildProcess();
    mockSpawn.mockReturnValue(child);
    const onStream = vi.fn();
    const call = callCopilot('coder', 'inspect task', { cwd: '/repo', onStream });
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledOnce());
    try {
      const toolUse = JSON.stringify({ type: 'tool.execution_start', data: {
        toolCallId: 'tool-1', toolName: 'takt_get_run', arguments: { runSlug: 'selected-run' },
      } });
      child.stdout.emit('data', Buffer.from(toolUse.slice(0, 30)));
      expect(onStream).not.toHaveBeenCalled();
      child.stdout.emit('data', Buffer.from(`${toolUse.slice(30)}\n`));
      expect(onStream).toHaveBeenCalledWith({ type: 'tool_use', data: {
        id: 'tool-1', tool: 'takt_get_run', input: { runSlug: 'selected-run' },
      } });
      const delta = Buffer.from(JSON.stringify({ type: 'assistant.message_delta', data: { deltaContent: '答え' } }) + '\n');
      const split = delta.indexOf(Buffer.from('答')) + 1;
      child.stdout.emit('data', delta.subarray(0, split));
      child.stdout.emit('data', delta.subarray(split));
      expect(onStream).toHaveBeenCalledWith({ type: 'text', data: { text: '答え' } });
      child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'tool.execution_complete', data: {
        toolCallId: 'tool-1', success: true, result: { content: 'run details' },
      } })));
      expect(onStream.mock.calls.filter(([event]) => event.type === 'tool_result')).toHaveLength(0);
    } finally {
      child.emit('close', 0, null);
    }
    const result = await call;

    expect(result).toMatchObject({ status: 'done', content: '答え' });
    expect(onStream.mock.calls.map(([event]) => event.type)).toEqual(['tool_use', 'text', 'tool_result', 'result']);
    expect(onStream).toHaveBeenCalledWith({ type: 'tool_result', data: {
      id: 'tool-1', content: 'run details', isError: false,
    } });
  });

  it.each([
    { label: 'clean output', warning: '' },
    { label: 'a warning line', warning: 'Warning: update available\n' },
  ])('preserves Copilot JSONL tools and response with $label', async ({ warning }) => {
    const marker = formatTaskStateReferenceMarker('run-from-copilot');
    const onStream = vi.fn();
    mockReadFile.mockResolvedValue('No session ID in the share transcript.');
    mockSpawnWithScenario({
      stdout: warning + [
        JSON.stringify({
          type: 'tool.execution_start',
          data: {
            toolCallId: 'copilot-tool-1',
            toolName: 'mcp__takt__takt_get_run',
            mcpToolName: 'takt_get_run',
            arguments: { runSlug: 'run-from-copilot' },
          },
        }),
        JSON.stringify({
          type: 'tool.execution_complete',
          data: {
            toolCallId: 'copilot-tool-1',
            success: true,
            result: { content: `run details\n${marker}` },
          },
        }),
        JSON.stringify({
          type: 'assistant.message',
          data: { content: 'answer', sessionId: 'copilot-session' },
        }),
      ].join('\n'),
      code: 0,
    });

    const result = await callCopilot('coder', 'inspect task', { cwd: '/repo', onStream });

    expect(result).toMatchObject({ status: 'done', content: 'answer', sessionId: 'copilot-session' });
    expect(onStream).toHaveBeenCalledWith({
      type: 'tool_use',
      data: {
        id: 'copilot-tool-1',
        tool: 'takt_get_run',
        input: { runSlug: 'run-from-copilot' },
      },
    });
    expect(onStream).toHaveBeenCalledWith({
      type: 'tool_result',
      data: {
        id: 'copilot-tool-1',
        content: `run details\n${marker}`,
        isError: false,
      },
    });
  });
});

describe('extractSessionIdFromShareFile', () => {
  it('should extract UUID from standard share file format', () => {
    const content = '# 🤖 Copilot CLI Session\n\n> **Session ID:** `107256ee-226c-4677-bf55-7b6b158ddadf`\n';
    expect(extractSessionIdFromShareFile(content)).toBe('107256ee-226c-4677-bf55-7b6b158ddadf');
  });

  it('should return undefined for content without session ID', () => {
    expect(extractSessionIdFromShareFile('no session here')).toBeUndefined();
  });

  it('should return undefined for empty content', () => {
    expect(extractSessionIdFromShareFile('')).toBeUndefined();
  });
});

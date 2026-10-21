import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { mkdtempMock, chmodMock, writeFileMock, rmMock } = vi.hoisted(() => ({
  mkdtempMock: vi.fn<typeof import('node:fs/promises').mkdtemp>(),
  chmodMock: vi.fn<typeof import('node:fs/promises').chmod>(),
  writeFileMock: vi.fn<typeof import('node:fs/promises').writeFile>(),
  rmMock: vi.fn<typeof import('node:fs/promises').rm>(),
}));

const { assertClaudeSkillsDisableSupportedMock } = vi.hoisted(() => ({
  assertClaudeSkillsDisableSupportedMock: vi.fn(),
}));

const { prepareClaudeMcpConfigMock } = vi.hoisted(() => ({
  prepareClaudeMcpConfigMock: vi.fn(),
}));

vi.mock('../infra/claude/cli-capability.js', () => ({
  assertClaudeSkillsDisableSupported: assertClaudeSkillsDisableSupportedMock,
}));

vi.mock('../infra/claude/mcp-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../infra/claude/mcp-config.js')>();
  prepareClaudeMcpConfigMock.mockImplementation(actual.prepareClaudeMcpConfig);
  return {
    ...actual,
    prepareClaudeMcpConfig: (...args: Parameters<typeof actual.prepareClaudeMcpConfig>) =>
      prepareClaudeMcpConfigMock(...args),
  };
});

vi.mock('node:crypto', () => ({
  randomUUID: vi.fn(),
}));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    mkdtemp: mkdtempMock,
    chmod: chmodMock,
    writeFile: writeFileMock,
    rm: rmMock,
  };
});

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

// The Windows spawn path uses cross-spawn's CommonJS child_process import.
// Keep it on the same stub so these provider tests never launch a real CLI.
vi.mock('cross-spawn', () => ({
  default: (...args: Parameters<typeof spawn>) => spawn(...args),
}));

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { callClaudeHeadless } from '../infra/claude-headless/client.js';
import {
  HEADLESS_ABORTED_MESSAGE,
  runHeadlessCli,
} from '../infra/claude-headless/headless-spawn.js';
import type { ClaudeHeadlessCallOptions } from '../infra/claude-headless/types.js';

describe('callClaudeHeadless', () => {
  let lastArgv: string[] = [];
  let lastSpawnEnv: NodeJS.ProcessEnv | undefined;
  let lastKill: ReturnType<typeof vi.fn> | undefined;
  let capturedMcpConfigContent: string | undefined;
  let capturedMcpConfigMode: number | undefined;
  let capturedMcpConfigPath: string | undefined;

  beforeEach(() => {
    vi.mocked(spawn).mockReset();
    vi.mocked(randomUUID).mockReset();
    vi.mocked(randomUUID).mockReturnValue('11111111-1111-4111-8111-111111111111');
    mkdtempMock.mockReset();
    chmodMock.mockReset();
    writeFileMock.mockReset();
    rmMock.mockReset();
    assertClaudeSkillsDisableSupportedMock.mockReset();
    assertClaudeSkillsDisableSupportedMock.mockResolvedValue(undefined);
    mkdtempMock.mockImplementation(async (...args) => {
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      return actual.mkdtemp(...args);
    });
    chmodMock.mockImplementation(async (...args) => {
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      return actual.chmod(...args);
    });
    writeFileMock.mockImplementation(async (...args) => {
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      return actual.writeFile(...args);
    });
    rmMock.mockImplementation(async (...args) => {
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      return actual.rm(...args);
    });
    lastArgv = [];
    lastSpawnEnv = undefined;
    lastKill = undefined;
    capturedMcpConfigContent = undefined;
    capturedMcpConfigMode = undefined;
    capturedMcpConfigPath = undefined;
    delete process.env.TAKT_OBSERVABILITY;
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  });

  type SpawnPlan = {
    stdoutChunks?: string[];
    stderrChunks?: string[];
    closeCode?: number | null;
    closeSignal?: NodeJS.Signals | null;
    error?: NodeJS.ErrnoException;
    keepOpen?: boolean;
  };

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  function stubSpawn(plans: SpawnPlan | SpawnPlan[]): void {
    let attempt = 0;
    vi.mocked(spawn).mockImplementation((_cmd, _args, spawnOptions) => {
      const opts = Array.isArray(plans) ? plans[attempt++] : plans;
      if (opts === undefined) throw new Error('Missing headless spawn plan');
      lastArgv = [...(_args as string[])];
      lastSpawnEnv = spawnOptions?.env as NodeJS.ProcessEnv | undefined;
      const mcpIndex = lastArgv.indexOf('--mcp-config');
      if (mcpIndex >= 0) {
        capturedMcpConfigPath = lastArgv[mcpIndex + 1];
        capturedMcpConfigContent = readFileSync(capturedMcpConfigPath!, 'utf-8');
        capturedMcpConfigMode = statSync(capturedMcpConfigPath!).mode & 0o777;
      }
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const proc = new EventEmitter() as EventEmitter & Partial<ChildProcess>;
      proc.stdout = stdout;
      proc.stderr = stderr;
      lastKill = vi.fn();
      proc.kill = lastKill as unknown as ChildProcess['kill'];

      queueMicrotask(() => {
        if (opts.error) {
          proc.emit('error', opts.error);
          return;
        }
        for (const c of opts.stdoutChunks ?? []) {
          stdout.emit('data', Buffer.from(c, 'utf-8'));
        }
        for (const c of opts.stderrChunks ?? []) {
          stderr.emit('data', Buffer.from(c, 'utf-8'));
        }
        if (opts.keepOpen) {
          return;
        }
        const code = opts.closeCode === undefined ? 0 : opts.closeCode;
        proc.emit('close', code, opts.closeSignal ?? null);
      });

      return proc as ChildProcess;
    });
  }

  it('passes --disable-slash-commands for disabled Skills on a new headless session', async () => {
    stubSpawn({
      stdoutChunks: [`${JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' })}\n`],
    });

    await callClaudeHeadless('agent', 'hi', {
      cwd: '/tmp',
      skillsEnabled: false,
    });

    expect(assertClaudeSkillsDisableSupportedMock).toHaveBeenCalledWith('claude', undefined);
    expect(lastArgv).toContain('--disable-slash-commands');
    expect(lastArgv).toContain('--session-id');
  });

  it('passes --disable-slash-commands for disabled Skills when resuming a headless session', async () => {
    stubSpawn({
      stdoutChunks: [`${JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' })}\n`],
    });

    await callClaudeHeadless('agent', 'hi', {
      cwd: '/tmp',
      sessionId: 'existing-session',
      skillsEnabled: false,
    });

    expect(assertClaudeSkillsDisableSupportedMock).toHaveBeenCalledWith('claude', undefined);
    expect(lastArgv).toEqual(expect.arrayContaining(['--disable-slash-commands', '--resume', 'existing-session']));
  });

  it('does not add a Skill flag when headless Skills are enabled', async () => {
    stubSpawn({
      stdoutChunks: [`${JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' })}\n`],
    });

    await callClaudeHeadless('agent', 'hi', {
      cwd: '/tmp',
      skillsEnabled: true,
    });

    expect(assertClaudeSkillsDisableSupportedMock).not.toHaveBeenCalled();
    expect(lastArgv).not.toContain('--disable-slash-commands');
  });

  it('returns a provider error before spawning when Skills disable capability is unsupported', async () => {
    assertClaudeSkillsDisableSupportedMock.mockRejectedValue(
      new Error('Claude Code must support --disable-slash-commands.'),
    );

    const result = await callClaudeHeadless('agent', 'hi', {
      cwd: '/tmp',
      skillsEnabled: false,
      claudeCliPath: 'claude-unsupported',
    });

    expect(assertClaudeSkillsDisableSupportedMock).toHaveBeenCalledWith(
      'claude-unsupported',
      undefined,
    );
    expect(spawn).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: 'error',
      error: 'Claude Code must support --disable-slash-commands.',
    });
  });

  it('returns done when stream-json yields text and process exits 0', async () => {
    const onActivity = vi.fn();
    stubSpawn({
      stdoutChunks: [
        `${JSON.stringify({ type: 'text', text: 'ok' })}\n`,
        `${JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' })}\n`,
      ],
      closeCode: 0,
    });
    const res = await callClaudeHeadless('agent', 'hi', { cwd: '/tmp', onActivity });
    expect(res.status).toBe('done');
    expect(res.content).toBe('ok');
    expect(onActivity).toHaveBeenCalledOnce();
    expect(onActivity).toHaveBeenCalledWith({ kind: 'attempt_started' });
  });

  it('passes only run-local observability snapshot to headless child env', async () => {
    process.env.TAKT_OBSERVABILITY = '{"enabled":false}';
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://ambient-user:pass@collector.example.test';
    stubSpawn({
      stdoutChunks: [
        `${JSON.stringify({ type: 'text', text: 'ok' })}\n`,
        `${JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' })}\n`,
      ],
      closeCode: 0,
    });

    await callClaudeHeadless('agent', 'hi', {
      cwd: '/tmp',
      childProcessEnv: {
        TAKT_OBSERVABILITY: '{"enabled":true}',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://snapshot-collector.example.test',
      },
    });

    expect(lastSpawnEnv?.TAKT_OBSERVABILITY).toBe('{"enabled":true}');
    expect(lastSpawnEnv?.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('https://snapshot-collector.example.test');
  });

  it('returns provider usage from the final stream-json result', async () => {
    stubSpawn({
      stdoutChunks: [
        `${JSON.stringify({
          type: 'result',
          subtype: 'success',
          result: 'ok',
          usage: {
            input_tokens: 12,
            output_tokens: 3,
            cache_creation_input_tokens: 5,
            cache_read_input_tokens: 7,
          },
        })}\n`,
      ],
      closeCode: 0,
    });

    const res = await callClaudeHeadless('agent', 'hi', { cwd: '/tmp' });

    expect(res.status).toBe('done');
    expect(res.providerUsage).toEqual({
      inputTokens: 12,
      outputTokens: 3,
      totalTokens: 15,
      cachedInputTokens: 12,
      cacheCreationInputTokens: 5,
      cacheReadInputTokens: 7,
      usageMissing: false,
    });
  });

  it('uses only the final result text when assistant content and result contain the same text', async () => {
    stubSpawn({
      stdoutChunks: [
        `${JSON.stringify({
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'final answer' }],
          },
        })}\n`,
        `${JSON.stringify({
          type: 'result',
          subtype: 'success',
          result: 'final answer',
        })}\n`,
      ],
      closeCode: 0,
    });

    const res = await callClaudeHeadless('agent', 'hi', { cwd: '/tmp' });

    expect(res.status).toBe('done');
    expect(res.content).toBe('final answer');
  });

  it('prefers the final result text over assistant message content', async () => {
    stubSpawn({
      stdoutChunks: [
        `${JSON.stringify({
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'draft answer' }],
          },
        })}\n`,
        `${JSON.stringify({
          type: 'result',
          subtype: 'success',
          result: 'final answer',
        })}\n`,
      ],
      closeCode: 0,
    });

    const res = await callClaudeHeadless('agent', 'hi', { cwd: '/tmp' });

    expect(res.status).toBe('done');
    expect(res.content).toBe('final answer');
  });

  it('returns error when the final result marks the response as error even if result text exists', async () => {
    stubSpawn({
      stdoutChunks: [
        `${JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: true,
          result: 'partial answer',
        })}\n`,
      ],
      closeCode: 0,
    });

    const res = await callClaudeHeadless('agent', 'hi', { cwd: '/tmp' });

    expect(res.status).toBe('error');
    expect(res.error).toContain('partial answer');
    expect(res.content).toContain('partial answer');
  });

  it('CLI stderr が rate limit を示す場合は rate_limited を返す', async () => {
    stubSpawn({
      stderrChunks: ["You're out of extra usage · resets 2:30pm (Asia/Tokyo)"],
      closeCode: 1,
    });

    const res = await callClaudeHeadless('agent', 'hi', { cwd: '/tmp' });

    expect(res.status).toBe('rate_limited');
    expect(res.errorKind).toBe('rate_limit');
    expect(res.content).toBe('');
  });

  it('CLI stderr が subscription の weekly limit を示す場合は rate_limited を返す', async () => {
    const limitText = "You've hit your weekly limit · resets Aug 16 at 1am (Asia/Tokyo)";
    const onStream = vi.fn();
    stubSpawn({
      stdoutChunks: ['stdout diagnostic'],
      stderrChunks: [limitText],
      closeCode: 1,
    });

    const res = await callClaudeHeadless('agent', 'hi', { cwd: '/tmp', onStream });

    expect(res).toMatchObject({
      status: 'rate_limited',
      errorKind: 'rate_limit',
      content: '',
      error: limitText,
    });
    expect(res.rateLimitInfo?.source).toBe('sdk_error');
    expect(res.rateLimitInfo?.resetAtRaw).toBe('Aug 16 at 1am (Asia/Tokyo)');
    expect(onStream).toHaveBeenLastCalledWith({
      type: 'result',
      data: {
        result: '',
        success: false,
        error: limitText,
        sessionId: '',
      },
    });
  });

  it('CLI stdout の subscription limit 本文を非ゼロ終了時にも rate_limited 応答へ保持する', async () => {
    const limitText = "You've hit your weekly limit · resets Aug 16 at 1am (Asia/Tokyo)";
    stubSpawn({
      stdoutChunks: [limitText],
      closeCode: 1,
    });

    const res = await callClaudeHeadless('agent', 'hi', { cwd: '/tmp' });

    expect(res).toMatchObject({
      status: 'rate_limited',
      errorKind: 'rate_limit',
      content: '',
      error: limitText,
    });
    expect(res.rateLimitInfo?.source).toBe('sdk_error');
    expect(res.rateLimitInfo?.resetAtRaw).toBe('Aug 16 at 1am (Asia/Tokyo)');
  });

  it('CLI stdout の subscription limit は stderr の通常診断と混在しても本文を保持する', async () => {
    const limitText = "You've hit your weekly limit · resets Aug 16 at 1am (Asia/Tokyo)";
    const onStream = vi.fn();
    stubSpawn({
      stdoutChunks: [limitText],
      stderrChunks: ['stderr diagnostic'],
      closeCode: 1,
    });

    const res = await callClaudeHeadless('agent', 'hi', { cwd: '/tmp', onStream });

    expect(res).toMatchObject({
      status: 'rate_limited',
      errorKind: 'rate_limit',
      content: '',
      error: limitText,
      rateLimitInfo: {
        source: 'sdk_error',
        resetAtRaw: 'Aug 16 at 1am (Asia/Tokyo)',
      },
    });
    expect(onStream).toHaveBeenLastCalledWith({
      type: 'result',
      data: {
        result: '',
        success: false,
        error: limitText,
        sessionId: '',
      },
    });
  });

  it('構造化 result error の正規化済み本文を raw JSON より優先する', async () => {
    const limitText = "You've hit your weekly limit · resets Aug 16 at 1am (Asia/Tokyo)";
    const onStream = vi.fn();
    stubSpawn({
      stdoutChunks: [
        `${JSON.stringify({
          type: 'result',
          subtype: 'error',
          errors: [limitText],
          result: 'partial answer',
        })}\n`,
      ],
      closeCode: 1,
    });

    const res = await callClaudeHeadless('agent', 'hi', { cwd: '/tmp', onStream });

    expect(res).toMatchObject({
      status: 'rate_limited',
      errorKind: 'rate_limit',
      content: '',
      error: limitText,
      rateLimitInfo: {
        source: 'sdk_error',
        resetAtRaw: 'Aug 16 at 1am (Asia/Tokyo)',
      },
    });
    expect(onStream).toHaveBeenLastCalledWith({
      type: 'result',
      data: {
        result: '',
        success: false,
        error: limitText,
        sessionId: '',
      },
    });
  });

  it('CLI stdout の通常の weekly limit 言及は rate_limited に分類しない', async () => {
    const ordinaryText = 'The documentation mentions a weekly limit.';
    const onStream = vi.fn();
    stubSpawn({
      stdoutChunks: [ordinaryText],
      closeCode: 1,
    });

    const res = await callClaudeHeadless('agent', 'hi', { cwd: '/tmp', onStream });
    const expectedError = 'Claude CLI failed (1): Claude CLI exited with code 1';

    expect(res).toMatchObject({
      status: 'error',
      content: expectedError,
      error: expectedError,
    });
    expect(res).not.toHaveProperty('errorKind');
    expect(res).not.toHaveProperty('rateLimitInfo');
    expect(res.error).not.toContain(ordinaryText);
    expect(onStream).toHaveBeenLastCalledWith({
      type: 'result',
      data: {
        result: '',
        success: false,
        error: expectedError,
        sessionId: '',
      },
    });
  });

  it.each(['stdout', 'stderr'] as const)(
    '%s の max-buffer error は weekly limit 本文より優先する',
    async (stream) => {
      const limitText = "You've hit your weekly limit · resets Aug 16 at 1am (Asia/Tokyo)";
      const maxBufferBytes = 10 * 1024 * 1024;
      const retainedText = `${limitText}${'x'.repeat(maxBufferBytes - Buffer.byteLength(limitText))}`;
      const onStream = vi.fn();
      stubSpawn(stream === 'stdout'
        ? { stdoutChunks: [retainedText, 'x'] }
        : { stderrChunks: [retainedText, 'x'] });

      const res = await callClaudeHeadless('agent', 'hi', { cwd: '/tmp', onStream });
      const expectedError = `Claude CLI ${stream} exceeded buffer limit`;

      expect(res).toMatchObject({
        status: 'error',
        content: expectedError,
        error: expectedError,
      });
      expect(res).not.toHaveProperty('errorKind');
      expect(res).not.toHaveProperty('rateLimitInfo');
      expect(res.error).not.toContain(limitText);
      expect(onStream).toHaveBeenLastCalledWith({
        type: 'result',
        data: {
          result: '',
          success: false,
          error: expectedError,
          sessionId: '',
        },
      });
    },
  );

  it('abort error は収集済み stdout の weekly limit 本文より優先する', async () => {
    const limitText = "You've hit your weekly limit · resets Aug 16 at 1am (Asia/Tokyo)";
    const abortController = new AbortController();
    const onStream = vi.fn();
    abortController.abort();
    stubSpawn({
      stdoutChunks: [limitText],
      closeCode: 1,
    });

    const res = await callClaudeHeadless('agent', 'hi', {
      cwd: '/tmp',
      abortSignal: abortController.signal,
      onStream,
    });

    expect(res).toMatchObject({
      status: 'error',
      content: HEADLESS_ABORTED_MESSAGE,
      error: HEADLESS_ABORTED_MESSAGE,
    });
    expect(res).not.toHaveProperty('errorKind');
    expect(res).not.toHaveProperty('rateLimitInfo');
    expect(onStream).toHaveBeenLastCalledWith({
      type: 'result',
      data: {
        result: '',
        success: false,
        error: HEADLESS_ABORTED_MESSAGE,
        sessionId: '',
      },
    });
  });

  it('成功 result 本文が rate limit を示す場合は rate_limited を返す', async () => {
    stubSpawn({
      stdoutChunks: [
        `${JSON.stringify({
          type: 'result',
          subtype: 'success',
          result: "You're out of extra usage · resets 2:30pm (Asia/Tokyo)",
        })}\n`,
      ],
      closeCode: 0,
    });

    const res = await callClaudeHeadless('agent', 'hi', { cwd: '/tmp' });

    expect(res.status).toBe('rate_limited');
    expect(res.errorKind).toBe('rate_limit');
    expect(res.content).toBe('');
    expect(res.rateLimitInfo?.source).toBe('stream_marker');
  });

  it('ストリーム中の rate limit marker を検出した時点で child process を停止して返す', async () => {
    const markerText = "You're out of extra usage · resets 2:30pm (Asia/Tokyo)";
    const onStream = vi.fn();
    stubSpawn({
      stdoutChunks: [
        `${JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: markerText }] },
        })}\n`,
      ],
      keepOpen: true,
    });

    const res = await callClaudeHeadless('agent', 'hi', { cwd: '/tmp', onStream });

    expect(res.status).toBe('rate_limited');
    expect(res.errorKind).toBe('rate_limit');
    expect(res.rateLimitInfo?.source).toBe('stream_marker');
    expect(res.error).toBe(markerText);
    expect(res.rateLimitInfo?.resetAtRaw).toBe('2:30pm (Asia/Tokyo)');
    expect(lastKill).toHaveBeenCalledWith('SIGTERM');
    expect(onStream).toHaveBeenLastCalledWith({
      type: 'result',
      data: {
        result: '',
        success: false,
        error: markerText,
        sessionId: '',
      },
    });
  });

  it('tool_result に rate limit 通知と同じ語が含まれていても CLI を止めず done を返す', async () => {
    // #1674: ファイル内容を Read した結果と、その内容を引用した応答
    const fileContent = 'テスト用ファイルです。\nこのリポジトリの検出パターンは usage_limit_exceeded です。\n';
    const reply = `marker.txt の内容:\n${fileContent}`;
    const onStream = vi.fn();
    stubSpawn({
      stdoutChunks: [
        `${JSON.stringify({
          type: 'user',
          message: {
            content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: fileContent }],
          },
        })}\n`,
        `${JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: reply }] },
        })}\n`,
        `${JSON.stringify({ type: 'result', subtype: 'success', result: reply })}\n`,
      ],
      closeCode: 0,
    });

    const res = await callClaudeHeadless('agent', 'hi', { cwd: '/tmp', onStream });

    expect(res.status).toBe('done');
    expect(res.content).toBe(reply);
    expect(res).not.toHaveProperty('errorKind');
    expect(res).not.toHaveProperty('rateLimitInfo');
    expect(lastKill).not.toHaveBeenCalled();
    expect(onStream).toHaveBeenCalledWith({
      type: 'tool_result',
      data: { id: 'tool-1', content: fileContent, isError: false },
    });
  });

  it('stderr の行が通知文を文中で含むだけなら rate_limited にしない', async () => {
    stubSpawn({
      stdoutChunks: [`${JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' })}\n`],
      stderrChunks: ['warning: pattern usage_limit_exceeded is deprecated\n'],
      closeCode: 0,
    });

    const res = await callClaudeHeadless('agent', 'hi', { cwd: '/tmp' });

    expect(res.status).toBe('done');
    expect(res.content).toBe('ok');
    expect(lastKill).not.toHaveBeenCalled();
  });

  it('stderr の通知文が改行なしで終わっても close 時に rate_limited として返す', async () => {
    const markerText = "You're out of extra usage · resets 2:30pm (Asia/Tokyo)";
    stubSpawn({
      stdoutChunks: [`${JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' })}\n`],
      stderrChunks: [markerText],
      closeCode: 0,
    });

    const res = await callClaudeHeadless('agent', 'hi', { cwd: '/tmp' });

    expect(res).toMatchObject({
      status: 'rate_limited',
      errorKind: 'rate_limit',
      error: markerText,
      rateLimitInfo: { source: 'stream_marker' },
    });
  });

  it('stderr の行がチャンク境界で分割されても、確定した行全体で判定する', async () => {
    // 'usage_limit_exceeded' だけの断片で止めてしまうと、続きが来た時点で通常の行だったと分かる
    stubSpawn({
      stdoutChunks: [`${JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' })}\n`],
      stderrChunks: ['usage_limit_exceeded', '_count = 0\n'],
      closeCode: 0,
    });

    const res = await callClaudeHeadless('agent', 'hi', { cwd: '/tmp' });

    expect(res.status).toBe('done');
    expect(res.content).toBe('ok');
    expect(lastKill).not.toHaveBeenCalled();
  });

  it('通知文のマルチバイト文字がチャンク境界で分割されても、ストリーム側の UTF-8 デコードで検出する', async () => {
    // 実環境と同じく PassThrough に write して流す（setEncoding('utf8') の経路を通す）。
    // ’ (U+2019, 3 バイト) の途中でチャンクを切る。
    const markerText = 'You’re out of extra usage · resets 2:30pm (Asia/Tokyo)';
    const line = Buffer.from(`${JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: markerText }] },
    })}\n`, 'utf-8');
    const quoteIndex = line.indexOf(Buffer.from('’', 'utf-8'));
    expect(quoteIndex).toBeGreaterThan(0);
    const splitAt = quoteIndex + 1;

    vi.mocked(spawn).mockImplementation(() => {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const proc = new EventEmitter() as EventEmitter & Partial<ChildProcess>;
      proc.stdout = stdout;
      proc.stderr = stderr;
      lastKill = vi.fn();
      proc.kill = lastKill as unknown as ChildProcess['kill'];
      stdout.on('end', () => proc.emit('close', 0, null));
      queueMicrotask(() => {
        stdout.write(line.subarray(0, splitAt));
        stdout.write(line.subarray(splitAt));
        stdout.end();
      });
      return proc as ChildProcess;
    });

    const res = await callClaudeHeadless('agent', 'hi', { cwd: '/tmp' });

    expect(res.status).toBe('rate_limited');
    expect(res.error).toBe(markerText);
    expect(res.rateLimitInfo?.source).toBe('stream_marker');
    expect(lastKill).toHaveBeenCalledWith('SIGTERM');
  });

  it('result の errors[] に通知文が入っている場合は stream_marker として返す', async () => {
    const markerText = "You're out of extra usage · resets 2:30pm (Asia/Tokyo)";
    stubSpawn({
      stdoutChunks: [
        `${JSON.stringify({ type: 'result', subtype: 'error', is_error: true, errors: [markerText] })}\n`,
      ],
      closeCode: 1,
    });

    const res = await callClaudeHeadless('agent', 'hi', { cwd: '/tmp' });

    expect(res).toMatchObject({
      status: 'rate_limited',
      errorKind: 'rate_limit',
      error: markerText,
      rateLimitInfo: { source: 'stream_marker', resetAtRaw: '2:30pm (Asia/Tokyo)' },
    });
  });

  it('stderr の rate limit marker を stdout より優先して stream_marker として返す', async () => {
    const markerText = 'usage_limit_exceeded: resets 12:30pm';
    stubSpawn({
      stdoutChunks: ['stdout diagnostic'],
      stderrChunks: [`${markerText}\n`],
      keepOpen: true,
    });

    const res = await callClaudeHeadless('agent', 'hi', { cwd: '/tmp' });

    expect(res).toMatchObject({
      status: 'rate_limited',
      errorKind: 'rate_limit',
      error: markerText,
      rateLimitInfo: {
        source: 'stream_marker',
        resetAtRaw: '12:30pm',
      },
    });
  });

  it('CLI の例外本文だけが rate limit を示す場合は sdk_error として返す', async () => {
    const limitText = "You've hit your weekly limit · resets Aug 16 at 1am (Asia/Tokyo)";
    const error = new Error(limitText) as NodeJS.ErrnoException;
    stubSpawn({ error });

    const res = await callClaudeHeadless('agent', 'hi', { cwd: '/tmp' });

    expect(res).toMatchObject({
      status: 'rate_limited',
      errorKind: 'rate_limit',
      error: limitText,
      rateLimitInfo: {
        source: 'sdk_error',
        resetAtRaw: 'Aug 16 at 1am (Asia/Tokyo)',
      },
    });
  });

  it('失敗resultの429は8回の待機後に error_text source で返す', async () => {
    vi.useFakeTimers();
    stubSpawn({
      stdoutChunks: [
        `${JSON.stringify({
          type: 'result',
          subtype: 'error',
          errors: ['HTTP 429: Too many requests'],
          result: 'partial answer',
        })}\n`,
      ],
      closeCode: 0,
    });

    const onStream = vi.fn();
    const pending = callClaudeHeadless('agent', 'hi', { cwd: '/tmp', onStream });
    await vi.advanceTimersByTimeAsync(0);
    for (const [index, delay] of [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000].entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(spawn).toHaveBeenCalledTimes(index + 1);
      expect(onStream.mock.calls.filter(([event]) => event.type === 'result')).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(spawn).toHaveBeenCalledTimes(index + 2);
    }
    const res = await pending;

    expect(res.status).toBe('rate_limited');
    expect(res.errorKind).toBe('rate_limit');
    expect(res.content).toBe('');
    expect(res.rateLimitInfo?.source).toBe('error_text');
    expect(onStream.mock.calls.filter(([event]) => event.type === 'result')).toHaveLength(1);
  });

  it.each(['result', 'stderr', 'exception'] as const)(
    '%s の429を2回再試行して成功しMCPと実行制約を最終試行まで保持する', async (channel) => {
      vi.useFakeTimers();
      const failure: SpawnPlan = channel === 'result'
        ? { stdoutChunks: [`${JSON.stringify({ type: 'result', subtype: 'error', errors: ['HTTP 429: Too Many Requests'], result: 'failed answer' })}\n`] }
        : channel === 'stderr'
          ? { stderrChunks: ['HTTP 429: Too Many Requests'], closeCode: 1 }
          : { error: new Error('HTTP 429: Too Many Requests') };
      stubSpawn([failure, failure, { stdoutChunks: [`${JSON.stringify({
        type: 'result', subtype: 'success', result: 'final answer', session_id: 'final-session', structured_output: { ok: true },
      })}\n`] }]);
      const preparedMcp = { args: ['--mcp-config=/tmp/prepared-mcp.json'], dispose: vi.fn(async () => {}) };
      const onStream = vi.fn();
      const pending = callClaudeHeadless('agent', 'original prompt', {
        cwd: '/tmp', model: 'sonnet', sessionId: 'original-session', permissionMode: 'readonly',
        allowedTools: ['Read'], outputSchema: { type: 'object' }, preparedMcp, onStream,
      });
      await vi.advanceTimersByTimeAsync(999);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(preparedMcp.dispose).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(spawn).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1999);
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(preparedMcp.dispose).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toMatchObject({ status: 'done', content: 'final answer', sessionId: 'final-session', structuredOutput: { ok: true } });
      expect(spawn).toHaveBeenCalledTimes(3);
      for (const [, argv] of vi.mocked(spawn).mock.calls) {
        expect(argv).toEqual(expect.arrayContaining(['--model', 'sonnet', '--resume', 'original-session', '--allowed-tools', 'Read', '--json-schema', '{"type":"object"}', ...preparedMcp.args, '--', 'original prompt']));
        expect(argv).not.toContain('--dangerously-skip-permissions');
      }
      expect(preparedMcp.dispose).toHaveBeenCalledOnce();
      const results = onStream.mock.calls.filter(([event]) => event.type === 'result');
      expect(results).toHaveLength(1);
      expect(results[0]?.[0].data.success).toBe(true);
    },
  );

  it('新規セッションの429再試行で使用済みsession-idを新規作成に再利用しない', async () => {
    vi.useFakeTimers();
    vi.mocked(randomUUID).mockReturnValueOnce('11111111-1111-4111-8111-111111111111')
      .mockReturnValue('22222222-2222-4222-8222-222222222222');
    stubSpawn([{ closeCode: 1, stderrChunks: ['HTTP 429: Too Many Requests'] }, {
      stdoutChunks: [`${JSON.stringify({ type: 'result', subtype: 'success', result: 'final answer' })}\n`],
    }]);
    const pending = callClaudeHeadless('agent', 'prompt', { cwd: '/tmp' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toMatchObject({ status: 'done', content: 'final answer' });
    expect(spawn).toHaveBeenCalledTimes(2);
    const first = vi.mocked(spawn).mock.calls[0]?.[1] as string[];
    const second = vi.mocked(spawn).mock.calls[1]?.[1] as string[];
    const firstId = first[first.indexOf('--session-id') + 1];
    expect(second).toContain('--session-id');
    expect(second).not.toContain('--resume');
    expect(second[second.indexOf('--session-id') + 1]).not.toBe(firstId);
  });

  it.each([
    { event: 'tool_use', closeCode: 0 },
    { event: 'tool_result', closeCode: 0 },
    { event: 'tool_use', closeCode: 1 },
    { event: 'tool_result', closeCode: 1 },
  ] as const)('$event観測後の終了コード$closeCodeによる429では新規セッションで再実行しない', async ({ event, closeCode }) => {
    vi.useFakeTimers();
    const toolEvent = event === 'tool_use'
      ? { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'touch marker' } }] } }
      : { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'done' }] } };
    stubSpawn([
      {
        closeCode,
        stdoutChunks: [`${JSON.stringify(toolEvent)}\n`, ...(closeCode === 0
          ? [`${JSON.stringify({ type: 'result', subtype: 'error', errors: ['HTTP 429: Too Many Requests'] })}\n`]
          : [])],
        stderrChunks: closeCode === 1 ? ['HTTP 429: Too Many Requests'] : [],
      },
      { stdoutChunks: [`${JSON.stringify({ type: 'result', subtype: 'success', result: 'unexpected retry' })}\n`] },
    ]);

    const pending = callClaudeHeadless('agent', 'prompt', { cwd: '/tmp' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await pending).toMatchObject({ status: 'rate_limited', content: '', errorKind: 'rate_limit' });
    expect(spawn).toHaveBeenCalledOnce();
  });

  it('本文中のtool_use文字列だけなら429を再試行する', async () => {
    vi.useFakeTimers();
    stubSpawn([
      { stdoutChunks: [
        `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'The literal string tool_use appears here.' }] } })}\n`,
        `${JSON.stringify({ type: 'result', subtype: 'error', errors: ['HTTP 429: Too Many Requests'] })}\n`,
      ] },
      { stdoutChunks: [`${JSON.stringify({ type: 'result', subtype: 'success', result: 'final answer' })}\n`] },
    ]);

    const pending = callClaudeHeadless('agent', 'prompt', { cwd: '/tmp' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await pending).toMatchObject({ status: 'done', content: 'final answer' });
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it.each([
    'usage_limit_exceeded',
    'HTTP 429: Your workspace is out of credits. Add credits to continue.',
    'You hit your spend cap set in your workspace. Increase your spend cap to continue. HTTP 429',
  ])('失敗resultの使い切りは即終了する: %s', async (message) => {
    stubSpawn({ stdoutChunks: [`${JSON.stringify({ type: 'result', subtype: 'error', errors: [message] })}\n`] });
    const result = await callClaudeHeadless('agent', 'prompt', { cwd: '/tmp' });
    expect(result).toMatchObject({ status: 'rate_limited', content: '', errorKind: 'rate_limit' });
    expect(spawn).toHaveBeenCalledOnce();
  });

  it('429の再試行中に使い切り通知を受けたら即終了する', async () => {
    vi.useFakeTimers();
    stubSpawn(['HTTP 429: Too Many Requests', 'HTTP 429: usage_limit_exceeded'].map((message) => ({
      stdoutChunks: [`${JSON.stringify({ type: 'result', subtype: 'error', errors: [message] })}\n`],
    })));
    const pending = callClaudeHeadless('agent', 'prompt', { cwd: '/tmp' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toMatchObject({ status: 'rate_limited', errorKind: 'rate_limit' });
    await vi.advanceTimersByTimeAsync(121_000);
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('非ゼロ終了のstderrに429と失敗resultに使い切りがある場合は使い切りを優先する', async () => {
    stubSpawn({ closeCode: 1, stderrChunks: ['HTTP 429: Too Many Requests'], stdoutChunks: [
      `${JSON.stringify({ type: 'result', subtype: 'error', errors: ["You've hit your weekly limit"] })}\n`,
    ] });
    expect(await callClaudeHeadless('agent', 'prompt', { cwd: '/tmp' }))
      .toMatchObject({ status: 'rate_limited', error: "You've hit your weekly limit" });
    expect(spawn).toHaveBeenCalledOnce();
  });

  it('429の待機中に中断したらCLIを追加起動しない', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const preparedMcp = { args: [], dispose: vi.fn(async () => {}) };
    stubSpawn({ stderrChunks: ['HTTP 429: Too Many Requests'], closeCode: 1 });
    const pending = callClaudeHeadless('agent', 'prompt', { cwd: '/tmp', abortSignal: controller.signal, preparedMcp });
    await vi.advanceTimersByTimeAsync(500);
    expect(preparedMcp.dispose).not.toHaveBeenCalled();
    controller.abort();
    await vi.advanceTimersByTimeAsync(121_000);
    expect(await pending).toMatchObject({ status: 'error', error: HEADLESS_ABORTED_MESSAGE });
    expect(spawn).toHaveBeenCalledOnce();
    expect(preparedMcp.dispose).toHaveBeenCalledOnce();
  });

  it('通常の失敗resultは再試行せず終端イベントの部分本文を保持する', async () => {
    const onStream = vi.fn();
    stubSpawn({ stdoutChunks: [
      `${JSON.stringify({ type: 'result', subtype: 'error', result: 'partial answer', errors: ['permission denied'] })}\n`,
    ] });
    const response = await callClaudeHeadless('agent', 'prompt', { cwd: '/tmp', onStream });
    expect(response).toMatchObject({ status: 'error', content: 'partial answer', error: 'permission denied' });
    expect(spawn).toHaveBeenCalledOnce();
    expect(onStream).toHaveBeenLastCalledWith({ type: 'result', data: {
      result: 'partial answer', success: false, sessionId: response.sessionId, error: 'permission denied',
    } });
  });

  it('非ゼロ終了でもtool出力の429を失敗resultの原因へ混ぜない', async () => {
    vi.useFakeTimers();
    stubSpawn({ closeCode: 1, stdoutChunks: [
      `${JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool', content: 'HTTP 429: Too Many Requests' }] } })}\n`,
      `${JSON.stringify({ type: 'result', subtype: 'error', errors: ['permission denied'] })}\n`,
    ] });
    const pending = callClaudeHeadless('agent', 'prompt', { cwd: '/tmp' });
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    const result = await pending;
    expect(result.status).toBe('error');
    expect(result.errorKind).not.toBe('rate_limit');
    expect(spawn).toHaveBeenCalledOnce();
  });

  it.each([
    'HTTP 429: Too Many Requests',
    '```text\nusage_limit_exceeded\n```',
    '~~~text\nusage_limit_exceeded\n~~~',
    '> > usage_limit_exceeded',
    '説明:\n    usage_limit_exceeded\n以上',
    '```text\nusage_limit_exceeded',
  ])('成功本文とtool出力の通知の引用を失敗扱いしない: %s', async (text) => {
    stubSpawn({ stdoutChunks: [
      `${JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool', content: text }] } })}\n`,
      `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } })}\n`,
      `${JSON.stringify({ type: 'result', subtype: 'success', result: text })}\n`,
    ] });
    const result = await callClaudeHeadless('agent', 'prompt', { cwd: '/tmp' });
    expect(result).toMatchObject({ status: 'done', content: text });
    expect(result.errorKind).toBeUndefined();
    expect(spawn).toHaveBeenCalledOnce();
    expect(lastKill).not.toHaveBeenCalled();
  });

  it('成功 result 本文の一般的な rate limit / 429 記述は done のまま返す', async () => {
    stubSpawn({
      stdoutChunks: [
        `${JSON.stringify({
          type: 'result',
          subtype: 'success',
          result: 'Documented rate limit fallback behavior for issue 429.',
        })}\n`,
      ],
      closeCode: 0,
    });

    const res = await callClaudeHeadless('agent', 'hi', { cwd: '/tmp' });

    expect(res.status).toBe('done');
    expect(res.content).toBe('Documented rate limit fallback behavior for issue 429.');
  });

  it('uses the final result error when a success result is followed by an error result', async () => {
    stubSpawn({
      stdoutChunks: [
        `${JSON.stringify({
          type: 'result',
          subtype: 'success',
          result: 'first answer',
        })}\n`,
        `${JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: true,
          result: 'final failure',
        })}\n`,
      ],
      closeCode: 0,
    });

    const res = await callClaudeHeadless('agent', 'hi', { cwd: '/tmp' });

    expect(res.status).toBe('error');
    expect(res.error).toBe('final failure');
    expect(res.content).toBe('final failure');
  });

  it('uses the final result success when an error result is followed by a success result', async () => {
    stubSpawn({
      stdoutChunks: [
        `${JSON.stringify({
          type: 'result',
          subtype: 'error',
          message: 'first failure',
          result: 'first failure',
        })}\n`,
        `${JSON.stringify({
          type: 'result',
          subtype: 'success',
          result: 'final answer',
        })}\n`,
      ],
      closeCode: 0,
    });

    const res = await callClaudeHeadless('agent', 'hi', { cwd: '/tmp' });

    expect(res.status).toBe('done');
    expect(res.error).toBeUndefined();
    expect(res.content).toBe('final answer');
  });

  it('prefers explicit result errors over stderr fallback when the final result fails', async () => {
    stubSpawn({
      stdoutChunks: [
        `${JSON.stringify({
          type: 'result',
          subtype: 'error',
          errors: ['explicit failure'],
          result: 'partial answer',
        })}\n`,
      ],
      stderrChunks: ['stderr fallback'],
      closeCode: 0,
    });

    const res = await callClaudeHeadless('agent', 'hi', { cwd: '/tmp' });

    expect(res.status).toBe('error');
    expect(res.error).toBe('explicit failure');
    expect(res.content).toBe('partial answer');
  });

  it('returns done when the final result succeeds with an empty result body', async () => {
    stubSpawn({
      stdoutChunks: [
        `${JSON.stringify({
          type: 'result',
          subtype: 'success',
          result: '',
        })}\n`,
      ],
      closeCode: 0,
    });

    const res = await callClaudeHeadless('agent', 'hi', { cwd: '/tmp' });

    expect(res.status).toBe('done');
    expect(res.content).toBe('');
    expect(res.error).toBeUndefined();
  });

  it('returns the empty final result body even when assistant content was streamed earlier', async () => {
    stubSpawn({
      stdoutChunks: [
        `${JSON.stringify({
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'partial answer' }],
          },
        })}\n`,
        `${JSON.stringify({
          type: 'result',
          subtype: 'success',
          result: '',
        })}\n`,
      ],
      closeCode: 0,
    });

    const res = await callClaudeHeadless('agent', 'hi', { cwd: '/tmp' });

    expect(res.status).toBe('done');
    expect(res.content).toBe('');
    expect(res.error).toBeUndefined();
  });

  it('returns an empty final result when assistant content was streamed but result.result is missing', async () => {
    stubSpawn({
      stdoutChunks: [
        `${JSON.stringify({
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'partial answer' }],
          },
        })}\n`,
        `${JSON.stringify({
          type: 'result',
          subtype: 'success',
        })}\n`,
      ],
      closeCode: 0,
    });

    const res = await callClaudeHeadless('agent', 'hi', { cwd: '/tmp' });

    expect(res.status).toBe('done');
    expect(res.content).toBe('');
    expect(res.error).toBeUndefined();
  });

  it('returns done when assistant content is streamed but the final result event is missing', async () => {
    stubSpawn({
      stdoutChunks: [
        `${JSON.stringify({
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'partial answer' }],
          },
        })}\n`,
      ],
      stderrChunks: ['missing final result'],
      closeCode: 0,
    });

    const res = await callClaudeHeadless('agent', 'hi', { cwd: '/tmp' });

    expect(res.status).toBe('done');
    expect(res.content).toBe('partial answer');
    expect(res.error).toBeUndefined();
  });

  it('returns error when exit code is non-zero', async () => {
    const onStream = vi.fn();
    stubSpawn({
      stdoutChunks: ['ordinary provider output'],
      closeCode: 1,
    });
    const res = await callClaudeHeadless('agent', 'hi', { cwd: '/tmp', onStream });
    const expectedError = 'Claude CLI failed (1): Claude CLI exited with code 1';
    expect(res).toMatchObject({
      status: 'error',
      content: expectedError,
      error: expectedError,
    });
    expect(res.error).not.toContain('ordinary provider output');
    expect(onStream).toHaveBeenCalledWith({
      type: 'result',
      data: {
        result: '',
        success: false,
        error: expectedError,
        sessionId: '',
      },
    });
  });

  it('does not use unknown placeholder when exit code is null', async () => {
    stubSpawn({
      stdoutChunks: [`${JSON.stringify({ type: 'text', text: 'x' })}\n`],
      closeCode: null,
    });
    const res = await callClaudeHeadless('agent', 'hi', { cwd: '/tmp' });
    expect(res.status).toBe('error');
    expect(res.error).toContain('without an exit code');
    expect(res.error).not.toContain('unknown');
  });

  it('maps ENOENT to claude CLI not found message', async () => {
    const err = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' as const });
    stubSpawn({ error: err });
    const res = await callClaudeHeadless('agent', 'hi', { cwd: '/tmp' });
    expect(res.status).toBe('error');
    expect(res.error).toMatch(/claude CLI not found/i);
  });

  function lastSpawnArgv(): string[] {
    expect(lastArgv.length).toBeGreaterThan(0);
    return lastArgv;
  }

  it('passes -p, stream-json, default permission-mode, and -- before prompt', async () => {
    stubSpawn({
      stdoutChunks: [`${JSON.stringify({ type: 'text', text: 'ok' })}\n`],
      closeCode: 0,
    });
    await callClaudeHeadless('agent', 'hi', { cwd: '/tmp' });
    const argv = lastSpawnArgv();
    expect(argv).toEqual(
      expect.arrayContaining([
        '-p',
        '--output-format',
        'stream-json',
        '--verbose',
        '--include-partial-messages',
        '--permission-mode',
        'default',
        '--session-id',
        '11111111-1111-4111-8111-111111111111',
      ]),
    );
    expect(argv.at(-2)).toBe('--');
    expect(argv.at(-1)).toBe('hi');
  });

  it('passes systemPrompt via --system-prompt without mixing it into user prompt', async () => {
    stubSpawn({
      stdoutChunks: [
        `${JSON.stringify({ type: 'system', session_id: '11111111-1111-4111-8111-111111111111' })}\n`,
        `${JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' })}\n`,
      ],
      closeCode: 0,
    });

    const res = await callClaudeHeadless('agent', 'user prompt', {
      cwd: '/tmp',
      systemPrompt: 'system prompt',
    });

    const argv = lastSpawnArgv();
    const systemPromptIndex = argv.indexOf('--system-prompt');
    expect(systemPromptIndex).toBeGreaterThanOrEqual(0);
    expect(argv[systemPromptIndex + 1]).toBe('system prompt');
    expect(argv.at(-1)).toBe('user prompt');
    expect(argv.at(-1)).not.toContain('system prompt');
    expect(res.sessionId).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('returns the generated sessionId when the first successful response does not include session metadata', async () => {
    stubSpawn({
      stdoutChunks: [`${JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' })}\n`],
      closeCode: 0,
    });

    const res = await callClaudeHeadless('agent', 'user prompt', {
      cwd: '/tmp',
    });

    expect(res.status).toBe('done');
    expect(res.sessionId).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('maps permissionMode edit to acceptEdits', async () => {
    stubSpawn({
      stdoutChunks: [`${JSON.stringify({ type: 'text', text: 'x' })}\n`],
      closeCode: 0,
    });
    await callClaudeHeadless('agent', 'p', { cwd: '/tmp', permissionMode: 'edit' });
    const argv = lastSpawnArgv();
    const i = argv.indexOf('--permission-mode');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(argv[i + 1]).toBe('acceptEdits');
  });

  it('maps permissionMode full to bypassPermissions', async () => {
    stubSpawn({
      stdoutChunks: [`${JSON.stringify({ type: 'text', text: 'x' })}\n`],
      closeCode: 0,
    });
    await callClaudeHeadless('agent', 'p', { cwd: '/tmp', permissionMode: 'full' });
    const argv = lastSpawnArgv();
    const i = argv.indexOf('--permission-mode');
    expect(argv[i + 1]).toBe('bypassPermissions');
  });

  it('maps bypassPermissions to bypassPermissions', async () => {
    stubSpawn({
      stdoutChunks: [`${JSON.stringify({ type: 'text', text: 'x' })}\n`],
      closeCode: 0,
    });
    await callClaudeHeadless('agent', 'p', { cwd: '/tmp', permissionMode: 'readonly', bypassPermissions: true });
    const argv = lastSpawnArgv();
    const i = argv.indexOf('--permission-mode');
    expect(argv[i + 1]).toBe('bypassPermissions');
  });

  it('passes --model when set', async () => {
    stubSpawn({
      stdoutChunks: [`${JSON.stringify({ type: 'text', text: 'x' })}\n`],
      closeCode: 0,
    });
    await callClaudeHeadless('agent', 'p', { cwd: '/tmp', model: 'opus-4' });
    const argv = lastSpawnArgv();
    const i = argv.indexOf('--model');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(argv[i + 1]).toBe('opus-4');
  });

  it('passes --resume with valid session UUID', async () => {
    const sessionId = 'claude-session-opaque-token';
    stubSpawn({
      stdoutChunks: [`${JSON.stringify({ type: 'text', text: 'x' })}\n`],
      closeCode: 0,
    });
    await callClaudeHeadless('agent', 'p', { cwd: '/tmp', sessionId });
    const argv = lastSpawnArgv();
    const i = argv.indexOf('--resume');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(argv[i + 1]).toBe(sessionId);
    expect(argv).not.toContain('--session-id');
  });

  it('passes --json-schema and returns structuredOutput when outputSchema is provided', async () => {
    const outputSchema = {
      type: 'object',
      properties: {
        decision: { type: 'string' },
      },
      required: ['decision'],
    };
    stubSpawn({
      stdoutChunks: [
        `${JSON.stringify({ type: 'result', subtype: 'success', result: '{"decision":"approved"}' })}\n`,
      ],
      closeCode: 0,
    });

    const res = await callClaudeHeadless('agent', 'p', {
      cwd: '/tmp',
      outputSchema,
    });

    const argv = lastSpawnArgv();
    const schemaIndex = argv.indexOf('--json-schema');
    expect(schemaIndex).toBeGreaterThanOrEqual(0);
    expect(JSON.parse(argv[schemaIndex + 1]!)).toEqual(outputSchema);
    expect(res.structuredOutput).toEqual({ decision: 'approved' });
  });

  it('prefers structured_output from the final result event over parsing plain-text content', async () => {
    const outputSchema = {
      type: 'object',
      properties: {
        decision: { type: 'string' },
      },
      required: ['decision'],
    };
    stubSpawn({
      stdoutChunks: [
        `${JSON.stringify({
          type: 'result',
          subtype: 'success',
          result: 'approved',
          structured_output: { decision: 'approved' },
        })}\n`,
      ],
      closeCode: 0,
    });

    const res = await callClaudeHeadless('agent', 'p', {
      cwd: '/tmp',
      outputSchema,
    });

    expect(res.status).toBe('done');
    expect(res.content).toBe('approved');
    expect(res.structuredOutput).toEqual({ decision: 'approved' });
  });

  it('returns a new sessionId from stdout on the first call and resumes with it on the next call', async () => {
    stubSpawn({
      stdoutChunks: [
        `${JSON.stringify({ type: 'system', session_id: '22222222-2222-4222-8222-222222222222' })}\n`,
        `${JSON.stringify({ type: 'result', subtype: 'success', result: 'first' })}\n`,
      ],
      closeCode: 0,
    });

    const first = await callClaudeHeadless('agent', 'first prompt', { cwd: '/tmp' });
    expect(first.sessionId).toBe('22222222-2222-4222-8222-222222222222');

    stubSpawn({
      stdoutChunks: [
        `${JSON.stringify({ type: 'result', result: 'second', session_id: '22222222-2222-4222-8222-222222222222' })}\n`,
      ],
      closeCode: 0,
    });

    const second = await callClaudeHeadless('agent', 'second prompt', {
      cwd: '/tmp',
      sessionId: first.sessionId,
    });

    const argv = lastSpawnArgv();
    const resumeIndex = argv.indexOf('--resume');
    expect(resumeIndex).toBeGreaterThanOrEqual(0);
    expect(argv[resumeIndex + 1]).toBe('22222222-2222-4222-8222-222222222222');
    expect(second.sessionId).toBe('22222222-2222-4222-8222-222222222222');
    expect(second.content).toBe('second');
  });

  it('passes mcpServers as --mcp-config temp file and removes it after execution', async () => {
    stubSpawn({
      stdoutChunks: [`${JSON.stringify({ type: 'text', text: 'x' })}\n`],
      closeCode: 0,
    });

    await callClaudeHeadless('agent', 'p', {
      cwd: '/tmp',
      mcpServers: {
        local: {
          command: 'node',
          args: ['server.js'],
        },
      },
    });

    const argv = lastSpawnArgv();
    const mcpIndex = argv.indexOf('--mcp-config');
    expect(mcpIndex).toBeGreaterThanOrEqual(0);
    expect(capturedMcpConfigMode).toBe(0o600);
    expect(JSON.parse(capturedMcpConfigContent!)).toEqual({
      mcpServers: {
        local: {
          command: 'node',
          args: ['server.js'],
        },
      },
    });
    expect(existsSync(capturedMcpConfigPath!)).toBe(false);
  });

  it('removes the temp directory when MCP config preparation fails before cleanup is registered', async () => {
    let createdTempDir: string | undefined;
    mkdtempMock.mockImplementationOnce(async (...args) => {
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      createdTempDir = await actual.mkdtemp(...args);
      return createdTempDir;
    });
    writeFileMock.mockRejectedValueOnce(new Error('write failed'));

    const res = await callClaudeHeadless('agent', 'p', {
      cwd: '/tmp',
      mcpServers: {
        local: {
          command: 'node',
          args: ['server.js'],
        },
      },
    });

    expect(res.status).toBe('error');
    expect(res.error).toContain('write failed');
    expect(createdTempDir).toBeDefined();
    expect(existsSync(createdTempDir!)).toBe(false);
    expect(vi.mocked(spawn)).not.toHaveBeenCalled();
  });

  it('keeps the successful response when MCP cleanup fails after execution', async () => {
    rmMock.mockRejectedValueOnce(new Error('cleanup failed'));
    stubSpawn({
      stdoutChunks: [`${JSON.stringify({ type: 'result', subtype: 'success', result: 'x' })}\n`],
      closeCode: 0,
    });
    const onStream = vi.fn();

    const res = await callClaudeHeadless('agent', 'p', {
      cwd: '/tmp',
      mcpServers: {
        local: {
          command: 'node',
          args: ['server.js'],
        },
      },
      onStream,
    });

    expect(res.status).toBe('done');
    expect(res.content).toBe('x');
    expect(onStream).toHaveBeenCalledWith({
      type: 'result',
      data: {
        result: 'x',
        success: true,
        sessionId: '11111111-1111-4111-8111-111111111111',
      },
    });
    expect(onStream).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'result',
        data: expect.objectContaining({ success: false }),
      }),
    );
  });

  it('streams assistant message content as text without replaying the final result text', async () => {
    stubSpawn({
      stdoutChunks: [
        `${JSON.stringify({
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'streamed answer' }],
          },
        })}\n`,
        `${JSON.stringify({
          type: 'result',
          subtype: 'success',
          result: 'streamed answer',
        })}\n`,
      ],
      closeCode: 0,
    });
    const onStream = vi.fn();

    await callClaudeHeadless('agent', 'p', {
      cwd: '/tmp',
      onStream,
    });

    expect(onStream).toHaveBeenCalledTimes(2);
    expect(onStream).toHaveBeenNthCalledWith(1, {
      type: 'text',
      data: { text: 'streamed answer' },
    });
    expect(onStream).toHaveBeenNthCalledWith(2, {
      type: 'result',
      data: {
        result: 'streamed answer',
        success: true,
        sessionId: '11111111-1111-4111-8111-111111111111',
      },
    });
  });

  it('CT-COMP-12 streams assistant tool_use blocks before the final result', async () => {
    stubSpawn({
      stdoutChunks: [
        `${JSON.stringify({
          type: 'assistant',
          message: {
            content: [{
              type: 'tool_use',
              id: 'tool-1',
              name: 'Edit',
              input: { file_path: 'src/a.ts' },
            }],
          },
        })}\n`,
        `${JSON.stringify({
          type: 'result',
          subtype: 'success',
          result: 'done',
        })}\n`,
      ],
      closeCode: 0,
    });
    const onStream = vi.fn();

    await callClaudeHeadless('agent', 'p', { cwd: '/tmp', onStream });

    expect(onStream).toHaveBeenNthCalledWith(1, {
      type: 'tool_use',
      data: { tool: 'Edit', id: 'tool-1', input: { file_path: 'src/a.ts' } },
    });
    expect(onStream).toHaveBeenNthCalledWith(2, {
      type: 'result',
      data: {
        result: 'done',
        success: true,
        sessionId: '11111111-1111-4111-8111-111111111111',
      },
    });
  });

  it('streams tool_result blocks with their matching tool id before the final result', async () => {
    stubSpawn({
      stdoutChunks: [
        `${JSON.stringify({
          type: 'assistant',
          message: {
            content: [{
              type: 'tool_use',
              id: 'tool-1',
              name: 'takt_get_run',
              input: { runSlug: 'run-a' },
            }],
          },
        })}\n`,
        `${JSON.stringify({
          type: 'user',
          message: {
            content: [{
              type: 'tool_result',
              tool_use_id: 'tool-1',
              content: [{ type: 'text', text: 'run state' }],
              is_error: false,
            }],
          },
        })}\n`,
        `${JSON.stringify({
          type: 'result',
          subtype: 'success',
          result: 'done',
        })}\n`,
      ],
      closeCode: 0,
    });
    const onStream = vi.fn();

    await callClaudeHeadless('agent', 'p', { cwd: '/tmp', onStream });

    expect(onStream).toHaveBeenNthCalledWith(1, {
      type: 'tool_use',
      data: { tool: 'takt_get_run', id: 'tool-1', input: { runSlug: 'run-a' } },
    });
    expect(onStream).toHaveBeenNthCalledWith(2, {
      type: 'tool_result',
      data: { id: 'tool-1', content: 'run state', isError: false },
    });
    expect(onStream).toHaveBeenNthCalledWith(3, {
      type: 'result',
      data: {
        result: 'done',
        success: true,
        sessionId: '11111111-1111-4111-8111-111111111111',
      },
    });
  });

  it('omits --mcp-config when mcpServers is an empty object', async () => {
    stubSpawn({
      stdoutChunks: [`${JSON.stringify({ type: 'text', text: 'x' })}\n`],
      closeCode: 0,
    });

    await callClaudeHeadless('agent', 'p', {
      cwd: '/tmp',
      mcpServers: {},
    });

    const argv = lastSpawnArgv();
    expect(argv).not.toContain('--mcp-config');
    expect(capturedMcpConfigPath).toBeUndefined();
  });

  it('passes claude sandbox settings via --settings JSON', async () => {
    stubSpawn({
      stdoutChunks: [`${JSON.stringify({ type: 'text', text: 'x' })}\n`],
      closeCode: 0,
    });

    await callClaudeHeadless('agent', 'p', {
      cwd: '/tmp',
      sandbox: {
        allowUnsandboxedCommands: true,
        excludedCommands: ['./gradlew', 'npm test'],
      },
    });

    const argv = lastSpawnArgv();
    const settingsIndex = argv.indexOf('--settings');
    expect(settingsIndex).toBeGreaterThanOrEqual(0);
    expect(JSON.parse(argv[settingsIndex + 1]!)).toEqual({
      sandbox: {
        allowUnsandboxedCommands: true,
        excludedCommands: ['./gradlew', 'npm test'],
      },
    });
  });

  it('accepts opaque sessionId when resuming', async () => {
    stubSpawn({
      stdoutChunks: [`${JSON.stringify({ type: 'result', subtype: 'success', result: 'resumed' })}\n`],
      closeCode: 0,
    });

    const res = await callClaudeHeadless('agent', 'p', {
      cwd: '/tmp',
      sessionId: 'resume-session-from-report-phase',
    });

    expect(res.status).toBe('done');
    expect(res.sessionId).toBe('resume-session-from-report-phase');
  });

  it('passes model, comma-joined allowed tools, and effort to the CLI', async () => {
    stubSpawn({
      stdoutChunks: [`${JSON.stringify({ type: 'text', text: 'x' })}\n`],
      closeCode: 0,
    });
    await callClaudeHeadless('agent', 'p', {
      cwd: '/tmp',
      model: 'sonnet',
      allowedTools: ['Read', 'Grep', 'Edit'],
      effort: 'high',
    });
    const argv = lastSpawnArgv();
    const modelIdx = argv.indexOf('--model');
    const toolsIdx = argv.indexOf('--allowed-tools');
    const effortIdx = argv.indexOf('--effort');
    expect(modelIdx).toBeGreaterThanOrEqual(0);
    expect(toolsIdx).toBeGreaterThanOrEqual(0);
    expect(effortIdx).toBeGreaterThanOrEqual(0);
    expect(argv[modelIdx + 1]).toBe('sonnet');
    expect(argv[toolsIdx + 1]).toBe('Read,Grep,Edit');
    expect(argv[effortIdx + 1]).toBe('high');
  });

  it('passes anthropicApiKey to the child process as ANTHROPIC_API_KEY', async () => {
    stubSpawn({
      stdoutChunks: [`${JSON.stringify({ type: 'text', text: 'x' })}\n`],
      closeCode: 0,
    });

    await callClaudeHeadless('agent', 'p', {
      cwd: '/tmp',
      anthropicApiKey: 'sk-ant-from-config',
    });

    expect(lastSpawnEnv?.ANTHROPIC_API_KEY).toBe('sk-ant-from-config');
  });

  it('baseUrl を ANTHROPIC_BASE_URL として subprocess env に注入し childProcessEnv より優先する', async () => {
    stubSpawn({
      stdoutChunks: [`${JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' })}\n`],
      closeCode: 0,
    });
    const callOptions = {
      cwd: '/tmp',
      baseUrl: 'http://127.0.0.1:8787',
      childProcessEnv: {
        ANTHROPIC_BASE_URL: 'http://ambient.example.test',
      },
    } as unknown as ClaudeHeadlessCallOptions;

    await runHeadlessCli(['-p', '--', 'prompt'], callOptions);

    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);
    expect(lastSpawnEnv?.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8787');
  });

  it('omits --allowed-tools and --effort when not configured', async () => {
    stubSpawn({
      stdoutChunks: [`${JSON.stringify({ type: 'text', text: 'x' })}\n`],
      closeCode: 0,
    });
    await callClaudeHeadless('agent', 'p', {
      cwd: '/tmp',
      allowedTools: [],
    });
    const argv = lastSpawnArgv();
    expect(argv).not.toContain('--allowed-tools');
    expect(argv).not.toContain('--effort');
  });

  it.each([undefined, 'previous-session'])('disables built-in and configured MCP tools for an empty allowlist (session: %s)', async (sessionId) => {
    stubSpawn({
      stdoutChunks: [`${JSON.stringify({ type: 'result', result: 'report' })}\n`],
      closeCode: 0,
    });

    const response = await callClaudeHeadless('reporter', 'write the report', {
      cwd: '/tmp',
      sessionId,
      allowedTools: [],
      permissionMode: 'readonly',
      skillsEnabled: true,
      mcpServers: { docs: { command: 'docs-mcp', args: ['serve'] } },
    });

    expect(response.status).toBe('done');
    const argv = lastSpawnArgv();
    const toolsIndex = argv.indexOf('--tools');
    expect(toolsIndex).toBeGreaterThanOrEqual(0);
    expect(argv[toolsIndex + 1]).toBe('');
    expect(argv).toContain('--strict-mcp-config');
    expect(argv).toContain('--disable-slash-commands');
    const settingsSourcesIndex = argv.indexOf('--setting-sources');
    expect(settingsSourcesIndex).toBeGreaterThanOrEqual(0);
    expect(argv[settingsSourcesIndex + 1]).toBe('');
    expect(argv).not.toContain('--mcp-config');
    expect(argv).not.toContain('--allowed-tools');
    expect(writeFileMock).not.toHaveBeenCalled();
    expect(argv).toContain(sessionId === undefined ? '--session-id' : '--resume');
  });

  it.each([
    { label: 'empty allowlist', allowedTools: [], internalAgentIsolation: undefined },
    { label: 'strict readonly', allowedTools: ['Read'], internalAgentIsolation: 'strict-readonly' as const },
  ])('suppresses prepared MCP tools and disposes their config for $label', async ({ allowedTools, internalAgentIsolation }) => {
    const configDirectory = mkdtempSync(join(tmpdir(), 'takt-headless-prepared-mcp-'));
    const configPath = join(configDirectory, 'mcp-config.json');
    writeFileSync(configPath, JSON.stringify({ mcpServers: { docs: { command: 'docs-mcp' } } }));
    const dispose = vi.fn(async () => { rmSync(configDirectory, { recursive: true, force: true }); });
    stubSpawn({
      stdoutChunks: [`${JSON.stringify({ type: 'result', result: 'report' })}\n`],
      closeCode: 0,
    });

    try {
      const response = await callClaudeHeadless('reporter', 'write the report', {
        cwd: '/tmp',
        allowedTools,
        internalAgentIsolation,
        permissionMode: 'readonly',
        preparedMcp: {
          args: ['--strict-mcp-config', '--mcp-config', configPath],
          dispose,
        },
      });

      expect(response.status).toBe('done');
      const argv = lastSpawnArgv();
      expect(argv).toContain('--strict-mcp-config');
      expect(argv).not.toContain('--mcp-config');
      expect(argv).not.toContain(configPath);
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(existsSync(configPath)).toBe(false);
    } finally {
      rmSync(configDirectory, { recursive: true, force: true });
    }
  });

  it('keeps explicitly enabled skills without adding unrelated restrictions', async () => {
    stubSpawn({
      stdoutChunks: [`${JSON.stringify({ type: 'text', text: 'x' })}\n`],
      closeCode: 0,
    });

    await callClaudeHeadless('selector', 'p', {
      cwd: '/tmp',
      permissionMode: 'readonly',
      skillsEnabled: true,
    });

    const argv = lastSpawnArgv();
    expect(argv).not.toContain('--tools');
    expect(argv).not.toContain('--setting-sources');
    expect(argv).not.toContain('--strict-mcp-config');
    expect(argv).not.toContain('--disable-slash-commands');
    expect(argv).not.toContain('--allowed-tools');
  });

  it('does not add unrelated restrictions to an ordinary headless call', async () => {
    stubSpawn({
      stdoutChunks: [`${JSON.stringify({ type: 'text', text: 'x' })}\n`],
      closeCode: 0,
    });

    await callClaudeHeadless('agent', 'p', {
      cwd: '/tmp',
      permissionMode: 'readonly',
    });

    const argv = lastSpawnArgv();
    expect(argv).not.toContain('--tools');
    expect(argv).not.toContain('--setting-sources');
    expect(argv).not.toContain('--strict-mcp-config');
  });

  it('strict-readonly isolation passes explicit tool, settings, MCP, and Skills restrictions to Claude CLI', async () => {
    stubSpawn({
      stdoutChunks: [`${JSON.stringify({ type: 'text', text: 'x' })}\n`],
      closeCode: 0,
    });

    await callClaudeHeadless('selector', 'p', {
      cwd: '/tmp',
      internalAgentIsolation: 'strict-readonly',
      allowedTools: ['Read'],
      mcpServers: {
        docs: { command: 'docs-mcp', args: ['serve'] },
      },
      permissionMode: 'readonly',
      bypassPermissions: false,
      skillsEnabled: true,
    });

    const argv = lastSpawnArgv();
    expect(argv).toEqual(expect.arrayContaining([
      '--tools',
      '',
      '--strict-mcp-config',
      '--setting-sources',
      '',
      '--disable-slash-commands',
      '--permission-mode',
      'default',
    ]));
    expect(argv).not.toContain('--allowed-tools');
    expect(argv).not.toContain('--mcp-config');
  });

  it('strict-readonly enables only Read when the interpretation call explicitly requests file access', async () => {
    stubSpawn({
      stdoutChunks: [`${JSON.stringify({ type: 'text', text: 'x' })}\n`],
      closeCode: 0,
    });

    await callClaudeHeadless('selector', 'read verification files', {
      cwd: '/tmp',
      internalAgentIsolation: 'strict-readonly',
      allowReadonlyFileRead: true,
      readonlyFileReadPaths: [fileURLToPath(import.meta.url)],
      allowedTools: ['Read'],
      permissionMode: 'readonly',
    });

    const argv = lastSpawnArgv();
    expect(argv).toEqual(expect.arrayContaining([
      '--tools',
      'Read',
      '--strict-mcp-config',
      '--setting-sources',
      '',
      '--disable-slash-commands',
      '--permission-mode',
      'default',
    ]));
    expect(argv).not.toContain('--allowed-tools');
    expect(argv).not.toContain('--mcp-config');
    const settingsIndex = argv.indexOf('--settings');
    expect(settingsIndex).toBeGreaterThanOrEqual(0);
    expect(JSON.parse(argv[settingsIndex + 1]!).hooks.PreToolUse[0]).toMatchObject({
      matcher: 'Read',
      hooks: [{ type: 'command', command: process.execPath, args: expect.arrayContaining(['-e']) }],
    });
  });

  it('keeps the Read hook allowlist when an artifact is removed during MCP preparation', async () => {
    const artifactsDirectory = mkdtempSync(join(tmpdir(), 'takt-headless-artifact-race-'));
    const specificationPath = join(artifactsDirectory, 'spec.qnt');
    writeFileSync(specificationPath, 'module verify {}');
    const resolvedSpecificationPath = realpathSync(specificationPath);
    let finishMcpPreparation: (() => void) | undefined;
    prepareClaudeMcpConfigMock.mockImplementationOnce(() => new Promise((resolve) => {
      finishMcpPreparation = () => resolve({ cleanup: async () => {} });
    }));
    stubSpawn({
      stdoutChunks: [`${JSON.stringify({ type: 'text', text: 'x' })}\n`],
      closeCode: 0,
    });

    try {
      const responsePromise = callClaudeHeadless('selector', 'read verification files', {
        cwd: artifactsDirectory,
        internalAgentIsolation: 'strict-readonly',
        allowReadonlyFileRead: true,
        readonlyFileReadPaths: [specificationPath],
        allowedTools: ['Read'],
        permissionMode: 'readonly',
      });
      await vi.waitFor(() => expect(finishMcpPreparation).toBeTypeOf('function'));
      rmSync(specificationPath);
      finishMcpPreparation!();
      await responsePromise;

      const argv = lastSpawnArgv();
      expect(argv).toEqual(expect.arrayContaining(['--tools', 'Read']));
      const settingsIndex = argv.indexOf('--settings');
      expect(settingsIndex).toBeGreaterThanOrEqual(0);
      const readHook = JSON.parse(argv[settingsIndex + 1]!).hooks.PreToolUse[0];
      expect(readHook.matcher).toBe('Read');
      expect(readHook.hooks[0].args[1]).toContain(JSON.stringify([resolvedSpecificationPath]));
    } finally {
      rmSync(artifactsDirectory, { recursive: true, force: true });
    }
  });

  it('passes --effort without --allowed-tools when tools list is empty', async () => {
    stubSpawn({
      stdoutChunks: [`${JSON.stringify({ type: 'text', text: 'x' })}\n`],
      closeCode: 0,
    });
    await callClaudeHeadless('agent', 'p', {
      cwd: '/tmp',
      allowedTools: [],
      effort: 'low',
    });
    const argv = lastSpawnArgv();
    expect(argv).not.toContain('--allowed-tools');
    const effortIdx = argv.indexOf('--effort');
    expect(effortIdx).toBeGreaterThanOrEqual(0);
    expect(argv[effortIdx + 1]).toBe('low');
  });

});

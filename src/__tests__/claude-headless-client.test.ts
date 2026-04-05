import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';

const { mkdtempMock, chmodMock, writeFileMock, rmMock } = vi.hoisted(() => ({
  mkdtempMock: vi.fn(),
  chmodMock: vi.fn(),
  writeFileMock: vi.fn(),
  rmMock: vi.fn(),
}));

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

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { callClaudeHeadless } from '../infra/claude-headless/client.js';

describe('callClaudeHeadless', () => {
  let lastArgv: string[] = [];
  let lastSpawnEnv: NodeJS.ProcessEnv | undefined;
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
    capturedMcpConfigContent = undefined;
    capturedMcpConfigMode = undefined;
    capturedMcpConfigPath = undefined;
  });

  function stubSpawn(opts: {
    stdoutChunks?: string[];
    stderrChunks?: string[];
    closeCode?: number | null;
    closeSignal?: NodeJS.Signals | null;
    error?: NodeJS.ErrnoException;
  }): void {
    vi.mocked(spawn).mockImplementation((_cmd, _args, spawnOptions) => {
      lastArgv = [...(_args as string[])];
      lastSpawnEnv = spawnOptions?.env as NodeJS.ProcessEnv | undefined;
      const mcpIndex = lastArgv.indexOf('--mcp-config');
      if (mcpIndex >= 0) {
        capturedMcpConfigPath = lastArgv[mcpIndex + 1];
        capturedMcpConfigContent = readFileSync(capturedMcpConfigPath!, 'utf-8');
        capturedMcpConfigMode = statSync(capturedMcpConfigPath!).mode & 0o777;
      }
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      const proc = new EventEmitter() as EventEmitter & Partial<ChildProcess>;
      proc.stdout = stdout as NodeJS.ReadableStream;
      proc.stderr = stderr as NodeJS.ReadableStream;
      proc.kill = vi.fn() as unknown as ChildProcess['kill'];

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
        const code = opts.closeCode === undefined ? 0 : opts.closeCode;
        proc.emit('close', code, opts.closeSignal ?? null);
      });

      return proc as ChildProcess;
    });
  }

  it('returns done when stream-json yields text and process exits 0', async () => {
    stubSpawn({
      stdoutChunks: [
        `${JSON.stringify({ type: 'text', text: 'ok' })}\n`,
        `${JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' })}\n`,
      ],
      closeCode: 0,
    });
    const res = await callClaudeHeadless('agent', 'hi', { cwd: '/tmp' });
    expect(res.status).toBe('done');
    expect(res.content).toBe('ok');
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

  it('returns the explicit final result message when isError is true', async () => {
    stubSpawn({
      stdoutChunks: [
        `${JSON.stringify({
          type: 'result',
          subtype: 'success',
          isError: true,
          message: 'explicit failure',
          result: 'partial answer',
        })}\n`,
      ],
      closeCode: 0,
    });

    const res = await callClaudeHeadless('agent', 'hi', { cwd: '/tmp' });

    expect(res.status).toBe('error');
    expect(res.error).toBe('explicit failure');
    expect(res.content).toBe('partial answer');
  });

  it('returns error when the final result subtype is error without is_error flags', async () => {
    stubSpawn({
      stdoutChunks: [
        `${JSON.stringify({
          type: 'result',
          subtype: 'error',
          message: 'explicit failure',
          result: 'partial answer',
        })}\n`,
      ],
      closeCode: 0,
    });

    const res = await callClaudeHeadless('agent', 'hi', { cwd: '/tmp' });

    expect(res.status).toBe('error');
    expect(res.error).toBe('explicit failure');
    expect(res.content).toBe('partial answer');
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
    stubSpawn({
      stdoutChunks: [`${JSON.stringify({ type: 'text', text: 'partial' })}\n`],
      closeCode: 1,
    });
    const res = await callClaudeHeadless('agent', 'hi', { cwd: '/tmp' });
    expect(res.status).toBe('error');
    expect(res.error).toMatch(/Claude CLI failed \(1\)/);
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
    expect(argv[0]).toBe('-p');
    expect(argv).toEqual(
      expect.arrayContaining([
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

  it('emits a failed final result event when the final result is marked as error', async () => {
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
          is_error: true,
          result: 'partial answer',
        })}\n`,
      ],
      closeCode: 0,
    });
    const onStream = vi.fn();

    const res = await callClaudeHeadless('agent', 'p', {
      cwd: '/tmp',
      onStream,
    });

    expect(res.status).toBe('error');
    expect(onStream).toHaveBeenNthCalledWith(2, {
      type: 'result',
      data: {
        result: 'partial answer',
        success: false,
        error: 'partial answer',
        sessionId: '11111111-1111-4111-8111-111111111111',
      },
    });
  });

  it('emits the explicit final result message when isError is true', async () => {
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
          isError: true,
          message: 'explicit failure',
          result: 'partial answer',
        })}\n`,
      ],
      closeCode: 0,
    });
    const onStream = vi.fn();

    const res = await callClaudeHeadless('agent', 'p', {
      cwd: '/tmp',
      onStream,
    });

    expect(res.status).toBe('error');
    expect(onStream).toHaveBeenNthCalledWith(2, {
      type: 'result',
      data: {
        result: 'partial answer',
        success: false,
        error: 'explicit failure',
        sessionId: '11111111-1111-4111-8111-111111111111',
      },
    });
  });

  it('emits an empty successful final result event even when assistant content was streamed earlier', async () => {
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
    const onStream = vi.fn();

    const res = await callClaudeHeadless('agent', 'p', {
      cwd: '/tmp',
      onStream,
    });

    expect(res.status).toBe('done');
    expect(onStream).toHaveBeenCalledTimes(2);
    expect(onStream).toHaveBeenNthCalledWith(1, {
      type: 'text',
      data: { text: 'partial answer' },
    });
    expect(onStream).toHaveBeenNthCalledWith(2, {
      type: 'result',
      data: {
        result: '',
        success: true,
        sessionId: '11111111-1111-4111-8111-111111111111',
      },
    });
  });

  it('emits an empty successful final result event when result.result is missing', async () => {
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
    const onStream = vi.fn();

    const res = await callClaudeHeadless('agent', 'p', {
      cwd: '/tmp',
      onStream,
    });

    expect(res.status).toBe('done');
    expect(onStream).toHaveBeenCalledTimes(2);
    expect(onStream).toHaveBeenNthCalledWith(1, {
      type: 'text',
      data: { text: 'partial answer' },
    });
    expect(onStream).toHaveBeenNthCalledWith(2, {
      type: 'result',
      data: {
        result: '',
        success: true,
        sessionId: '11111111-1111-4111-8111-111111111111',
      },
    });
  });

  it('emits a successful compatibility result event when assistant content is streamed without a result event', async () => {
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
    const onStream = vi.fn();

    const res = await callClaudeHeadless('agent', 'p', {
      cwd: '/tmp',
      onStream,
    });

    expect(res.status).toBe('done');
    expect(onStream).toHaveBeenCalledTimes(2);
    expect(onStream).toHaveBeenNthCalledWith(1, {
      type: 'text',
      data: { text: 'partial answer' },
    });
    expect(onStream).toHaveBeenNthCalledWith(2, {
      type: 'result',
      data: {
        result: 'partial answer',
        success: true,
        sessionId: '11111111-1111-4111-8111-111111111111',
      },
    });
  });

  it('emits the final error result event when a success result is followed by an error result', async () => {
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
    const onStream = vi.fn();

    const res = await callClaudeHeadless('agent', 'p', {
      cwd: '/tmp',
      onStream,
    });

    expect(res.status).toBe('error');
    expect(onStream).toHaveBeenCalledTimes(1);
    expect(onStream).toHaveBeenNthCalledWith(1, {
      type: 'result',
      data: {
        result: 'final failure',
        success: false,
        error: 'final failure',
        sessionId: '11111111-1111-4111-8111-111111111111',
      },
    });
  });

  it('emits the final error result event when subtype is error without is_error flags', async () => {
    stubSpawn({
      stdoutChunks: [
        `${JSON.stringify({
          type: 'result',
          subtype: 'error',
          message: 'explicit failure',
          result: 'partial answer',
        })}\n`,
      ],
      closeCode: 0,
    });
    const onStream = vi.fn();

    const res = await callClaudeHeadless('agent', 'p', {
      cwd: '/tmp',
      onStream,
    });

    expect(res.status).toBe('error');
    expect(onStream).toHaveBeenCalledTimes(1);
    expect(onStream).toHaveBeenNthCalledWith(1, {
      type: 'result',
      data: {
        result: 'partial answer',
        success: false,
        error: 'explicit failure',
        sessionId: '11111111-1111-4111-8111-111111111111',
      },
    });
  });

  it('emits the final success result event when an error result is followed by a success result', async () => {
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
    const onStream = vi.fn();

    const res = await callClaudeHeadless('agent', 'p', {
      cwd: '/tmp',
      onStream,
    });

    expect(res.status).toBe('done');
    expect(onStream).toHaveBeenCalledTimes(1);
    expect(onStream).toHaveBeenNthCalledWith(1, {
      type: 'result',
      data: {
        result: 'final answer',
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

  it('passes --allowed-tools with comma-joined values after --model and before --effort', async () => {
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
    const sepIdx = argv.indexOf('--');
    expect(modelIdx).toBeGreaterThanOrEqual(0);
    expect(toolsIdx).toBeGreaterThanOrEqual(0);
    expect(effortIdx).toBeGreaterThanOrEqual(0);
    expect(argv[toolsIdx + 1]).toBe('Read,Grep,Edit');
    expect(argv[effortIdx + 1]).toBe('high');
    expect(modelIdx).toBeLessThan(toolsIdx);
    expect(toolsIdx).toBeLessThan(effortIdx);
    expect(effortIdx).toBeLessThan(sepIdx);
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

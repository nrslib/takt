import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';

vi.mock('node:crypto', () => ({
  randomUUID: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { callClaudeHeadless } from '../infra/claude-headless/client.js';

describe('callClaudeHeadless', () => {
  beforeEach(() => {
    vi.mocked(spawn).mockReset();
    vi.mocked(randomUUID).mockReset();
    vi.mocked(randomUUID).mockReturnValue('11111111-1111-4111-8111-111111111111');
  });

  function stubSpawn(opts: {
    stdoutChunks?: string[];
    stderrChunks?: string[];
    closeCode?: number | null;
    closeSignal?: NodeJS.Signals | null;
    error?: NodeJS.ErrnoException;
  }): void {
    vi.mocked(spawn).mockImplementation((_cmd, _args, _o) => {
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
      stdoutChunks: [`${JSON.stringify({ type: 'text', text: 'ok' })}\n`],
      closeCode: 0,
    });
    const res = await callClaudeHeadless('agent', 'hi', { cwd: '/tmp' });
    expect(res.status).toBe('done');
    expect(res.content).toBe('ok');
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
    const call = vi.mocked(spawn).mock.calls.at(-1);
    expect(call).toBeDefined();
    return call![1] as string[];
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
        `${JSON.stringify({ type: 'text', text: 'ok' })}\n`,
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
    const sessionId = '550e8400-e29b-41d4-a716-446655440000';
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

  it('returns a new sessionId from stdout on the first call and resumes with it on the next call', async () => {
    stubSpawn({
      stdoutChunks: [
        `${JSON.stringify({ type: 'system', session_id: '22222222-2222-4222-8222-222222222222' })}\n`,
        `${JSON.stringify({ type: 'text', text: 'first' })}\n`,
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

  it('passes mcpServers as --mcp-config JSON', async () => {
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
    expect(JSON.parse(argv[mcpIndex + 1]!)).toEqual({
      mcpServers: {
        local: {
          command: 'node',
          args: ['server.js'],
        },
      },
    });
  });

  it('returns an error when sessionId is not a UUID', async () => {
    const res = await callClaudeHeadless('agent', 'p', {
      cwd: '/tmp',
      sessionId: 'not-a-uuid',
    });

    expect(res.status).toBe('error');
    expect(res.error).toMatch(/must be a valid UUID/);
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
      providerOptions: { claude: { effort: 'high' } },
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

  it('omits --allowed-tools and --effort when not configured', async () => {
    stubSpawn({
      stdoutChunks: [`${JSON.stringify({ type: 'text', text: 'x' })}\n`],
      closeCode: 0,
    });
    await callClaudeHeadless('agent', 'p', {
      cwd: '/tmp',
      allowedTools: [],
      providerOptions: { claude: {} },
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
      providerOptions: { claude: { effort: 'low' } },
    });
    const argv = lastSpawnArgv();
    expect(argv).not.toContain('--allowed-tools');
    const effortIdx = argv.indexOf('--effort');
    expect(effortIdx).toBeGreaterThanOrEqual(0);
    expect(argv[effortIdx + 1]).toBe('low');
  });
});

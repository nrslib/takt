import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

import { spawn } from 'node:child_process';
import { callClaudeHeadless } from '../infra/claude-headless/client.js';

describe('callClaudeHeadless', () => {
  beforeEach(() => {
    vi.mocked(spawn).mockReset();
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
      ]),
    );
    expect(argv.at(-2)).toBe('--');
    expect(argv.at(-1)).toBe('hi');
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

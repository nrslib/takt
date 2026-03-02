/**
 * Tests for GitHub Copilot CLI client
 */

import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

import { callCopilot, extractSessionIdFromShareFile } from '../infra/copilot/client.js';

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

function mockSpawnWithScenario(scenario: SpawnScenario): void {
  mockSpawn.mockImplementation((_cmd: string, _args: string[], _options: object) => {
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

      child.emit('close', scenario.code ?? 0, scenario.signal ?? null);
    });

    return child;
  });
}

describe('callCopilot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.COPILOT_GITHUB_TOKEN;
    mockMkdtemp.mockResolvedValue('/tmp/takt-copilot-XXXXXX');
    mockReadFile.mockResolvedValue(
      '# 🤖 Copilot CLI Session\n\n> **Session ID:** `aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`\n',
    );
    mockRm.mockResolvedValue(undefined);
  });

  it('should invoke copilot with required args including --silent, --no-color', async () => {
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
    });

    expect(result.status).toBe('done');
    expect(result.content).toBe('Implementation complete. All tests pass.');
    expect(result.sessionId).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [command, args, options] = mockSpawn.mock.calls[0] as [string, string[], { env?: NodeJS.ProcessEnv; stdio?: unknown }];

    expect(command).toBe('copilot');
    expect(args).toContain('-p');
    expect(args).toContain('--silent');
    expect(args).toContain('--no-color');
    expect(args).toContain('--no-auto-update');
    expect(args).toContain('--model');
    expect(args).toContain('--resume');
    expect(args).toContain('--yolo');
    expect(args).toContain('--share');
    expect(options.env?.COPILOT_GITHUB_TOKEN).toBe('gh-token');
    expect(options.stdio).toEqual(['ignore', 'pipe', 'pipe']);
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

  it('should not add permission flags for readonly mode', async () => {
    mockSpawnWithScenario({
      stdout: 'done',
      code: 0,
    });

    await callCopilot('coder', 'implement feature', {
      cwd: '/repo',
      permissionMode: 'readonly',
    });

    const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
    expect(args).not.toContain('--yolo');
    expect(args).not.toContain('--allow-all-tools');
    expect(args).not.toContain('--no-ask-user');
    expect(args).not.toContain('--autopilot');
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
    expect(options.env).toBe(process.env);
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

    await callCopilot('reviewer', 'review this code', {
      cwd: '/repo',
      systemPrompt: 'You are a strict reviewer.',
    });

    const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
    const promptIndex = args.indexOf('-p');
    expect(promptIndex).toBeGreaterThan(-1);
    expect(args[promptIndex + 1]).toBe('You are a strict reviewer.\n\nreview this code');
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

  it('should return error when stdout buffer overflows', async () => {
    mockSpawn.mockImplementation(() => {
      const child = createMockChildProcess();
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.alloc(10 * 1024 * 1024 + 1));
      });
      return child;
    });

    const result = await callCopilot('coder', 'implement', { cwd: '/repo' });

    expect(result.status).toBe('error');
    expect(result.content).toContain('Copilot CLI output exceeded buffer limit');
  });

  it('should return error when stderr buffer overflows', async () => {
    mockSpawn.mockImplementation(() => {
      const child = createMockChildProcess();
      queueMicrotask(() => {
        child.stderr.emit('data', Buffer.alloc(10 * 1024 * 1024 + 1));
      });
      return child;
    });

    const result = await callCopilot('coder', 'implement', { cwd: '/repo' });

    expect(result.status).toBe('error');
    expect(result.content).toContain('Copilot CLI output exceeded buffer limit');
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

/**
 * Tests for Cursor Agent CLI client
 */

import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSpawn } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: mockSpawn,
}));

import { callCursor } from '../infra/cursor/client.js';

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

describe('callCursor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.CURSOR_API_KEY;
  });

  it('should invoke cursor-agent with required args and map model/session/permission', async () => {
    mockSpawnWithScenario({
      stdout: JSON.stringify({ content: 'done', sessionId: 'sess-new' }),
      code: 0,
    });

    const result = await callCursor('coder', 'implement feature', {
      cwd: '/repo',
      model: 'cursor/gpt-5',
      sessionId: 'sess-prev',
      permissionMode: 'full',
      cursorApiKey: 'cursor-key',
    });

    expect(result.status).toBe('done');
    expect(result.content).toBe('done');
    expect(result.sessionId).toBe('sess-new');

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [command, args, options] = mockSpawn.mock.calls[0] as [string, string[], { env?: NodeJS.ProcessEnv; stdio?: unknown }];

    expect(command).toBe('cursor-agent');
    expect(args).toEqual([
      '-p',
      '--output-format',
      'json',
      '--workspace',
      '/repo',
      '--model',
      'cursor/gpt-5',
      '--resume',
      'sess-prev',
      '--force',
      'implement feature',
    ]);
    expect(options.env?.CURSOR_API_KEY).toBe('cursor-key');
    expect(options.stdio).toEqual(['ignore', 'pipe', 'pipe']);
  });

  it('should not inject CURSOR_API_KEY when cursorApiKey is undefined', async () => {
    mockSpawnWithScenario({
      stdout: JSON.stringify({ content: 'done' }),
      code: 0,
    });

    const result = await callCursor('coder', 'implement feature', {
      cwd: '/repo',
      permissionMode: 'edit',
    });

    expect(result.status).toBe('done');

    const [, args, options] = mockSpawn.mock.calls[0] as [string, string[], { env?: NodeJS.ProcessEnv }];
    expect(args).not.toContain('--force');
    expect(options.env).toBe(process.env);
  });

  it('should return structured error when cursor-agent binary is not found', async () => {
    mockSpawnWithScenario({
      error: { code: 'ENOENT', message: 'spawn cursor-agent ENOENT' },
    });

    const result = await callCursor('coder', 'implement feature', { cwd: '/repo' });

    expect(result.status).toBe('error');
    expect(result.content).toContain('cursor-agent binary not found');
  });

  it('should classify authentication errors', async () => {
    mockSpawnWithScenario({
      code: 1,
      stderr: 'Authentication required. Please login.',
    });

    const result = await callCursor('coder', 'implement feature', { cwd: '/repo' });

    expect(result.status).toBe('error');
    expect(result.content).toContain('cursor-agent login');
    expect(result.content).toContain('TAKT_CURSOR_API_KEY');
  });

  it('should classify non-zero exits', async () => {
    mockSpawnWithScenario({
      code: 2,
      stderr: 'unexpected failure',
    });

    const result = await callCursor('coder', 'implement feature', { cwd: '/repo' });

    expect(result.status).toBe('error');
    expect(result.content).toContain('code 2');
    expect(result.content).toContain('unexpected failure');
  });

  it('should return parse error when stdout is not valid JSON', async () => {
    mockSpawnWithScenario({
      stdout: 'not-json',
      code: 0,
    });

    const result = await callCursor('coder', 'implement feature', { cwd: '/repo' });

    expect(result.status).toBe('error');
    expect(result.content).toContain('Failed to parse cursor-agent JSON output');
  });
});

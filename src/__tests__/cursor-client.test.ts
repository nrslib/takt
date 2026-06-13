/**
 * Tests for Cursor Agent CLI client
 */

import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

const CURSOR_CONFIG_RENAME_ENOENT =
  "Error: ENOENT: no such file or directory, rename '/home/user/.cursor/cli-config.json.tmp' -> '/home/user/.cursor/cli-config.json'";
const CURSOR_CONFIG_NON_RENAME_ENOENT =
  "Error: ENOENT: no such file or directory, open '/home/user/.cursor/cli-config.json.tmp'";
const CURSOR_CONFIG_RENAME_ENOENT_ATTEMPTS = 9;

function createMockChildProcess(): MockChildProcess {
  const child = new EventEmitter() as MockChildProcess;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn(() => true);
  return child;
}

function mockSpawnWithScenarios(scenarios: SpawnScenario[]): void {
  let scenarioIndex = 0;

  mockSpawn.mockImplementation((_cmd: string, _args: string[], _options: object) => {
    const scenario = scenarios[scenarioIndex];
    scenarioIndex += 1;
    if (!scenario) {
      throw new Error(`Missing cursor spawn scenario for attempt ${scenarioIndex}`);
    }

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

function mockSpawnWithScenario(scenario: SpawnScenario): void {
  mockSpawnWithScenarios([scenario]);
}

describe('callCursor', () => {
  const originalEnv = {
    CURSOR_API_KEY: process.env.CURSOR_API_KEY,
    TAKT_OBSERVABILITY: process.env.TAKT_OBSERVABILITY,
    OTEL_EXPORTER_OTLP_ENDPOINT: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.CURSOR_API_KEY;
    delete process.env.TAKT_OBSERVABILITY;
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();

    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
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
      '--trust',
      '--output-format',
      'json',
      '--workspace',
      '/repo',
      '--model',
      'cursor/gpt-5',
      '--resume',
      'sess-prev',
      '--force',
      '--',
      'implement feature',
    ]);
    expect(options.env?.CURSOR_API_KEY).toBe('cursor-key');
    expect(options.stdio).toEqual(['ignore', 'pipe', 'pipe']);
  });

  it('should pass prompt after end-of-options marker', async () => {
    mockSpawnWithScenario({
      stdout: JSON.stringify({ content: 'done' }),
      code: 0,
    });

    const result = await callCursor('coder', '--workspace=/', {
      cwd: '/repo',
    });

    expect(result.status).toBe('done');

    const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
    expect(args).toContain('--');
    expect(args.at(-2)).toBe('--');
    expect(args.at(-1)).toBe('--workspace=/');
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
    expect(options.env).not.toBe(process.env);
    expect(options.env?.CURSOR_API_KEY).toBeUndefined();
  });

  it('preserves ambient OTEL env when childProcessEnv is undefined', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://ambient-collector.example.test';
    mockSpawnWithScenario({
      stdout: JSON.stringify({ content: 'done' }),
      code: 0,
    });

    const result = await callCursor('coder', 'implement feature', {
      cwd: '/repo',
      permissionMode: 'edit',
    });

    expect(result.status).toBe('done');

    const [, , options] = mockSpawn.mock.calls[0] as [string, string[], { env?: NodeJS.ProcessEnv }];
    expect(options.env?.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('https://ambient-collector.example.test');
  });

  it('passes only run-local observability snapshot to cursor child env', async () => {
    process.env.TAKT_OBSERVABILITY = '{"enabled":false}';
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://ambient-user:pass@collector.example.test';
    mockSpawnWithScenario({
      stdout: JSON.stringify({ content: 'done' }),
      code: 0,
    });

    const result = await callCursor('coder', 'implement feature', {
      cwd: '/repo',
      childProcessEnv: {
        TAKT_OBSERVABILITY: '{"enabled":true}',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://snapshot-collector.example.test',
      },
    });

    expect(result.status).toBe('done');

    const [, , options] = mockSpawn.mock.calls[0] as [string, string[], { env?: NodeJS.ProcessEnv }];
    expect(options.env?.TAKT_OBSERVABILITY).toBe('{"enabled":true}');
    expect(options.env?.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('https://snapshot-collector.example.test');
  });

  it('should return structured error when cursor-agent binary is not found', async () => {
    mockSpawnWithScenario({
      error: { code: 'ENOENT', message: 'spawn cursor-agent ENOENT' },
    });

    const result = await callCursor('coder', 'implement feature', { cwd: '/repo' });

    expect(result.status).toBe('error');
    expect(result.content).toContain('cursor-agent binary not found');
    expect(result.failureCategory).toBeUndefined();
    expect(mockSpawn).toHaveBeenCalledTimes(1);
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
    expect(result.failureCategory).toBeUndefined();
    expect(mockSpawn).toHaveBeenCalledTimes(1);
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
    expect(result.failureCategory).toBeUndefined();
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it('should retry cli-config rename ENOENT and return successful retry result', async () => {
    vi.useFakeTimers();
    mockSpawnWithScenarios([
      {
        code: 1,
        stderr: `${'x'.repeat(450)}${CURSOR_CONFIG_RENAME_ENOENT}`,
      },
      {
        stdout: JSON.stringify({ content: 'retry succeeded', sessionId: 'sess-after-retry' }),
        code: 0,
      },
    ]);

    const resultPromise = callCursor('coding-review', 'review changes', {
      cwd: '/repo',
      sessionId: 'sess-before-retry',
    });

    await vi.advanceTimersByTimeAsync(999);
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    const result = await resultPromise;

    expect(mockSpawn).toHaveBeenCalledTimes(2);
    expect(result.status).toBe('done');
    expect(result.content).toBe('retry succeeded');
    expect(result.sessionId).toBe('sess-after-retry');
  });

  it('should stop cli-config rename ENOENT retry when aborted during retry delay', async () => {
    vi.useFakeTimers();
    const abortController = new AbortController();
    const onStream = vi.fn();
    mockSpawnWithScenarios([
      {
        code: 1,
        stderr: CURSOR_CONFIG_RENAME_ENOENT,
      },
      {
        stdout: JSON.stringify({ content: 'should not run' }),
        code: 0,
      },
    ]);

    const resultPromise = callCursor('coding-review', 'review changes', {
      cwd: '/repo',
      sessionId: 'sess-aborted-retry',
      abortSignal: abortController.signal,
      onStream,
    });

    await vi.advanceTimersByTimeAsync(999);
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    abortController.abort();
    const result = await resultPromise;

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('error');
    expect(result.content).toBe('Cursor execution aborted');
    expect(result.failureCategory).toBeUndefined();
    expect(onStream).toHaveBeenCalledWith({
      type: 'result',
      data: {
        result: '',
        success: false,
        error: 'Cursor execution aborted',
        sessionId: 'sess-aborted-retry',
      },
    });
  });

  it('should not retry cli-config ENOENT when it is not a rename failure', async () => {
    vi.useFakeTimers();
    mockSpawnWithScenario({
      code: 1,
      stderr: CURSOR_CONFIG_NON_RENAME_ENOENT,
    });

    const result = await callCursor('coding-review', 'review changes', { cwd: '/repo' });

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('error');
    expect(result.failureCategory).toBeUndefined();
    expect(result.content).toContain('code 1');
    expect(result.content).toContain('cli-config.json.tmp');
  });

  it('should return provider_error when cli-config rename ENOENT retry attempts are exhausted', async () => {
    vi.useFakeTimers();
    const onStream = vi.fn();
    mockSpawnWithScenarios(Array.from({ length: CURSOR_CONFIG_RENAME_ENOENT_ATTEMPTS }, () => ({
      code: 1,
      stderr: CURSOR_CONFIG_RENAME_ENOENT,
    })));

    const resultPromise = callCursor('coding-review', 'review changes', {
      cwd: '/repo',
      sessionId: 'sess-retry-exhausted',
      onStream,
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(mockSpawn).toHaveBeenCalledTimes(CURSOR_CONFIG_RENAME_ENOENT_ATTEMPTS);
    expect(result.status).toBe('error');
    expect(result.failureCategory).toBe('provider_error');
    expect(result.content).toContain('code 1');
    expect(result.content).toContain('cli-config.json.tmp');
    expect(result.content).toContain('cli-config.json');
    expect(onStream).toHaveBeenCalledWith({
      type: 'result',
      data: expect.objectContaining({
        success: false,
        error: expect.stringContaining('cli-config.json.tmp'),
        failureCategory: 'provider_error',
      }),
    });
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

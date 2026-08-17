import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { crossSpawnMock, createClientMock } = vi.hoisted(() => ({
  crossSpawnMock: vi.fn(),
  createClientMock: vi.fn(),
}));

vi.unmock('../infra/opencode/server-process.js');

vi.mock('../shared/utils/spawn.js', () => ({
  crossSpawn: crossSpawnMock,
}));

vi.mock('@opencode-ai/sdk/v2', () => ({
  createOpencodeClient: createClientMock,
}));

interface TestChildProcess {
  child: ChildProcess;
  stdin: EventEmitter;
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
}

interface MutableChildProcessState {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: (signal?: number | NodeJS.Signals) => boolean;
}

function createTestChildProcess(markTerminatedOnSigterm = true): TestChildProcess {
  const stdin = new EventEmitter();
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const rawChild = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    exitCode: null,
    signalCode: null,
  });
  const state = rawChild as unknown as MutableChildProcessState;
  const kill = vi.fn((signal?: number | NodeJS.Signals) => {
    if (markTerminatedOnSigterm && signal === 'SIGTERM') state.signalCode = 'SIGTERM';
    return true;
  });
  state.kill = kill;
  return {
    child: rawChild as unknown as ChildProcess,
    stdin,
    stdout,
    stderr,
    kill,
  };
}

function emitExit(testChild: TestChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
  const state = testChild.child as unknown as MutableChildProcessState;
  state.exitCode = code;
  state.signalCode = signal;
  testChild.child.emit('exit', code, signal);
}

async function getStartOpenCodeServer(): Promise<typeof import('../infra/opencode/server-process.js').startOpenCodeServer> {
  const module = await import('../infra/opencode/server-process.js');
  return module.startOpenCodeServer;
}

function startOptions(timeoutMs = 100): {
  port: number;
  timeoutMs: number;
  config: Record<string, unknown>;
} {
  return {
    port: 62000,
    timeoutMs,
    config: { model: 'opencode/model' },
  };
}

async function expectPromisePending(promise: Promise<unknown>): Promise<void> {
  let settled = false;
  void promise.then(
    () => { settled = true; },
    () => { settled = true; },
  );
  await Promise.resolve();
  expect(settled).toBe(false);
}

describe('OpenCode server process', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    crossSpawnMock.mockReset();
    createClientMock.mockReset();
  });

  it.each(['stdin', 'stdout', 'stderr'] as const)(
    'should report a %s EPIPE after startup through onError',
    async (streamName) => {
      const testChild = createTestChildProcess();
      const client = {};
      crossSpawnMock.mockReturnValue(testChild.child);
      createClientMock.mockReturnValue(client);

      const startOpenCodeServer = await getStartOpenCodeServer();
      const startPromise = startOpenCodeServer(startOptions());
      testChild.stdout.emit('data', 'opencode server listening on http://127.0.0.1:62000\n');
      const server = await startPromise;
      const errors: Error[] = [];
      server.onError((error) => errors.push(error));

      const stream = testChild[streamName];
      stream.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));

      expect(errors).toHaveLength(1);
      expect(errors[0]?.message).toBe(`OpenCode server ${streamName} stream failed: write EPIPE`);

      server.close();
    },
  );

  it('should include recent post-startup output in an unexpected exit error', async () => {
    const testChild = createTestChildProcess();
    crossSpawnMock.mockReturnValue(testChild.child);
    createClientMock.mockReturnValue({});

    const startOpenCodeServer = await getStartOpenCodeServer();
    const startPromise = startOpenCodeServer(startOptions());
    testChild.stdout.emit('data', 'opencode server listening on http://127.0.0.1:62000\n');
    const server = await startPromise;
    const errors: Error[] = [];
    server.onError((error) => errors.push(error));

    testChild.stderr.emit('data', 'FATAL: model backend unreachable\n');
    testChild.child.emit('exit', 1, null);

    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('FATAL: model backend unreachable');
    server.close();
  });

  it('should wait for a complete stdout line before parsing a server URL', async () => {
    const testChild = createTestChildProcess();
    crossSpawnMock.mockReturnValue(testChild.child);
    createClientMock.mockReturnValue({});

    const startOpenCodeServer = await getStartOpenCodeServer();
    const startPromise = startOpenCodeServer(startOptions());
    testChild.stdout.emit('data', 'opencode server listening on http://127.0.0.1:62000');
    await expectPromisePending(startPromise);

    testChild.stdout.emit('data', '\n');
    const server = await startPromise;

    expect(createClientMock).toHaveBeenCalledWith({ baseUrl: 'http://127.0.0.1:62000' });
    server.close();
  });

  it('should wait for the rest of an incomplete listening line instead of failing', async () => {
    const testChild = createTestChildProcess();
    crossSpawnMock.mockReturnValue(testChild.child);
    createClientMock.mockReturnValue({});

    const startOpenCodeServer = await getStartOpenCodeServer();
    const startPromise = startOpenCodeServer(startOptions());
    testChild.stdout.emit('data', 'opencode server listening');
    await expectPromisePending(startPromise);

    testChild.stdout.emit('data', ' on http://127.0.0.1:62000\n');
    const server = await startPromise;

    expect(createClientMock).toHaveBeenCalledWith({ baseUrl: 'http://127.0.0.1:62000' });
    server.close();
  });

  it('should sanitize server output included in a startup failure', async () => {
    const testChild = createTestChildProcess();
    const secret = 'server-output-api-key-secret';
    crossSpawnMock.mockReturnValue(testChild.child);
    createClientMock.mockReturnValue({});

    const startOpenCodeServer = await getStartOpenCodeServer();
    const startPromise = startOpenCodeServer(startOptions());
    testChild.stderr.emit('data', `server config: apiKey=${secret}\n`);
    emitExit(testChild, 1, null);

    const error = await startPromise.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('[REDACTED]');
    expect((error as Error).message).not.toContain(secret);
  });

  it('should fail startup when a child stdio stream emits an error', async () => {
    const testChild = createTestChildProcess();
    crossSpawnMock.mockReturnValue(testChild.child);

    const startOpenCodeServer = await getStartOpenCodeServer();
    const startPromise = startOpenCodeServer(startOptions());
    testChild.stdin.emit('error', new Error('startup stdin failed'));

    await expect(startPromise).rejects.toThrow('OpenCode server stdin stream failed: startup stdin failed');
    expect(testChild.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('should fail startup after the configured timeout', async () => {
    vi.useFakeTimers();
    try {
      const testChild = createTestChildProcess();
      crossSpawnMock.mockReturnValue(testChild.child);

      const startOpenCodeServer = await getStartOpenCodeServer();
      const startPromise = startOpenCodeServer(startOptions(20));
      const rejection = expect(startPromise).rejects.toThrow(
        'Timeout waiting for OpenCode server to start after 20ms',
      );
      await vi.advanceTimersByTimeAsync(20);

      await rejection;
      expect(testChild.kill).toHaveBeenCalledWith('SIGTERM');
    } finally {
      vi.useRealTimers();
    }
  });

  it('should propagate a child exit after startup through onError', async () => {
    const testChild = createTestChildProcess();
    crossSpawnMock.mockReturnValue(testChild.child);
    createClientMock.mockReturnValue({});

    const startOpenCodeServer = await getStartOpenCodeServer();
    const startPromise = startOpenCodeServer(startOptions());
    testChild.stdout.emit('data', 'opencode server listening on http://127.0.0.1:62000\n');
    const server = await startPromise;
    const errors: Error[] = [];
    server.onError((error) => errors.push(error));

    emitExit(testChild, 1, null);

    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('OpenCode server exited with code 1');
  });

  it('should not notify listeners for events emitted after close', async () => {
    const testChild = createTestChildProcess();
    crossSpawnMock.mockReturnValue(testChild.child);
    createClientMock.mockReturnValue({});

    const startOpenCodeServer = await getStartOpenCodeServer();
    const startPromise = startOpenCodeServer(startOptions());
    testChild.stdout.emit('data', 'opencode server listening on http://127.0.0.1:62000\n');
    const server = await startPromise;
    const errors: Error[] = [];
    server.onError((error) => errors.push(error));
    server.close();

    testChild.stdin.on('error', () => {});
    testChild.stdout.on('error', () => {});
    testChild.stderr.on('error', () => {});
    testChild.child.on('error', () => {});
    testChild.stdin.emit('error', new Error('stdin after close'));
    testChild.stdout.emit('error', new Error('stdout after close'));
    testChild.stderr.emit('error', new Error('stderr after close'));
    testChild.stdout.emit('data', 'opencode server listening on http://127.0.0.1:62000\n');
    testChild.child.emit('error', new Error('child after close'));
    testChild.child.emit('exit', 1, null);

    expect(errors).toHaveLength(0);
  });

  it('should escalate a non-terminating child from SIGTERM to SIGKILL', async () => {
    vi.useFakeTimers();
    try {
      const testChild = createTestChildProcess(false);
      crossSpawnMock.mockReturnValue(testChild.child);
      createClientMock.mockReturnValue({});

      const startOpenCodeServer = await getStartOpenCodeServer();
      const startPromise = startOpenCodeServer(startOptions());
      testChild.stdout.emit('data', 'opencode server listening on http://127.0.0.1:62000\n');
      const server = await startPromise;
      server.close();

      expect(testChild.kill).toHaveBeenCalledWith('SIGTERM');
      await vi.advanceTimersByTimeAsync(500);
      expect(testChild.kill).toHaveBeenCalledWith('SIGKILL');
    } finally {
      vi.useRealTimers();
    }
  });
});

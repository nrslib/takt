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
    pid: 12345,
    exitCode: null,
    signalCode: null,
  });
  const state = rawChild as unknown as MutableChildProcessState;
  const kill = vi.fn((signal?: number | NodeJS.Signals) => {
    if ((markTerminatedOnSigterm && signal === 'SIGTERM') || signal === 'SIGKILL') {
      state.signalCode = signal;
      queueMicrotask(() => rawChild.emit('exit', null, signal));
    }
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
  runtime: import('../infra/opencode/runtime.js').OpenCodeRuntime;
  port: number;
  timeoutMs: number;
  config: Record<string, unknown>;
} {
  return {
    runtime: { generation: 'v1', command: 'opencode', version: '1.18.2' },
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

      await server.close();
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
    await server.close();
  });

  it('should keep only the bounded tail of post-startup output in an exit error', async () => {
    const testChild = createTestChildProcess();
    crossSpawnMock.mockReturnValue(testChild.child);
    createClientMock.mockReturnValue({});

    const startOpenCodeServer = await getStartOpenCodeServer();
    const startPromise = startOpenCodeServer(startOptions());
    testChild.stdout.emit('data', 'opencode server listening on http://127.0.0.1:62000\n');
    const server = await startPromise;
    const errors: Error[] = [];
    server.onError((error) => errors.push(error));

    testChild.stderr.emit('data', `OLD-HEAD ${'x'.repeat(2100)}`);
    testChild.stderr.emit('data', 'RECENT-TAIL\n');
    testChild.child.emit('exit', 1, null);

    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).not.toContain('OLD-HEAD');
    expect(errors[0]?.message).toContain('RECENT-TAIL');
    await server.close();
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
    await server.close();
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
    await server.close();
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
    const testChild = createTestChildProcess(false);
    crossSpawnMock.mockReturnValue(testChild.child);

    const startOpenCodeServer = await getStartOpenCodeServer();
    const startPromise = startOpenCodeServer(startOptions());
    const rejection = expect(startPromise).rejects.toThrow(
      'OpenCode server stdin stream failed: startup stdin failed',
    );
    testChild.stdin.emit('error', new Error('startup stdin failed'));

    await expectPromisePending(startPromise);
    expect(testChild.kill).toHaveBeenCalledWith('SIGTERM');
    emitExit(testChild, null, 'SIGTERM');
    await rejection;
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

  it('should wait for child exit when transport creation fails', async () => {
    vi.useFakeTimers();
    try {
      const testChild = createTestChildProcess(false);
      crossSpawnMock.mockReturnValue(testChild.child);
      createClientMock.mockImplementationOnce(() => {
        throw new Error('transport initialization failed');
      });

      const startOpenCodeServer = await getStartOpenCodeServer();
      const startPromise = startOpenCodeServer(startOptions());
      const rejection = expect(startPromise).rejects.toThrow('transport initialization failed');
      testChild.stdout.emit('data', 'opencode server listening on http://127.0.0.1:62000\n');

      await expectPromisePending(startPromise);
      expect(testChild.kill).toHaveBeenCalledWith('SIGTERM');
      await vi.advanceTimersByTimeAsync(500);
      expect(testChild.kill).toHaveBeenCalledWith('SIGKILL');
      await rejection;
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
    await server.close();

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

  it('should wait for child exit before resolving close and escalate after 500ms when SIGTERM is ignored', async () => {
    vi.useFakeTimers();
    try {
      const testChild = createTestChildProcess(false);
      crossSpawnMock.mockReturnValue(testChild.child);
      createClientMock.mockReturnValue({});

      const startOpenCodeServer = await getStartOpenCodeServer();
      const startPromise = startOpenCodeServer(startOptions());
      testChild.stdout.emit('data', 'opencode server listening on http://127.0.0.1:62000\n');
      const server = await startPromise;
      testChild.kill.mockImplementation(() => true);
      const closePromise = server.close();
      const duplicateClosePromise = server.close();

      expect(testChild.kill).toHaveBeenCalledWith('SIGTERM');
      expect(testChild.kill).toHaveBeenCalledTimes(1);
      await expectPromisePending(closePromise);
      await expectPromisePending(duplicateClosePromise);
      await vi.advanceTimersByTimeAsync(500);
      expect(testChild.kill).toHaveBeenCalledWith('SIGKILL');
      expect(testChild.kill).toHaveBeenCalledTimes(2);
      await expectPromisePending(closePromise);
      await expectPromisePending(duplicateClosePromise);

      emitExit(testChild, null, 'SIGKILL');
      await Promise.all([closePromise, duplicateClosePromise]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('should wait for a SIGTERM-responsive child exit before resolving close', async () => {
    const testChild = createTestChildProcess(false);
    crossSpawnMock.mockReturnValue(testChild.child);
    createClientMock.mockReturnValue({});

    const startOpenCodeServer = await getStartOpenCodeServer();
    const startPromise = startOpenCodeServer(startOptions());
    testChild.stdout.emit('data', 'opencode server listening on http://127.0.0.1:62000\n');
    const server = await startPromise;
    const closePromise = server.close();

    expect(testChild.kill).toHaveBeenCalledWith('SIGTERM');
    await expectPromisePending(closePromise);
    emitExit(testChild, null, 'SIGTERM');
    await closePromise;
    expect(testChild.kill).not.toHaveBeenCalledWith('SIGKILL');
  });

  it.each([
    ['exit state is updated before kill returns and the event follows later', 'state-before-return'],
    ['exit state is updated after kill returns without an event yet', 'state-after-return'],
    ['the exit event arrives in the next event-loop turn', 'next-turn'],
    ['the exit event arrives after the first confirmation check', 'second-check'],
    ['no exit confirmation arrives', 'none'],
  ] as const)(
    'should settle SIGKILL false based on child exit confirmation when %s',
    async (_description, confirmation) => {
      vi.useFakeTimers();
      try {
        const testChild = createTestChildProcess(false);
        const state = testChild.child as unknown as MutableChildProcessState;
        const events: string[] = [];
        testChild.kill.mockImplementation((signal?: number | NodeJS.Signals) => {
          if (signal !== 'SIGKILL') return true;
          const emitConfirmedExit = (): void => {
            state.signalCode = 'SIGKILL';
            events.push('exit-state-updated');
            events.push('exit-event');
            testChild.child.emit('exit', null, 'SIGKILL');
          };
          if (confirmation === 'state-before-return') {
            state.signalCode = 'SIGKILL';
            events.push('exit-state-updated-before-return');
            events.push('sigkill-return-false');
            setTimeout(() => {
              events.push('exit-event');
              testChild.child.emit('exit', null, 'SIGKILL');
            }, 1);
          } else if (confirmation === 'state-after-return') {
            events.push('sigkill-return-false');
            setTimeout(() => {
              state.signalCode = 'SIGKILL';
              events.push('exit-state-updated-after-return');
            }, 0);
          } else if (confirmation === 'next-turn') {
            events.push('sigkill-return-false');
            setImmediate(emitConfirmedExit);
          } else if (confirmation === 'second-check') {
            events.push('sigkill-return-false');
            setTimeout(() => setTimeout(emitConfirmedExit, 0), 0);
          } else {
            events.push('sigkill-return-false');
          }
          return false;
        });
        crossSpawnMock.mockReturnValue(testChild.child);
        createClientMock.mockReturnValue({});

        const startOpenCodeServer = await getStartOpenCodeServer();
        const startPromise = startOpenCodeServer(startOptions());
        testChild.stdout.emit('data', 'opencode server listening on http://127.0.0.1:62000\n');
        const server = await startPromise;
        const exitListenerCountBeforeClose = testChild.child.listenerCount('exit');
        const closePromise = server.close();
        void closePromise.then(
          () => events.push('close-resolved'),
          () => events.push('close-rejected'),
        );

        expect(testChild.kill).toHaveBeenCalledWith('SIGTERM');
        await expectPromisePending(closePromise);
        await vi.advanceTimersByTimeAsync(500);
        expect(testChild.kill).toHaveBeenCalledWith('SIGKILL');

        if (confirmation === 'state-before-return') {
          await expect(closePromise).resolves.toBeUndefined();
          expect(events.indexOf('exit-state-updated-before-return'))
            .toBeLessThan(events.indexOf('sigkill-return-false'));
          await vi.runOnlyPendingTimersAsync();
          expect(events.indexOf('close-resolved')).toBeLessThan(events.indexOf('exit-event'));
        } else {
          await vi.runOnlyPendingTimersAsync();
          await vi.runOnlyPendingTimersAsync();
        }

        if (confirmation === 'none') {
          await expect(closePromise).rejects.toThrow('Failed to terminate the OpenCode server process');
          expect(events).toContain('close-rejected');
          expect(events.indexOf('sigkill-return-false')).toBeLessThan(events.indexOf('close-rejected'));
        } else if (confirmation === 'state-before-return') {
          expect(events.indexOf('exit-state-updated-before-return'))
            .toBeLessThan(events.indexOf('sigkill-return-false'));
        } else if (confirmation === 'state-after-return') {
          await expect(closePromise).resolves.toBeUndefined();
          expect(events.indexOf('sigkill-return-false'))
            .toBeLessThan(events.indexOf('exit-state-updated-after-return'));
          expect(events.indexOf('exit-state-updated-after-return'))
            .toBeLessThan(events.indexOf('close-resolved'));
        } else {
          await expect(closePromise).resolves.toBeUndefined();
          expect(events.indexOf('sigkill-return-false')).toBeLessThan(events.indexOf('exit-state-updated'));
          expect(events.indexOf('exit-state-updated')).toBeLessThan(events.indexOf('exit-event'));
          expect(events.indexOf('exit-event')).toBeLessThan(events.indexOf('close-resolved'));
        }
        expect(testChild.child.listenerCount('exit')).toBe(exitListenerCountBeforeClose - 1);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('should wait for child exit confirmation after SIGKILL throws', async () => {
    vi.useFakeTimers();
    try {
      const testChild = createTestChildProcess(false);
      const state = testChild.child as unknown as MutableChildProcessState;
      testChild.kill.mockImplementation((signal?: number | NodeJS.Signals) => {
        if (signal === 'SIGKILL') {
          setImmediate(() => {
            state.signalCode = 'SIGKILL';
            testChild.child.emit('exit', null, 'SIGKILL');
          });
          throw new Error('SIGKILL failed after child exit began');
        }
        return true;
      });
      crossSpawnMock.mockReturnValue(testChild.child);
      createClientMock.mockReturnValue({});

      const startOpenCodeServer = await getStartOpenCodeServer();
      const startPromise = startOpenCodeServer(startOptions());
      testChild.stdout.emit('data', 'opencode server listening on http://127.0.0.1:62000\n');
      const server = await startPromise;
      const closePromise = server.close();

      await vi.advanceTimersByTimeAsync(500);
      await vi.runOnlyPendingTimersAsync();

      await expect(closePromise).resolves.toBeUndefined();
      expect(testChild.child.listenerCount('exit')).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

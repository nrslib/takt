import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanupOpenCodeClient,
  cleanupOpenCodeProbe,
  listOpenCodeSessionMessages,
  promptOpenCodeSession,
  promptOpenCodeSessionAsync,
  runOpenCodeProbe,
  runOpenCodeSessionWithEvents,
  summarizeOpenCodeSession,
  type OpenCodeProbeClient,
  type OpenCodeRunnableProbeClient,
} from '../../tools/opencode-probe/opencode-probe-lifecycle.mjs';
import {
  parseProbeResult,
  runProbeProcess,
} from '../../tools/opencode-probe/probe-process.mjs';
import {
  PROCESS_TREE_CLEANUP_GRACE_MS,
  startProcessTreeCleanup,
  terminateWindowsProcessTree,
} from '../../tools/opencode-probe/process-tree.mjs';
import {
  runSmokeBatch,
  runSmokeScript,
  type SmokeBatchResult,
} from '../../tools/opencode-probe/smoke-process.mjs';
import {
  markProbeWorkerEnvironment,
  prepareIsolatedProbeEnvironment,
} from '../../tools/opencode-probe/probe-environment.mjs';
import { withProbeWorkspace } from '../../tools/opencode-probe/probe-workspace.mjs';

interface SmokeFixtureCase {
  name: string;
  script: string;
  args: string[];
}

function expectWindowsCommandTimeoutsWithinGrace(executeFile: { mock: { calls: unknown[][] } }) {
  const timeouts = executeFile.mock.calls.flatMap((call) => {
    const options = call[2];
    if (typeof options !== 'object' || options === null || !('timeout' in options)) {
      return [];
    }
    return typeof options.timeout === 'number' ? [options.timeout] : [];
  });
  expect(timeouts.length).toBeGreaterThan(0);
  expect(timeouts.every((timeout) => timeout > 0 && timeout <= PROCESS_TREE_CLEANUP_GRACE_MS)).toBe(true);
}

function captureCleanupWarning(expectedWarning: string | RegExp) {
  const writes: string[] = [];
  let flushed = false;
  let resolveWriteStarted: (() => void) | undefined;
  const writeStarted = new Promise<void>((resolve) => {
    resolveWriteStarted = resolve;
  });
  const flushCallbacks: ((error?: Error | null) => void)[] = [];
  const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation((
    ((
      chunk: string | Uint8Array,
      encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
      callback?: (error?: Error | null) => void,
    ) => {
      const written = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      writes.push(written);
      if (typeof expectedWarning === 'string'
        ? written.includes(expectedWarning)
        : new RegExp(expectedWarning.source, expectedWarning.flags.replace('g', '')).test(written)) {
        resolveWriteStarted?.();
        resolveWriteStarted = undefined;
      }
      const pending = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
      if (pending !== undefined) {
        if (flushed) {
          pending();
        } else {
          flushCallbacks.push(pending);
        }
      }
      return true;
    }) as typeof process.stderr.write
  ));

  return {
    writes,
    writeStarted,
    flush: () => {
      if (flushCallbacks.length === 0) {
        throw new Error('Cleanup warning write callback was not registered');
      }
      flushed = true;
      while (flushCallbacks.length > 0) {
        flushCallbacks.shift()?.();
      }
    },
    wasFlushed: () => flushed,
    restore: () => stderrWrite.mockRestore(),
  };
}

async function expectCleanupFailureAfterWarningFlush(
  cleanup: Promise<void>,
  warning: ReturnType<typeof captureCleanupWarning>,
  expectedError: string | RegExp,
  expectedWarning: string | RegExp,
) {
  let settled = false;
  const observed = cleanup.finally(() => {
    settled = true;
  });
  await warning.writeStarted;
  await Promise.resolve();
  expect(settled).toBe(false);
  warning.flush();
  await expect(observed).rejects.toThrow(expectedError);
  expect(warning.wasFlushed()).toBe(true);
  expect(warning.writes.join('')).toMatch(expectedWarning);
}

// Windows CI boots node children slowly enough that a 500ms phase budget can
// expire before the probe finishes starting (it then never spawns its
// grandchild or prints its PIDs), so give each phase extra headroom there.
const PROBE_PHASE_BUDGET_MS = process.platform === 'win32' ? 2_000 : 500;
const INNER_PROBE_STARTUP_TIMEOUT_MS = 2_000;
const INNER_PROBE_EXECUTION_TIMEOUT_MS = 2_000;
const INNER_PROBE_CLEANUP_TIMEOUT_MS = 150;
const INNER_PROBE_TIMEOUT_BUDGET_MS = INNER_PROBE_STARTUP_TIMEOUT_MS
  + INNER_PROBE_EXECUTION_TIMEOUT_MS
  + INNER_PROBE_CLEANUP_TIMEOUT_MS;
const OWNED_ENTRYPOINT_STARTUP_MARGIN_MS = process.platform === 'win32' ? 5_000 : 1_000;
const OWNED_ENTRYPOINT_REPORT_FLUSH_MARGIN_MS = process.platform === 'win32' ? 5_000 : 2_000;
const OWNED_ENTRYPOINT_TIMEOUT_MS = INNER_PROBE_TIMEOUT_BUDGET_MS
  + OWNED_ENTRYPOINT_STARTUP_MARGIN_MS
  + OWNED_ENTRYPOINT_REPORT_FLUSH_MARGIN_MS
  + PROCESS_TREE_CLEANUP_GRACE_MS;
const OUTER_PROBE_TIMEOUT_MS = INNER_PROBE_TIMEOUT_BUDGET_MS
  + OWNED_ENTRYPOINT_STARTUP_MARGIN_MS
  + PROCESS_TREE_CLEANUP_GRACE_MS;
const SMOKE_BATCH_CASE_TIMEOUT_MS = 5_000;
const SMOKE_BATCH_FIXTURE_STARTUP_MARGIN_MS = process.platform === 'win32' ? 5_000 : 1_000;
const SMOKE_BATCH_CASE_SPAWN_MARGIN_MS = process.platform === 'win32' ? 2_000 : 1_000;
const SMOKE_BATCH_DISPATCH_MARGIN_MS = 250;

function smokeBatchTimeoutMs(caseCount: number) {
  const dispatchedCaseCount = Math.max(1, caseCount);
  const caseBudget = dispatchedCaseCount * (
    SMOKE_BATCH_CASE_TIMEOUT_MS
    + SMOKE_BATCH_CASE_SPAWN_MARGIN_MS
    + PROCESS_TREE_CLEANUP_GRACE_MS
  );
  return SMOKE_BATCH_FIXTURE_STARTUP_MARGIN_MS
    + caseBudget
    + dispatchedCaseCount * SMOKE_BATCH_DISPATCH_MARGIN_MS;
}

const smokeBatchFixture = fileURLToPath(
  new URL('../../tools/opencode-probe/fixtures/run-smoke-batch.mjs', import.meta.url),
);
const smokeCaseFixture = fileURLToPath(
  new URL('../../tools/opencode-probe/fixtures/smoke-case.mjs', import.meta.url),
);

describe('prompt eval probe lifecycle', () => {
  const temporaryDirectories: string[] = [];
  const probeProcessIds: number[] = [];

  function runSmokeFixtureBatch(cases: SmokeFixtureCase[]) {
    const testRoot = mkdtempSync(join(tmpdir(), 'takt-smoke-batch-fixture-'));
    temporaryDirectories.push(testRoot);
    const configPath = join(testRoot, 'smoke-cases.json');
    writeFileSync(configPath, JSON.stringify({ cases, caseTimeoutMs: SMOKE_BATCH_CASE_TIMEOUT_MS }), 'utf8');
    return runSmokeScript(smokeBatchFixture, [configPath], process.env, {
      timeoutMs: smokeBatchTimeoutMs(cases.length),
    });
  }

  function parseSmokeBatchResult(output: string): SmokeBatchResult {
    const marker = 'SMOKE_BATCH_RESULT ';
    const line = output.split('\n').find((candidate) => candidate.startsWith(marker));
    if (line === undefined) {
      throw new Error(`Smoke batch output did not contain ${marker.trim()}`);
    }
    return JSON.parse(line.slice(marker.length)) as SmokeBatchResult;
  }

  afterEach(() => {
    for (const pid of probeProcessIds) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
          throw error;
        }
      }
    }
    probeProcessIds.length = 0;
    for (const directory of temporaryDirectories) {
      rmSync(directory, { recursive: true, force: true });
    }
    temporaryDirectories.length = 0;
  });

  it('should attempt global disposal after session deletion fails', async () => {
    const deletionError = new Error('session deletion failed');
    const sessionDelete = vi.fn().mockRejectedValue(deletionError);
    const globalDispose = vi.fn().mockResolvedValue(undefined);
    const client: OpenCodeProbeClient = {
      session: { delete: sessionDelete },
      global: { dispose: globalDispose },
    };

    await expect(cleanupOpenCodeClient({
      client,
      sessionId: 'session-1',
      directory: '/tmp/probe',
    })).rejects.toBe(deletionError);

    expect(sessionDelete).toHaveBeenCalledOnce();
    expect(globalDispose).toHaveBeenCalledOnce();
    expect(sessionDelete).toHaveBeenCalledWith(
      { sessionID: 'session-1', directory: '/tmp/probe' },
      { throwOnError: true },
    );
    expect(globalDispose).toHaveBeenCalledWith({ throwOnError: true });
  });

  it('should retain both cleanup errors when deletion and disposal fail', async () => {
    const deletionError = new Error('session deletion failed');
    const disposalError = new Error('global disposal failed');
    const client: OpenCodeProbeClient = {
      session: { delete: vi.fn().mockRejectedValue(deletionError) },
      global: { dispose: vi.fn().mockRejectedValue(disposalError) },
    };

    const cleanup = cleanupOpenCodeClient({
      client,
      sessionId: 'session-1',
      directory: '/tmp/probe',
    });

    await expect(cleanup).rejects.toMatchObject({
      errors: [deletionError, disposalError],
    });
  });

  it('should close the server after client cleanup fails', async () => {
    const deletionError = new Error('session deletion failed');
    const serverClose = vi.fn();
    const client: OpenCodeProbeClient = {
      session: { delete: vi.fn().mockRejectedValue(deletionError) },
      global: { dispose: vi.fn().mockResolvedValue(undefined) },
    };

    await expect(cleanupOpenCodeProbe({
      client,
      server: { close: serverClose },
      sessionId: 'session-1',
      directory: '/tmp/probe',
    })).rejects.toBe(deletionError);

    expect(client.global.dispose).toHaveBeenCalledOnce();
    expect(serverClose).toHaveBeenCalledOnce();
  });

  it('should run SDK work inside the shared session and cleanup lifecycle', async () => {
    const calls: string[] = [];
    const client: OpenCodeRunnableProbeClient = {
      session: {
        create: vi.fn().mockImplementation(async () => {
          calls.push('session.create');
          return { data: { id: 'session-1' } };
        }),
        delete: vi.fn().mockImplementation(async () => {
          calls.push('session.delete');
        }),
      },
      global: {
        dispose: vi.fn().mockImplementation(async () => {
          calls.push('global.dispose');
        }),
      },
    };

    const result = await runOpenCodeProbe({
      createProbe: async () => ({
        client,
        server: { close: () => { calls.push('server.close'); } },
      }),
      directory: '/tmp/probe',
      onPhase: (phase) => { calls.push(`phase:${phase}`); },
      execute: async ({ sessionId, markReady }) => {
        calls.push(`execute:${sessionId}`);
        expect(calls).not.toContain('phase:ready');
        markReady();
        return 'completed';
      },
    });

    expect(result).toBe('completed');
    expect(client.session.create).toHaveBeenCalledWith(
      { directory: '/tmp/probe' },
      { throwOnError: true },
    );
    expect(calls).toEqual([
      'session.create',
      'execute:session-1',
      'phase:ready',
      'phase:cleanupStart',
      'session.delete',
      'global.dispose',
      'server.close',
    ]);
  });

  it('should cleanup the client after probe execution fails', async () => {
    const executionError = new Error('execution failed');
    const client: OpenCodeRunnableProbeClient = {
      session: {
        create: vi.fn().mockResolvedValue({ data: { id: 'session-1' } }),
        delete: vi.fn().mockResolvedValue(undefined),
      },
      global: { dispose: vi.fn().mockResolvedValue(undefined) },
    };

    await expect(runOpenCodeProbe({
      createProbe: async () => ({ client }),
      directory: '/tmp/probe',
      onPhase: vi.fn(),
      execute: async ({ markReady }) => {
        markReady();
        throw executionError;
      },
    })).rejects.toBe(executionError);

    expect(client.session.delete).toHaveBeenCalledOnce();
    expect(client.global.dispose).toHaveBeenCalledOnce();
  });

  it('should retain execution and cleanup errors together', async () => {
    const executionError = new Error('execution failed');
    const cleanupError = new Error('cleanup failed');
    const client: OpenCodeRunnableProbeClient = {
      session: {
        create: vi.fn().mockResolvedValue({ data: { id: 'session-1' } }),
        delete: vi.fn().mockRejectedValue(cleanupError),
      },
      global: { dispose: vi.fn().mockResolvedValue(undefined) },
    };

    await expect(runOpenCodeProbe({
      createProbe: async () => ({ client }),
      directory: '/tmp/probe',
      onPhase: vi.fn(),
      execute: async ({ markReady }) => {
        markReady();
        throw executionError;
      },
    })).rejects.toMatchObject({ errors: [executionError, cleanupError] });
  });

  it('should cleanup and retain errors when the cleanup phase notification fails', async () => {
    const phaseError = new Error('cleanup phase notification failed');
    const cleanupError = new Error('session deletion failed');
    const serverClose = vi.fn();
    const globalDispose = vi.fn().mockResolvedValue(undefined);
    const client: OpenCodeRunnableProbeClient = {
      session: {
        create: vi.fn().mockResolvedValue({ data: { id: 'session-1' } }),
        delete: vi.fn().mockRejectedValue(cleanupError),
      },
      global: { dispose: globalDispose },
    };

    await expect(runOpenCodeProbe({
      createProbe: async () => ({ client, server: { close: serverClose } }),
      directory: '/tmp/probe',
      onPhase: (phase) => {
        if (phase === 'cleanupStart') {
          throw phaseError;
        }
      },
      execute: async ({ markReady }) => {
        markReady();
        return 'completed';
      },
    })).rejects.toMatchObject({ errors: [phaseError, cleanupError] });

    expect(client.session.delete).toHaveBeenCalledOnce();
    expect(globalDispose).toHaveBeenCalledOnce();
    expect(serverClose).toHaveBeenCalledOnce();
  });

  it.each([
    ['session creation failure', { createError: new Error('session creation failed') }],
    ['empty session ID', { sessionId: '' }],
  ])('should enter cleanup after %s', async (_scenario, setup) => {
    const phases: string[] = [];
    const serverClose = vi.fn();
    const globalDispose = vi.fn().mockResolvedValue(undefined);
    const client = {
      session: {
        create: setup.createError === undefined
          ? vi.fn().mockResolvedValue({ data: { id: setup.sessionId ?? 'session-1' } })
          : vi.fn().mockRejectedValue(setup.createError),
        delete: vi.fn().mockResolvedValue(undefined),
      },
      global: { dispose: globalDispose },
    };

    await expect(runOpenCodeProbe({
      createProbe: async () => ({ client, server: { close: serverClose } }),
      directory: '/tmp/probe',
      onPhase: (phase) => { phases.push(phase); },
      execute: vi.fn(),
    })).rejects.toThrow();

    expect(phases).toEqual(['failureCleanupStart']);
    expect(client.session.delete).not.toHaveBeenCalled();
    expect(globalDispose).toHaveBeenCalledOnce();
    expect(serverClose).toHaveBeenCalledOnce();
  });

  it('should preserve the original startup failure after failure cleanup completes', async () => {
    const testRoot = mkdtempSync(join(tmpdir(), 'takt-probe-startup-failure-'));
    temporaryDirectories.push(testRoot);
    const script = join(testRoot, 'startup-failure.mjs');
    const lifecycleUrl = new URL('../../tools/opencode-probe/opencode-probe-lifecycle.mjs', import.meta.url).href;
    const processUrl = new URL('../../tools/opencode-probe/probe-process.mjs', import.meta.url).href;
    writeFileSync(script, [
      `import { runOpenCodeProbe } from ${JSON.stringify(lifecycleUrl)}`,
      `import { reportProbePhase } from ${JSON.stringify(processUrl)}`,
      'try {',
      '  await runOpenCodeProbe({',
      "    createProbe: async () => { throw new Error('startup failed') },",
      "    directory: '/tmp/probe',",
      '    execute: async () => undefined,',
      '    onPhase: reportProbePhase,',
      '  })',
      '} catch (error) {',
      "  process.stderr.write(`${error.message}\n`)",
      '  process.exitCode = 7',
      '}',
    ].join('\n'), 'utf8');

    let thrown: unknown;
    try {
      await runProbeProcess(script, [], {
        startupTimeout: 2_000,
        executionTimeout: 2_000,
        cleanupTimeout: 2_000,
        env: process.env,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      code: 7,
      stderr: expect.stringContaining('startup failed'),
    });
  });

  it.each(['plugin probe', 'SDK tool probe'])(
    'should subscribe before starting %s and abort after a terminal event',
    async () => {
    let subscribedSignal: AbortSignal | undefined;
    let subscribed = false;
    const client = {
      event: {
        subscribe: vi.fn(async (_input: { directory: string }, options: { signal: AbortSignal; throwOnError: true }) => {
          subscribedSignal = options.signal;
          subscribed = true;
          return {
            stream: (async function* () {
              yield { type: 'session.idle', properties: { sessionID: 'session-1' } };
            })(),
          };
        }),
      },
    };
    const events: unknown[] = [];
    const onReady = vi.fn();

    const result = await runOpenCodeSessionWithEvents({
      client,
      directory: '/tmp/probe',
      sessionId: 'session-1',
      start: async () => {
        expect(subscribed).toBe(true);
        return 'completed';
      },
      onReady,
      onEvent: (event) => { events.push(event); },
    });

    expect(client.event.subscribe).toHaveBeenCalledWith(
      { directory: '/tmp/probe' },
      { signal: expect.any(AbortSignal), throwOnError: true },
    );
    expect(events).toHaveLength(1);
    expect(onReady).toHaveBeenCalledOnce();
    expect(subscribedSignal?.aborted).toBe(true);
    expect(result).toBe('completed');
  });

  it('should abort the SSE subscription when the stream ends before a terminal event', async () => {
    let subscribedSignal: AbortSignal | undefined;
    const client = {
      event: {
        subscribe: vi.fn(async (_input: { directory: string }, options: { signal: AbortSignal; throwOnError: true }) => {
          subscribedSignal = options.signal;
          return { stream: (async function* () { yield { type: 'message.updated' }; })() };
        }),
      },
    };

    await expect(runOpenCodeSessionWithEvents({
      client,
      directory: '/tmp/probe',
      sessionId: 'session-1',
      start: async () => undefined,
      onReady: vi.fn(),
      onEvent: () => undefined,
    })).rejects.toThrow(/ended before session/);
    expect(subscribedSignal?.aborted).toBe(true);
  });

  it('should abort the SSE subscription when the event callback fails', async () => {
    const callbackError = new Error('callback failed');
    let subscribedSignal: AbortSignal | undefined;
    const client = {
      event: {
        subscribe: vi.fn(async (_input: { directory: string }, options: { signal: AbortSignal; throwOnError: true }) => {
          subscribedSignal = options.signal;
          return {
            stream: (async function* () {
              yield { type: 'message.updated', properties: { sessionID: 'session-1' } };
            })(),
          };
        }),
      },
    };

    await expect(runOpenCodeSessionWithEvents({
      client,
      directory: '/tmp/probe',
      sessionId: 'session-1',
      start: async () => undefined,
      onReady: vi.fn(),
      onEvent: () => { throw callbackError; },
    })).rejects.toBe(callbackError);
    expect(subscribedSignal?.aborted).toBe(true);
  });

  it('should terminate the complete Windows process tree with taskkill', async () => {
    const executeFile = vi.fn(async (file: string) => (
      file === 'powershell.exe' ? { stdout: '[]' } : undefined
    ));

    await terminateWindowsProcessTree(4321, executeFile);

    expect(executeFile).toHaveBeenCalledWith(
      'taskkill',
      ['/PID', '4321', '/T', '/F'],
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
    expectWindowsCommandTimeoutsWithinGrace(executeFile);
  });

  it('should reject process-tree cleanup failures after flushing the warning', async () => {
    const warning = captureCleanupWarning(/Warning: Process tree cleanup warning: Child process did not expose a PID/);

    try {
      await expectCleanupFailureAfterWarningFlush(
        startProcessTreeCleanup(undefined),
        warning,
        /Child process did not expose a PID/,
        /Warning: Process tree cleanup warning: Child process did not expose a PID/,
      );
    } finally {
      warning.restore();
    }
  });

  it.each([
    ['PowerShell fails', () => { throw new Error('PowerShell failed'); }],
    ['PowerShell returns malformed JSON', () => ({ stdout: '{invalid' })],
  ])('should warn after still taskkilling the root when %s during the initial snapshot', async (_scenario, query) => {
    const executeFile = vi.fn(async (file: string) => (
      file === 'powershell.exe' ? query() : undefined
    ));
    const warning = captureCleanupWarning(/Warning: Process tree cleanup warning: .*WMI process snapshot unavailable/);

    try {
      await expectCleanupFailureAfterWarningFlush(
        terminateWindowsProcessTree(4321, executeFile),
        warning,
        /WMI process snapshot unavailable/,
        /Warning: Process tree cleanup warning: .*WMI process snapshot unavailable/,
      );
    } finally {
      warning.restore();
    }

    expect(executeFile).toHaveBeenCalledWith(
      'taskkill',
      ['/PID', '4321', '/T', '/F'],
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
    expectWindowsCommandTimeoutsWithinGrace(executeFile);
  });

  it('should invoke taskkill after the initial WMI deadline is exhausted', async () => {
    const now = vi.spyOn(Date, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValue(10_000);
    const executeFile = vi.fn(async (file: string) => {
      if (file === 'taskkill') return undefined;
      throw new Error('WMI query should not start after the deadline');
    });
    const warning = captureCleanupWarning(/Warning: Process tree cleanup warning: .*WMI process snapshot deadline exceeded/);

    try {
      await expectCleanupFailureAfterWarningFlush(
        terminateWindowsProcessTree(4321, executeFile),
        warning,
        /WMI process snapshot deadline exceeded/,
        /Warning: Process tree cleanup warning: .*WMI process snapshot deadline exceeded/,
      );
    } finally {
      warning.restore();
      now.mockRestore();
    }

    expect(executeFile).toHaveBeenCalledWith(
      'taskkill',
      ['/PID', '4321', '/T', '/F'],
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
  });

  it.each(['descendant identity', 'final remaining-process'])(
    'should warn after taskkill when the %s query returns malformed JSON',
    async (failureStage) => {
      let fullSnapshot = 0;
      const executeFile = vi.fn(async (file: string, args: readonly string[]) => {
        if (file !== 'powershell.exe') return undefined;
        if (args[3]?.includes('-Filter')) {
          return failureStage === 'descendant identity'
            ? { stdout: '{invalid' }
            : { stdout: JSON.stringify({
              ProcessId: 5001,
              ParentProcessId: 4321,
              CreationDate: 'created-5001',
            }) };
        }
        fullSnapshot += 1;
        if (fullSnapshot === 1) {
          return { stdout: JSON.stringify({
            ProcessId: 5001,
            ParentProcessId: 4321,
            CreationDate: 'created-5001',
          }) };
        }
        return failureStage === 'final remaining-process'
          ? { stdout: '{invalid' }
          : { stdout: '[]' };
      });
      const warning = captureCleanupWarning(/Warning: Process tree cleanup warning: .*WMI (?:identity query.*|final process query) unavailable/);

      try {
        await expectCleanupFailureAfterWarningFlush(
          terminateWindowsProcessTree(4321, executeFile),
          warning,
          /WMI (?:identity query.*|final process query) unavailable/,
          /Warning: Process tree cleanup warning: .*WMI (?:identity query.*|final process query) unavailable/,
        );
      } finally {
        warning.restore();
      }

      expect(executeFile).toHaveBeenCalledWith(
        'taskkill',
        ['/PID', '5001', '/T', '/F'],
        expect.objectContaining({ timeout: expect.any(Number) }),
      );
      expectWindowsCommandTimeoutsWithinGrace(executeFile);
    },
  );

  it('should terminate recorded Windows descendants when the parent has already exited', async () => {
    let fullSnapshot = 0;
    const executeFile = vi.fn(async (file: string, args: readonly string[]) => {
      if (file === 'powershell.exe') {
        if (args[3]?.includes('-Filter')) {
          const processId = args[3].includes('5002') ? 5002 : 5001;
          return { stdout: JSON.stringify({
            ProcessId: processId,
            ParentProcessId: processId === 5002 ? 5001 : 4321,
            CreationDate: `created-${processId}`,
          }) };
        }
        fullSnapshot += 1;
        return fullSnapshot === 1
          ? { stdout: JSON.stringify([
            { ProcessId: 5001, ParentProcessId: 4321, CreationDate: 'created-5001' },
            { ProcessId: 5002, ParentProcessId: 5001, CreationDate: 'created-5002' },
          ]) }
          : { stdout: '[]' };
      }
      if (args[1] === '4321') {
        throw Object.assign(new Error('parent not found'), { code: 128 });
      }
      return undefined;
    });
    await expect(terminateWindowsProcessTree(4321, executeFile)).resolves.toBeUndefined();

    expect(executeFile).toHaveBeenCalledWith(
      'taskkill',
      ['/PID', '5002', '/T', '/F'],
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
    expect(executeFile).toHaveBeenCalledWith(
      'taskkill',
      ['/PID', '5001', '/T', '/F'],
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
    expectWindowsCommandTimeoutsWithinGrace(executeFile);
  });

  it('should warn about taskkill failure even when a descendant PID is later reused', async () => {
    let fullSnapshot = 0;
    const executeFile = vi.fn(async (file: string, args: readonly string[]) => {
      if (file === 'taskkill' && args[1] === '5001') {
        throw new Error('taskkill failed');
      }
      if (args[3]?.includes('-Filter')) {
        return { stdout: JSON.stringify({
          ProcessId: 5001,
          ParentProcessId: 4321,
          CreationDate: 'created-original',
        }) };
      }
      fullSnapshot += 1;
      return fullSnapshot === 1
        ? { stdout: JSON.stringify({
          ProcessId: 5001,
          ParentProcessId: 4321,
          CreationDate: 'created-original',
        }) }
        : { stdout: JSON.stringify({
          ProcessId: 5001,
          ParentProcessId: 9999,
          CreationDate: 'created-reused',
        }) };
    });
    const warning = captureCleanupWarning(/Warning: Process tree cleanup warning: .*taskkill descendant 5001 failed/);

    try {
      await expectCleanupFailureAfterWarningFlush(
        terminateWindowsProcessTree(4321, executeFile),
        warning,
        /taskkill descendant 5001 failed/,
        /Warning: Process tree cleanup warning: .*taskkill descendant 5001 failed/,
      );
    } finally {
      warning.restore();
    }

    expect(executeFile).toHaveBeenCalledWith(
      'taskkill',
      ['/PID', '5001', '/T', '/F'],
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
    expectWindowsCommandTimeoutsWithinGrace(executeFile);
  });

  it('should throw when a snapshotted Windows process remains alive', async () => {
    const processSnapshot = JSON.stringify({
      ProcessId: 4321,
      ParentProcessId: 1000,
      CreationDate: 'created-root',
    });
    const executeFile = vi.fn(async (file: string) => {
      if (file === 'taskkill') {
        throw new Error('taskkill failed');
      }
      return { stdout: processSnapshot };
    });
    const warning = captureCleanupWarning(/Warning: Process tree cleanup warning: .*Windows process tree 4321 retained processes: 4321/);

    try {
      await expectCleanupFailureAfterWarningFlush(
        terminateWindowsProcessTree(4321, executeFile),
        warning,
        'Windows process tree 4321 retained processes: 4321',
        /Warning: Process tree cleanup warning: .*Windows process tree 4321 retained processes: 4321/,
      );
    } finally {
      warning.restore();
    }
  });

  it('should wait for a Windows process tree to disappear after taskkill', async () => {
    let fullSnapshot = 0;
    const processSnapshot = JSON.stringify({
      ProcessId: 4321,
      ParentProcessId: 1000,
      CreationDate: 'created-root',
    });
    const executeFile = vi.fn(async (file: string) => {
      if (file === 'taskkill') return undefined;
      fullSnapshot += 1;
      return { stdout: fullSnapshot <= 2 ? processSnapshot : '[]' };
    });

    await expect(terminateWindowsProcessTree(4321, executeFile)).resolves.toBeUndefined();
    expect(fullSnapshot).toBeGreaterThanOrEqual(3);
  });

  it('should stop the timed-out child and grandchild before removing the parent-owned workspace', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'takt-probe-lifecycle-test-'));
    temporaryDirectories.push(parent);
    let workspace = '';
    let childPid = 0;
    let grandchildPid = 0;

    const execution = withProbeWorkspace(parent, 'plugin-timeout-', async (createdWorkspace) => {
      workspace = createdWorkspace;
      try {
        await runProbeProcess('-e', [
          [
            "const { spawn } = require('node:child_process')",
            "const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
            'console.log(JSON.stringify({ childPid: process.pid, grandchildPid: grandchild.pid }))',
            'setInterval(() => {}, 1000)',
          ].join(';'),
        ], {
          startupTimeout: PROBE_PHASE_BUDGET_MS,
          executionTimeout: PROBE_PHASE_BUDGET_MS,
          cleanupTimeout: PROBE_PHASE_BUDGET_MS,
          env: process.env,
        });
      } catch (error) {
        const timeoutError = error as Error & {
          killed?: boolean;
          stdout?: string;
          cleanup: Promise<void>;
        };
        const pids = JSON.parse(timeoutError.stdout?.trim() ?? '{}') as {
          childPid?: number;
          grandchildPid?: number;
        };
        childPid = pids.childPid ?? 0;
        grandchildPid = pids.grandchildPid ?? 0;
        if (childPid > 0) probeProcessIds.push(childPid);
        if (grandchildPid > 0) probeProcessIds.push(grandchildPid);
        expect(timeoutError.killed).toBe(true);
        await timeoutError.cleanup;
        throw error;
      }
    });

    await expect(execution).rejects.toThrow();
    expect(workspace).not.toBe('');
    expect(existsSync(workspace)).toBe(false);
    expect(childPid).toBeGreaterThan(0);
    expect(grandchildPid).toBeGreaterThan(0);
    expect(() => process.kill(childPid, 0)).toThrow();
    expect(() => process.kill(grandchildPid, 0)).toThrow();
  });

  it('should return a probe report before intentionally delayed cleanup finishes', async () => {
    const execution = runProbeProcess('-e', [
      [
        "process.on('SIGTERM', () => {})",
        "console.log('PROBE_READY')",
        "console.log('PROBE_CLEANUP_START')",
        "console.log('PROBE_RESULT {}')",
        'setInterval(() => {}, 1000)',
      ].join(';'),
    ], {
      startupTimeout: 2_000,
      executionTimeout: 2_000,
      cleanupTimeout: 150,
      env: process.env,
    });

    const result = await execution;
    let cleanupFinished = false;
    const observedCleanup = result.cleanup.then(() => {
      cleanupFinished = true;
    });
    await Promise.resolve();
    if (process.platform !== 'win32') {
      expect(cleanupFinished).toBe(false);
    }
    expect(result.stdout).toContain('PROBE_RESULT {}');
    await observedCleanup;
    expect(cleanupFinished).toBe(true);
  });

  it('should terminate child descendants after the probe exits successfully', async () => {
    const result = await runProbeProcess('-e', [
      [
        "const { spawn } = require('node:child_process')",
        "const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: false, stdio: 'ignore' })",
        'grandchild.unref()',
        'console.log(JSON.stringify({ childPid: process.pid, grandchildPid: grandchild.pid }))',
        "console.log('PROBE_READY')",
        "console.log('PROBE_CLEANUP_START')",
        "console.log('PROBE_RESULT {}')",
      ].join(';'),
    ], {
      startupTimeout: 10_000,
      executionTimeout: 10_000,
      cleanupTimeout: 10_000,
      env: process.env,
    });
    await result.cleanup;
    const firstLine = result.stdout.split('\n')[0] ?? '{}';
    const pids = JSON.parse(firstLine) as { childPid: number; grandchildPid: number };

    expect(result.stdout).toContain('PROBE_RESULT {}');
    expect(() => process.kill(pids.childPid, 0)).toThrow();
    expect(() => process.kill(pids.grandchildPid, 0)).toThrow();
  });

  it('should wait for a complete JSON result frame before terminating descendants', async () => {
    const result = await runProbeProcess('-e', [
      [
        "console.log('PROBE_READY')",
        "console.log('PROBE_CLEANUP_START')",
        "process.stdout.write('PROBE_RESULT ')",
        "setTimeout(() => process.stdout.write('{}\\n'), 150)",
      ].join(';'),
    ], {
      startupTimeout: 2_000,
      executionTimeout: 2_000,
      cleanupTimeout: 2_000,
      env: process.env,
    });

    expect(result.stdout).toContain('PROBE_RESULT {}\n');
  });

  it('should keep a complete result when its frame completes after cleanup starts', async () => {
    const result = await runProbeProcess('-e', [
      [
        "console.log('PROBE_READY')",
        "console.log('PROBE_CLEANUP_START')",
        "process.stdout.write('PROBE_RESULT ')",
        "setImmediate(() => process.stdout.write('{}\\n'))",
        'setInterval(() => {}, 1000)',
      ].join(';'),
    ], {
      startupTimeout: 2_000,
      executionTimeout: 2_000,
      cleanupTimeout: 2_000,
      env: process.env,
    });

    const cleanupStartIndex = result.stdout.indexOf('PROBE_CLEANUP_START');
    const resultFrameIndex = result.stdout.indexOf('PROBE_RESULT {}');
    expect(cleanupStartIndex).toBeGreaterThanOrEqual(0);
    expect(resultFrameIndex).toBeGreaterThan(cleanupStartIndex);
    expect(result.stdout).toContain('PROBE_RESULT {}\n');
    await result.cleanup;
  });

  it('should reject a complete result emitted before cleanup starts', async () => {
    const execution = runProbeProcess('-e', [
      [
        "console.log('PROBE_READY')",
        "console.log('PROBE_RESULT {\"stale\":true}')",
        "console.log('PROBE_CLEANUP_START')",
        'setInterval(() => {}, 1000)',
      ].join(';'),
    ], {
      startupTimeout: 2_000,
      executionTimeout: 2_000,
      cleanupTimeout: 150,
      env: process.env,
    });

    await expect(execution).rejects.toMatchObject({ code: 'EPROBEPROTOCOL', phase: 'execution' });
  });

  it('should reject multiple complete results when parsing probe output', () => {
    const output = [
      'PROBE_READY',
      'PROBE_CLEANUP_START',
      'PROBE_RESULT {"first":true}',
      'PROBE_RESULT {"second":true}',
      '',
    ].join('\n');

    expect(() => parseProbeResult(output)).toThrow('multiple PROBE_RESULT');
  });

  it('should reject cleanup and result markers when READY was not emitted', async () => {
    const execution = runProbeProcess('-e', [
      "console.log('PROBE_CLEANUP_START'); console.log('PROBE_RESULT {}')",
    ], {
      startupTimeout: 2_000,
      executionTimeout: 2_000,
      cleanupTimeout: 2_000,
      env: process.env,
    });

    await expect(execution).rejects.toMatchObject({
      code: 'EPROBEPROTOCOL',
      phase: 'startup',
    });
  });

  it('should reject a non-zero exit after a complete probe result', async () => {
    const execution = runProbeProcess('-e', [[
      "console.log('PROBE_READY')",
      "console.log('PROBE_CLEANUP_START')",
      "console.log('PROBE_RESULT {}')",
      'process.exitCode = 7',
    ].join(';')], {
      startupTimeout: 2_000,
      executionTimeout: 2_000,
      cleanupTimeout: 2_000,
      env: process.env,
    });

    await expect(execution).rejects.toMatchObject({ code: 7, killed: false });
  });

  it('should reject multiple complete results after cleanup starts', async () => {
    const execution = runProbeProcess('-e', [[
      "console.log('PROBE_READY')",
      "console.log('PROBE_CLEANUP_START')",
      "console.log('PROBE_RESULT {\"first\":true}')",
      "console.log('PROBE_RESULT {\"second\":true}')",
    ].join(';')], {
      startupTimeout: 2_000,
      executionTimeout: 2_000,
      cleanupTimeout: 2_000,
      env: process.env,
    });

    await expect(execution).rejects.toMatchObject({
      code: 'EPROBEPROTOCOL',
      phase: 'cleanup',
    });
  });

  it('should abort the event stream when a non-throwing SDK request is configured to reject', async () => {
    const sdkError = new Error('prompt request failed');
    let subscribedSignal: AbortSignal | undefined;
    const client = {
      event: {
        subscribe: vi.fn(async (_input: { directory: string }, options: { signal: AbortSignal; throwOnError: true }) => {
          subscribedSignal = options.signal;
          return { stream: (async function* () { await new Promise(() => {}); })() };
        }),
      },
    };

    await expect(runOpenCodeSessionWithEvents({
      client,
      directory: '/tmp/probe',
      sessionId: 'session-1',
      start: () => Promise.reject(sdkError),
      onReady: vi.fn(),
      onEvent: vi.fn(),
    })).rejects.toBe(sdkError);
    expect(subscribedSignal?.aborted).toBe(true);
  });

  it.each([
    ['prompt', promptOpenCodeSession, 'prompt'],
    ['promptAsync', promptOpenCodeSessionAsync, 'promptAsync'],
    ['summarize', summarizeOpenCodeSession, 'summarize'],
    ['messages', listOpenCodeSessionMessages, 'messages'],
  ] as const)('should propagate non-throwing SDK errors from the concrete %s entry', async (_name, request, method) => {
    const sdkError = new Error(`${method} failed`);
    const operation = vi.fn((_input: { sessionID: string }, options: { throwOnError?: boolean }) => (
      options.throwOnError === true
        ? Promise.reject(sdkError)
        : Promise.resolve({ error: sdkError })
    ));
    const client = { session: { [method]: operation } };

    await expect(request(client as never, { sessionID: 'session-1' })).rejects.toBe(sdkError);
    expect(operation).toHaveBeenCalledWith(
      { sessionID: 'session-1' },
      { throwOnError: true },
    );
  });

  it('should stop retaining output and terminate the process tree at the byte limit', async () => {
    const execution = runProbeProcess('-e', [
      "process.stdout.write('x'.repeat(2 * 1024 * 1024)); setInterval(() => {}, 1000)",
    ], {
      startupTimeout: 10_000,
      executionTimeout: 10_000,
      cleanupTimeout: 10_000,
      env: process.env,
    });

    await expect(execution).rejects.toMatchObject({
      code: 'EOUTPUTLIMIT',
      killed: true,
    });
    await execution.catch((error: Error & { stdout: string; stderr: string }) => {
      expect(Buffer.byteLength(error.stdout) + Buffer.byteLength(error.stderr)).toBeLessThanOrEqual(1024 * 1024);
    });
  });

  it('should truncate probe output only at a complete UTF-8 character boundary', async () => {
    const execution = runProbeProcess('-e', [
      "process.stdout.write('x'.repeat(1024 * 1024 - 1) + '界' + 'x'.repeat(1024)); setInterval(() => {}, 1000)",
    ], {
      startupTimeout: 10_000,
      executionTimeout: 10_000,
      cleanupTimeout: 10_000,
      env: process.env,
    });

    await expect(execution).rejects.toMatchObject({ code: 'EOUTPUTLIMIT' });
    await execution.catch((error: Error & { stdout: string }) => {
      expect(error.stdout).not.toContain('\uFFFD');
      expect(Buffer.byteLength(error.stdout, 'utf8')).toBeLessThanOrEqual(1024 * 1024);
    });
  });

  it('should apply independent startup, execution, and cleanup timeouts', async () => {
    // Each phase completes at half its budget while the total run exceeds any
    // single budget, proving the timeouts are independent.
    const budget = PROBE_PHASE_BUDGET_MS * 2;
    const result = await runProbeProcess('-e', [
      [
        `setTimeout(() => console.log('PROBE_READY'), ${budget / 2})`,
        `setTimeout(() => console.log('PROBE_CLEANUP_START'), ${budget})`,
        `setTimeout(() => console.log('PROBE_RESULT {}'), ${budget * 1.5})`,
      ].join(';'),
    ], {
      startupTimeout: budget,
      executionTimeout: budget,
      cleanupTimeout: budget,
      env: process.env,
    });

    expect(result.stdout).toContain('PROBE_READY');
    expect(result.stdout).toContain('PROBE_CLEANUP_START');
    expect(result.stdout).toContain('PROBE_RESULT {}');
  });

  it.each([
    ['startup', 'setInterval(() => {}, 1000)'],
    ['execution', "console.log('PROBE_READY'); setInterval(() => {}, 1000)"],
    ['cleanup', "console.log('PROBE_READY'); console.log('PROBE_CLEANUP_START'); setInterval(() => {}, 1000)"],
  ])('should report a %s phase timeout independently', async (phase, source) => {
    const execution = runProbeProcess('-e', [source], {
      startupTimeout: PROBE_PHASE_BUDGET_MS,
      executionTimeout: PROBE_PHASE_BUDGET_MS,
      cleanupTimeout: PROBE_PHASE_BUDGET_MS,
      env: process.env,
    });

    await expect(execution).rejects.toMatchObject({
      code: 'ETIMEDOUT',
      phase,
      killed: true,
    });
  });

  it('should reject cleanup immediately when startup did not complete', async () => {
    const startedAt = Date.now();
    const execution = runProbeProcess('-e', [
      "console.log('PROBE_CLEANUP_START'); setInterval(() => {}, 1000)",
    ], {
      startupTimeout: 5_000,
      executionTimeout: 5_000,
      cleanupTimeout: 150,
      env: process.env,
    });

    await expect(execution).rejects.toMatchObject({ code: 'EPROBEPROTOCOL', phase: 'startup' });
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  });

  it('should own cleanup timeout termination and remove a SIGTERM-resistant descendant', async () => {
    let grandchildPid = 0;
    const execution = runProbeProcess('-e', [
      [
        "const { spawn } = require('node:child_process')",
        "const worker = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\"], { stdio: 'ignore' })",
        'console.log(JSON.stringify({ grandchildPid: worker.pid }))',
        "console.log('PROBE_READY')",
        "console.log('PROBE_CLEANUP_START')",
        'setInterval(() => {}, 1000)',
      ].join(';'),
    ], {
      startupTimeout: 2_000,
      executionTimeout: 2_000,
      cleanupTimeout: 150,
      env: process.env,
    });

    await expect(execution).rejects.toMatchObject({ code: 'ETIMEDOUT', phase: 'cleanup' });
    await execution.catch((error: Error & { stdout: string; cleanup: Promise<void> }) => {
      grandchildPid = (JSON.parse(error.stdout.split('\n')[0]!) as { grandchildPid: number }).grandchildPid;
      return error.cleanup;
    });
    expect(grandchildPid).toBeGreaterThan(0);
    expect(() => process.kill(grandchildPid, 0)).toThrow();
  });

  it('should preserve inner cleanup timeout ownership through the outer smoke launcher', async () => {
    const testRoot = mkdtempSync(join(tmpdir(), 'takt-smoke-outer-timeout-'));
    temporaryDirectories.push(testRoot);
    const script = join(testRoot, 'outer-probe.mjs');
    const probeProcessUrl = new URL('../../tools/opencode-probe/probe-process.mjs', import.meta.url).href;
    const workerSource = [
      "const { spawn } = require('node:child_process')",
      "const worker = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\"], { stdio: 'ignore' })",
      'console.log(JSON.stringify({ grandchildPid: worker.pid }))',
      "console.log('PROBE_READY')",
      "console.log('PROBE_CLEANUP_START')",
      'setInterval(() => {}, 1000)',
    ].join(';');
    writeFileSync(script, [
      `import { runProbeProcess } from ${JSON.stringify(probeProcessUrl)}`,
      'try {',
      `  await runProbeProcess('-e', [${JSON.stringify(workerSource)}], { startupTimeout: ${INNER_PROBE_STARTUP_TIMEOUT_MS}, executionTimeout: ${INNER_PROBE_EXECUTION_TIMEOUT_MS}, cleanupTimeout: ${INNER_PROBE_CLEANUP_TIMEOUT_MS}, env: process.env })`,
      '} catch (error) {',
      "  await new Promise((resolve, reject) => process.stdout.write(error.stdout ?? '', writeError => writeError ? reject(writeError) : resolve()))",
      "  await new Promise((resolve, reject) => process.stderr.write(`phase=${error.phase}\\n`, writeError => writeError ? reject(writeError) : resolve()))",
      '  await error.cleanup',
      '  throw error',
      '}',
    ].join('\n'), 'utf8');

    let launchError: (Error & { stdout?: string; stderr?: string }) | undefined;
    try {
      await runSmokeScript(script, [], process.env, { timeoutMs: OUTER_PROBE_TIMEOUT_MS });
    } catch (error) {
      launchError = error as Error & { stdout?: string; stderr?: string };
    }

    expect(launchError?.stderr).toContain('phase=cleanup');
    const firstLine = launchError?.stdout?.split('\n')[0];
    expect(firstLine).toBeTruthy();
    const { grandchildPid } = JSON.parse(firstLine!) as { grandchildPid: number };
    expect(() => process.kill(grandchildPid, 0)).toThrow();
  });

  it('should time out the outer smoke launcher and terminate its process tree', async () => {
    const testRoot = mkdtempSync(join(tmpdir(), 'takt-smoke-outer-hang-'));
    temporaryDirectories.push(testRoot);
    const script = join(testRoot, 'outer-hang.mjs');
    writeFileSync(script, [
      "import { spawn } from 'node:child_process'",
      "const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
      "process.stdout.write(JSON.stringify({ childPid: process.pid, grandchildPid: worker.pid }) + '\\n')",
      'setInterval(() => {}, 1000)',
    ].join('\n'), 'utf8');

    // 500ms keeps the timeout fast while leaving the worker enough headroom to
    // print its PID line first even when the host is under parallel-test load.
    const execution = runSmokeScript(script, [], process.env, { timeoutMs: 500 });

    await expect(execution).rejects.toMatchObject({
      code: 'ETIMEDOUT',
      killed: true,
    });
    await execution.catch((error: Error & { stdout: string; cleanup: Promise<void> }) => {
      return error.cleanup.then(() => {
        const pids = JSON.parse(error.stdout.trim()) as { childPid: number; grandchildPid: number };
        expect(() => process.kill(pids.childPid, 0)).toThrow();
        expect(() => process.kill(pids.grandchildPid, 0)).toThrow();
      });
    });
  });

  it('should resolve the smoke launcher at the report before post-report cleanup', async () => {
    const testRoot = mkdtempSync(join(tmpdir(), 'takt-smoke-report-first-'));
    temporaryDirectories.push(testRoot);
    const script = join(testRoot, 'report-first.mjs');
    writeFileSync(script, [
      "process.stdout.write('SMOKE_REPORT {}\\n')",
      'setInterval(() => {}, 1000)',
    ].join('\n'), 'utf8');

    const execution = runSmokeScript(script, [], process.env, {
      timeoutMs: 2_000,
      reportMarker: 'SMOKE_REPORT ',
    });
    const result = await execution;

    let cleanupFinished = false;
    const observedCleanup = result.cleanup.then(() => {
      cleanupFinished = true;
    });
    await Promise.resolve();
    expect(cleanupFinished).toBe(false);
    expect(result.stdout).toContain('SMOKE_REPORT {}');
    await observedCleanup;
    expect(cleanupFinished).toBe(true);
  });

  it('should preserve a workspace report and warn when attached cleanup fails', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'takt-probe-workspace-cleanup-'));
    temporaryDirectories.push(parent);
    const cleanupError = new Error('workspace cleanup failed');
    const cleanup = Promise.reject(cleanupError);
    let workspace = '';
    const warning = captureCleanupWarning('Warning: Probe workspace cleanup failed: workspace cleanup failed');

    try {
      const execution = withProbeWorkspace(parent, 'reported-', async (createdWorkspace) => {
        workspace = createdWorkspace;
        return { reported: true, cleanup };
      });

      await warning.writeStarted;
      expect(existsSync(workspace)).toBe(false);
      warning.flush();

      await expect(execution).resolves.toMatchObject({ reported: true });
      expect(warning.wasFlushed()).toBe(true);
      expect(warning.writes.join('')).toContain(
        'Warning: Probe workspace cleanup failed: workspace cleanup failed',
      );
    } finally {
      warning.restore();
    }
  });

  it('should preserve a reported smoke result and warn when cleanup closes non-zero', async () => {
    const testRoot = mkdtempSync(join(tmpdir(), 'takt-smoke-report-close-'));
    temporaryDirectories.push(testRoot);
    const script = join(testRoot, 'report-close-non-zero.mjs');
    writeFileSync(script, [
      "process.stdout.write('SMOKE_REPORT {}\\n')",
      'process.exitCode = 7',
    ].join('\n'), 'utf8');
    const warning = captureCleanupWarning('Warning: Smoke process exited after report with code 7');

    try {
      const result = await runSmokeScript(script, [], process.env, {
        timeoutMs: 2_000,
        reportMarker: 'SMOKE_REPORT ',
      });

      expect(result.stdout).toContain('SMOKE_REPORT {}');
      await warning.writeStarted;
      expect(warning.wasFlushed()).toBe(false);
      warning.flush();
      await expect(result.cleanup).rejects.toMatchObject({ code: 7 });
      expect(warning.wasFlushed()).toBe(true);
      expect(warning.writes.join('')).toContain(
        'Warning: Smoke process exited after report with code 7',
      );
    } finally {
      warning.restore();
    }
  });

  it('should reject a smoke process that closes successfully without its report marker', async () => {
    const testRoot = mkdtempSync(join(tmpdir(), 'takt-smoke-report-missing-'));
    temporaryDirectories.push(testRoot);
    const script = join(testRoot, 'report-missing.mjs');
    writeFileSync(script, "process.stdout.write('completed without report\\n')\n", 'utf8');

    const execution = runSmokeScript(script, [], process.env, {
      timeoutMs: 2_000,
      reportMarker: 'SMOKE_REPORT ',
    });

    await expect(execution).rejects.toMatchObject({
      code: 'EPROBEPROTOCOL',
      exitCode: 0,
    });
    await execution.catch((error: Error & { cleanup: Promise<void> }) => error.cleanup);
  });

  it('should forward a post-report cleanup warning without changing the smoke result', async () => {
    const testRoot = mkdtempSync(join(tmpdir(), 'takt-smoke-report-warning-'));
    temporaryDirectories.push(testRoot);
    const script = join(testRoot, 'report-cleanup-warning.mjs');
    writeFileSync(script, [
      "process.stdout.write('SMOKE_REPORT {}\\n')",
      "process.stderr.write('Warning: Process tree cleanup warning: delayed cleanup\\n')",
    ].join('\n'), 'utf8');
    const warning = captureCleanupWarning('Warning: Process tree cleanup warning: delayed cleanup');

    try {
      const result = await runSmokeScript(script, [], process.env, {
        timeoutMs: 2_000,
        reportMarker: 'SMOKE_REPORT ',
      });

      expect(result.stdout).toContain('SMOKE_REPORT {}');
      await warning.writeStarted;
      warning.flush();
      await expect(result.cleanup).rejects.toMatchObject({ code: 'ECLEANUPWARNING' });
      expect(warning.wasFlushed()).toBe(true);
      expect(warning.writes.join('')).toContain(
        'Warning: Process tree cleanup warning: delayed cleanup',
      );
    } finally {
      warning.restore();
    }
  });

  it('should surface smoke cleanup failure without changing the evaluation result', async () => {
    const cleanupError = new Error('smoke cleanup failed');
    const execution = runSmokeBatch([{
      name: 'cleanup-failure',
      run: async () => ({ cleanup: Promise.reject(cleanupError) }),
    }]);

    await expect(execution).rejects.toMatchObject({
      errors: [expect.objectContaining({ errors: [cleanupError] })],
      smokeResult: {
        status: 'passed',
        cases: [{ name: 'cleanup-failure', status: 'passed' }],
      },
    });
  });

  it('should exit successfully after every smoke case succeeds', async () => {
    const { stdout, exitCode } = await runSmokeFixtureBatch([
      { name: 'plugin-none', script: smokeCaseFixture, args: ['--outcome', 'success'] },
      { name: 'summarize', script: smokeCaseFixture, args: ['--outcome', 'success'] },
      { name: 'sdk-tool', script: smokeCaseFixture, args: ['--outcome', 'success'] },
    ]);

    expect(exitCode).toBe(0);
    expect(parseSmokeBatchResult(stdout)).toEqual({
      status: 'passed',
      cases: [
        { name: 'plugin-none', status: 'passed' },
        { name: 'summarize', status: 'passed' },
        { name: 'sdk-tool', status: 'passed' },
      ],
    });
  });

  it('should wait for remaining smoke cases before exiting after a partial failure', async () => {
    const testRoot = mkdtempSync(join(tmpdir(), 'takt-smoke-partial-failure-'));
    temporaryDirectories.push(testRoot);
    const completionFile = join(testRoot, 'slow-case-completed');
    const startedAt = Date.now();
    const execution = runSmokeFixtureBatch([
      {
        name: 'evaluation-mismatch',
        script: smokeCaseFixture,
        args: ['--outcome', 'evaluation-failure'],
      },
      {
        name: 'slow-cleanup',
        script: smokeCaseFixture,
        args: ['--outcome', 'success', '--delay', '200', '--completionFile', completionFile],
      },
    ]);

    await expect(execution).rejects.toMatchObject({
      code: 1,
      stdout: expect.stringContaining('SMOKE_BATCH_RESULT'),
    });
    await execution.catch((error: Error & { stdout: string }) => {
      expect(parseSmokeBatchResult(error.stdout)).toEqual({
        status: 'failed',
        cases: [
          { name: 'evaluation-mismatch', status: 'failed' },
          { name: 'slow-cleanup', status: 'passed' },
        ],
      });
    });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(150);
    expect(existsSync(completionFile)).toBe(true);
  });

  it('should report every failed smoke case before exiting unsuccessfully', async () => {
    const execution = runSmokeFixtureBatch([
      {
        name: 'evaluation-mismatch',
        script: smokeCaseFixture,
        args: ['--outcome', 'evaluation-failure'],
      },
      {
        name: 'execution-error',
        script: smokeCaseFixture,
        args: ['--outcome', 'execution-error'],
      },
    ]);

    await expect(execution).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('evaluation-mismatch'),
    });
    await execution.catch((error: Error & { stderr: string }) => {
      expect(error.stderr).toContain('execution-error');
    });
    await execution.catch((error: Error & { stdout: string }) => {
      expect(parseSmokeBatchResult(error.stdout)).toEqual({
        status: 'failed',
        cases: [
          { name: 'evaluation-mismatch', status: 'failed' },
          { name: 'execution-error', status: 'failed' },
        ],
      });
    });
  });

  it('should preserve a prompt evaluation failure exit code and diagnostic output', async () => {
    const testRoot = mkdtempSync(join(tmpdir(), 'takt-smoke-evaluation-failure-'));
    temporaryDirectories.push(testRoot);
    const script = join(testRoot, 'evaluation-failure.mjs');
    const diagnostic = 'evaluation diagnostic';
    writeFileSync(script, [
      `process.stderr.write(${JSON.stringify(`${diagnostic}\\n`)})`,
      'process.exitCode = 7',
    ].join('\n'), 'utf8');

    let thrown: unknown;
    try {
      await runSmokeScript(script, [], process.env, { timeoutMs: 2_000 });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      code: 7,
      stderr: expect.stringContaining(diagnostic),
    });
  });

  it('should fail the smoke process when a probe throws an execution error', async () => {
    const execution = runSmokeFixtureBatch([{
      name: 'execution-error',
      script: smokeCaseFixture,
      args: ['--outcome', 'execution-error'],
    }]);

    await expect(execution).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('execution-error'),
    });
  });

  it('should fail when a configured smoke target is missing', async () => {
    const testRoot = mkdtempSync(join(tmpdir(), 'takt-smoke-missing-target-'));
    temporaryDirectories.push(testRoot);
    const missingScript = join(testRoot, 'does-not-exist.mjs');

    const execution = runSmokeFixtureBatch([{
      name: 'missing-target',
      script: missingScript,
      args: [],
    }]);

    await expect(execution).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('missing-target'),
    });
    await execution.catch((error: Error & { stderr: string }) => {
      expect(error.stderr).toContain(missingScript);
    });
    await execution.catch((error: Error & { stdout: string }) => {
      expect(parseSmokeBatchResult(error.stdout)).toEqual({
        status: 'failed',
        cases: [{ name: 'missing-target', status: 'failed' }],
      });
    });
  });

  it('should remove worker-created temporary workspaces through the owned entrypoint runtime root', async () => {
    const testRoot = mkdtempSync(join(tmpdir(), 'takt-probe-owned-entrypoint-'));
    temporaryDirectories.push(testRoot);
    const script = join(testRoot, 'owned-entrypoint-probe.mjs');
    const entrypointUrl = new URL('../../tools/opencode-probe/probe-entrypoint.mjs', import.meta.url).href;
    writeFileSync(script, [
      "import { mkdtempSync } from 'node:fs'",
      "import { tmpdir } from 'node:os'",
      "import { join } from 'node:path'",
      `import { ensureOwnedProbeEntrypoint } from ${JSON.stringify(entrypointUrl)}`,
      'await ensureOwnedProbeEntrypoint(import.meta.url)',
      "const workspace = mkdtempSync(join(tmpdir(), 'worker-workspace-'))",
      "console.log('PROBE_READY')",
      "console.log('PROBE_CLEANUP_START')",
      "console.log(`PROBE_RESULT ${JSON.stringify({ workspace, temporaryRoot: tmpdir() })}`)",
    ].join('\n'), 'utf8');

    const { stdout } = await runSmokeScript(script, [], process.env, {
      timeoutMs: OWNED_ENTRYPOINT_TIMEOUT_MS,
    });
    const result = parseProbeResult(stdout) as { workspace: string; temporaryRoot: string };
    if (existsSync(result.workspace)) {
      temporaryDirectories.push(result.workspace);
    }

    expect(result.temporaryRoot).not.toBe(tmpdir());
    expect(result.workspace.startsWith(result.temporaryRoot)).toBe(true);
    expect(existsSync(result.workspace)).toBe(false);
  });

  it('should flush large worker output before the owned entrypoint exits', async () => {
    const testRoot = mkdtempSync(join(tmpdir(), 'takt-probe-entrypoint-output-'));
    temporaryDirectories.push(testRoot);
    const script = join(testRoot, 'owned-entrypoint-output.mjs');
    const entrypointUrl = new URL('../../tools/opencode-probe/probe-entrypoint.mjs', import.meta.url).href;
    const stdoutPayloadBytes = 256 * 1024;
    const stderrPayloadBytes = 128 * 1024;
    writeFileSync(script, [
      `import { ensureOwnedProbeEntrypoint } from ${JSON.stringify(entrypointUrl)}`,
      'await ensureOwnedProbeEntrypoint(import.meta.url)',
      `await new Promise((resolve, reject) => process.stdout.write('x'.repeat(${stdoutPayloadBytes}) + '\\n', error => error ? reject(error) : resolve()))`,
      `await new Promise((resolve, reject) => process.stderr.write('e'.repeat(${stderrPayloadBytes}) + 'STDERR_END\\n', error => error ? reject(error) : resolve()))`,
      "console.log('PROBE_READY')",
      "console.log('PROBE_CLEANUP_START')",
      "console.log('PROBE_RESULT {\"flushed\":true}')",
    ].join('\n'), 'utf8');

    const { stdout, stderr } = await runSmokeScript(script, [], process.env, {
      timeoutMs: OWNED_ENTRYPOINT_TIMEOUT_MS,
      reportMarker: 'PROBE_RESULT ',
    });
    const expectedStdout = [
      'x'.repeat(stdoutPayloadBytes),
      'PROBE_READY',
      'PROBE_CLEANUP_START',
      'PROBE_RESULT {"flushed":true}',
      '',
    ].join('\n');

    expect(stdout).toBe(expectedStdout);
    expect(stderr).toBe(`${'e'.repeat(stderrPayloadBytes)}STDERR_END\n`);
  });

  it('should isolate OpenCode configuration for every probe worker environment', () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'takt-probe-environment-test-'));
    temporaryDirectories.push(runtimeRoot);
    const environment = markProbeWorkerEnvironment(prepareIsolatedProbeEnvironment({
      PATH: '/usr/bin',
      SECRET_TOKEN: 'must-not-leak',
      HOME: '/user/home',
      USERPROFILE: 'C:\\Users\\operator',
      XDG_CONFIG_HOME: '/user/config',
      XDG_DATA_HOME: '/user/data',
      XDG_CACHE_HOME: '/user/cache',
      XDG_STATE_HOME: '/user/state',
      APPDATA: 'C:\\Users\\operator\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\operator\\AppData\\Local',
      TMPDIR: '/user/tmpdir',
      TMP: 'C:\\Users\\operator\\Temp',
      TEMP: 'C:\\Users\\operator\\Temp',
      OPENCODE_CONFIG: '/user/opencode.json',
      OPENCODE_CONFIG_CONTENT: '{"plugin":["untrusted"]}',
      OPENCODE_CONFIG_DIR: '/user/opencode',
    }, runtimeRoot));

    expect(environment).toMatchObject({
      HOME: join(runtimeRoot, 'home'),
      USERPROFILE: join(runtimeRoot, 'home'),
      XDG_CONFIG_HOME: join(runtimeRoot, 'config'),
      XDG_DATA_HOME: join(runtimeRoot, 'data'),
      XDG_CACHE_HOME: join(runtimeRoot, 'cache'),
      XDG_STATE_HOME: join(runtimeRoot, 'state'),
      APPDATA: join(runtimeRoot, 'appdata'),
      LOCALAPPDATA: join(runtimeRoot, 'local-appdata'),
      TMPDIR: join(runtimeRoot, 'tmp'),
      TMP: join(runtimeRoot, 'tmp'),
      TEMP: join(runtimeRoot, 'tmp'),
      OPENCODE_CONFIG_DIR: join(runtimeRoot, 'config', 'opencode'),
      OPENCODE_DB: join(runtimeRoot, 'data', 'opencode.db'),
      TAKT_PROMPT_EVAL_WORKER: '1',
    });
    expect(environment.OPENCODE_CONFIG).toBeUndefined();
    expect(environment.OPENCODE_CONFIG_CONTENT).toBeUndefined();
    expect(environment.PATH).toBe('/usr/bin');
    expect(environment.SECRET_TOKEN).toBeUndefined();
  });
});

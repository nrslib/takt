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
} from '../../prompt-evals/opencode-probe-lifecycle.mjs';
import {
  parseProbeResult,
  runProbeProcess,
} from '../../prompt-evals/probe-process.mjs';
import { terminateWindowsProcessTree } from '../../prompt-evals/process-tree.mjs';
import {
  runSmokeScript,
  type SmokeBatchResult,
} from '../../prompt-evals/smoke-process.mjs';
import {
  markProbeWorkerEnvironment,
  prepareIsolatedProbeEnvironment,
} from '../../prompt-evals/probe-environment.mjs';
import { withProbeWorkspace } from '../../prompt-evals/probe-workspace.mjs';

interface SmokeFixtureCase {
  name: string;
  script: string;
  args: string[];
}

const smokeBatchFixture = fileURLToPath(
  new URL('../../prompt-evals/fixtures/run-smoke-batch.mjs', import.meta.url),
);
const smokeCaseFixture = fileURLToPath(
  new URL('../../prompt-evals/fixtures/smoke-case.mjs', import.meta.url),
);

describe('prompt eval probe lifecycle', () => {
  const temporaryDirectories: string[] = [];
  const probeProcessIds: number[] = [];

  function runSmokeFixtureBatch(cases: SmokeFixtureCase[]) {
    const testRoot = mkdtempSync(join(tmpdir(), 'takt-smoke-batch-fixture-'));
    temporaryDirectories.push(testRoot);
    const configPath = join(testRoot, 'smoke-cases.json');
    writeFileSync(configPath, JSON.stringify({ cases }), 'utf8');
    return runSmokeScript(smokeBatchFixture, [configPath], process.env, { timeoutMs: 10_000 });
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
    const lifecycleUrl = new URL('../../prompt-evals/opencode-probe-lifecycle.mjs', import.meta.url).href;
    const processUrl = new URL('../../prompt-evals/probe-process.mjs', import.meta.url).href;
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
    );
  });

  it('should terminate recorded Windows descendants after the parent has already exited', async () => {
    let snapshot = 0;
    const executeFile = vi.fn(async (file: string, args: readonly string[]) => {
      if (file === 'powershell.exe') {
        snapshot += 1;
        return snapshot === 1
          ? { stdout: JSON.stringify([
            { ProcessId: 5001, ParentProcessId: 4321 },
            { ProcessId: 5002, ParentProcessId: 5001 },
          ]) }
          : { stdout: '[]' };
      }
      if (args[1] === '4321') {
        throw Object.assign(new Error('parent not found'), { code: 128 });
      }
      return undefined;
    });
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid) => {
      if (pid === 4321) {
        throw Object.assign(new Error('not found'), { code: 'ESRCH' });
      }
      return true;
    });

    try {
      await terminateWindowsProcessTree(4321, executeFile);
    } finally {
      killSpy.mockRestore();
    }

    expect(executeFile).toHaveBeenCalledWith('taskkill', ['/PID', '5002', '/T', '/F']);
    expect(executeFile).toHaveBeenCalledWith('taskkill', ['/PID', '5001', '/T', '/F']);
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
          startupTimeout: 1_000,
          executionTimeout: 1_000,
          cleanupTimeout: 1_000,
          env: process.env,
        });
      } catch (error) {
        const timeoutError = error as Error & { killed?: boolean; stdout?: string };
        const pids = JSON.parse(timeoutError.stdout?.trim() ?? '{}') as {
          childPid?: number;
          grandchildPid?: number;
        };
        childPid = pids.childPid ?? 0;
        grandchildPid = pids.grandchildPid ?? 0;
        if (childPid > 0) probeProcessIds.push(childPid);
        if (grandchildPid > 0) probeProcessIds.push(grandchildPid);
        expect(timeoutError.killed).toBe(true);
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

  it('should reject a probe that reports a result but does not exit during cleanup', async () => {
    const execution = runProbeProcess('-e', [
      [
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

    await expect(execution).rejects.toMatchObject({
      code: 'ETIMEDOUT',
      phase: 'cleanup',
      killed: true,
    });
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
    const result = await runProbeProcess('-e', [
      [
        "setTimeout(() => console.log('PROBE_READY'), 1750)",
        "setTimeout(() => console.log('PROBE_CLEANUP_START'), 3500)",
        "setTimeout(() => console.log('PROBE_RESULT {}'), 5250)",
      ].join(';'),
    ], {
      startupTimeout: 3000,
      executionTimeout: 3000,
      cleanupTimeout: 3000,
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
      startupTimeout: 1_000,
      executionTimeout: 1_000,
      cleanupTimeout: 1_000,
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
    await execution.catch((error: Error & { stdout: string }) => {
      grandchildPid = (JSON.parse(error.stdout.split('\n')[0]!) as { grandchildPid: number }).grandchildPid;
    });
    expect(grandchildPid).toBeGreaterThan(0);
    expect(() => process.kill(grandchildPid, 0)).toThrow();
  });

  it('should preserve inner cleanup timeout ownership through the outer smoke launcher', async () => {
    const testRoot = mkdtempSync(join(tmpdir(), 'takt-smoke-outer-timeout-'));
    temporaryDirectories.push(testRoot);
    const script = join(testRoot, 'outer-probe.mjs');
    const probeProcessUrl = new URL('../../prompt-evals/probe-process.mjs', import.meta.url).href;
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
      `  await runProbeProcess('-e', [${JSON.stringify(workerSource)}], { startupTimeout: 2000, executionTimeout: 2000, cleanupTimeout: 150, env: process.env })`,
      '} catch (error) {',
      "  process.stdout.write(error.stdout ?? '')",
      "  process.stderr.write(`phase=${error.phase}\\n`)",
      '  throw error',
      '}',
    ].join('\n'), 'utf8');

    let launchError: (Error & { stdout?: string; stderr?: string }) | undefined;
    try {
      await runSmokeScript(script, [], process.env, { timeoutMs: 2_000 });
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

    const execution = runSmokeScript(script, [], process.env, { timeoutMs: 150 });

    await expect(execution).rejects.toMatchObject({
      code: 'ETIMEDOUT',
      killed: true,
    });
    await execution.catch((error: Error & { stdout: string }) => {
      const pids = JSON.parse(error.stdout.trim()) as { childPid: number; grandchildPid: number };
      expect(() => process.kill(pids.childPid, 0)).toThrow();
      expect(() => process.kill(pids.grandchildPid, 0)).toThrow();
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
      expect(error.stderr).toContain('No main prompt contained the required needle');
      expect(error.stderr).toContain('Smoke fixture execution failed');
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
    writeFileSync(script, [
      "process.stderr.write('No main prompt contained the required needle\\n')",
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
      stderr: expect.stringContaining('No main prompt contained the required needle'),
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
      stderr: expect.stringContaining('Smoke fixture execution failed'),
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
      expect(error.stderr).toContain(`Smoke target not found: ${missingScript}`);
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
    const entrypointUrl = new URL('../../prompt-evals/probe-entrypoint.mjs', import.meta.url).href;
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

    const { stdout } = await runSmokeScript(script, [], process.env, { timeoutMs: 2_000 });
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
    const entrypointUrl = new URL('../../prompt-evals/probe-entrypoint.mjs', import.meta.url).href;
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

    const { stdout, stderr } = await runSmokeScript(script, [], process.env, { timeoutMs: 2_000 });
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

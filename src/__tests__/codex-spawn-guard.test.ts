import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { spawn as esmSpawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexProvider } from '../infra/providers/codex.js';
import {
  invalidateAllResolvedConfigCache,
  invalidateGlobalConfigCache,
  resolveNonWorkflowProviderOptions,
} from '../infra/config/index.js';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import '../infra/codex/codex-spawn-guard.js';

type SpawnFunction = (
  command: string,
  argsOrOptions?: readonly string[] | SpawnOptions,
  options?: SpawnOptions,
) => ChildProcess;

type FakeExecutableMode = 'exit' | 'epipe' | 'hang' | 'line-separator-json';
type ProtocolExecutableMode = 'success' | 'capacity-first' | 'refusal-first' | 'profile-failure' | 'parallel' | 'timeout-first';

interface ProtocolExecutable {
  executablePath: string;
  recordPath: string;
  directory: string;
}

interface RecordedInvocation {
  args: string[];
  marker: string;
}

const require = createRequire(import.meta.url);
const childProcessModule = require('node:child_process') as { spawn: SpawnFunction };
const tempRoots = new Set<string>();
const trackedCodexChildren = new Set<ChildProcess>();
const activeCodexCalls = new Set<Promise<unknown>>();
const activeCodexAbortControllers = new Set<AbortController>();
let trackedSpawnOriginal: SpawnFunction | undefined;
let trackedSpawn: SpawnFunction | undefined;

function installCodexChildTracking(): void {
  if (trackedSpawnOriginal !== undefined) {
    return;
  }
  trackedSpawnOriginal = childProcessModule.spawn;
  trackedSpawn = (command, argsOrOptions, options) => {
    const child = trackedSpawnOriginal!(command, argsOrOptions, options);
    trackedCodexChildren.add(child);
    const remove = (): void => {
      trackedCodexChildren.delete(child);
    };
    // The SDK removes all ChildProcess listeners in its stream finally block. Re-install the
    // test-owned close observer after that cleanup so a real close event remains observable.
    const originalRemoveAllListeners = child.removeAllListeners.bind(child);
    child.removeAllListeners = ((event?: string | symbol) => {
      const result = originalRemoveAllListeners(event);
      if (event === undefined || event === 'close') {
        child.once('close', remove);
      }
      return result;
    }) as ChildProcess['removeAllListeners'];
    child.once('close', remove);
    child.once('error', remove);
    return child;
  };
  childProcessModule.spawn = trackedSpawn;
  syncBuiltinESMExports();
}

function restoreCodexChildTracking(): void {
  if (trackedSpawnOriginal === undefined || childProcessModule.spawn !== trackedSpawn) {
    return;
  }
  childProcessModule.spawn = trackedSpawnOriginal;
  syncBuiltinESMExports();
  trackedSpawnOriginal = undefined;
  trackedSpawn = undefined;
}

function trackCodexCall<T>(promise: Promise<T>): Promise<T> {
  activeCodexCalls.add(promise);
  void promise.then(
    () => activeCodexCalls.delete(promise),
    () => activeCodexCalls.delete(promise),
  );
  return promise;
}

async function cleanupCodexProcesses(): Promise<void> {
  for (const controller of activeCodexAbortControllers) {
    if (!controller.signal.aborted) {
      controller.abort(new Error('Codex test cleanup'));
    }
  }
  await Promise.allSettled([...activeCodexCalls]);

  const children = [...trackedCodexChildren];
  const closePromises = children.map(waitForCloseWithDeadline);
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null && !child.killed) {
      child.kill('SIGTERM');
    }
  }
  const closeResults = await Promise.allSettled(closePromises);
  trackedCodexChildren.clear();
  restoreCodexChildTracking();
  const closeFailure = closeResults.find((result) => result.status === 'rejected');
  if (closeFailure?.status === 'rejected') {
    throw closeFailure.reason;
  }
}

function makeFakeExecutable(name: string, mode: FakeExecutableMode = 'exit'): string {
  const dir = mkdtempSync(join(tmpdir(), 'takt-codex-guard-'));
  tempRoots.add(dir);
  const fileName = process.platform === 'win32' ? `${name}.cmd` : name;
  const file = join(dir, fileName);
  if (process.platform === 'win32') {
    writeFileSync(file, '@echo off\r\nexit /b 0\r\n');
  } else {
    const script = mode === 'exit'
      ? '#!/bin/sh\nexit 0\n'
      : mode === 'epipe'
        ? '#!/bin/sh\nexec 0<&-\nsleep 0.2\nexit 42\n'
        : mode === 'line-separator-json'
          ? '#!/bin/sh\nprintf \'{"a":"abc\\342\\200\\250def"}\\n\'\n'
          : '#!/bin/sh\nexec 0<&-\nwhile :; do :; done\n';
    writeFileSync(file, script);
    chmodSync(file, 0o755);
  }
  return file;
}

function makeRecordingExecutable(): { executablePath: string; recordPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'takt-codex-profile-'));
  tempRoots.add(dir);
  const executablePath = join(dir, process.platform === 'win32' ? 'codex.cmd' : 'codex');
  const recordPath = join(dir, 'record.txt');
  if (process.platform === 'win32') {
    writeFileSync(executablePath, '@echo off\r\nexit /b 0\r\n');
  } else {
    writeFileSync(executablePath, [
      '#!/bin/sh',
      'printf \'%s\\n\' "$@" > "$TAKT_TEST_RECORD"',
      'if [ -n "${TAKT_CODEX_CONFIG_PROFILE+x}" ]; then printf \'marker=%s\\n\' "$TAKT_CODEX_CONFIG_PROFILE" >> "$TAKT_TEST_RECORD"; fi',
      'exit 0',
      '',
    ].join('\n'));
    chmodSync(executablePath, 0o755);
  }
  return { executablePath, recordPath };
}

function makeProtocolExecutable(mode: ProtocolExecutableMode): ProtocolExecutable {
  const directory = mkdtempSync(join(tmpdir(), 'takt-codex-protocol-'));
  tempRoots.add(directory);
  const executablePath = join(directory, process.platform === 'win32' ? 'codex.cmd' : 'codex');
  const recordPath = join(directory, 'record.txt');
  if (process.platform === 'win32') {
    writeFileSync(executablePath, '@echo off\r\nexit /b 0\r\n');
  } else {
    const script = [
      '#!/bin/sh',
      'set -eu',
      'record="${TAKT_OBSERVABILITY:?TAKT_OBSERVABILITY is required}"',
      'counter="${record}.count"',
      'attempt=1',
      'if [ -f "$counter" ]; then attempt=$(( $(cat "$counter") + 1 )); fi',
      'printf "%s\\n" "$attempt" > "$counter"',
      'profile=""',
      'previous=""',
      'for argument in "$@"; do',
      '  if [ "$previous" = "--profile" ]; then profile="$argument"; fi',
      '  previous="$argument"',
      'done',
      'printf "%s\\n" "begin" >> "$record"',
      'for argument in "$@"; do printf "arg=%s\\n" "$argument" >> "$record"; done',
      'if [ -n "${TAKT_CODEX_CONFIG_PROFILE+x}" ]; then',
      '  printf "marker=%s\\n" "$TAKT_CODEX_CONFIG_PROFILE" >> "$record"',
      'else',
      '  printf "%s\\n" "marker=absent" >> "$record"',
      'fi',
      'printf "%s\\n" "end" >> "$record"',
      `mode='${mode}'`,
      `if [ "$mode" = "timeout-first" ] && [ "$attempt" -eq 1 ]; then`,
      '  printf "%s\\n" \'{"type":"thread.started","thread_id":"thread-fake"}\'',
      `  trap 'printf "%s\\n" "terminated" >> "$record"; exit 0' TERM INT`,
      '  while :; do :; done',
      'fi',
      'if [ "$mode" = "parallel" ]; then',
      '  barrier="${TAKT_OBSERVABILITY_SESSION_LOG_EXPORTER:?TAKT_OBSERVABILITY_SESSION_LOG_EXPORTER is required}"',
      '  printf "%s\\n" "$profile" >> "$barrier"',
      '  attempts=0',
      '  while [ "$(wc -l < "$barrier")" -lt 2 ] && [ "$attempts" -lt 100 ]; do',
      '    attempts=$((attempts + 1))',
      '    sleep 0.01',
      '  done',
      '  if [ "$(wc -l < "$barrier")" -lt 2 ]; then exit 42; fi',
      'fi',
      'if [ "$mode" = "profile-failure" ]; then',
      '  printf "%s\\n" "profile selection failed" >&2',
      '  exit 23',
      'fi',
      'if [ "$mode" = "capacity-first" ] && [ "$attempt" -eq 1 ]; then',
      '  printf "%s\\n" \'{"type":"thread.started","thread_id":"thread-fake"}\'',
      '  printf "%s\\n" \'{"type":"turn.failed","error":{"message":"Selected model is at capacity."}}\'',
      '  exit 0',
      'fi',
      'if [ "$mode" = "refusal-first" ] && [ "$attempt" -eq 1 ]; then',
      '  printf "%s\\n" \'{"type":"thread.started","thread_id":"thread-fake"}\'',
      '  printf "%s\\n" \'{"type":"item.completed","item":{"id":"msg-fake","type":"agent_message","text":"This request was flagged for possible cybersecurity risk."}}\'',
      '  printf "%s\\n" \'{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":1,"reasoning_output_tokens":0}}\'',
      '  exit 0',
      'fi',
      'printf "%s\\n" \'{"type":"thread.started","thread_id":"thread-fake"}\'',
      'printf "%s\\n" \'{"type":"item.completed","item":{"id":"msg-fake","type":"agent_message","text":"{\\"ok\\":true}"}}\'',
      'printf "%s\\n" \'{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":1,"reasoning_output_tokens":0}}\'',
    ].join('\n');
    writeFileSync(executablePath, `${script}\n`);
    chmodSync(executablePath, 0o755);
  }
  return { executablePath, recordPath, directory };
}

function readProtocolInvocations(recordPath: string): RecordedInvocation[] {
  const lines = readFileSync(recordPath, 'utf8').trim().split('\n');
  const invocations: RecordedInvocation[] = [];
  let current: RecordedInvocation | undefined;
  for (const line of lines) {
    if (line === 'begin') {
      current = { args: [], marker: '' };
    } else if (current && line.startsWith('arg=')) {
      current.args.push(line.slice('arg='.length));
    } else if (current && line.startsWith('marker=')) {
      current.marker = line.slice('marker='.length);
    } else if (current && line === 'end') {
      invocations.push(current);
      current = undefined;
    }
  }
  return invocations;
}

async function waitForRealCondition(
  condition: () => boolean,
  description: string,
): Promise<void> {
  const startedAt = process.hrtime.bigint();
  while (!condition()) {
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    if (elapsedMs >= 5000) {
      throw new Error(`Timed out waiting for ${description}`);
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function recordContains(recordPath: string, text: string): boolean {
  try {
    return readFileSync(recordPath, 'utf8').includes(text);
  } catch {
    return false;
  }
}

function fakeProviderOptions(configProfile: string) {
  return {
    codex: {
      permissionControl: 'codex' as const,
      configProfile,
    },
  };
}

function fakeChildProcessEnv(recordPath: string, barrierPath?: string): Record<string, string> {
  return {
    TAKT_OBSERVABILITY: recordPath,
    ...(barrierPath ? { TAKT_OBSERVABILITY_SESSION_LOG_EXPORTER: barrierPath } : {}),
  };
}

function cleanupTempRoots(): void {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
  tempRoots.clear();
}

function spawnOptions(): SpawnOptions {
  return {
    stdio: ['pipe', 'pipe', 'pipe'],
    ...(process.platform === 'win32' ? { shell: true } : {}),
  };
}

function waitForClose(child: ChildProcess): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
}> {
  return new Promise((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

async function waitForCloseWithDeadline(child: ChildProcess): Promise<void> {
  const startedAt = process.hrtime.bigint();
  let closed = false;
  let resolveClose!: () => void;
  const onClose = (): void => {
    closed = true;
    resolveClose();
  };
  const closePromise = new Promise<void>((resolve) => {
    resolveClose = resolve;
    child.once('close', onClose);
  });

  try {
    while (!closed) {
      const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      if (elapsedMs >= 5000) {
        throw new Error('Timed out waiting for the Codex child to close during cleanup');
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await closePromise;
  } finally {
    child.removeListener('close', onClose);
  }
}

async function runCodex(executablePath: string): Promise<void> {
  const { Codex } = await import('@openai/codex-sdk');
  const thread = new Codex({ codexPathOverride: executablePath }).startThread();
  const streamed = await thread.runStreamed('x'.repeat(1024 * 1024));
  for await (const _event of streamed.events) {
    void _event;
  }
}

describe('codex-spawn-guard', () => {
  afterEach(() => {
    return cleanupCodexProcesses().finally(() => {
      vi.useRealTimers();
      vi.unstubAllEnvs();
      invalidateGlobalConfigCache();
      invalidateAllResolvedConfigCache();
      cleanupTempRoots();
    });
  });

  it('synchronizes the CJS patch into ESM child_process bindings', () => {
    expect(childProcessModule.spawn).toBe(esmSpawn);
  });

  it('attaches and removes stdio listeners independently for parallel Codex spawns', async () => {
    const children = [
      childProcessModule.spawn(makeFakeExecutable('codex'), [], spawnOptions()),
      childProcessModule.spawn(makeFakeExecutable('codex'), [], spawnOptions()),
    ];

    for (const child of children) {
      expect(child.stdin).not.toBeNull();
      expect((child.stdin as EventEmitter).listenerCount('error')).toBeGreaterThan(0);
      expect((child.stdout as EventEmitter).listenerCount('error')).toBeGreaterThan(0);
      expect((child.stderr as EventEmitter).listenerCount('error')).toBeGreaterThan(0);
      expect((child as EventEmitter).listenerCount('error')).toBeGreaterThan(0);
    }

    await Promise.all(children.map(waitForClose));
    for (const child of children) {
      expect((child.stdin as EventEmitter).listenerCount('error')).toBe(0);
      expect((child.stdout as EventEmitter).listenerCount('error')).toBe(0);
      expect((child.stderr as EventEmitter).listenerCount('error')).toBe(0);
      expect((child as EventEmitter).listenerCount('error')).toBe(0);
    }
  });

  it('does not alter non-Codex spawns or the spawn(command, options) overload', async () => {
    const environment = { ...process.env };
    delete environment.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;
    const child = childProcessModule.spawn(
      makeFakeExecutable('other'),
      ['exec', '--experimental-json'],
      { ...spawnOptions(), env: environment },
    );
    const overloadChild = childProcessModule.spawn(makeFakeExecutable('other-overload'), spawnOptions());

    for (const spawnedChild of [child, overloadChild]) {
      expect(spawnedChild.stdin).not.toBeNull();
      expect((spawnedChild.stdin as EventEmitter).listenerCount('error')).toBe(0);
      expect((spawnedChild.stdout as EventEmitter).listenerCount('error')).toBe(0);
      expect((spawnedChild.stderr as EventEmitter).listenerCount('error')).toBe(0);
    }

    await Promise.all([waitForClose(child), waitForClose(overloadChild)]);
  });

  it.skipIf(process.platform === 'win32')('injects --profile after exec and removes the internal marker from the child environment', async () => {
    const { executablePath, recordPath } = makeRecordingExecutable();
    const environment = {
      ...process.env,
      TAKT_TEST_RECORD: recordPath,
      TAKT_CODEX_CONFIG_PROFILE: 'automation-review',
    };
    const child = childProcessModule.spawn(
      executablePath,
      ['exec', '--experimental-json', 'prompt'],
      { ...spawnOptions(), env: environment },
    );

    await waitForClose(child);
    const recorded = readFileSync(recordPath, 'utf8').trim().split('\n');
    expect(recorded).toEqual(['exec', '--profile', 'automation-review', '--experimental-json', 'prompt']);
    expect(recorded).not.toContain('marker=automation-review');
  });

  it.skipIf(process.platform === 'win32')('does not inject a profile when the internal marker is absent', async () => {
    const { executablePath, recordPath } = makeRecordingExecutable();
    const environment = { ...process.env, TAKT_TEST_RECORD: recordPath } as Record<string, string | undefined>;
    delete environment.TAKT_CODEX_CONFIG_PROFILE;
    const child = childProcessModule.spawn(
      executablePath,
      ['exec', '--experimental-json', 'prompt'],
      { ...spawnOptions(), env: environment },
    );

    await waitForClose(child);
    expect(readFileSync(recordPath, 'utf8').trim().split('\n'))
      .toEqual(['exec', '--experimental-json', 'prompt']);
  });

  it.skipIf(process.platform === 'win32')('forwards a profile through Provider, SDK, and the real CLI process', async () => {
    const fixture = makeProtocolExecutable('success');
    vi.stubEnv('TAKT_CODEX_CLI_PATH', fixture.executablePath);
    const providerOptions = fakeProviderOptions('automation-review');
    const provider = new CodexProvider();
    const commonOptions = {
      cwd: '/tmp',
      openaiApiKey: 'test-api-key',
      providerOptions,
      childProcessEnv: fakeChildProcessEnv(fixture.recordPath),
    };

    const normalResult = await provider.setup({ name: 'coder' }).call('prompt', commonOptions);
    const resumeResult = await provider.setup({ name: 'coder' }).call('prompt', {
      ...commonOptions,
      sessionId: 'thread-resume',
    });
    const isolatedResult = await provider.setupIsolatedStructured({ name: 'selector' }).call('prompt', {
      ...commonOptions,
      outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
    });

    expect(normalResult.status).toBe('done');
    expect(resumeResult.status).toBe('done');
    expect(isolatedResult.status).toBe('done');

    const invocations = readProtocolInvocations(fixture.recordPath);
    expect(invocations).toHaveLength(3);
    for (const invocation of invocations) {
      expect(invocation.args.slice(0, 3)).toEqual(['exec', '--profile', 'automation-review']);
      expect(invocation.marker).toBe('absent');
      expect(invocation.args).not.toContain('--sandbox');
      expect(invocation.args).not.toContain('--config=sandbox_workspace_write.network_access=false');
      expect(invocation.args).toContain('approval_policy="never"');
    }
    expect(invocations[1]?.args).toEqual(expect.arrayContaining(['resume', 'thread-resume']));
    expect(invocations[2]?.args).toContain('--output-schema');
  });

  it.skipIf(process.platform === 'win32')('passes split global/project provider options to the real CLI', async () => {
    const fixture = makeProtocolExecutable('success');
    const root = mkdtempSync(join(tmpdir(), 'takt-codex-config-'));
    tempRoots.add(root);
    const projectDir = join(root, 'project');
    const globalDir = process.env.TAKT_CONFIG_DIR;
    if (globalDir === undefined) {
      throw new Error('TAKT_CONFIG_DIR must be provided by the shared test setup');
    }
    mkdirSync(join(projectDir, '.takt'), { recursive: true });
    writeFileSync(join(globalDir, 'config.yaml'), [
      'provider_options:',
      '  codex:',
      '    permission_control: codex',
    ].join('\n'));
    writeFileSync(join(projectDir, '.takt', 'config.yaml'), [
      'provider_options:',
      '  codex:',
      '    config_profile: project-review',
    ].join('\n'));
    vi.stubEnv('TAKT_CODEX_CLI_PATH', fixture.executablePath);
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();

    const providerOptions = resolveNonWorkflowProviderOptions(projectDir, undefined, undefined, 'codex');
    expect(providerOptions).toMatchObject({
      codex: { permissionControl: 'codex', configProfile: 'project-review' },
    });
    const result = await new CodexProvider().setup({ name: 'coder' }).call('prompt', {
      cwd: projectDir,
      openaiApiKey: 'test-api-key',
      providerOptions,
      childProcessEnv: fakeChildProcessEnv(fixture.recordPath),
    });

    expect(result.status).toBe('done');
    const invocation = readProtocolInvocations(fixture.recordPath)[0];
    expect(invocation?.args.slice(0, 3)).toEqual(['exec', '--profile', 'project-review']);
    expect(invocation?.marker).toBe('absent');
    expect(invocation?.args).toContain('approval_policy="never"');
  });

  it.skipIf(process.platform === 'win32')('keeps the profile in every real standard retry spawn', async () => {
    const fixture = makeProtocolExecutable('capacity-first');
    vi.stubEnv('TAKT_CODEX_CLI_PATH', fixture.executablePath);
    const result = await new CodexProvider().setup({ name: 'coder' }).call('prompt', {
      cwd: '/tmp',
      openaiApiKey: 'test-api-key',
      providerOptions: fakeProviderOptions('automation-review'),
      childProcessEnv: fakeChildProcessEnv(fixture.recordPath),
    });

    expect(result.status).toBe('done');
    expect(result.retryCount).toBe(1);
    const invocations = readProtocolInvocations(fixture.recordPath);
    expect(invocations).toHaveLength(2);
    for (const invocation of invocations) {
      expect(invocation.args.slice(0, 3)).toEqual(['exec', '--profile', 'automation-review']);
      expect(invocation.marker).toBe('absent');
    }
    expect(invocations[1]?.args).toEqual(expect.arrayContaining(['resume', 'thread-fake']));
  });

  it.skipIf(process.platform === 'win32')('keeps the profile in every real refusal retry spawn', async () => {
    const fixture = makeProtocolExecutable('refusal-first');
    vi.stubEnv('TAKT_CODEX_CLI_PATH', fixture.executablePath);
    const result = await new CodexProvider().setup({ name: 'coder' }).call('prompt', {
      cwd: '/tmp',
      openaiApiKey: 'test-api-key',
      providerOptions: fakeProviderOptions('automation-review'),
      childProcessEnv: fakeChildProcessEnv(fixture.recordPath),
    });

    expect(result.status).toBe('done');
    expect(result.retryCount).toBe(1);
    const invocations = readProtocolInvocations(fixture.recordPath);
    expect(invocations).toHaveLength(2);
    for (const invocation of invocations) {
      expect(invocation.args.slice(0, 3)).toEqual(['exec', '--profile', 'automation-review']);
      expect(invocation.marker).toBe('absent');
    }
    expect(invocations.every((invocation) => !invocation.args.includes('resume'))).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('keeps the profile across a real idle-timeout retry spawn', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const fixture = makeProtocolExecutable('timeout-first');
    vi.stubEnv('TAKT_CODEX_CLI_PATH', fixture.executablePath);
    installCodexChildTracking();
    const abortController = new AbortController();
    activeCodexAbortControllers.add(abortController);
    let resolveFirstInit!: () => void;
    const firstInit = new Promise<void>((resolve) => {
      resolveFirstInit = resolve;
    });
    try {
      const attempts: string[] = [];
      const resultPromise = trackCodexCall(new CodexProvider().setup({ name: 'coder' }).call('prompt', {
        cwd: '/tmp',
        openaiApiKey: 'test-api-key',
        providerOptions: fakeProviderOptions('automation-review'),
        abortSignal: abortController.signal,
        onActivity: (event) => {
          if (event?.kind === 'attempt_started') {
            attempts.push(event.kind);
          }
        },
        onStream: (event) => {
          if (event.type === 'init') {
            resolveFirstInit();
          }
        },
        childProcessEnv: fakeChildProcessEnv(fixture.recordPath),
      }));

      await firstInit;
      expect(attempts).toHaveLength(1);
      expect(readProtocolInvocations(fixture.recordPath)).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      await waitForRealCondition(
        () => recordContains(fixture.recordPath, 'terminated'),
        'the first timed-out Codex child to terminate',
      );
      await waitForRealCondition(
        () => vi.getTimerCount() === 1,
        'the retry timer after the first child closes',
      );

      await vi.advanceTimersByTimeAsync(1000);
      await waitForRealCondition(() => attempts.length === 2, 'the retry attempt to start');
      const result = await resultPromise;
      await waitForRealCondition(
        () => readProtocolInvocations(fixture.recordPath).length === 2,
        'the retry invocation to finish recording',
      );

      expect(result.status).toBe('done');
      expect(result.retryCount).toBe(1);
      const invocations = readProtocolInvocations(fixture.recordPath);
      expect(invocations).toHaveLength(2);
      for (const invocation of invocations) {
        expect(invocation.args.slice(0, 3)).toEqual(['exec', '--profile', 'automation-review']);
        expect(invocation.marker).toBe('absent');
      }
      expect(invocations[1]?.args).toEqual(expect.arrayContaining(['resume', 'thread-fake']));
    } finally {
      await cleanupCodexProcesses();
      activeCodexAbortControllers.delete(abortController);
    }
  });

  it.skipIf(process.platform === 'win32')('cleans up the timeout child when the test fails mid-call', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const fixture = makeProtocolExecutable('timeout-first');
    vi.stubEnv('TAKT_CODEX_CLI_PATH', fixture.executablePath);
    installCodexChildTracking();
    const abortController = new AbortController();
    activeCodexAbortControllers.add(abortController);
    let resolveFirstInit!: () => void;
    const firstInit = new Promise<void>((resolve) => {
      resolveFirstInit = resolve;
    });
    let failure: unknown;

    try {
      trackCodexCall(new CodexProvider().setup({ name: 'coder' }).call('prompt', {
        cwd: '/tmp',
        openaiApiKey: 'test-api-key',
        providerOptions: fakeProviderOptions('automation-review'),
        abortSignal: abortController.signal,
        onStream: (event) => {
          if (event.type === 'init') {
            resolveFirstInit();
          }
        },
        childProcessEnv: fakeChildProcessEnv(fixture.recordPath),
      }));

      await firstInit;
      throw new Error('intentional timeout test failure');
    } catch (error) {
      failure = error;
    } finally {
      await cleanupCodexProcesses();
      activeCodexAbortControllers.delete(abortController);
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('intentional timeout test failure');
    expect(readProtocolInvocations(fixture.recordPath)).toHaveLength(1);
    expect(activeCodexCalls.size).toBe(0);
    expect(trackedCodexChildren.size).toBe(0);
  });

  it.skipIf(process.platform === 'win32')('returns AgentResponse.error after a real profile selection failure without fallback', async () => {
    const fixture = makeProtocolExecutable('profile-failure');
    vi.stubEnv('TAKT_CODEX_CLI_PATH', fixture.executablePath);
    const result = await new CodexProvider().setup({ name: 'coder' }).call('prompt', {
      cwd: '/tmp',
      openaiApiKey: 'test-api-key',
      providerOptions: fakeProviderOptions('missing-profile'),
      childProcessEnv: fakeChildProcessEnv(fixture.recordPath),
    });

    expect(result.status).toBe('error');
    expect(result.error).toContain('Codex Exec exited with code 23');
    const invocations = readProtocolInvocations(fixture.recordPath);
    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.args.slice(0, 3)).toEqual(['exec', '--profile', 'missing-profile']);
    expect(invocations[0]?.marker).toBe('absent');
  });

  it.skipIf(process.platform === 'win32')('keeps concurrent real CLI histories isolated by profile', async () => {
    const fixture = makeProtocolExecutable('parallel');
    const barrierPath = join(fixture.directory, 'barrier.txt');
    vi.stubEnv('TAKT_CODEX_CLI_PATH', fixture.executablePath);
    const provider = new CodexProvider();
    const [reviewResult, implementResult] = await Promise.all([
      provider.setup({ name: 'review' }).call('prompt', {
        cwd: '/tmp',
        openaiApiKey: 'test-api-key',
        providerOptions: fakeProviderOptions('review'),
        childProcessEnv: fakeChildProcessEnv(join(fixture.directory, 'review-record.txt'), barrierPath),
      }),
      provider.setup({ name: 'implement' }).call('prompt', {
        cwd: '/tmp',
        openaiApiKey: 'test-api-key',
        providerOptions: fakeProviderOptions('implement'),
        childProcessEnv: fakeChildProcessEnv(join(fixture.directory, 'implement-record.txt'), barrierPath),
      }),
    ]);

    expect(reviewResult.status).toBe('done');
    expect(implementResult.status).toBe('done');
    const reviewInvocations = readProtocolInvocations(join(fixture.directory, 'review-record.txt'));
    const implementInvocations = readProtocolInvocations(join(fixture.directory, 'implement-record.txt'));
    expect(reviewInvocations).toHaveLength(1);
    expect(implementInvocations).toHaveLength(1);
    expect(reviewInvocations[0]?.args.slice(0, 3)).toEqual(['exec', '--profile', 'review']);
    expect(implementInvocations[0]?.args.slice(0, 3)).toEqual(['exec', '--profile', 'implement']);
    expect(reviewInvocations[0]?.marker).toBe('absent');
    expect(implementInvocations[0]?.marker).toBe('absent');
    expect(readFileSync(barrierPath, 'utf8').trim().split('\n').sort()).toEqual(['implement', 'review']);
  });

  it.skipIf(process.platform === 'win32')('keeps a JSON line with a raw U+2028 as one line through the Codex spawn wiring', async () => {
    const child = childProcessModule.spawn(
      makeFakeExecutable('codex', 'line-separator-json'),
      [],
      spawnOptions(),
    );
    const closePromise = waitForClose(child);
    expect(child.stdout).not.toBeNull();

    const rl = createInterface({ input: child.stdout as Readable, crlfDelay: Infinity });
    const lines: string[] = [];
    for await (const line of rl) {
      lines.push(line);
    }
    const result = await closePromise;

    expect(result.code).toBe(0);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toEqual({ a: 'abc\u2028def' });
  });

  it.skipIf(process.platform === 'win32')('handles a real EPIPE and terminates a stuck Codex child', async () => {
    const child = childProcessModule.spawn(makeFakeExecutable('codex', 'hang'), [], spawnOptions());
    const stdin = child.stdin;
    expect(stdin).not.toBeNull();
    if (!stdin) {
      throw new Error('Codex fixture must have a stdin pipe');
    }

    const epipe = new Promise<Error>((resolve) => {
      stdin.once('error', resolve);
    });
    stdin.write('x'.repeat(1024 * 1024));
    stdin.end();

    await expect(epipe).resolves.toMatchObject({ code: 'EPIPE' });
    const result = await waitForClose(child);

    expect(result.signal).toBe('SIGTERM');
    expect(stdin.listenerCount('error')).toBe(0);
  });

  it.skipIf(process.platform === 'win32')('protects the actual SDK ESM spawn binding for a renamed Codex executable', async () => {
    const codexPath = makeFakeExecutable('renamed-codex', 'epipe');

    await expect(runCodex(codexPath)).rejects.toThrow(/Codex Exec exited with/);
  });
});

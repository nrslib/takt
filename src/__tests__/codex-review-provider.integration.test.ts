import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

interface StartedProvider {
  child: ChildProcessWithoutNullStreams;
  result: Promise<ProcessResult>;
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const evalDir = join(repoRoot, 'eval');
const providerScript = join(evalDir, 'providers', 'codex-review.sh');

let testDir: string;
let fixtureDir: string;
let fakeBinDir: string;
let pidFile: string;
let activeChildren: StartedProvider[];

function collectResult(child: ChildProcessWithoutNullStreams): Promise<ProcessResult> {
  return new Promise((resolveResult, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      resolveResult({ code, signal, stdout, stderr });
    });
  });
}

function startProvider(
  mode: 'success' | 'failure' | 'activity' | 'idle' | 'exit-race',
  environment: NodeJS.ProcessEnv = {},
): StartedProvider {
  const currentPath = process.env.PATH;
  if (currentPath === undefined) {
    throw new Error('PATH is required for the Codex provider integration test');
  }

  const child = spawn(
    'bash',
    [providerScript, 'test-model', 'max', relative(evalDir, fixtureDir), 'Review the fixture'],
    {
      env: {
        ...process.env,
        ...environment,
        PATH: `${fakeBinDir}${delimiter}${currentPath}`,
        FAKE_CODEX_MODE: mode,
        FAKE_CODEX_PID_FILE: pidFile,
        CODEX_REVIEW_IDLE_TIMEOUT_SECONDS:
          environment.CODEX_REVIEW_IDLE_TIMEOUT_SECONDS ?? '1',
      },
    },
  );
  const result = collectResult(child);
  const started = { child, result };
  activeChildren.push(started);
  return started;
}

function readWorkerPids(): number[] {
  if (!existsSync(pidFile)) return [];
  return readFileSync(pidFile, 'utf8')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(Number);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

function signalProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!existsSync(path) && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  expect(existsSync(path)).toBe(true);
}

async function expectProcessesGone(pids: number[]): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (pids.some(isProcessAlive) && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  expect(pids.filter(isProcessAlive)).toEqual([]);
}

async function waitForCompletion(
  result: Promise<ProcessResult>,
  timeoutMs: number,
): Promise<boolean> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      result.then(() => true, () => true),
      new Promise<boolean>((resolveWait) => {
        timeout = setTimeout(() => resolveWait(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function waitForProcessesGone(pids: number[], timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (pids.some(isProcessAlive) && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  return pids.every((pid) => !isProcessAlive(pid));
}

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'takt-codex-review-provider-'));
  fixtureDir = join(testDir, 'fixture');
  fakeBinDir = join(testDir, 'bin');
  pidFile = join(testDir, 'worker-pids');
  activeChildren = [];
  mkdirSync(fixtureDir);
  mkdirSync(fakeBinDir);
  writeFileSync(join(fixtureDir, 'input.txt'), 'fixture input\n');

  const fakeCodex = join(fakeBinDir, 'codex');
  writeFileSync(
    fakeCodex,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      "out=''",
      'while [ "$#" -gt 0 ]; do',
      '  if [ "$1" = "-o" ]; then',
      '    out="$2"',
      '    shift 2',
      '  else',
      '    shift',
      '  fi',
      'done',
      'cat >/dev/null',
      'case "$FAKE_CODEX_MODE" in',
      '  success)',
      '    printf \'%s\\n\' \'{"type":"thread.started"}\'',
      '    printf \'review complete\\n\' > "$out"',
      '    ;;',
      '  failure)',
      '    echo \'fake codex failure\' >&2',
      '    exit 7',
      '    ;;',
      '  activity)',
      '    for step in 1 2 3; do',
      '      printf \'{"type":"item.completed","step":%s}\\n\' "$step"',
      '      sleep 0.6',
      '    done',
      '    printf \'review complete\\n\' > "$out"',
      '    ;;',
      '  idle)',
      '    sleep 300 &',
      '    descendant_pid=$!',
      '    printf \'%s %s\\n\' "$$" "$descendant_pid" > "$FAKE_CODEX_PID_FILE"',
      '    trap \'wait "$descendant_pid" 2>/dev/null || true; exit 0\' TERM',
      '    wait "$descendant_pid"',
      '    ;;',
      '  exit-race)',
      '    printf \'%s\\n\' \'{"type":"thread.started"}\'',
      '    printf \'review complete\\n\' > "$out"',
      '    sleep 4',
      '    ;;',
      '  *)',
      '    exit 64',
      '    ;;',
      'esac',
      '',
    ].join('\n'),
  );
  chmodSync(fakeCodex, 0o755);
});

afterEach(async () => {
  for (const started of activeChildren) {
    const { child, result } = started;
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    if (await waitForCompletion(result, 1_000)) continue;

    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    expect(await waitForCompletion(result, 1_000)).toBe(true);
  }

  const workerPids = readWorkerPids().filter(isProcessAlive);
  for (const pid of workerPids) {
    signalProcess(pid, 'SIGTERM');
  }
  if (!(await waitForProcessesGone(workerPids, 1_000))) {
    for (const pid of workerPids.filter(isProcessAlive)) {
      signalProcess(pid, 'SIGKILL');
    }
    expect(await waitForProcessesGone(workerPids, 1_000)).toBe(true);
  }
  rmSync(testDir, { recursive: true, force: true });
});

describe('Codex review eval provider process boundary', () => {
  it('returns the final response on normal completion', async () => {
    const outputRootDir = join(testDir, 'provider-tmp');
    mkdirSync(outputRootDir);
    const { result } = startProvider('success', { TMPDIR: outputRootDir });

    await expect(result).resolves.toEqual({
      code: 0,
      signal: null,
      stdout: 'review complete\n',
      stderr: '',
    });
    expect(readdirSync(outputRootDir)).toEqual([]);
  });

  it('allows total runtime beyond the idle threshold while events continue', async () => {
    const outputRootDir = join(testDir, 'provider-tmp');
    mkdirSync(outputRootDir);
    const { result } = startProvider('activity', { TMPDIR: outputRootDir });

    await expect(result).resolves.toEqual({
      code: 0,
      signal: null,
      stdout: 'review complete\n',
      stderr: '',
    });
    expect(readdirSync(outputRootDir)).toEqual([]);
  });

  it('returns 124 after observable inactivity and terminates the process group', async () => {
    const outputRootDir = join(testDir, 'provider-tmp');
    mkdirSync(outputRootDir);
    const { result } = startProvider('idle', { TMPDIR: outputRootDir });
    await waitForFile(pidFile);
    const workerPids = readWorkerPids();
    const completed = await result;

    expect(completed.code).toBe(124);
    expect(completed.signal).toBeNull();
    expect(completed.stderr).toContain('made no observable progress for 1s');
    await expectProcessesGone(workerPids);
    expect(readdirSync(outputRootDir)).toEqual([]);
  });

  it('returns 143 and cleans up the worker process group and output directory on external SIGTERM', async () => {
    const outputRootDir = join(testDir, 'provider-tmp');
    mkdirSync(outputRootDir);
    const { child, result } = startProvider('idle', {
      CODEX_REVIEW_IDLE_TIMEOUT_SECONDS: '30',
      TMPDIR: outputRootDir,
    });
    await waitForFile(pidFile);
    const workerPids = readWorkerPids();

    child.kill('SIGTERM');
    const completed = await result;

    expect(completed).toMatchObject({ code: 143, signal: null });
    await expectProcessesGone(workerPids);
    expect(readdirSync(outputRootDir)).toEqual([]);
  });

  it('preserves a nonzero Codex exit and diagnostic output', async () => {
    const outputRootDir = join(testDir, 'provider-tmp');
    mkdirSync(outputRootDir);
    const { result } = startProvider('failure', { TMPDIR: outputRootDir });
    const completed = await result;

    expect(completed.code).toBe(7);
    expect(completed.signal).toBeNull();
    expect(completed.stdout).toBe('');
    expect(completed.stderr).toContain('codex review failed (exit 7)');
    expect(completed.stderr).toContain('fake codex failure');
    expect(readdirSync(outputRootDir)).toEqual([]);
  });

  it(
    'keeps the child exit result when it exits before the watchdog signal',
    async () => {
      const preload = join(testDir, 'simulate-watchdog-exit-race.cjs');
      writeFileSync(
        preload,
        [
          'const originalKill = process.kill.bind(process);',
          'process.kill = (pid, signal) => {',
          '  const isWatchdog = process.argv.some((argument) => argument.endsWith("/idle-timed-out"));',
          '  if (pid < 0 && signal === "SIGTERM" && isWatchdog) {',
          '    const error = new Error("process group already exited");',
          '    error.code = "ESRCH";',
          '    throw error;',
          '  }',
          '  return originalKill(pid, signal);',
          '};',
          '',
        ].join('\n'),
      );

      await expect(
        startProvider('exit-race', { NODE_OPTIONS: `--require=${preload}` }).result,
      ).resolves.toEqual({
        code: 0,
        signal: null,
        stdout: 'review complete\n',
        stderr: '',
      });
    },
    10_000,
  );
});

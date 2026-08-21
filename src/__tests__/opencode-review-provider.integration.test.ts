import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
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
const providerScript = join(evalDir, 'providers', 'opencode-review.sh');

let testDir: string;
let fixtureDir: string;
let fakeBinDir: string;
let pidFile: string;
let workDirFile: string;
let activeChildren: ChildProcess[];

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
  mode: 'success' | 'failure' | 'idle' | 'external-termination' | 'exit-race',
  environment: NodeJS.ProcessEnv = {},
): StartedProvider {
  const currentPath = process.env.PATH;
  if (currentPath === undefined) {
    throw new Error('PATH is required for the OpenCode provider integration test');
  }

  const fixtureArgument = relative(evalDir, fixtureDir);
  const child = spawn(
    'bash',
    [providerScript, 'test/model', fixtureArgument, `Review ${realpathSync(fixtureDir)}/input.txt`],
    {
      env: {
        ...process.env,
        ...environment,
        PATH: `${fakeBinDir}${delimiter}${currentPath}`,
        FAKE_OPENCODE_MODE: mode,
        FAKE_OPENCODE_PID_FILE: pidFile,
        FAKE_OPENCODE_WORK_DIR_FILE: workDirFile,
        OPENCODE_REVIEW_IDLE_TIMEOUT_SECONDS: environment.OPENCODE_REVIEW_IDLE_TIMEOUT_SECONDS ?? '1',
      },
    },
  );
  activeChildren.push(child);
  return { child, result: collectResult(child) };
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

function expectWorkDirectoryRemoved(): void {
  const workDir = readFileSync(workDirFile, 'utf8').trim();
  expect(existsSync(workDir)).toBe(false);
}

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'takt-opencode-review-provider-'));
  fixtureDir = join(testDir, 'fixture');
  fakeBinDir = join(testDir, 'bin');
  pidFile = join(testDir, 'worker-pids');
  workDirFile = join(testDir, 'work-dir');
  activeChildren = [];
  mkdirSync(fixtureDir);
  mkdirSync(fakeBinDir);
  writeFileSync(join(fixtureDir, 'input.txt'), 'fixture input\n');

  const fakeOpencode = join(fakeBinDir, 'opencode');
  writeFileSync(fakeOpencode, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$PWD" > "$FAKE_OPENCODE_WORK_DIR_FILE"

case "$FAKE_OPENCODE_MODE" in
  success)
    printf '%s\\n' '{"type":"text","part":{"text":"review complete"}}'
    ;;
  failure)
    echo 'fake opencode failure' >&2
    exit 7
    ;;
  idle|external-termination)
    sleep 300 &
    descendant_pid=$!
    printf '%s %s\\n' "$$" "$descendant_pid" > "$FAKE_OPENCODE_PID_FILE"
    trap 'wait "$descendant_pid" 2>/dev/null || true; exit 0' TERM
    wait "$descendant_pid"
    ;;
  exit-race)
    printf '%s\\n' '{"type":"text","part":{"text":"review complete"}}'
    sleep 4
    ;;
  *)
    echo "unknown fake mode: $FAKE_OPENCODE_MODE" >&2
    exit 64
    ;;
esac
`);
  chmodSync(fakeOpencode, 0o755);
});

afterEach(() => {
  for (const child of activeChildren) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  for (const pid of readWorkerPids()) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
  rmSync(testDir, { recursive: true, force: true });
});

describe('OpenCode review eval provider process boundary', () => {
  it('returns extracted text and removes the isolated work directory on normal completion', async () => {
    const { result } = startProvider('success');

    await expect(result).resolves.toEqual({
      code: 0,
      signal: null,
      stdout: 'review complete\n',
      stderr: '',
    });
    expectWorkDirectoryRemoved();
  });

  it('preserves a nonzero OpenCode exit and diagnostic output', async () => {
    const { result } = startProvider('failure');
    const completed = await result;

    expect(completed.code).toBe(7);
    expect(completed.signal).toBeNull();
    expect(completed.stdout).toBe('');
    expect(completed.stderr).toContain('opencode review failed (exit 7)');
    expect(completed.stderr).toContain('fake opencode failure');
    expectWorkDirectoryRemoved();
  });

  it('returns 124 after observable inactivity and terminates the process group', async () => {
    const { result } = startProvider('idle');
    await waitForFile(pidFile);
    const workerPids = readWorkerPids();
    const completed = await result;

    expect(completed.code).toBe(124);
    expect(completed.signal).toBeNull();
    expect(completed.stderr).toContain('made no observable progress for 1s');
    await expectProcessesGone(workerPids);
    expectWorkDirectoryRemoved();
  });

  it('cleans up the process group when the provider receives SIGTERM', async () => {
    const { child, result } = startProvider('external-termination', {
      OPENCODE_REVIEW_IDLE_TIMEOUT_SECONDS: '30',
    });
    await waitForFile(pidFile);
    const workerPids = readWorkerPids();

    child.kill('SIGTERM');
    const completed = await result;

    expect(completed).toMatchObject({ code: 143, signal: null });
    await expectProcessesGone(workerPids);
    expectWorkDirectoryRemoved();
  });

  it('keeps the child exit result when it exits before the watchdog signal', async () => {
    const preload = join(testDir, 'simulate-watchdog-exit-race.cjs');
    writeFileSync(preload, `const originalKill = process.kill.bind(process);
process.kill = (pid, signal) => {
  if (pid < 0 && signal === 'SIGTERM' && process.argv[3]?.endsWith('/idle-timed-out')) {
    const error = new Error('process group already exited');
    error.code = 'ESRCH';
    throw error;
  }
  return originalKill(pid, signal);
};
`);

    const { result } = startProvider('exit-race', { NODE_OPTIONS: `--require=${preload}` });

    await expect(result).resolves.toEqual({
      code: 0,
      signal: null,
      stdout: 'review complete\n',
      stderr: '',
    });
    expectWorkDirectoryRemoved();
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';
import { createIsolatedEnv, updateIsolatedConfig, type IsolatedEnv } from '../helpers/isolated-env.js';
import { createLocalRepo, type LocalRepo } from '../helpers/test-repo.js';
import { runTakt, formatTaktRunResult } from '../helpers/takt-runner.js';
import { waitFor, waitForClose } from '../helpers/wait.js';

const directory = dirname(fileURLToPath(import.meta.url));
const bin = resolve(directory, '../../bin/takt');
const workflow = resolve(directory, '../fixtures/workflows/mock-single-step.yaml');
const coderPersona = 'You are the E2E test coder.\n';

interface Owner {
  ownerId: string;
  pid: number;
  processIdentity: { startTime: string };
  kind: 'run' | 'watch';
  state: 'starting' | 'running' | 'stopping';
}

// 登録済みの watch.e2e.ts から読み込み、既存の mock E2E gate で実行する。
describe('E2E: プロジェクト単位の実行ロック', () => {
  let isolated: IsolatedEnv;
  let repo: LocalRepo;
  let env: NodeJS.ProcessEnv;
  const children: ChildProcess[] = [];
  const output = new Map<ChildProcess, string>();

  beforeEach(() => {
    isolated = createIsolatedEnv();
    repo = createLocalRepo();
    updateIsolatedConfig(isolated.taktDir, { provider: 'mock', model: 'mock-model',
      concurrency: 1, task_poll_interval_ms: 100 });
    mkdirSync(join(repo.path, '.takt'), { recursive: true });
    const scenario = join(repo.path, 'scenario.json');
    writeFileSync(scenario, JSON.stringify([
      { persona: 'summarizer', status: 'done', content: 'added-during-execution' },
      { persona: coderPersona, status: 'done', content: '[EXECUTE:1]\nDone', wait_for_abort: true },
    ]));
    env = { ...isolated.env, TAKT_MOCK_SCENARIO: scenario, TAKT_SHUTDOWN_TIMEOUT_MS: '1000',
      OTEL_EXPORTER_OTLP_ENDPOINT: undefined, OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: undefined,
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: undefined,
      TAKT_MOCK_CALL_LOG: join(repo.path, '.takt', 'mock-calls.jsonl') };
  });

  afterEach(async () => {
    try {
      await Promise.all(children.splice(0).map(async (child) => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill('SIGKILL');
        await waitForClose(child, 5_000);
      }));
    } finally {
      output.clear();
      repo.cleanup();
      isolated.cleanup();
    }
  });

  function owner(): Owner | undefined {
    const lock = join(repo.path, '.takt', 'execution.lock');
    if (!existsSync(lock)) return undefined;
    const names = readdirSync(lock).filter((name) => /^owner-.*\.json$/.test(name));
    if (names.length === 0) return undefined;
    expect(names).toHaveLength(1);
    return JSON.parse(readFileSync(join(lock, names[0]!), 'utf8')) as Owner;
  }

  function tasks(): Array<{ name: string; status: string; content?: string; summary?: string;
    task_dir?: string; owner_pid: number | null }> {
    const path = join(repo.path, '.takt', 'tasks.yaml');
    if (!existsSync(path)) return [];
    return (parse(readFileSync(path, 'utf8')) as { tasks: ReturnType<typeof tasks> }).tasks;
  }

  function seedTasks(): void {
    writeFileSync(join(repo.path, '.takt', 'tasks.yaml'), stringify({ tasks: ['first', 'second'].map((name) => ({
      name, status: 'pending', content: name, workflow, worktree: false, auto_pr: false,
      created_at: '2026-01-01T00:00:00.000Z', started_at: null, completed_at: null, owner_pid: null,
    })) }));
  }

  function start(kind: 'run' | 'watch'): ChildProcess {
    const child = spawn(process.execPath, [bin, '--provider', 'mock', kind],
      { cwd: repo.path, env, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    output.set(child, '');
    for (const stream of [child.stdout, child.stderr]) {
      stream?.on('data', (chunk: Buffer) => output.set(child, output.get(child)! + chunk.toString()));
    }
    return child;
  }

  async function ready(child: ChildProcess, requireTask: boolean): Promise<Owner> {
    const observed = await waitFor(() => {
      const current = owner();
      return current !== undefined && current.pid === child.pid && current.state === 'running'
        && (!requireTask || (tasks().some((task) => task.status === 'running') && coderStarted()));
    }, 10_000, 20);
    expect(observed, output.get(child)).toBe(true);
    return owner()!;
  }

  function coderStarted(): boolean {
    const path = env.TAKT_MOCK_CALL_LOG!;
    if (!existsSync(path)) return false;
    // The writer may still be appending the final JSONL record.
    return readFileSync(path, 'utf8').split('\n').slice(0, -1).some((line) => {
      const call = JSON.parse(line) as { event: string; personaName: string };
      return call.event === 'start' && call.personaName === coderPersona;
    });
  }

  it.each([
    { first: 'run', second: 'run' }, { first: 'run', second: 'watch' },
    { first: 'watch', second: 'run' }, { first: 'watch', second: 'watch' },
  ] as const)('$first が保持中は後発 $second が所有者を表示し、最初の取得前に終了する', async ({ first, second }) => {
    seedTasks();
    const initial = start(first);
    const held = await ready(initial, true);
    const before = tasks();
    const contender = start(second);
    const exited = await waitForClose(contender, 10_000);
    expect(exited.signal).toBeNull();
    expect(exited.code).not.toBe(0);
    const lines = output.get(contender)!.split(/\r?\n/);
    expect(lines.some((line) => line.includes(first) && line.includes(String(held.pid)))).toBe(true);
    expect(tasks()).toEqual(before);
    expect(owner()).toEqual(held);
  }, 30_000);

  it('空キュー待機中の watch を SIGKILL した後は別所有者として引き継ぐ', async () => {
    const first = start('watch');
    const old = await ready(first, false);
    first.kill('SIGKILL');
    const killed = await waitForClose(first, 5_000);
    expect(killed.signal).toBe('SIGKILL');
    expect(owner()).toEqual(old);
    const next = start('watch');
    const current = await ready(next, false);
    expect(current.ownerId).not.toBe(old.ownerId);
    expect(current.pid).toBe(next.pid);
    expect(current.processIdentity.startTime.length).toBeGreaterThan(0);
  }, 30_000);

  it('保持中の watch を生かしたまま CLI add で投入してキューを読み取れる', async () => {
    const watcher = start('watch');
    const held = await ready(watcher, false);
    const added = runTakt({ args: ['--provider', 'mock', '--workflow', workflow, 'add', 'Added during execution'],
      cwd: repo.path, env, input: 'n\n', timeout: 30_000 });
    expect(added.exitCode, formatTaktRunResult(added)).toBe(0);
    const saved = tasks().find((task) => task.summary === 'Added during execution');
    expect(saved?.task_dir).toEqual(expect.any(String));
    expect(readFileSync(join(repo.path, saved!.task_dir!, 'order.md'), 'utf8')).toBe('Added during execution');
    expect(owner()).toEqual(held);
    expect(watcher.exitCode).toBeNull();
  }, 45_000);

  it('空キュー run の正常終了後に watch が取得できる', async () => {
    const run = start('run');
    expect((await waitForClose(run, 10_000)).code, output.get(run)).toBe(0);
    expect(owner()).toBeUndefined();
    const watcher = start('watch');
    await ready(watcher, false);
  }, 30_000);

  it('同じ watch は SIGINT 後に停止中を記録し、実行中タスクの自然な保存完了まで保持する', async () => {
    seedTasks();
    writeFileSync(env.TAKT_MOCK_SCENARIO!, JSON.stringify([
      { persona: coderPersona, status: 'done', content: '[EXECUTE:1]\nDone', delay_ms: 3_000 },
    ]));
    env.TAKT_SHUTDOWN_TIMEOUT_MS = '10000';
    const watcher = start('watch');
    const running = await ready(watcher, true);
    watcher.kill('SIGINT');
    expect(await waitFor(() => owner()?.state === 'stopping', 2_000, 10), output.get(watcher)).toBe(true);
    expect(owner()).toEqual({ ...running, state: 'stopping' });
    expect(tasks().find((task) => task.name === 'first')?.status).toBe('running');
    const exited = await waitForClose(watcher, 15_000);
    expect(exited.code, output.get(watcher)).toBe(0);
    expect(tasks().find((task) => task.name === 'first')).toMatchObject({ status: 'completed', owner_pid: null });
    expect(tasks().find((task) => task.name === 'second')?.status).toBe('pending');
    expect(owner()).toBeUndefined();
  }, 30_000);

  it.each(['single', 'double', 'timeout'] as const)('SIGINT 終了（%s）で記録を解放し、次の実行を開始できる', async (termination) => {
    const kind = termination === 'single' ? 'run' : 'watch';
    seedTasks();
    env.TAKT_SHUTDOWN_TIMEOUT_MS = termination === 'timeout' ? '250' : '10000';
    const first = start(kind);
    await ready(first, true);
    first.kill('SIGINT');
    if (termination === 'double') {
      expect(await waitFor(() => owner()?.state === 'stopping', 2_000, 10)).toBe(true);
      first.kill('SIGINT');
    }
    const exited = await waitForClose(first, 15_000);
    expect(exited.signal).toBeNull();
    expect(exited.code).toBe(termination === 'single' ? 0 : 130);
    expect(owner()).toBeUndefined();
    const next = start('watch');
    await ready(next, false);
  }, 40_000);
});

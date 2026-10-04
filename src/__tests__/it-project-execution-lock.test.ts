import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, randomUUID: vi.fn(actual.randomUUID) };
});
vi.mock('../infra/task/process.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../infra/task/process.js')>();
  return { ...actual, getProcessIdentity: vi.fn(actual.getProcessIdentity),
    getSelfProcessIdentity: vi.fn(actual.getSelfProcessIdentity) };
});
vi.mock('../infra/task/summarize.js', () => ({
  summarizeTaskName: vi.fn().mockResolvedValue('mcp-during-watch'),
}));

import { acquireProjectExecutionLock } from '../infra/task/project-execution-lock.js';
import { getProcessIdentity, getSelfProcessIdentity, type ProcessIdentity } from '../infra/task/process.js';
import { TaskStore } from '../infra/task/store.js';
import { enqueueTaktTask } from '../features/mcp/operations.js';

interface OwnerRecord {
  ownerId: string;
  pid: number;
  processIdentity: ProcessIdentity;
  kind: 'run' | 'watch';
  state: 'starting' | 'running' | 'stopping';
}

function readOwner(projectDir: string): OwnerRecord {
  const directory = join(projectDir, '.takt', 'execution.lock');
  const names = readdirSync(directory).filter((name) => /^owner-.*\.json$/.test(name));
  expect(names).toHaveLength(1);
  return JSON.parse(readFileSync(join(directory, names[0]!), 'utf8')) as OwnerRecord;
}

async function waitForFiles(paths: string[], children: ChildProcess[]): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!paths.every((path) => existsSync(path))) {
    if (children.some((child, index) =>
      (child.exitCode !== null || child.signalCode !== null) && !existsSync(paths[index]!))) {
      throw new Error('Lock worker exited before publishing its result');
    }
    if (Date.now() >= deadline) throw new Error('Timed out waiting for lock workers');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('プロジェクト実行ロックの保存と所有権', () => {
  let projectDir: string;
  const children: ChildProcess[] = [];

  beforeEach(async () => {
    const crypto = await vi.importActual<typeof import('node:crypto')>('node:crypto');
    const processes = await vi.importActual<typeof import('../infra/task/process.js')>('../infra/task/process.js');
    vi.mocked(randomUUID).mockReset().mockImplementation(crypto.randomUUID);
    vi.mocked(getProcessIdentity).mockReset().mockImplementation(processes.getProcessIdentity);
    vi.mocked(getSelfProcessIdentity).mockReset().mockImplementation(processes.getSelfProcessIdentity);
    projectDir = mkdtempSync(join(tmpdir(), 'takt-execution-lock-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(children.splice(0).map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const closed = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Lock worker cleanup timed out')), 5_000);
        child.once('close', () => { clearTimeout(timeout); resolve(); });
      });
      child.kill('SIGKILL');
      await closed;
    }));
    rmSync(projectDir, { recursive: true, force: true });
  });

  function seedOwner(owner: OwnerRecord): void {
    const directory = join(projectDir, '.takt', 'execution.lock');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `owner-${owner.ownerId}.json`), JSON.stringify(owner));
  }

  function selfIdentity(): ProcessIdentity {
    const identity = getSelfProcessIdentity();
    expect(identity).toBeDefined();
    return identity!;
  }

  it('取得直後の完成した記録を同じ所有者の実行中・停止中へ更新する', () => {
    const lock = acquireProjectExecutionLock(projectDir, 'watch');
    const starting = readOwner(projectDir);
    expect(starting).toMatchObject({ pid: process.pid, processIdentity: selfIdentity(), kind: 'watch', state: 'starting' });
    expect(starting.ownerId.length).toBeGreaterThan(0);
    lock.updateState('running');
    expect(readOwner(projectDir)).toEqual({ ...starting, state: 'running' });
    lock.updateState('stopping');
    expect(readOwner(projectDir)).toEqual({ ...starting, state: 'stopping' });
    lock.release();
    const next = acquireProjectExecutionLock(projectDir, 'run');
    next.release();
  });

  it.each(['starting', 'running', 'stopping'] as const)('生存所有者が %s でも後発を拒否して記録を保持する', (state) => {
    const first = acquireProjectExecutionLock(projectDir, 'watch');
    first.updateState(state);
    const before = readOwner(projectDir);
    expect(() => acquireProjectExecutionLock(projectDir, 'run')).toThrow();
    expect(readOwner(projectDir)).toEqual(before);
    first.release();
  });

  it('生存所有者と生成した所有者 ID が衝突しても記録を上書きしない', () => {
    const ownerId: ReturnType<typeof randomUUID> = '550e8400-e29b-41d4-a716-446655440000';
    vi.mocked(randomUUID).mockReturnValue(ownerId);
    const first = acquireProjectExecutionLock(projectDir, 'watch');
    const before = readOwner(projectDir);
    expect(before.ownerId).toBe(ownerId);
    expect(() => acquireProjectExecutionLock(projectDir, 'run')).toThrow(new RegExp(`watch.*${before.pid}|${before.pid}.*watch`));
    expect(readOwner(projectDir)).toEqual(before);
    first.release();
  });

  it('PID は生存していても開始時刻が異なれば新しい所有者 ID で引き継ぐ', () => {
    const old: OwnerRecord = { ownerId: '550e8400-e29b-41d4-a716-446655440000', pid: process.pid,
      processIdentity: { startTime: 'previous-process-start' }, kind: 'run', state: 'running' };
    seedOwner(old);
    const lock = acquireProjectExecutionLock(projectDir, 'watch');
    const current = readOwner(projectDir);
    expect(current.ownerId).not.toBe(old.ownerId);
    expect(current).toMatchObject({ pid: process.pid, processIdentity: selfIdentity(), kind: 'watch', state: 'starting' });
    lock.release();
  });

  it('終了済み run の記録を新しい watch の所有者 ID とプロセス識別情報へ引き継ぐ', () => {
    const terminated = spawnSync(process.execPath, ['-e', ''], { timeout: 5_000 });
    expect(terminated.status).toBe(0);
    expect(getProcessIdentity(terminated.pid)).toBeUndefined();
    const old: OwnerRecord = { ownerId: '550e8400-e29b-41d4-a716-446655440000', pid: terminated.pid,
      processIdentity: { startTime: 'terminated-process-start' }, kind: 'run', state: 'running' };
    seedOwner(old);
    const lock = acquireProjectExecutionLock(projectDir, 'watch');
    const current = readOwner(projectDir);
    expect(current.ownerId).not.toBe(old.ownerId);
    expect(current).toMatchObject({ pid: process.pid, processIdentity: selfIdentity(), kind: 'watch', state: 'starting' });
    lock.release();
  });

  it('生存中の既存所有者の開始時刻が不明なら引き継がない', () => {
    const first = acquireProjectExecutionLock(projectDir, 'watch');
    const before = readOwner(projectDir);
    vi.mocked(getProcessIdentity).mockReturnValue(undefined);
    expect(() => acquireProjectExecutionLock(projectDir, 'run')).toThrow();
    expect(readOwner(projectDir)).toEqual(before);
    first.release();
  });

  it('自分の開始時刻が不明なら記録を公開しない', () => {
    vi.mocked(getSelfProcessIdentity).mockReturnValue(undefined);
    vi.mocked(getProcessIdentity).mockReturnValue(undefined);
    expect(() => acquireProjectExecutionLock(projectDir, 'run')).toThrow();
    expect(existsSync(join(projectDir, '.takt', 'execution.lock'))).toBe(false);
  });

  it('不正な所有者記録を死亡済みとして消さない', () => {
    const directory = join(projectDir, '.takt', 'execution.lock');
    mkdirSync(directory, { recursive: true });
    const path = join(directory, 'owner-broken.json');
    writeFileSync(path, '{');
    expect(() => acquireProjectExecutionLock(projectDir, 'run')).toThrow();
    expect(readFileSync(path, 'utf8')).toBe('{');
  });

  it('別プロジェクトは独立し、解放済み旧所有者は新所有者を消さない', () => {
    const first = acquireProjectExecutionLock(projectDir, 'run');
    const other = acquireProjectExecutionLock(join(projectDir, 'other'), 'watch');
    first.release();
    const next = acquireProjectExecutionLock(projectDir, 'watch');
    const before = readOwner(projectDir);
    first.release();
    expect(readOwner(projectDir)).toEqual(before);
    expect(() => acquireProjectExecutionLock(projectDir, 'run')).toThrow();
    next.release();
    other.release();
  });

  it('ロック位置が別所有者へ置換された後の旧解放は新所有者を消さない', () => {
    const first = acquireProjectExecutionLock(projectDir, 'run');
    renameSync(join(projectDir, '.takt', 'execution.lock'), join(projectDir, '.takt', 'old.lock'));
    const next = acquireProjectExecutionLock(projectDir, 'watch');
    const before = readOwner(projectDir);
    first.release();
    expect(readOwner(projectDir)).toEqual(before);
    next.release();
  });

  it('保持中でも本番 MCP 投入とキュー読取が保存済みタスクを返す', async () => {
    const lock = acquireProjectExecutionLock(projectDir, 'watch');
    const before = readOwner(projectDir);
    const result = await enqueueTaktTask({ cwd: projectDir, task: 'MCP during watch',
      workflow: 'default', worktree: false, autoPr: false });
    expect(result.isError).not.toBe(true);
    const tasks = new TaskStore(projectDir).read().tasks;
    const added = tasks.find((task) => task.name === 'mcp-during-watch');
    expect(added).toMatchObject({ summary: 'MCP during watch', status: 'pending' });
    expect(added?.task_dir).toEqual(expect.any(String));
    expect(readFileSync(join(projectDir, added!.task_dir!, 'order.md'), 'utf8')).toBe('MCP during watch');
    expect(readOwner(projectDir)).toEqual(before);
    lock.release();
  });

  it.each([true, false])('取得結果=%s の JSON は書込完了後にだけ公開される', async (acquired) => {
    const existing = acquired ? undefined : acquireProjectExecutionLock(projectDir, 'run');
    const fixture = fileURLToPath(new URL('./fixtures/project-execution-lock-child.ts', import.meta.url));
    const ready = join(projectDir, 'ready');
    const start = join(projectDir, 'start');
    const result = join(projectDir, 'result');
    const child = spawn(process.execPath, ['--import', 'tsx', fixture, projectDir, ready, start, result, 'hold', 'pause-result'],
      { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    child.stdout?.resume();
    child.stderr?.resume();
    try {
      await waitForFiles([ready], [child]);
      writeFileSync(start, 'go');
      await waitForFiles([`${result}.writing`], [child]);
      expect(existsSync(result)).toBe(false);
      const waiting = waitForFiles([result], [child]);
      let parsed = false;
      const outcome = waiting.then(() => {
        parsed = true;
        return JSON.parse(readFileSync(result, 'utf8')) as { acquired: boolean; owner?: OwnerRecord; error?: string };
      });
      await Promise.resolve();
      expect(parsed).toBe(false);
      writeFileSync(`${result}.publish`, 'publish');
      const published = await outcome;
      expect(published.acquired).toBe(acquired);
      if (acquired) {
        expect(published.owner).toEqual(readOwner(projectDir));
        expect(published.owner?.pid).toBe(child.pid);
        expect(getProcessIdentity(child.pid!)).toEqual(published.owner!.processIdentity);
        expect(getProcessIdentity(child.pid!)).toEqual(published.owner!.processIdentity);
      } else {
        expect(published.error).toEqual(expect.any(String));
        expect(readOwner(projectDir)).toEqual(existing!.owner);
      }
    } finally {
      existing?.release();
    }
  });

  it.each(['empty', 'dead', 'interrupted-update'] as const)('ロック状態 %s で複数プロセスが同時取得しても成功は一つ', async (initialState) => {
    const fixture = fileURLToPath(new URL('./fixtures/project-execution-lock-child.ts', import.meta.url));
    const start = join(projectDir, 'start');
    const readyFiles = [0, 1, 2].map((index) => join(projectDir, `ready-${index}`));
    const results = [0, 1, 2].map((index) => join(projectDir, `result-${index}`));
    function worker(index: number): ChildProcess {
      const child = spawn(process.execPath, ['--import', 'tsx', fixture, projectDir, readyFiles[index]!, start, results[index]!,
        index === 0 && initialState === 'interrupted-update' ? 'interrupt-update' : 'hold'],
        { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
      children.push(child);
      child.stdout?.resume();
      child.stderr?.resume();
      return child;
    }
    let old: OwnerRecord | undefined;
    if (initialState !== 'empty') {
      const first = worker(0);
      await waitForFiles([readyFiles[0]!], [first]);
      writeFileSync(start, 'go');
      await waitForFiles([results[0]!], [first]);
      old = readOwner(projectDir);
      expect(old.pid).toBe(first.pid);
      const closed = first.exitCode !== null || first.signalCode !== null
        ? Promise.resolve()
        : new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('Owner did not terminate')), 5_000);
          first.once('close', () => { clearTimeout(timeout); resolve(); });
        });
      if (initialState === 'dead') first.kill('SIGKILL');
      await closed;
      if (process.platform === 'win32' && initialState === 'interrupted-update') {
        expect(first.exitCode).toBe(1);
        expect(first.signalCode).toBeNull();
      } else {
        expect(first.exitCode).toBeNull();
        expect(first.signalCode).toBe('SIGKILL');
      }
      if (initialState === 'interrupted-update') {
        expect(readdirSync(join(projectDir, '.takt', 'execution.lock')).filter((name) => !/^owner-.*\.json$/.test(name)).length)
          .toBeGreaterThan(0);
      }
      expect(readOwner(projectDir)).toEqual(old);
      rmSync(start);
    }
    const contenders = [worker(1), worker(2)];
    await waitForFiles(readyFiles.slice(1), contenders);
    writeFileSync(start, 'go');
    await waitForFiles(results.slice(1), contenders);
    const outcomes = results.slice(1).map((path) => JSON.parse(readFileSync(path, 'utf8')) as { acquired: boolean; owner?: OwnerRecord });
    expect(outcomes.filter((outcome) => outcome.acquired)).toHaveLength(1);
    expect(outcomes.filter((outcome) => !outcome.acquired)).toHaveLength(1);
    const winner = outcomes.find((outcome) => outcome.acquired)!.owner!;
    expect(readOwner(projectDir)).toEqual(winner);
    expect(contenders.map((child) => child.pid)).toContain(winner.pid);
    expect(getProcessIdentity(winner.pid)).toEqual(winner.processIdentity);
    expect(getProcessIdentity(winner.pid)).toEqual(winner.processIdentity);
    if (old !== undefined) expect(winner.ownerId).not.toBe(old.ownerId);
    expect(() => acquireProjectExecutionLock(projectDir, 'run')).toThrow();
  }, 20_000);
});

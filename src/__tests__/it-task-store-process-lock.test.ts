import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});

import { TaskStore } from '../infra/task/store.js';

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'task-store-concurrent-add.ts',
);
const viteNodePath = join(process.cwd(), 'node_modules', 'vite-node', 'vite-node.mjs');

function runWorker(
  projectDir: string,
  workerId: number,
  readyFile: string,
  releaseFile: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      viteNodePath,
      fixturePath,
      projectDir,
      String(workerId),
      readyFile,
      releaseFile,
    ], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`Worker ${workerId} exited with ${String(code)}: ${stderr}`));
      }
    });
  });
}

async function waitUntilAllWorkersReady(readyFiles: string[]): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (readyFiles.some((file) => !existsSync(file))) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for task-store workers');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('TaskStore process lock', () => {
  const testDirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const testDir of testDirs) {
      rmSync(testDir, { recursive: true, force: true });
    }
    testDirs.length = 0;
  });

  it('serializes simultaneous same-target additions across processes without lost updates', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-task-store-process-lock-'));
    testDirs.push(projectDir);
    const releaseFile = join(projectDir, 'release');
    const readyFiles = Array.from(
      { length: 12 },
      (_, workerId) => join(projectDir, `ready-${workerId}`),
    );
    const workers = readyFiles.map((readyFile, workerId) => (
      runWorker(projectDir, workerId, readyFile, releaseFile)
    ));

    await waitUntilAllWorkersReady(readyFiles);
    writeFileSync(releaseFile, 'go', 'utf-8');
    const results = await Promise.all(workers);

    expect(results.filter((result) => result === 'created')).toHaveLength(1);
    expect(results.filter((result) => result === 'duplicate')).toHaveLength(11);
    const tasksFile = readFileSync(join(projectDir, '.takt', 'tasks.yaml'), 'utf-8');
    const parsed = parseYaml(tasksFile) as { tasks: Array<{ issue?: number }> };
    expect(parsed.tasks).toHaveLength(1);
    expect(parsed.tasks[0]?.issue).toBe(42);
  }, 20_000);

  it('steals a lock left by a dead process immediately', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-task-store-dead-lock-'));
    testDirs.push(projectDir);
    mkdirSync(join(projectDir, '.takt'), { recursive: true });

    const probe = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    const deadPid = probe.pid;
    await new Promise((resolve) => probe.once('close', resolve));
    expect(deadPid).toBeTypeOf('number');

    const lockFile = join(projectDir, '.takt', 'tasks.yaml.lock');
    writeFileSync(lockFile, `${String(deadPid)}\n`, 'utf-8');

    const store = new TaskStore(projectDir);
    const startedAt = Date.now();
    const data = store.read();
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(data.tasks).toEqual([]);
    expect(existsSync(lockFile)).toBe(false);
  });

  it('serializes two stale removers and a new acquirer without deleting the current owner', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-task-store-recovery-race-'));
    testDirs.push(projectDir);
    mkdirSync(join(projectDir, '.takt'), { recursive: true });
    const probe = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    const deadPid = probe.pid;
    await new Promise((resolve) => probe.once('close', resolve));
    expect(deadPid).toBeTypeOf('number');
    const lockFile = join(projectDir, '.takt', 'tasks.yaml.lock');
    writeFileSync(lockFile, `${String(deadPid)}\n`);
    const marker = (id: string, phase: string): string => join(projectDir, `${id}-${phase}`);
    const fixture = join(dirname(fixturePath), 'task-store-stale-recovery.ts');
    const children: ReturnType<typeof spawn>[] = [];
    const results: Array<Promise<{ code: number | null; stderr: string }>> = [];
    const start = (id: string): Promise<{ code: number | null; stderr: string }> => {
      const child = spawn(process.execPath, [viteNodePath, fixture, projectDir, id], {
        cwd: process.cwd(), stdio: ['ignore', 'ignore', 'pipe'],
      });
      children.push(child);
      const result = new Promise<{ code: number | null; stderr: string }>((resolve) => {
        let stderr = '';
        child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
        child.once('error', (error) => resolve({ code: -1, stderr: error.message }));
        child.once('close', (code) => resolve({ code, stderr }));
      });
      results.push(result);
      return result;
    };
    const waitForAttempt = async (id: string): Promise<'waiting' | 'entered'> => {
      const deadline = Date.now() + 4_000;
      while (!existsSync(marker(id, 'waiting')) && !existsSync(marker(id, 'entered'))) {
        if (Date.now() >= deadline) throw new Error(`Worker ${id} did not attempt acquisition`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return existsSync(marker(id, 'entered')) ? 'entered' : 'waiting';
    };
    const release = (id: string, phase: string): void => {
      writeFileSync(marker(id, `release-${phase}`), 'go');
    };
    try {
      const first = start('a');
      await waitUntilAllWorkersReady([marker('a', 'removing')]);
      const second = start('b');
      if (await waitForAttempt('b') === 'entered') {
        // Exercise the original ABA ordering too: B replaces the dead lock,
        // then C acquires it before A resumes its already-validated unlink.
        release('b', 'update');
        expect(await second).toEqual({ code: 0, stderr: '' });
        start('c');
        await waitUntilAllWorkersReady([marker('c', 'entered')]);
        release('a', 'removal');
        expect(await first).toEqual({ code: 0, stderr: '' });
      } else {
        start('c');
        expect(await waitForAttempt('c')).toBe('waiting');
        release('a', 'removal');
        await waitUntilAllWorkersReady([marker('a', 'entered')]);
        expect(readFileSync(lockFile, 'utf-8').trim()).toBe(readFileSync(marker('a', 'entered'), 'utf-8'));
        expect(existsSync(marker('b', 'entered'))).toBe(false);
        expect(existsSync(marker('c', 'entered'))).toBe(false);
        release('a', 'update');
        expect(await first).toEqual({ code: 0, stderr: '' });
      }
      release('b', 'update');
      release('c', 'update');
      const completed = await Promise.all(results);
      expect(completed).toEqual(results.map(() => ({ code: 0, stderr: '' })));
      expect(readFileSync(join(projectDir, 'counter'), 'utf-8')).toBe('3');
      expect(existsSync(lockFile)).toBe(false);
    } finally {
      release('a', 'removal');
      for (const id of ['a', 'b', 'c']) release(id, 'update');
      for (const child of children) {
        if (child.exitCode === null) child.kill();
      }
      await Promise.all(results);
    }
  }, 20_000);

  it.each(['ENOTEMPTY', 'EEXIST', 'EPERM', 'EACCES'])('recovers a crashed guard when directory publication reports %s', async (code) => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-task-store-dead-guard-'));
    testDirs.push(projectDir);
    mkdirSync(join(projectDir, '.takt'), { recursive: true });
    const probe = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    const deadPid = probe.pid;
    await new Promise((resolve) => probe.once('close', resolve));
    expect(deadPid).toBeTypeOf('number');
    const lockFile = join(projectDir, '.takt', 'tasks.yaml.lock');
    writeFileSync(lockFile, `${String(deadPid)}\n`);
    mkdirSync(`${lockFile}.guard`);
    writeFileSync(join(`${lockFile}.guard`, `owner-${String(deadPid)}-00000000-0000-0000-0000-000000000000`), '');

    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('Destination guard already exists'), { code });
    });
    expect(new TaskStore(projectDir).read()).toEqual({ tasks: [] });
    expect(existsSync(lockFile)).toBe(false);
    expect(existsSync(`${lockFile}.guard`)).toBe(false);
  });

  it('does not steal a lock held by a live process', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-task-store-live-lock-'));
    testDirs.push(projectDir);
    mkdirSync(join(projectDir, '.takt'), { recursive: true });
    const lockFile = join(projectDir, '.takt', 'tasks.yaml.lock');
    writeFileSync(lockFile, `${String(process.pid)}\n`, 'utf-8');
    const olderThanStaleThreshold = new Date(Date.now() - 60_000);
    utimesSync(lockFile, olderThanStaleThreshold, olderThanStaleThreshold);

    const store = new TaskStore(projectDir);
    expect(() => store.read()).toThrow(/timed out waiting for lock/);
    expect(existsSync(lockFile)).toBe(true);
  }, 10_000);
});

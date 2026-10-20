import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { TaskStore } from '../infra/task/store.js';
import { getSelfProcessIdentity } from '../infra/task/process.js';
import { TaskRunner } from '../infra/task/runner.js';

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

function runDeletionRaceWorker(projectDir: string, role: 'delete' | 'claim', taskName: string) {
  const child = spawn(process.execPath, [
    viteNodePath,
    join(dirname(fixturePath), 'task-delete-claim.ts'),
    projectDir, role, taskName,
  ], {
    cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000, killSignal: 'SIGKILL',
  });
  let stderr = '';
  child.stdout.resume();
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const completed = new Promise<{ code: number | null; stderr: string }>((resolve) => {
    child.on('error', (error) => { stderr += String(error); });
    child.on('close', (code) => { resolve({ code, stderr }); });
  });
  return { child, completed };
}

describe('TaskStore process lock', () => {
  const testDirs: string[] = [];

  afterEach(() => {
    for (const testDir of testDirs) {
      rmSync(testDir, { recursive: true, force: true });
    }
    testDirs.length = 0;
  });

  it.each(['delete', 'claim'] as const)('protects cleanup from concurrent claim when %s acquires first', async (first) => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-delete-claim-'));
    testDirs.push(projectDir);
    const worktreePath = join(projectDir, 'worktree');
    mkdirSync(worktreePath);
    const marker = join(worktreePath, 'work.txt');
    writeFileSync(marker, 'keep work');
    const runner = new TaskRunner(projectDir);
    const target = runner.addTask('delete claim race', { branch: 'takt/race', worktree_path: worktreePath });
    const deletion = runDeletionRaceWorker(projectDir, 'delete', target.name);
    const claim = runDeletionRaceWorker(projectDir, 'claim', target.name);
    const start = (role: 'delete' | 'claim') => writeFileSync(join(projectDir, `${role}-start`), 'go');
    try {
      await waitUntilAllWorkersReady(['delete', 'claim'].map((role) => join(projectDir, `${role}-ready`)));
      start(first);
      if (first === 'delete') {
        await waitUntilAllWorkersReady([join(projectDir, 'cleanup-started')]);
        const lockFile = join(projectDir, '.takt', 'tasks.yaml.lock');
        expect(JSON.parse(readFileSync(lockFile, 'utf8'))).toMatchObject({ pid: deletion.child.pid });
        start('claim');
        await waitUntilAllWorkersReady([join(projectDir, 'claim-attempt')]);
        expect(JSON.parse(readFileSync(lockFile, 'utf8'))).toMatchObject({ pid: deletion.child.pid });
        expect(existsSync(join(projectDir, 'claim-result'))).toBe(false);
        expect(parseYaml(readFileSync(runner.getTasksFilePath(), 'utf8'))).toMatchObject({
          tasks: [{ name: target.name, status: 'pending' }],
        });
        writeFileSync(join(projectDir, 'cleanup-release'), 'go');
      } else {
        expect(await claim.completed).toMatchObject({ code: 0 });
        start('delete');
      }

      expect(await deletion.completed).toMatchObject({ code: 0 });
      expect(await claim.completed).toMatchObject({ code: 0 });
      expect(JSON.parse(readFileSync(join(projectDir, 'delete-result'), 'utf8'))).toEqual({ deleted: first === 'delete' });
      expect(JSON.parse(readFileSync(join(projectDir, 'claim-result'), 'utf8'))).toEqual(first === 'claim' ? [target.name] : []);
      expect(existsSync(marker)).toBe(first === 'claim');
      expect(existsSync(join(projectDir, 'cleanup-started'))).toBe(first === 'delete');
      expect(runner.listAllTaskItems()).toMatchObject(first === 'claim'
        ? [{ name: target.name, kind: 'running', worktreePath }] : []);
      expect(runner.listAllTaskItems()).toHaveLength(first === 'claim' ? 1 : 0);
    } finally {
      writeFileSync(join(projectDir, 'cleanup-release'), 'go');
      for (const worker of [deletion, claim]) {
        if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill('SIGKILL');
      }
      await Promise.all([deletion.completed, claim.completed]);
    }
  }, 30_000);

  it('serializes simultaneous automatic same-target additions across processes without lost updates', async () => {
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
    writeFileSync(lockFile, JSON.stringify({ pid: deadPid, processIdentity: { startTime: 'terminated-process-start' } }), 'utf-8');

    const store = new TaskStore(projectDir);
    const startedAt = Date.now();
    const data = store.read();
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(data.tasks).toEqual([]);
    expect(existsSync(lockFile)).toBe(false);
  });

  it('ignores a leftover legacy guard directory while recovering a dead owner', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-task-store-dead-guard-'));
    testDirs.push(projectDir);
    mkdirSync(join(projectDir, '.takt'), { recursive: true });
    const probe = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    const deadPid = probe.pid;
    await new Promise((resolve) => probe.once('close', resolve));
    expect(deadPid).toBeTypeOf('number');
    const lockFile = join(projectDir, '.takt', 'tasks.yaml.lock');
    writeFileSync(lockFile, JSON.stringify({ pid: deadPid, processIdentity: { startTime: 'terminated-process-start' } }));
    mkdirSync(`${lockFile}.guard`);
    const guardOwner = join(`${lockFile}.guard`, `owner-${String(deadPid)}-00000000-0000-0000-0000-000000000000`);
    writeFileSync(guardOwner, '');

    expect(new TaskStore(projectDir).read()).toEqual({ tasks: [] });
    expect(existsSync(lockFile)).toBe(false);
    expect(existsSync(guardOwner)).toBe(true);
  });

  it('does not steal a lock held by a live process', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-task-store-live-lock-'));
    testDirs.push(projectDir);
    mkdirSync(join(projectDir, '.takt'), { recursive: true });
    const lockFile = join(projectDir, '.takt', 'tasks.yaml.lock');
    writeFileSync(lockFile, JSON.stringify({ pid: process.pid, processIdentity: getSelfProcessIdentity() }), 'utf-8');
    const olderThanStaleThreshold = new Date(Date.now() - 60_000);
    utimesSync(lockFile, olderThanStaleThreshold, olderThanStaleThreshold);

    const store = new TaskStore(projectDir);
    expect(() => store.read()).toThrow(/timed out waiting for lock/);
    expect(existsSync(lockFile)).toBe(true);
  }, 10_000);
});

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
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

  it('does not steal a lock held by a live process', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-task-store-live-lock-'));
    testDirs.push(projectDir);
    mkdirSync(join(projectDir, '.takt'), { recursive: true });
    const lockFile = join(projectDir, '.takt', 'tasks.yaml.lock');
    writeFileSync(lockFile, `${String(process.pid)}\n`, 'utf-8');

    const store = new TaskStore(projectDir);
    expect(() => store.read()).toThrow(/timed out waiting for lock/);
    expect(existsSync(lockFile)).toBe(true);
  }, 10_000);
});

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GoalStore } from '../infra/goals/store.js';
import { goalId, goalRecord } from './helpers/goal-fixtures.js';

describe('GoalStore process lock', () => {
  it('publishes exactly one complete record when independent processes register the same ID', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-goal-process-'));
    const releaseFile = join(cwd, 'release');
    const workers = ['0', '1', '2'].map((workerId) => {
      const readyFile = join(cwd, `ready-${workerId}`);
      const child = spawn(process.execPath, [
        join(process.cwd(), 'node_modules', 'vite-node', 'vite-node.mjs'),
        '--config', 'src/__tests__/helpers/vite-node.config.ts',
        'src/__tests__/fixtures/goal-store-concurrent-create.ts',
        cwd, workerId, readyFile, releaseFile,
      ], {
        cwd: process.cwd(),
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const result = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
        let stdout = '';
        let stderr = '';
        const timeout = setTimeout(() => child.kill('SIGKILL'), 15_000);
        child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
        child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
        child.once('error', (error) => {
          clearTimeout(timeout);
          resolve({ code: -1, stdout, stderr: error.message });
        });
        child.once('close', (code) => {
          clearTimeout(timeout);
          resolve({ code, stdout, stderr });
        });
      });
      return { child, readyFile, result };
    });
    try {
      const deadline = Date.now() + 10_000;
      while (workers.some(({ readyFile }) => !existsSync(readyFile))) {
        if (workers.some(({ child }) => child.exitCode !== null)) {
          const exited = workers.filter(({ child }) => child.exitCode !== null);
          throw new Error(`Goal worker exited before readiness: ${JSON.stringify(await Promise.all(exited.map(({ result }) => result)))}`);
        }
        if (Date.now() >= deadline) throw new Error('Goal workers did not become ready');
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      writeFileSync(releaseFile, 'go');
      const results = await Promise.all(workers.map(({ result }) => result));
      for (const result of results) expect(result.code, result.stderr).toBe(0);
      const outcomes = results.map(({ stdout }) => JSON.parse(stdout) as {
        workerId: string; created: boolean; error?: string;
      });
      const winners = outcomes.filter(({ created }) => created);
      expect(winners).toHaveLength(1);
      expect(outcomes.filter(({ created }) => !created)).toHaveLength(2);
      for (const rejected of outcomes.filter(({ created }) => !created)) {
        expect(rejected.error).toEqual(expect.any(String));
      }
      const expected = { ...goalRecord(), objective: `worker-${winners[0]!.workerId}` };
      expect(JSON.parse(readFileSync(join(cwd, '.takt', 'goals', goalId, 'goal.json'), 'utf-8'))).toEqual(expected);
      expect(await new GoalStore(cwd).get(goalId)).toEqual(expected);
    } finally {
      writeFileSync(releaseFile, 'go');
      for (const { child } of workers) {
        if (child.exitCode === null) child.kill('SIGKILL');
      }
      await Promise.all(workers.map(({ result }) => result));
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 20_000);
});

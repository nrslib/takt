import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createIsolatedEnv,
  updateIsolatedConfig,
  type IsolatedEnv,
} from '../helpers/isolated-env';
import { createTestRepo, type TestRepo } from '../helpers/test-repo';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  intervalMs: number = 100,
): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return true;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs));
  }
  return false;
}

async function waitForClose(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return await new Promise((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      rejectPromise(new Error(`Process did not exit within ${timeoutMs}ms`));
    }, timeoutMs);

    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      resolvePromise({ code, signal });
    });
  });
}

// E2E更新時は docs/testing/e2e.md も更新すること
describe('E2E: Run tasks graceful shutdown on SIGINT (parallel)', () => {
  let isolatedEnv: IsolatedEnv;
  let testRepo: TestRepo;

  beforeEach(() => {
    isolatedEnv = createIsolatedEnv();
    testRepo = createTestRepo();

    updateIsolatedConfig(isolatedEnv.taktDir, {
      provider: 'mock',
      model: 'mock-model',
      concurrency: 2,
      task_poll_interval_ms: 100,
    });
  });

  afterEach(() => {
    try {
      testRepo.cleanup();
    } catch {
      // best-effort
    }
    try {
      isolatedEnv.cleanup();
    } catch {
      // best-effort
    }
  });

  it('should stop scheduling new clone work after SIGINT and exit cleanly', async () => {
    const binPath = resolve(__dirname, '../../bin/takt');
    const piecePath = resolve(__dirname, '../fixtures/pieces/mock-slow-multi-step.yaml');
    const scenarioPath = resolve(__dirname, '../fixtures/scenarios/run-sigint-parallel.json');

    const tasksFile = join(testRepo.path, '.takt', 'tasks.yaml');
    mkdirSync(join(testRepo.path, '.takt'), { recursive: true });

    const now = new Date().toISOString();
    writeFileSync(
      tasksFile,
      [
        'tasks:',
        '  - name: sigint-a',
        '    status: pending',
        '    content: "E2E SIGINT task A"',
        `    piece: "${piecePath}"`,
        '    worktree: true',
        `    created_at: "${now}"`,
        '    started_at: null',
        '    completed_at: null',
        '    owner_pid: null',
        '  - name: sigint-b',
        '    status: pending',
        '    content: "E2E SIGINT task B"',
        `    piece: "${piecePath}"`,
        '    worktree: true',
        `    created_at: "${now}"`,
        '    started_at: null',
        '    completed_at: null',
        '    owner_pid: null',
        '  - name: sigint-c',
        '    status: pending',
        '    content: "E2E SIGINT task C"',
        `    piece: "${piecePath}"`,
        '    worktree: true',
        `    created_at: "${now}"`,
        '    started_at: null',
        '    completed_at: null',
        '    owner_pid: null',
      ].join('\n'),
      'utf-8',
    );

    const child = spawn('node', [binPath, 'run', '--provider', 'mock'], {
      cwd: testRepo.path,
      env: {
        ...isolatedEnv.env,
        TAKT_MOCK_SCENARIO: scenarioPath,
        TAKT_E2E_SELF_SIGINT_ONCE: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    const workersFilled = await waitFor(
      () => stdout.includes('=== Task: sigint-b ==='),
      30_000,
      20,
    );
    expect(workersFilled, `stdout:\n${stdout}\n\nstderr:\n${stderr}`).toBe(true);

    const exit = await waitForClose(child, 60_000);

    expect(
      exit.signal === 'SIGINT' || exit.code === 130 || exit.code === 0,
      `unexpected exit: code=${exit.code}, signal=${exit.signal}`,
    ).toBe(true);
    expect(stdout).not.toContain('=== Task: sigint-c ===');
    expect(stdout).not.toContain('Task "sigint-c" completed');

    const summaryIndex = stdout.lastIndexOf('=== Tasks Summary ===');
    expect(summaryIndex).toBeGreaterThan(-1);

    const afterSummary = stdout.slice(summaryIndex);
    expect(afterSummary).not.toContain('=== Task:');
    expect(afterSummary).not.toContain('=== Running Piece:');
    expect(afterSummary).not.toContain('Creating clone...');

    const finalTasksYaml = readFileSync(tasksFile, 'utf-8');
    expect(finalTasksYaml).toMatch(
      /name: sigint-c[\s\S]*?status: pending/,
    );

    if (stderr.trim().length > 0) {
      expect(stderr).not.toContain('UnhandledPromiseRejection');
    }
  }, 120_000);
});

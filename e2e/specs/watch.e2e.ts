import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { createIsolatedEnv, type IsolatedEnv } from '../helpers/isolated-env';
import { createTestRepo, type TestRepo } from '../helpers/test-repo';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// E2E更新時は docs/testing/e2e.md も更新すること
describe('E2E: Watch tasks (takt watch)', () => {
  let isolatedEnv: IsolatedEnv;
  let testRepo: TestRepo;

  beforeEach(() => {
    isolatedEnv = createIsolatedEnv();
    testRepo = createTestRepo();
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

  it('should execute a task added during watch', async () => {
    const binPath = resolve(__dirname, '../../bin/takt');
    const scenarioPath = resolve(__dirname, '../fixtures/scenarios/execute-done.json');
    const piecePath = resolve(__dirname, '../fixtures/pieces/mock-single-step.yaml');

    const child = spawn('node', [binPath, 'watch', '--provider', 'mock'], {
      cwd: testRepo.path,
      env: {
        ...isolatedEnv.env,
        TAKT_MOCK_SCENARIO: scenarioPath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    const taktDir = join(testRepo.path, '.takt');
    mkdirSync(taktDir, { recursive: true });
    const tasksFile = join(taktDir, 'tasks.yaml');
    const createdAt = new Date().toISOString();
    const taskYaml = [
      'tasks:',
      '  - name: watch-task',
      '    status: pending',
      '    content: "Add a single line \\"watch test\\" to README.md"',
      `    piece: "${piecePath}"`,
      `    created_at: "${createdAt}"`,
      '    started_at: null',
      '    completed_at: null',
    ].join('\n');
    writeFileSync(tasksFile, taskYaml, 'utf-8');

    const completed = await new Promise<boolean>((resolvePromise) => {
      const timeout = setTimeout(() => resolvePromise(false), 240_000);
      const interval = setInterval(() => {
        if (stdout.includes('Task "watch-task" completed')) {
          clearTimeout(timeout);
          clearInterval(interval);
          resolvePromise(true);
        }
      }, 250);
    });

    child.kill('SIGINT');

    await new Promise<void>((resolvePromise) => {
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        resolvePromise();
      }, 30_000);
      child.on('close', () => {
        clearTimeout(timeout);
        resolvePromise();
      });
    });

    expect(completed).toBe(true);
    const tasksRaw = readFileSync(tasksFile, 'utf-8');
    const parsed = parseYaml(tasksRaw) as { tasks?: Array<{ name?: string; status?: string }> };
    const watchTask = parsed.tasks?.find((task) => task.name === 'watch-task');
    expect(watchTask).toBeUndefined();
  }, 240_000);
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
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

    const tasksDir = join(testRepo.path, '.takt', 'tasks');
    mkdirSync(tasksDir, { recursive: true });

    const taskYaml = [
      'task: "Add a single line \\\"watch test\\\" to README.md"',
      `piece: "${piecePath}"`,
    ].join('\n');

    const taskPath = join(tasksDir, 'watch-task.yaml');
    writeFileSync(taskPath, taskYaml, 'utf-8');

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
    expect(existsSync(taskPath)).toBe(false);
  }, 240_000);
});

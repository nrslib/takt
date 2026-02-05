import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIsolatedEnv, type IsolatedEnv } from '../helpers/isolated-env';
import { createTestRepo, type TestRepo } from '../helpers/test-repo';
import { runTakt } from '../helpers/takt-runner';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// E2E更新時は docs/testing/e2e.md も更新すること
describe('E2E: Add task and run (takt add → takt run)', () => {
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

  it('should add a task file and execute it with takt run', () => {
    const piecePath = resolve(__dirname, '../fixtures/pieces/simple.yaml');

    // Step 1: Create a task file in .takt/tasks/ (simulates `takt add`)
    const tasksDir = join(testRepo.path, '.takt', 'tasks');
    mkdirSync(tasksDir, { recursive: true });

    const taskYaml = [
      'task: "Add a single line \\"E2E test passed\\" to README.md"',
      `piece: "${piecePath}"`,
    ].join('\n');
    writeFileSync(join(tasksDir, 'e2e-test-task.yaml'), taskYaml, 'utf-8');

    // Step 2: Run `takt run` to execute the pending task
    const result = runTakt({
      args: ['run'],
      cwd: testRepo.path,
      env: isolatedEnv.env,
      timeout: 240_000,
    });

    // Task should succeed
    expect(result.exitCode).toBe(0);

    // Verify task was picked up and executed
    expect(result.stdout).toContain('e2e-test-task');

    // Verify README.md was modified
    const readmePath = join(testRepo.path, 'README.md');
    expect(existsSync(readmePath)).toBe(true);

    const readme = readFileSync(readmePath, 'utf-8');
    expect(readme).toContain('E2E test passed');

    // Verify task file was moved out of tasks/ (completed or failed)
    expect(existsSync(join(tasksDir, 'e2e-test-task.yaml'))).toBe(false);
  }, 240_000);
});

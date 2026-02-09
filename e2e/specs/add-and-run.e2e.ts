import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
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

    // Step 1: Create a pending task in .takt/tasks.yaml (simulates `takt add`)
    const taktDir = join(testRepo.path, '.takt');
    mkdirSync(taktDir, { recursive: true });
    const tasksFile = join(taktDir, 'tasks.yaml');

    const taskYaml = [
      'tasks:',
      '  - name: e2e-test-task',
      '    status: pending',
      '    content: "Add a single line \\"E2E test passed\\" to README.md"',
      `    piece: "${piecePath}"`,
      `    created_at: "${new Date().toISOString()}"`,
      '    started_at: null',
      '    completed_at: null',
    ].join('\n');
    writeFileSync(tasksFile, taskYaml, 'utf-8');

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

    // Verify task status became completed
    const tasksRaw = readFileSync(tasksFile, 'utf-8');
    const parsed = parseYaml(tasksRaw) as { tasks?: Array<{ name?: string; status?: string }> };
    const executed = parsed.tasks?.find((task) => task.name === 'e2e-test-task');
    expect(executed?.status).toBe('completed');
  }, 240_000);
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import {
  createIsolatedEnv,
  updateIsolatedConfig,
  type IsolatedEnv,
} from '../helpers/isolated-env';
import { createTestRepo, type TestRepo } from '../helpers/test-repo';
import { runTakt } from '../helpers/takt-runner';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// E2E更新時は docs/testing/e2e.md も更新すること
describe('E2E: Add task from GitHub issue (takt add)', () => {
  let isolatedEnv: IsolatedEnv;
  let testRepo: TestRepo;
  let issueNumber: string;

  beforeEach(() => {
    isolatedEnv = createIsolatedEnv();
    testRepo = createTestRepo();

    // Use mock provider to stabilize summarizer
    updateIsolatedConfig(isolatedEnv.taktDir, {
      provider: 'mock',
      model: 'mock-model',
    });

    const createOutput = execFileSync(
      'gh',
      [
        'issue', 'create',
        '--title', 'E2E Add Issue',
        '--body', 'Add task via issue for E2E',
        '--repo', testRepo.repoName,
      ],
      { encoding: 'utf-8' },
    );

    const match = createOutput.match(/\/issues\/(\d+)/);
    if (!match?.[1]) {
      throw new Error(`Failed to extract issue number from: ${createOutput}`);
    }
    issueNumber = match[1];
  });

  afterEach(() => {
    try {
      execFileSync('gh', ['issue', 'close', issueNumber, '--repo', testRepo.repoName], { stdio: 'pipe' });
    } catch {
      // ignore
    }
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

  it('should create a task file from issue reference', () => {
    const scenarioPath = resolve(__dirname, '../fixtures/scenarios/add-task.json');

    const result = runTakt({
      args: ['add', `#${issueNumber}`],
      cwd: testRepo.path,
      env: {
        ...isolatedEnv.env,
        TAKT_MOCK_SCENARIO: scenarioPath,
      },
      input: 'n\n',
      timeout: 240_000,
    });

    expect(result.exitCode).toBe(0);

    const tasksFile = join(testRepo.path, '.takt', 'tasks.yaml');
    const content = readFileSync(tasksFile, 'utf-8');
    const parsed = parseYaml(content) as { tasks?: Array<{ issue?: number; task_dir?: string }> };
    expect(parsed.tasks?.length).toBe(1);
    expect(parsed.tasks?.[0]?.issue).toBe(Number(issueNumber));
    expect(parsed.tasks?.[0]?.task_dir).toBeTypeOf('string');
    const orderPath = join(testRepo.path, String(parsed.tasks?.[0]?.task_dir), 'order.md');
    expect(existsSync(orderPath)).toBe(true);
    expect(readFileSync(orderPath, 'utf-8')).toContain('E2E Add Issue');
  }, 240_000);
});

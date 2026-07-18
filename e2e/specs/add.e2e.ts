import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import {
  createIsolatedEnv,
  updateIsolatedConfig,
  type IsolatedEnv,
} from '../helpers/isolated-env';
import { createOfflineTestRepo, type TestRepo } from '../helpers/test-repo';
import { runTakt } from '../helpers/takt-runner';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ISSUE_NUMBER = '42';

// E2E更新時は docs/testing/e2e.md も更新すること
describe('E2E: Add task from GitHub issue (takt add)', () => {
  let isolatedEnv: IsolatedEnv;
  let testRepo: TestRepo;

  beforeEach(() => {
    isolatedEnv = createIsolatedEnv();
    testRepo = createOfflineTestRepo();

    // Use mock provider to stabilize summarizer
    updateIsolatedConfig(isolatedEnv.taktDir, {
      provider: 'mock',
      model: 'mock-model',
    });

    const fakeBinDir = join(isolatedEnv.taktDir, 'fake-bin');
    const ghPath = join(fakeBinDir, 'gh');
    mkdirSync(fakeBinDir, { recursive: true });
    writeFileSync(ghPath, `#!/bin/sh
if [ "$#" -eq 2 ] && [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  exit 0
fi
if [ "$#" -eq 5 ] \
  && [ "$1" = "issue" ] \
  && [ "$2" = "view" ] \
  && [ "$3" = "${ISSUE_NUMBER}" ] \
  && [ "$4" = "--json" ] \
  && [ "$5" = "number,title,body,labels,comments" ]; then
  printf '%s\n' '{"number":42,"title":"E2E Add Issue","body":"Add task via issue for E2E","labels":[],"comments":[]}'
  exit 0
fi
exit 1
`);
    chmodSync(ghPath, 0o755);
    isolatedEnv.env.PATH = `${fakeBinDir}:${isolatedEnv.env.PATH ?? ''}`;
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

  it('should create a task file from issue reference', () => {
    const scenarioPath = resolve(__dirname, '../fixtures/scenarios/add-task.json');

    const result = runTakt({
      args: ['--workflow', 'default', 'add', `#${ISSUE_NUMBER}`],
      cwd: testRepo.path,
      env: {
        ...isolatedEnv.env,
        TAKT_MOCK_SCENARIO: scenarioPath,
      },
      input: '\n\n\n\nn\n',
      timeout: 240_000,
    });

    expect(result.exitCode).toBe(0);

    const tasksFile = join(testRepo.path, '.takt', 'tasks.yaml');
    const content = readFileSync(tasksFile, 'utf-8');
    const parsed = parseYaml(content) as { tasks?: Array<{ issue?: number; task_dir?: string }> };
    expect(parsed.tasks?.length).toBe(1);
    expect(parsed.tasks?.[0]?.issue).toBe(Number(ISSUE_NUMBER));
    expect(parsed.tasks?.[0]?.task_dir).toBeTypeOf('string');
    const orderPath = join(testRepo.path, String(parsed.tasks?.[0]?.task_dir), 'order.md');
    expect(existsSync(orderPath)).toBe(true);
    expect(readFileSync(orderPath, 'utf-8')).toContain('E2E Add Issue');
  }, 240_000);
});

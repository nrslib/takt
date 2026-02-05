import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIsolatedEnv, type IsolatedEnv } from '../helpers/isolated-env';
import { createTestRepo, type TestRepo } from '../helpers/test-repo';
import { runTakt } from '../helpers/takt-runner';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// E2E更新時は docs/testing/e2e.md も更新すること
describe('E2E: Pipeline mode (--pipeline --auto-pr)', () => {
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

  it('should execute full CI pipeline: branch → piece → commit → push → PR', () => {
    const piecePath = resolve(__dirname, '../fixtures/pieces/simple.yaml');

    const result = runTakt({
      args: [
        '--pipeline',
        '--task', 'Create a file called hello.txt with the content "Hello World"',
        '--piece', piecePath,
        '--auto-pr',
        '--repo', testRepo.repoName,
      ],
      cwd: testRepo.path,
      env: isolatedEnv.env,
      timeout: 240_000,
    });

    // Pipeline should succeed
    expect(result.exitCode).toBe(0);

    // Verify piece completion message
    expect(result.stdout).toContain('completed');

    // Verify PR was created
    expect(result.stdout).toContain('PR created');

    // Verify PR exists on GitHub
    const prList = execFileSync(
      'gh',
      ['pr', 'list', '--repo', testRepo.repoName, '--json', 'title', '--jq', '.[].title'],
      { encoding: 'utf-8' },
    ).trim();
    expect(prList).toBeTruthy();
  }, 240_000);
});

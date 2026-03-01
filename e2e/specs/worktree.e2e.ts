import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIsolatedEnv, type IsolatedEnv } from '../helpers/isolated-env';
import { createTestRepo, type TestRepo } from '../helpers/test-repo';
import { runTakt } from '../helpers/takt-runner';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// E2E更新時は docs/testing/e2e.md も更新すること
describe('E2E: Removed --create-worktree option', () => {
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

  it('should fail fast with migration guidance', () => {
    const piecePath = resolve(__dirname, '../fixtures/pieces/simple.yaml');

    const result = runTakt({
      args: [
        '--task', 'Add a line "worktree test" to README.md',
        '--piece', piecePath,
        '--create-worktree', 'yes',
      ],
      cwd: testRepo.path,
      env: isolatedEnv.env,
      timeout: 240_000,
    });

    expect(result.exitCode).not.toBe(0);
    const combined = result.stdout + result.stderr;
    expect(combined).toContain('--create-worktree has been removed');
  }, 240_000);
});

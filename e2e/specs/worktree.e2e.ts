import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIsolatedEnv, type IsolatedEnv } from '../helpers/isolated-env';
import { createTestRepo, type TestRepo } from '../helpers/test-repo';
import { runTakt } from '../helpers/takt-runner';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// E2E更新時は docs/testing/e2e.md も更新すること
describe('E2E: Worktree/Clone isolation (--create-worktree yes)', () => {
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

  it('should execute task in an isolated worktree/clone', () => {
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

    // Task should succeed
    expect(result.exitCode).toBe(0);
  }, 240_000);
});

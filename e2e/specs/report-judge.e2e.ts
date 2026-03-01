import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIsolatedEnv, type IsolatedEnv } from '../helpers/isolated-env';
import { createTestRepo, type TestRepo } from '../helpers/test-repo';
import { runTakt } from '../helpers/takt-runner';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// E2E更新時は docs/testing/e2e.md も更新すること
describe('E2E: Report + Judge phases (mock)', () => {
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

  it('should complete with report and judge phases using mock scenario', () => {
    const piecePath = resolve(__dirname, '../fixtures/pieces/report-judge.yaml');
    const scenarioPath = resolve(__dirname, '../fixtures/scenarios/report-judge.json');

    const result = runTakt({
      args: [
        '--task', 'Create a short report and finish',
        '--piece', piecePath,
        '--provider', 'mock',
      ],
      cwd: testRepo.path,
      env: {
        ...isolatedEnv.env,
        TAKT_MOCK_SCENARIO: scenarioPath,
      },
      timeout: 240_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Piece completed');
  }, 240_000);
});

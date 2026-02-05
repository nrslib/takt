import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIsolatedEnv, type IsolatedEnv } from '../helpers/isolated-env';
import { createTestRepo, type TestRepo } from '../helpers/test-repo';
import { runTakt } from '../helpers/takt-runner';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// E2E更新時は docs/testing/e2e.md も更新すること
describe('E2E: Multi-step with parallel movements (mock)', () => {
  let isolatedEnv: IsolatedEnv;
  let testRepo: TestRepo;

  const piecePath = resolve(__dirname, '../fixtures/pieces/multi-step-parallel.yaml');

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

  it('should complete plan → review (all approved) → COMPLETE', () => {
    const scenarioPath = resolve(__dirname, '../fixtures/scenarios/multi-step-all-approved.json');

    const result = runTakt({
      args: [
        '--task', 'Implement a feature',
        '--piece', piecePath,
        '--create-worktree', 'no',
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

  it('should complete plan → review (needs_fix) → fix → review (all approved) → COMPLETE', () => {
    const scenarioPath = resolve(__dirname, '../fixtures/scenarios/multi-step-needs-fix.json');

    const result = runTakt({
      args: [
        '--task', 'Implement a feature with issues',
        '--piece', piecePath,
        '--create-worktree', 'no',
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

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIsolatedEnv, type IsolatedEnv } from '../helpers/isolated-env';
import { runTakt } from '../helpers/takt-runner';
import { createLocalRepo, type LocalRepo } from '../helpers/test-repo';
import { readSessionRecords } from '../helpers/session-log';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// E2E更新時は docs/testing/e2e.md も更新すること
describe('E2E: Sequential multi-step session log transitions (mock)', () => {
  let isolatedEnv: IsolatedEnv;
  let repo: LocalRepo;

  beforeEach(() => {
    isolatedEnv = createIsolatedEnv();
    repo = createLocalRepo();
  });

  afterEach(() => {
    try { repo.cleanup(); } catch { /* best-effort */ }
    try { isolatedEnv.cleanup(); } catch { /* best-effort */ }
  });

  it('should record step_complete for both step-1 and step-2', () => {
    const piecePath = resolve(__dirname, '../fixtures/pieces/mock-two-step.yaml');
    const scenarioPath = resolve(__dirname, '../fixtures/scenarios/two-step-done.json');

    const result = runTakt({
      args: [
        '--task', 'Test sequential transitions',
        '--piece', piecePath,
        '--provider', 'mock',
      ],
      cwd: repo.path,
      env: {
        ...isolatedEnv.env,
        TAKT_MOCK_SCENARIO: scenarioPath,
      },
      timeout: 240_000,
    });

    expect(result.exitCode).toBe(0);

    const records = readSessionRecords(repo.path);
    const completedSteps = records
      .filter((r) => r.type === 'step_complete')
      .map((r) => String(r.step));

    expect(completedSteps).toContain('step-1');
    expect(completedSteps).toContain('step-2');
    expect(records.some((r) => r.type === 'piece_complete')).toBe(true);
  }, 240_000);
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createIsolatedEnv,
  updateIsolatedConfig,
  type IsolatedEnv,
} from '../helpers/isolated-env';
import { runTakt } from '../helpers/takt-runner';
import { createLocalRepo, type LocalRepo } from '../helpers/test-repo';
import { readSessionRecords } from '../helpers/session-log';
import { copyWorkflowFixtureToRepo } from '../helpers/local-workflow-fixture';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// E2E更新時は docs/testing/e2e.md も更新すること
describe('E2E: Cycle detection via loop_monitors (mock)', () => {
  let isolatedEnv: IsolatedEnv;
  let repo: LocalRepo;

  beforeEach(() => {
    isolatedEnv = createIsolatedEnv();
    updateIsolatedConfig(isolatedEnv.taktDir, {
      provider: 'mock',
    });
    repo = createLocalRepo();
  });

  afterEach(() => {
    try { repo.cleanup(); } catch { /* best-effort */ }
    try { isolatedEnv.cleanup(); } catch { /* best-effort */ }
  });

  it('should abort when cycle threshold is reached and judge selects ABORT', () => {
    const workflowPath = copyWorkflowFixtureToRepo(
      repo.path,
      resolve(__dirname, '../fixtures/workflows/mock-cycle-detect.yaml'),
    );
    const scenarioPath = resolve(__dirname, '../fixtures/scenarios/cycle-detect-abort.json');

    const result = runTakt({
      args: [
        '--task', 'Test cycle detection abort',
        '--workflow', workflowPath,
        '--provider', 'mock',
      ],
      cwd: repo.path,
      env: {
        ...isolatedEnv.env,
        TAKT_MOCK_SCENARIO: scenarioPath,
      },
      timeout: 240_000,
    });

    expect(result.exitCode).not.toBe(0);

    const records = readSessionRecords(repo.path);
    const judgeStep = records.find((r) => r.type === 'step_complete' && r.step === '_loop_judge_review_fix');
    const abort = records.find((r) => r.type === 'workflow_abort');

    expect(judgeStep).toBeDefined();
    expect(abort).toBeDefined();
  }, 240_000);

  it('should complete when cycle threshold is not reached', () => {
    const workflowPath = copyWorkflowFixtureToRepo(
      repo.path,
      resolve(__dirname, '../fixtures/workflows/mock-cycle-detect.yaml'),
    );
    const scenarioPath = resolve(__dirname, '../fixtures/scenarios/cycle-detect-pass.json');

    const result = runTakt({
      args: [
        '--task', 'Test cycle detection pass',
        '--workflow', workflowPath,
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
    expect(records.some((r) => r.type === 'workflow_complete')).toBe(true);
    expect(records.some((r) => r.type === 'workflow_abort')).toBe(false);
  }, 240_000);
});

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
describe('E2E: Workflow error handling (mock)', () => {
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

  it('should abort when agent returns error status', () => {
    // Given: a workflow and a scenario that returns error status
    const workflowPath = resolve(__dirname, '../fixtures/workflows/mock-no-match.yaml');
    const scenarioPath = resolve(__dirname, '../fixtures/scenarios/no-match.json');

    // When: executing the workflow
    const result = runTakt({
      args: [
        '--task', 'Test error status abort',
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

    // Then: workflow aborts with a non-zero exit code
    expect(result.exitCode).not.toBe(0);
    const combined = result.stdout + result.stderr;
    expect(combined).toMatch(/failed|aborted|error/i);
  }, 240_000);

  it('should abort when max_steps is reached', () => {
    // Given: a workflow with max_steps=2 that loops between step-a and step-b
    const workflowPath = resolve(__dirname, '../fixtures/workflows/mock-max-iter.yaml');
    const scenarioPath = resolve(__dirname, '../fixtures/scenarios/max-iter-loop.json');

    // When: executing the workflow
    const result = runTakt({
      args: [
        '--task', 'Test max steps',
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

    // Then: workflow aborts due to iteration limit
    expect(result.exitCode).not.toBe(0);
    const combined = result.stdout + result.stderr;
    expect(combined).toContain('Workflow aborted after');
  }, 240_000);

  it('should pass previous response between sequential steps', () => {
    // Given: a two-step workflow and a scenario with distinct step outputs
    const workflowPath = resolve(__dirname, '../fixtures/workflows/mock-two-step.yaml');
    const scenarioPath = resolve(__dirname, '../fixtures/scenarios/two-step-done.json');

    // When: executing the workflow
    const result = runTakt({
      args: [
        '--task', 'Test previous response passing',
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

    // Then: workflow completes successfully (both steps execute)
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Workflow completed');
    const records = readSessionRecords(repo.path);
    const step2PhaseStart = records.find((record) =>
      record.type === 'phase_start'
      && record.step === 'step-2'
      && record.phase === 1,
    );
    expect(step2PhaseStart).toBeDefined();
    expect(step2PhaseStart?.instruction).toContain('Step 1 output text completed.');
  }, 240_000);
});

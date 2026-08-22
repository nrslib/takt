import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIsolatedEnv, type IsolatedEnv } from '../helpers/isolated-env';
import { copyWorkflowFixtureToRepo } from '../helpers/local-workflow-fixture';
import { readSessionRecords } from '../helpers/session-log';
import { runTakt } from '../helpers/takt-runner';
import { createLocalRepo, type LocalRepo } from '../helpers/test-repo';

const currentDirectory = dirname(fileURLToPath(import.meta.url));

describe('E2E: workflow_call shared step budget (mock)', () => {
  let isolatedEnv: IsolatedEnv;
  let repo: LocalRepo;
  let standaloneRepo: LocalRepo;

  beforeEach(() => {
    isolatedEnv = createIsolatedEnv();
    repo = createLocalRepo();
    standaloneRepo = createLocalRepo();
  });

  afterEach(() => {
    const cleanupErrors: unknown[] = [];
    for (const cleanup of [
      () => repo.cleanup(),
      () => standaloneRepo.cleanup(),
      () => isolatedEnv.cleanup(),
    ]) {
      try {
        cleanup();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'Failed to clean up workflow-call budget E2E resources');
    }
  });

  it('should complete an extracted subworkflow with the same four-step budget', () => {
    const fixturePath = resolve(
      currentDirectory,
      '../fixtures/workflows/workflow-call-budget/root.yaml',
    );
    const workflowPath = copyWorkflowFixtureToRepo(repo.path, fixturePath);
    copyWorkflowFixtureToRepo(
      repo.path,
      resolve(currentDirectory, '../fixtures/workflows/workflow-call-budget/child.yaml'),
    );
    const standaloneFixturePath = resolve(
      currentDirectory,
      '../fixtures/workflows/workflow-call-budget/standalone.yaml',
    );
    const standaloneWorkflowPath = copyWorkflowFixtureToRepo(
      standaloneRepo.path,
      standaloneFixturePath,
    );
    const scenarioPath = resolve(
      currentDirectory,
      '../fixtures/scenarios/workflow-call-budget.json',
    );

    const extractedResult = runTakt({
      args: [
        '--task',
        'Execute a workflow split into a callable child',
        '--workflow',
        workflowPath,
        '--provider',
        'mock',
      ],
      cwd: repo.path,
      env: {
        ...isolatedEnv.env,
        TAKT_MOCK_SCENARIO: scenarioPath,
      },
      timeout: 240_000,
    });
    const standaloneResult = runTakt({
      args: [
        '--task',
        'Execute the same workflow without a callable child',
        '--workflow',
        standaloneWorkflowPath,
        '--provider',
        'mock',
      ],
      cwd: standaloneRepo.path,
      env: {
        ...isolatedEnv.env,
        TAKT_MOCK_SCENARIO: scenarioPath,
      },
      timeout: 240_000,
    });

    expect(extractedResult.exitCode).toBe(0);
    expect(standaloneResult.exitCode).toBe(0);
    const extractedRecords = readSessionRecords(repo.path);
    const standaloneRecords = readSessionRecords(standaloneRepo.path);
    const extractedSteps = extractedRecords
      .filter((record) => record.type === 'phase_start' && record.phase === 1)
      .map((record) => record.step);
    const standaloneSteps = standaloneRecords
      .filter((record) => record.type === 'phase_start' && record.phase === 1)
      .map((record) => record.step);
    expect(extractedSteps).toEqual(standaloneSteps);
    expect(extractedSteps).toEqual(['plan', 'implement', 'review', 'supervise']);
    expect(extractedRecords.find((record) => record.type === 'workflow_complete')).toEqual(
      expect.objectContaining({ iterations: 4 }),
    );
  }, 240_000);
});

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stringify as stringifyYaml } from 'yaml';
import { createIsolatedEnv, type IsolatedEnv } from '../helpers/isolated-env';
import { copyWorkflowFixtureToRepo } from '../helpers/local-workflow-fixture';
import { formatTaktRunResult, runTakt } from '../helpers/takt-runner';
import { createLocalRepo, type LocalRepo } from '../helpers/test-repo';
import { waitFor } from '../helpers/wait';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function findLoopAnalysisReports(directory: string): string[] {
  if (!existsSync(directory)) {
    return [];
  }
  const reports: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      reports.push(...findLoopAnalysisReports(path));
    } else if (entry.name === 'loop-analysis.md') {
      reports.push(path);
    }
  }
  return reports;
}

// E2E更新時は docs/testing/e2e.md も更新すること
describe('E2E: detached loop analysis worker (mock)', () => {
  let isolatedEnv: IsolatedEnv;
  let repo: LocalRepo;

  beforeEach(() => {
    isolatedEnv = createIsolatedEnv();
    repo = createLocalRepo();
    writeFileSync(
      join(isolatedEnv.taktDir, 'runtime.yaml'),
      stringifyYaml({
        version: 1,
        loop_analysis: {
          enabled: true,
          output: 'file',
        },
      }),
    );
  });

  afterEach(() => {
    try { repo.cleanup(); } catch { /* best-effort */ }
    try { isolatedEnv.cleanup(); } catch { /* best-effort */ }
  });

  it('should save the analysis report after the source CLI process exits', async () => {
    const workflowPath = copyWorkflowFixtureToRepo(
      repo.path,
      resolve(__dirname, '../fixtures/workflows/mock-single-step.yaml'),
    );
    const scenarioPath = resolve(
      __dirname,
      '../fixtures/scenarios/loop-analysis-worker.json',
    );

    const sourceResult = runTakt({
      args: [
        '--task', 'Complete the source workflow',
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

    expect(sourceResult.exitCode, formatTaktRunResult(sourceResult)).toBe(0);

    const runsDirectory = join(repo.path, '.takt', 'runs');
    const reportWasSaved = await waitFor(
      () => findLoopAnalysisReports(runsDirectory).length === 1,
      30_000,
    );
    expect(reportWasSaved).toBe(true);

    const [reportPath] = findLoopAnalysisReports(runsDirectory);
    expect(reportPath).toBeDefined();
    expect(readFileSync(reportPath as string, 'utf-8')).toContain(
      '# Loop Analysis Report',
    );
  }, 240_000);
});

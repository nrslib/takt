import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
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
    let reports: string[] = [];
    const reportWasSaved = await waitFor(
      () => {
        reports = findLoopAnalysisReports(runsDirectory);
        return reports.length === 1;
      },
      30_000,
    );
    expect(reportWasSaved).toBe(true);
    expect(reports).toHaveLength(1);
    const reportPath = reports[0];
    if (reportPath === undefined) {
      throw new Error('Loop analysis report was not found');
    }
    expect(readFileSync(reportPath, 'utf-8')).toContain(
      '# Loop Analysis Report',
    );
  }, 240_000);

  it.each([
    { selection: 'unspecified', assignment: undefined, expectedModel: 'unselected-model' },
    { selection: 'cost', assignment: 'cost', expectedModel: 'analysis-cost-model' },
    { selection: 'empty name', assignment: '', expectedModel: 'analysis-empty-model' },
    { selection: 'spaces name', assignment: '  ', expectedModel: 'analysis-spaces-model' },
  ])('uses the source runtime selection $selection in the analysis worker after the source CLI exits', async ({ assignment, expectedModel }) => {
    writeFileSync(join(isolatedEnv.taktDir, 'config.yaml'), stringifyYaml({
      language: 'en', notification_sound: false,
    }));
    writeFileSync(join(isolatedEnv.taktDir, 'runtime.yaml'), stringifyYaml({
      version: 1,
      companion: { enabled: false },
      loop_analysis: { enabled: true, output: 'file' },
      provider: {
        defaults: { profile: 'base' },
        profiles: {
          base: { provider: 'mock', model: 'unselected-model' },
          cost: { provider: 'mock', model: 'analysis-cost-model' },
          empty: { provider: 'mock', model: 'analysis-empty-model' },
          spaces: { provider: 'mock', model: 'analysis-spaces-model' },
        },
        assignments: {
          cost: { defaults: { profile: 'cost' } },
          '': { defaults: { profile: 'empty' } },
          '  ': { defaults: { profile: 'spaces' } },
        },
      },
    }));
    const workflowPath = copyWorkflowFixtureToRepo(repo.path,
      resolve(__dirname, '../fixtures/workflows/mock-single-step.yaml'));
    const agentsDir = join(repo.path, '.takt', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    const personaPath = join(agentsDir, 'test-coder.md');
    writeFileSync(personaPath, readFileSync(resolve(__dirname, '../fixtures/agents/test-coder.md')));
    const workflow = parseYaml(readFileSync(workflowPath, 'utf8')) as Record<string, unknown>;
    workflow.personas = { 'test-coder': personaPath };
    writeFileSync(workflowPath, stringifyYaml(workflow));
    const callLog = join(repo.path, 'analysis-calls.jsonl');
    const scenarioPath = join(repo.path, 'analysis-scenario.json');
    const scenario = JSON.parse(
      readFileSync(resolve(__dirname, '../fixtures/scenarios/loop-analysis-worker.json'), 'utf8'),
    ) as Array<Record<string, unknown>>;
    scenario[0]!.persona = 'agents/test-coder';
    writeFileSync(scenarioPath, JSON.stringify(scenario));

    const result = runTakt({ injectProvider: false,
      args: [...(assignment === undefined ? [] : ['--runtime-assignment', assignment]),
        '--task', 'Complete the source workflow', '--workflow', workflowPath],
      cwd: repo.path, env: { ...isolatedEnv.env,
        TAKT_MOCK_SCENARIO: scenarioPath,
        TAKT_MOCK_CALL_LOG: callLog,
        TAKT_PROVIDER: undefined, TAKT_MODEL: undefined, TAKT_PROVIDER_OPTIONS: undefined,
      }, timeout: 240_000 });

    expect(result.exitCode, formatTaktRunResult(result)).toBe(0);
    const saved = await waitFor(() => findLoopAnalysisReports(join(repo.path, '.takt', 'runs')).length === 1, 30_000);
    expect(saved).toBe(true);
    const reports = findLoopAnalysisReports(join(repo.path, '.takt', 'runs'));
    expect(reports).toHaveLength(1);
    expect(readFileSync(reports[0]!, 'utf8')).toContain('# Loop Analysis Report');
    const calls = readFileSync(callLog, 'utf8').trim().split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>).filter((call) => call.event === 'start');
    for (const personaName of ['agents/test-coder', 'loop-analyzer', 'loop-analysis-reviewer']) {
      const selectedCalls = calls.filter((call) => call.personaName === personaName);
      expect(selectedCalls.length).toBeGreaterThan(0);
      for (const call of selectedCalls) expect(call).toMatchObject({ provider: 'mock', model: expectedModel });
    }
  }, 240_000);
});

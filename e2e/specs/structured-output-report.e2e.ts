import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import {
  createIsolatedEnv,
  updateIsolatedConfig,
  type IsolatedEnv,
} from '../helpers/isolated-env';
import { runTakt } from '../helpers/takt-runner';
import { createLocalRepo, type LocalRepo } from '../helpers/test-repo';
import { copyWorkflowFixtureToRepo } from '../helpers/local-workflow-fixture';
import { readSessionRecords } from '../helpers/session-log';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PHASE1_STRUCTURED_JSON = '{"status":"COMPLETE"}';

/**
 * E2E: `structured_output` と `output_contracts.report` の併用（issue #1242）。
 *
 * step の structured_output は Phase 1 の遷移判定用、report は Phase 2 の成果物、
 * という役割分担がリリースゲートで恒久的に踏まれるようにする。
 *
 * mock provider は outputSchema を無視して scenario の content をそのまま返すため、
 * この spec は「修正を外すと赤になる」ガードではない（その役割は
 * src/__tests__/report-phase-structured-output-report.test.ts が担う）。ここでは
 * 組合せが実際の CLI 実行で成立すること — report file が Phase 2 の Markdown であり
 * Phase 1 の JSON でないこと、when(structured.<step>.…) の遷移が効くこと — を確認する。
 */
// E2E更新時は docs/testing/e2e.md も更新すること
describe('E2E: structured_output + report output contract (mock)', () => {
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

  it('should write the Phase 2 Markdown report and route on the Phase 1 structured output', () => {
    const workflowPath = copyWorkflowFixtureToRepo(
      repo.path,
      resolve(__dirname, '../fixtures/workflows/structured-output-report.yaml'),
    );
    const schemasDir = join(repo.path, '.takt', 'schemas');
    mkdirSync(schemasDir, { recursive: true });
    copyFileSync(
      resolve(__dirname, '../fixtures/schemas/e2e-researcher-status.json'),
      join(schemasDir, 'e2e-researcher-status.json'),
    );
    const scenarioPath = resolve(__dirname, '../fixtures/scenarios/structured-output-report.json');

    const result = runTakt({
      args: [
        '--task', 'Run the structured_output plus Markdown report reproduction test.',
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

    if (result.exitCode !== 0) {
      console.log('=== STDOUT ===\n', result.stdout);
      console.log('=== STDERR ===\n', result.stderr);
    }
    expect(result.exitCode).toBe(0);

    const runsDir = join(repo.path, '.takt', 'runs');
    const runDirs = readdirSync(runsDir).sort();
    expect(runDirs.length).toBeGreaterThan(0);
    const latestRun = runDirs[runDirs.length - 1]!;
    const reportPath = join(runsDir, latestRun, 'reports', 'repro.md');

    expect(existsSync(reportPath)).toBe(true);
    const report = readFileSync(reportPath, 'utf-8');
    expect(report).not.toContain(PHASE1_STRUCTURED_JSON);

    // Phase 1 の structured output で when(structured.researcher.status == "COMPLETE")
    // （rule index 0）が決定的に一致したこと。when 一致は auto_select として記録される。
    const records = readSessionRecords(repo.path);
    expect(records.find((r) => r.type === 'workflow_complete')).toBeDefined();
    const stepComplete = records.find((r) => r.type === 'step_complete');
    expect(stepComplete).toBeDefined();
    expect(stepComplete?.matchedRuleMethod).toBe('auto_select');
    expect(stepComplete?.matchedRuleIndex).toBe(0);
  }, 240_000);
});

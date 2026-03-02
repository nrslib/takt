import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import {
  createIsolatedEnv,
  updateIsolatedConfig,
  type IsolatedEnv,
} from '../helpers/isolated-env';
import { runTakt } from '../helpers/takt-runner';
import { createLocalRepo, type LocalRepo } from '../helpers/test-repo';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// E2E更新時は docs/testing/e2e.md も更新すること
describe('E2E: Report file output (mock)', () => {
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

  it('should write report file to .takt/runs/*/reports with expected content', () => {
    const piecePath = resolve(__dirname, '../fixtures/pieces/report-judge.yaml');
    const scenarioPath = resolve(__dirname, '../fixtures/scenarios/report-judge.json');

    const result = runTakt({
      args: [
        '--task', 'Test report output',
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

    const runsDir = join(repo.path, '.takt', 'runs');
    expect(existsSync(runsDir)).toBe(true);

    const runDirs = readdirSync(runsDir).sort();
    expect(runDirs.length).toBeGreaterThan(0);

    const latestRun = runDirs[runDirs.length - 1]!;
    const reportPath = join(runsDir, latestRun, 'reports', 'report.md');

    expect(existsSync(reportPath)).toBe(true);
    const report = readFileSync(reportPath, 'utf-8');
    expect(report).toContain('Report summary: OK');
  }, 240_000);
});

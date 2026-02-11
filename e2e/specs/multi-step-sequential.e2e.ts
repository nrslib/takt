import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createIsolatedEnv, type IsolatedEnv } from '../helpers/isolated-env';
import { runTakt } from '../helpers/takt-runner';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function createLocalRepo(): { path: string; cleanup: () => void } {
  const repoPath = mkdtempSync(join(tmpdir(), 'takt-e2e-sequential-step-'));
  execFileSync('git', ['init'], { cwd: repoPath, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoPath, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoPath, stdio: 'pipe' });
  writeFileSync(join(repoPath, 'README.md'), '# test\n');
  execFileSync('git', ['add', '.'], { cwd: repoPath, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repoPath, stdio: 'pipe' });
  return {
    path: repoPath,
    cleanup: () => {
      try { rmSync(repoPath, { recursive: true, force: true }); } catch { /* best-effort */ }
    },
  };
}

function readSessionRecords(repoPath: string): Array<Record<string, unknown>> {
  const runsDir = join(repoPath, '.takt', 'runs');
  const runDirs = readdirSync(runsDir).sort();

  for (const runDir of runDirs) {
    const logsDir = join(runsDir, runDir, 'logs');
    const logFiles = readdirSync(logsDir).filter((file) => file.endsWith('.jsonl'));
    for (const file of logFiles) {
      const content = readFileSync(join(logsDir, file), 'utf-8').trim();
      if (!content) continue;
      const records = content.split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
      if (records[0]?.type === 'piece_start') {
        return records;
      }
    }
  }

  throw new Error('Session NDJSON log not found');
}

// E2E更新時は docs/testing/e2e.md も更新すること
describe('E2E: Sequential multi-step session log transitions (mock)', () => {
  let isolatedEnv: IsolatedEnv;
  let repo: { path: string; cleanup: () => void };

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
        '--create-worktree', 'no',
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

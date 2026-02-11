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
  const repoPath = mkdtempSync(join(tmpdir(), 'takt-e2e-session-log-'));
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
describe('E2E: Session NDJSON log output (mock)', () => {
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

  it('should write piece_start, step_complete, and piece_complete on success', () => {
    const piecePath = resolve(__dirname, '../fixtures/pieces/mock-single-step.yaml');
    const scenarioPath = resolve(__dirname, '../fixtures/scenarios/execute-done.json');

    const result = runTakt({
      args: [
        '--task', 'Test session log success',
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
    expect(records.some((r) => r.type === 'piece_start')).toBe(true);
    expect(records.some((r) => r.type === 'step_complete')).toBe(true);
    expect(records.some((r) => r.type === 'piece_complete')).toBe(true);
  }, 240_000);

  it('should write piece_abort with reason on failure', () => {
    const piecePath = resolve(__dirname, '../fixtures/pieces/mock-no-match.yaml');
    const scenarioPath = resolve(__dirname, '../fixtures/scenarios/no-match.json');

    const result = runTakt({
      args: [
        '--task', 'Test session log abort',
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

    expect(result.exitCode).not.toBe(0);

    const records = readSessionRecords(repo.path);
    const abortRecord = records.find((r) => r.type === 'piece_abort');
    expect(abortRecord).toBeDefined();
    expect(typeof abortRecord?.reason).toBe('string');
    expect((abortRecord?.reason as string).length).toBeGreaterThan(0);
  }, 240_000);
});

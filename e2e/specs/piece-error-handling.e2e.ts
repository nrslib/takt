import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createIsolatedEnv, type IsolatedEnv } from '../helpers/isolated-env';
import { runTakt } from '../helpers/takt-runner';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function createLocalRepo(): { path: string; cleanup: () => void } {
  const repoPath = mkdtempSync(join(tmpdir(), 'takt-e2e-piece-err-'));
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

// E2E更新時は docs/testing/e2e.md も更新すること
describe('E2E: Piece error handling (mock)', () => {
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

  it('should abort when agent returns error status', () => {
    // Given: a piece and a scenario that returns error status
    const piecePath = resolve(__dirname, '../fixtures/pieces/mock-no-match.yaml');
    const scenarioPath = resolve(__dirname, '../fixtures/scenarios/no-match.json');

    // When: executing the piece
    const result = runTakt({
      args: [
        '--task', 'Test error status abort',
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

    // Then: piece aborts with a non-zero exit code
    expect(result.exitCode).not.toBe(0);
    const combined = result.stdout + result.stderr;
    expect(combined).toMatch(/failed|aborted|error/i);
  }, 240_000);

  it('should abort when max_movements is reached', () => {
    // Given: a piece with max_movements=2 that loops between step-a and step-b
    const piecePath = resolve(__dirname, '../fixtures/pieces/mock-max-iter.yaml');
    const scenarioPath = resolve(__dirname, '../fixtures/scenarios/max-iter-loop.json');

    // When: executing the piece
    const result = runTakt({
      args: [
        '--task', 'Test max movements',
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

    // Then: piece aborts due to iteration limit
    expect(result.exitCode).not.toBe(0);
    const combined = result.stdout + result.stderr;
    expect(combined).toMatch(/Max movements|iteration|aborted/i);
  }, 240_000);

  it('should pass previous response between sequential steps', () => {
    // Given: a two-step piece and a scenario with distinct step outputs
    const piecePath = resolve(__dirname, '../fixtures/pieces/mock-two-step.yaml');
    const scenarioPath = resolve(__dirname, '../fixtures/scenarios/two-step-done.json');

    // When: executing the piece
    const result = runTakt({
      args: [
        '--task', 'Test previous response passing',
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

    // Then: piece completes successfully (both steps execute)
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Piece completed');
  }, 240_000);
});

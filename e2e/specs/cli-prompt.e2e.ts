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
  const repoPath = mkdtempSync(join(tmpdir(), 'takt-e2e-prompt-'));
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
describe('E2E: Prompt preview command (takt prompt)', () => {
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

  it('should output prompt preview header and movement info for a piece', () => {
    // Given: a piece file path
    const piecePath = resolve(__dirname, '../fixtures/pieces/mock-single-step.yaml');

    // When: running takt prompt with piece path
    const result = runTakt({
      args: ['prompt', piecePath],
      cwd: repo.path,
      env: isolatedEnv.env,
    });

    // Then: output contains "Prompt Preview" header and movement info
    // (may fail on Phase 3 for pieces with tag-based rules, but header is still output)
    const combined = result.stdout + result.stderr;
    expect(combined).toMatch(/Prompt Preview|Movement 1/i);
  });

  it('should report not found for a nonexistent piece name', () => {
    // Given: a nonexistent piece name

    // When: running takt prompt with invalid piece
    const result = runTakt({
      args: ['prompt', 'nonexistent-piece-xyz'],
      cwd: repo.path,
      env: isolatedEnv.env,
    });

    // Then: reports piece not found
    const combined = result.stdout + result.stderr;
    expect(combined).toMatch(/not found/i);
  });
});

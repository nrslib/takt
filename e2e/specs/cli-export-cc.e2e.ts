import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createIsolatedEnv, type IsolatedEnv } from '../helpers/isolated-env';
import { runTakt } from '../helpers/takt-runner';

function createLocalRepo(): { path: string; cleanup: () => void } {
  const repoPath = mkdtempSync(join(tmpdir(), 'takt-e2e-export-cc-'));
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
describe('E2E: Export-cc command (takt export-cc)', () => {
  let isolatedEnv: IsolatedEnv;
  let repo: { path: string; cleanup: () => void };
  let fakeHome: string;

  beforeEach(() => {
    isolatedEnv = createIsolatedEnv();
    repo = createLocalRepo();
    fakeHome = mkdtempSync(join(tmpdir(), 'takt-e2e-export-cc-home-'));
  });

  afterEach(() => {
    try { repo.cleanup(); } catch { /* best-effort */ }
    try { isolatedEnv.cleanup(); } catch { /* best-effort */ }
    try { rmSync(fakeHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('should deploy skill files to isolated home directory', () => {
    // Given: a local repo with isolated env and HOME redirected to fakeHome
    const env: NodeJS.ProcessEnv = { ...isolatedEnv.env, HOME: fakeHome };

    // When: running takt export-cc
    const result = runTakt({
      args: ['export-cc'],
      cwd: repo.path,
      env,
    });

    // Then: exits successfully and outputs deploy message
    expect(result.exitCode).toBe(0);
    const output = result.stdout;
    expect(output).toMatch(/ファイルをデプロイしました/);

    // Then: SKILL.md exists in the skill directory
    const skillMdPath = join(fakeHome, '.claude', 'skills', 'takt', 'SKILL.md');
    expect(existsSync(skillMdPath)).toBe(true);
  });

  it('should deploy resource directories', () => {
    // Given: a local repo with isolated env and HOME redirected to fakeHome
    const env: NodeJS.ProcessEnv = { ...isolatedEnv.env, HOME: fakeHome };

    // When: running takt export-cc
    runTakt({
      args: ['export-cc'],
      cwd: repo.path,
      env,
    });

    // Then: pieces/ and personas/ directories exist with at least one file each
    const skillDir = join(fakeHome, '.claude', 'skills', 'takt');

    const piecesDir = join(skillDir, 'pieces');
    expect(existsSync(piecesDir)).toBe(true);
    const pieceFiles = readdirSync(piecesDir);
    expect(pieceFiles.length).toBeGreaterThan(0);

    const personasDir = join(skillDir, 'personas');
    expect(existsSync(personasDir)).toBe(true);
    const personaFiles = readdirSync(personasDir);
    expect(personaFiles.length).toBeGreaterThan(0);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createIsolatedEnv, type IsolatedEnv } from '../helpers/isolated-env';
import { runTakt } from '../helpers/takt-runner';

/**
 * Create a minimal local git repository for eject tests.
 * No GitHub access needed — just a local git init.
 */
function createLocalRepo(): { path: string; cleanup: () => void } {
  const repoPath = mkdtempSync(join(tmpdir(), 'takt-eject-e2e-'));
  execFileSync('git', ['init'], { cwd: repoPath, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoPath, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoPath, stdio: 'pipe' });
  // Create initial commit so branch exists
  writeFileSync(join(repoPath, 'README.md'), '# test\n');
  execFileSync('git', ['add', '.'], { cwd: repoPath, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repoPath, stdio: 'pipe' });
  return {
    path: repoPath,
    cleanup: () => {
      try {
        rmSync(repoPath, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    },
  };
}

// E2E更新時は docs/testing/e2e.md も更新すること
describe('E2E: Eject builtin pieces (takt eject)', () => {
  let isolatedEnv: IsolatedEnv;
  let repo: { path: string; cleanup: () => void };

  beforeEach(() => {
    isolatedEnv = createIsolatedEnv();
    repo = createLocalRepo();
  });

  afterEach(() => {
    try {
      repo.cleanup();
    } catch {
      // best-effort
    }
    try {
      isolatedEnv.cleanup();
    } catch {
      // best-effort
    }
  });

  it('should list available builtin pieces when no name given', () => {
    const result = runTakt({
      args: ['eject'],
      cwd: repo.path,
      env: isolatedEnv.env,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('default');
    expect(result.stdout).toContain('Available builtin pieces');
  });

  it('should eject piece to project .takt/ by default', () => {
    const result = runTakt({
      args: ['eject', 'default'],
      cwd: repo.path,
      env: isolatedEnv.env,
    });

    expect(result.exitCode).toBe(0);

    // Piece YAML should be in project .takt/pieces/
    const piecePath = join(repo.path, '.takt', 'pieces', 'default.yaml');
    expect(existsSync(piecePath)).toBe(true);

    // Agents should be in project .takt/agents/
    const agentsDir = join(repo.path, '.takt', 'agents', 'default');
    expect(existsSync(agentsDir)).toBe(true);
    expect(existsSync(join(agentsDir, 'coder.md'))).toBe(true);
    expect(existsSync(join(agentsDir, 'planner.md'))).toBe(true);
  });

  it('should preserve relative agent paths in ejected piece (no rewriting)', () => {
    runTakt({
      args: ['eject', 'default'],
      cwd: repo.path,
      env: isolatedEnv.env,
    });

    const piecePath = join(repo.path, '.takt', 'pieces', 'default.yaml');
    const content = readFileSync(piecePath, 'utf-8');

    // Relative paths should be preserved as ../agents/
    expect(content).toContain('agent: ../agents/default/');
    // Should NOT contain rewritten absolute paths
    expect(content).not.toContain('agent: ~/.takt/agents/');
  });

  it('should eject piece to global ~/.takt/ with --global flag', () => {
    const result = runTakt({
      args: ['eject', 'default', '--global'],
      cwd: repo.path,
      env: isolatedEnv.env,
    });

    expect(result.exitCode).toBe(0);

    // Piece YAML should be in global dir (TAKT_CONFIG_DIR from isolated env)
    const piecePath = join(isolatedEnv.taktDir, 'pieces', 'default.yaml');
    expect(existsSync(piecePath)).toBe(true);

    // Agents should be in global agents dir
    const agentsDir = join(isolatedEnv.taktDir, 'agents', 'default');
    expect(existsSync(agentsDir)).toBe(true);
    expect(existsSync(join(agentsDir, 'coder.md'))).toBe(true);

    // Should NOT be in project dir
    const projectPiecePath = join(repo.path, '.takt', 'pieces', 'default.yaml');
    expect(existsSync(projectPiecePath)).toBe(false);
  });

  it('should warn and skip when piece already exists', () => {
    // First eject
    runTakt({
      args: ['eject', 'default'],
      cwd: repo.path,
      env: isolatedEnv.env,
    });

    // Second eject — should skip
    const result = runTakt({
      args: ['eject', 'default'],
      cwd: repo.path,
      env: isolatedEnv.env,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('already exists');
  });

  it('should report error for non-existent builtin', () => {
    const result = runTakt({
      args: ['eject', 'nonexistent-piece-xyz'],
      cwd: repo.path,
      env: isolatedEnv.env,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('not found');
  });

  it('should correctly eject agents for pieces with unique agents', () => {
    const result = runTakt({
      args: ['eject', 'magi'],
      cwd: repo.path,
      env: isolatedEnv.env,
    });

    expect(result.exitCode).toBe(0);

    // MAGI piece should have its own agents
    const magiDir = join(repo.path, '.takt', 'agents', 'magi');
    expect(existsSync(join(magiDir, 'melchior.md'))).toBe(true);
    expect(existsSync(join(magiDir, 'balthasar.md'))).toBe(true);
    expect(existsSync(join(magiDir, 'casper.md'))).toBe(true);

    // Should NOT have default agents mixed in
    expect(existsSync(join(repo.path, '.takt', 'agents', 'default'))).toBe(false);
  });

  it('should preserve relative paths for global eject too', () => {
    runTakt({
      args: ['eject', 'magi', '--global'],
      cwd: repo.path,
      env: isolatedEnv.env,
    });

    const piecePath = join(isolatedEnv.taktDir, 'pieces', 'magi.yaml');
    const content = readFileSync(piecePath, 'utf-8');

    expect(content).toContain('agent: ../agents/magi/');
    expect(content).not.toContain('agent: ~/.takt/agents/');
  });
});

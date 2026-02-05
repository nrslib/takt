import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createIsolatedEnv, type IsolatedEnv } from '../helpers/isolated-env';
import { createTestRepo, type TestRepo } from '../helpers/test-repo';
import { runTakt } from '../helpers/takt-runner';

// E2E更新時は docs/testing/e2e.md も更新すること
describe('E2E: List tasks non-interactive (takt list)', () => {
  let isolatedEnv: IsolatedEnv;
  let testRepo: TestRepo;

  beforeEach(() => {
    isolatedEnv = createIsolatedEnv();
    testRepo = createTestRepo();
  });

  afterEach(() => {
    try {
      testRepo.cleanup();
    } catch {
      // best-effort
    }
    try {
      isolatedEnv.cleanup();
    } catch {
      // best-effort
    }
  });

  it('should show diff for a takt branch in non-interactive mode', () => {
    const branchName = 'takt/e2e-list-diff';

    execFileSync('git', ['checkout', '-b', branchName], { cwd: testRepo.path, stdio: 'pipe' });
    writeFileSync(join(testRepo.path, 'LIST_DIFF.txt'), 'diff e2e', 'utf-8');
    execFileSync('git', ['add', 'LIST_DIFF.txt'], { cwd: testRepo.path, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'takt: list diff e2e'], { cwd: testRepo.path, stdio: 'pipe' });
    execFileSync('git', ['checkout', testRepo.branch], { cwd: testRepo.path, stdio: 'pipe' });

    const result = runTakt({
      args: ['list', '--non-interactive', '--action', 'diff', '--branch', branchName],
      cwd: testRepo.path,
      env: isolatedEnv.env,
      timeout: 240_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('LIST_DIFF.txt');
  }, 240_000);

  it('should try-merge a takt branch in non-interactive mode', () => {
    const branchName = 'takt/e2e-list-try';

    execFileSync('git', ['checkout', '-b', branchName], { cwd: testRepo.path, stdio: 'pipe' });
    writeFileSync(join(testRepo.path, 'LIST_TRY.txt'), 'try e2e', 'utf-8');
    execFileSync('git', ['add', 'LIST_TRY.txt'], { cwd: testRepo.path, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'takt: list try e2e'], { cwd: testRepo.path, stdio: 'pipe' });
    execFileSync('git', ['checkout', testRepo.branch], { cwd: testRepo.path, stdio: 'pipe' });

    const result = runTakt({
      args: ['list', '--non-interactive', '--action', 'try', '--branch', branchName],
      cwd: testRepo.path,
      env: isolatedEnv.env,
      timeout: 240_000,
    });

    expect(result.exitCode).toBe(0);

    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd: testRepo.path,
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    expect(status).toContain('LIST_TRY.txt');
  }, 240_000);

  it('should merge a takt branch in non-interactive mode', () => {
    const branchName = 'takt/e2e-list-merge';

    execFileSync('git', ['checkout', '-b', branchName], { cwd: testRepo.path, stdio: 'pipe' });
    writeFileSync(join(testRepo.path, 'LIST_MERGE.txt'), 'merge e2e', 'utf-8');
    execFileSync('git', ['add', 'LIST_MERGE.txt'], { cwd: testRepo.path, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'takt: list merge e2e'], { cwd: testRepo.path, stdio: 'pipe' });
    execFileSync('git', ['checkout', testRepo.branch], { cwd: testRepo.path, stdio: 'pipe' });

    const result = runTakt({
      args: ['list', '--non-interactive', '--action', 'merge', '--branch', branchName],
      cwd: testRepo.path,
      env: isolatedEnv.env,
      timeout: 240_000,
    });

    expect(result.exitCode).toBe(0);

    const merged = execFileSync('git', ['branch', '--list', branchName], {
      cwd: testRepo.path,
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim();
    expect(merged).toBe('');
  }, 240_000);

  it('should delete a takt branch in non-interactive mode', () => {
    const branchName = 'takt/e2e-list-test';

    execFileSync('git', ['checkout', '-b', branchName], { cwd: testRepo.path, stdio: 'pipe' });
    writeFileSync(join(testRepo.path, 'LIST_E2E.txt'), 'list e2e', 'utf-8');
    execFileSync('git', ['add', 'LIST_E2E.txt'], { cwd: testRepo.path, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'takt: list e2e'], { cwd: testRepo.path, stdio: 'pipe' });
    execFileSync('git', ['checkout', testRepo.branch], { cwd: testRepo.path, stdio: 'pipe' });

    const result = runTakt({
      args: ['list', '--non-interactive', '--action', 'delete', '--branch', branchName, '--yes'],
      cwd: testRepo.path,
      env: isolatedEnv.env,
      timeout: 240_000,
    });

    expect(result.exitCode).toBe(0);

    const remaining = execFileSync('git', ['branch', '--list', branchName], {
      cwd: testRepo.path,
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim();
    expect(remaining).toBe('');
  }, 240_000);
});

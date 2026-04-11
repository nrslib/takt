import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { createIsolatedEnv, type IsolatedEnv } from '../helpers/isolated-env';
import { createTestRepo, type TestRepo } from '../helpers/test-repo';
import { runTakt } from '../helpers/takt-runner';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MOCK_PIECE_PATH = resolve(__dirname, '../fixtures/pieces/mock-single-step.yaml');
const MOCK_SCENARIO_PATH = resolve(__dirname, '../fixtures/scenarios/execute-done.json');

interface CompletedTaskMeta {
  status?: string;
  branch?: string;
  worktree_path?: string;
}

function writeCompletedTask(repoPath: string, name: string, branch: string): void {
  const taktDir = join(repoPath, '.takt');
  mkdirSync(taktDir, { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(
    join(taktDir, 'tasks.yaml'),
    [
      'tasks:',
      `  - name: ${name}`,
      '    status: completed',
      `    content: "E2E test task for ${name}"`,
      `    branch: "${branch}"`,
      `    created_at: "${now}"`,
      `    started_at: "${now}"`,
      `    completed_at: "${now}"`,
    ].join('\n'),
    'utf-8',
  );
}

function writePendingWorktreeTask(repoPath: string, name: string, content: string): void {
  const taktDir = join(repoPath, '.takt');
  mkdirSync(taktDir, { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(
    join(taktDir, 'tasks.yaml'),
    [
      'tasks:',
      `  - name: ${name}`,
      '    status: pending',
      `    content: "${content.replaceAll('"', '\\"')}"`,
      `    piece: "${MOCK_PIECE_PATH}"`,
      '    worktree: true',
      `    created_at: "${now}"`,
      '    started_at: null',
      '    completed_at: null',
    ].join('\n'),
    'utf-8',
  );
}

function readTaskMeta(repoPath: string, name: string): CompletedTaskMeta {
  const raw = readFileSync(join(repoPath, '.takt', 'tasks.yaml'), 'utf-8');
  const parsed = parseYaml(raw) as { tasks?: CompletedTaskMeta[] & Array<{ name?: string }> };
  return parsed.tasks?.find(task => task.name === name) ?? {};
}

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

    writeCompletedTask(testRepo.path, 'e2e-list-diff', branchName);

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

    writeCompletedTask(testRepo.path, 'e2e-list-try', branchName);

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

    writeCompletedTask(testRepo.path, 'e2e-list-merge', branchName);

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

    writeCompletedTask(testRepo.path, 'e2e-list-test', branchName);

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

  it('should create a completed worktree task via mock run and try-merge it', () => {
    const taskName = 'e2e-run-try-merge';
    writePendingWorktreeTask(
      testRepo.path,
      taskName,
      'Add a single line "E2E try merge passed" to README.md',
    );

    const runResult = runTakt({
      args: ['run', '--provider', 'mock'],
      cwd: testRepo.path,
      env: { ...isolatedEnv.env, TAKT_MOCK_SCENARIO: MOCK_SCENARIO_PATH },
      timeout: 240_000,
    });

    expect(runResult.exitCode).toBe(0);

    const taskMeta = readTaskMeta(testRepo.path, taskName);
    expect(taskMeta.status).toBe('completed');
    expect(taskMeta.branch).toMatch(/^takt\//);
    expect(taskMeta.worktree_path).toBeTruthy();

    const rootBranch = execFileSync('git', ['branch', '--list', taskMeta.branch!], {
      cwd: testRepo.path,
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim();
    expect(rootBranch).toContain(taskMeta.branch!);
    execFileSync('git', ['branch', '-D', taskMeta.branch!], {
      cwd: testRepo.path,
      stdio: 'pipe',
    });

    const result = runTakt({
      args: ['list', '--non-interactive', '--action', 'try', '--branch', taskMeta.branch!],
      cwd: testRepo.path,
      env: isolatedEnv.env,
      timeout: 240_000,
    });

    expect(result.exitCode).toBe(0);

    const stagedFiles = execFileSync('git', ['diff', '--cached', '--name-only'], {
      cwd: testRepo.path,
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    const restoredBranch = execFileSync('git', ['branch', '--list', taskMeta.branch!], {
      cwd: testRepo.path,
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim();
    expect(restoredBranch).toContain(taskMeta.branch!);
    expect(stagedFiles.trim()).not.toBe('');
  }, 240_000);

  it('should create a completed worktree task via mock run and merge from root', () => {
    const taskName = 'e2e-run-sync';
    writePendingWorktreeTask(
      testRepo.path,
      taskName,
      'Add a single line "E2E sync passed" to README.md',
    );

    const runResult = runTakt({
      args: ['run', '--provider', 'mock'],
      cwd: testRepo.path,
      env: { ...isolatedEnv.env, TAKT_MOCK_SCENARIO: MOCK_SCENARIO_PATH },
      timeout: 240_000,
    });

    expect(runResult.exitCode).toBe(0);

    const taskMeta = readTaskMeta(testRepo.path, taskName);
    expect(taskMeta.status).toBe('completed');
    expect(taskMeta.branch).toMatch(/^takt\//);
    expect(taskMeta.worktree_path).toBeTruthy();

    writeFileSync(join(testRepo.path, 'ROOT_SYNC.txt'), 'sync from root\n', 'utf-8');
    execFileSync('git', ['add', 'ROOT_SYNC.txt'], { cwd: testRepo.path, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'root sync source'], { cwd: testRepo.path, stdio: 'pipe' });

    const result = runTakt({
      args: ['list', '--non-interactive', '--action', 'sync', '--branch', taskMeta.branch!],
      cwd: testRepo.path,
      env: isolatedEnv.env,
      timeout: 240_000,
    });

    expect(result.exitCode).toBe(0);

    const syncedFile = execFileSync('git', ['show', `${taskMeta.branch!}:ROOT_SYNC.txt`], {
      cwd: testRepo.path,
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    expect(syncedFile).toContain('sync from root');

    const worktreeFile = readFileSync(join(taskMeta.worktree_path!, 'ROOT_SYNC.txt'), 'utf-8');
    expect(worktreeFile).toContain('sync from root');
  }, 240_000);
});

/**
 * Integration test for stageAndCommit and .takt/.gitignore semantics
 *
 * Tests that gitignored files are NOT included in commits.
 * Regression test for c89ac4c where `git add -f .takt/runs/` caused
 * gitignored report files to be committed.
 *
 * Also verifies that .takt/.gitignore patterns correctly track facet directories
 * (workflows, personas, policies, knowledge, instructions, output-contracts)
 * while ignoring runtime directories (tasks, logs, runs, completed, .runtime).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { stageAndCommit } from '../infra/task/git.js';
import { getProjectWorkflowsDir, getProjectFacetDir } from '../infra/config/paths.js';
import { VALID_FACET_TYPES, parseFacetType } from '../features/config/facetTypes.js';
import { ensureWorktreeTaktRuntimeProtection } from '../infra/task/projectLocalTaktSync.js';

const dotgitignorePath = join(__dirname, '..', '..', 'builtins', 'project', 'dotgitignore');

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `takt-stage-commit-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });

  execFileSync('git', ['init'], { cwd: testDir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: testDir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: testDir });

  // Initial commit
  writeFileSync(join(testDir, 'README.md'), '# Test');
  execFileSync('git', ['add', '.'], { cwd: testDir });
  execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: testDir });
});

afterEach(() => {
  vi.unstubAllEnvs();
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
});

describe('stageAndCommit', () => {
  it('should not commit gitignored .takt/runs/ files', async () => {
    // Setup: .takt/ is gitignored
    writeFileSync(join(testDir, '.gitignore'), '.takt/\n');
    execFileSync('git', ['add', '.gitignore'], { cwd: testDir });
    execFileSync('git', ['commit', '-m', 'Add gitignore'], { cwd: testDir });

    // Create .takt/runs/ with a report file
    mkdirSync(join(testDir, '.takt', 'runs', 'test-report', 'reports'), { recursive: true });
    writeFileSync(join(testDir, '.takt', 'runs', 'test-report', 'reports', '00-plan.md'), '# Plan');

    // Also create a tracked file change to ensure commit happens
    writeFileSync(join(testDir, 'src.ts'), 'export const x = 1;');

    const hash = await stageAndCommit(testDir, 'test commit');
    expect(hash).toBeDefined();

    // Verify .takt/runs/ is NOT in the commit
    const committedFiles = execFileSync('git', ['diff-tree', '--no-commit-id', '-r', '--name-only', 'HEAD'], {
      cwd: testDir,
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim();

    expect(committedFiles).toContain('src.ts');
    expect(committedFiles).not.toContain('.takt/runs/');
  });

  it('should commit normally when no gitignored files exist', async () => {
    writeFileSync(join(testDir, 'app.ts'), 'console.log("hello");');

    const hash = await stageAndCommit(testDir, 'add app');
    expect(hash).toBeDefined();

    const committedFiles = execFileSync('git', ['diff-tree', '--no-commit-id', '-r', '--name-only', 'HEAD'], {
      cwd: testDir,
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim();

    expect(committedFiles).toBe('app.ts');
  });

  it('should use the cwd repository when inherited Git repository variables point to a decoy', async () => {
    const decoyDir = mkdtempSync(join(tmpdir(), 'takt-stage-commit-decoy-'));
    try {
      execFileSync('git', ['init'], { cwd: decoyDir });
      execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: decoyDir });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: decoyDir });
      writeFileSync(join(decoyDir, 'README.md'), '# Decoy');
      execFileSync('git', ['add', '.'], { cwd: decoyDir });
      execFileSync('git', ['commit', '-m', 'Decoy baseline'], { cwd: decoyDir });
      const decoyHead = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: decoyDir,
        encoding: 'utf-8',
      }).trim();

      execFileSync('git', ['config', '--local', 'filter.observer.clean', 'false'], { cwd: testDir });
      execFileSync('git', ['config', '--local', 'filter.observer.required', 'true'], { cwd: testDir });
      writeFileSync(join(testDir, '.gitattributes'), 'app.ts filter=observer\n');
      writeFileSync(join(testDir, 'app.ts'), 'export const target = true;');

      const decoyGitDir = join(decoyDir, '.git');
      vi.stubEnv('GIT_DIR', decoyGitDir);
      vi.stubEnv('GIT_WORK_TREE', decoyDir);
      vi.stubEnv('GIT_COMMON_DIR', decoyGitDir);
      vi.stubEnv('GIT_INDEX_FILE', join(decoyGitDir, 'index'));

      let hash: string | undefined;
      try {
        hash = await stageAndCommit(testDir, 'commit target repository');
      } finally {
        vi.unstubAllEnvs();
      }

      expect(hash).toBeDefined();
      expect(execFileSync('git', ['show', '--format=', '--name-only', 'HEAD'], {
        cwd: testDir,
        encoding: 'utf-8',
      })).toContain('app.ts');
      expect(execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: decoyDir,
        encoding: 'utf-8',
      }).trim()).toBe(decoyHead);
    } finally {
      rmSync(decoyDir, { recursive: true, force: true });
    }
  });

  it('should commit .takt/.gitignore while leaving runtime artifacts uncommitted', async () => {
    const dotgitignore = readFileSync(dotgitignorePath, 'utf-8');
    mkdirSync(join(testDir, '.takt', '.runtime', 'tmp'), { recursive: true });
    mkdirSync(join(testDir, '.takt', 'runs', 'test-run', 'reports'), { recursive: true });
    writeFileSync(join(testDir, '.takt', '.gitignore'), dotgitignore, 'utf-8');
    writeFileSync(join(testDir, '.takt', '.runtime', 'tmp', 'cache.txt'), 'cache', 'utf-8');
    writeFileSync(join(testDir, '.takt', 'runs', 'test-run', 'reports', 'test-report.md'), '# Report', 'utf-8');
    writeFileSync(join(testDir, 'src.ts'), 'export const x = 1;', 'utf-8');

    const hash = await stageAndCommit(testDir, 'add worktree gitignore');
    expect(hash).toBeDefined();

    const committedFiles = execFileSync('git', ['diff-tree', '--no-commit-id', '-r', '--name-only', 'HEAD'], {
      cwd: testDir,
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim().split('\n').filter(Boolean).sort();

    expect(committedFiles).toContain('.takt/.gitignore');
    expect(committedFiles).toContain('src.ts');
    expect(committedFiles).not.toContain('.takt/.runtime/tmp/cache.txt');
    expect(committedFiles).not.toContain('.takt/runs/test-run/reports/test-report.md');
  });

  it('should return undefined when there are no changes', async () => {
    const hash = await stageAndCommit(testDir, 'empty');
    expect(hash).toBeUndefined();
  });
});

describe('dotgitignore patterns', () => {
  function gitTrackedFiles(cwd: string): string[] {
    const output = execFileSync('git', ['ls-files', '.takt/'], { cwd, encoding: 'utf-8' });
    return output.trim().split('\n').filter(Boolean).sort();
  }

  beforeEach(() => {
    // Copy actual dotgitignore as .takt/.gitignore
    const taktDir = join(testDir, '.takt');
    mkdirSync(taktDir, { recursive: true });
    const content = readFileSync(dotgitignorePath, 'utf-8');
    writeFileSync(join(taktDir, '.gitignore'), content);
  });

  it('should track config.yaml', () => {
    writeFileSync(join(testDir, '.takt', 'config.yaml'), 'language: ja\n');
    execFileSync('git', ['add', '.takt/'], { cwd: testDir });

    const tracked = gitTrackedFiles(testDir);
    expect(tracked).toContain('.takt/config.yaml');
  });

  it('should track facet directories', () => {
    // workflows directory
    const workflowsDir = getProjectWorkflowsDir(testDir);
    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(join(workflowsDir, 'test.md'), '# workflows');

    // facet type directories — derived from VALID_FACET_TYPES
    for (const singular of VALID_FACET_TYPES) {
      const facetType = parseFacetType(singular)!;
      const facetDir = getProjectFacetDir(testDir, facetType);
      mkdirSync(facetDir, { recursive: true });
      writeFileSync(join(facetDir, 'test.md'), `# ${facetType}`);
    }

    execFileSync('git', ['add', '.takt/'], { cwd: testDir });
    const tracked = gitTrackedFiles(testDir);

    // Assert workflows tracked
    expect(tracked).toContain('.takt/workflows/test.md');

    // Assert all facet types tracked
    for (const singular of VALID_FACET_TYPES) {
      const facetType = parseFacetType(singular)!;
      expect(tracked).toContain(`.takt/facets/${facetType}/test.md`);
    }
  });

  it('should track nested files in facet directories', () => {
    const subDir = join(getProjectWorkflowsDir(testDir), 'sub');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, 'nested.yaml'), 'name: test');

    execFileSync('git', ['add', '.takt/'], { cwd: testDir });
    const tracked = gitTrackedFiles(testDir);

    expect(tracked).toContain('.takt/workflows/sub/nested.yaml');
  });

  it('should ignore runtime directories', () => {
    const runtimeDirs = ['tasks', 'completed', 'logs', 'runs', '.runtime'];
    for (const dir of runtimeDirs) {
      mkdirSync(join(testDir, '.takt', dir), { recursive: true });
      writeFileSync(join(testDir, '.takt', dir, 'data.json'), '{}');
    }

    execFileSync('git', ['add', '.takt/'], { cwd: testDir });
    const tracked = gitTrackedFiles(testDir);

    for (const dir of runtimeDirs) {
      const runtimeFiles = tracked.filter(f => f.startsWith(`.takt/${dir}/`));
      expect(runtimeFiles).toEqual([]);
    }
  });

  it('should preserve run logs from git clean after tracked .takt/.gitignore is removed', () => {
    execFileSync('git', ['add', '.takt/.gitignore'], { cwd: testDir });
    execFileSync('git', ['commit', '-m', 'Track takt gitignore'], { cwd: testDir });
    ensureWorktreeTaktRuntimeProtection(testDir);

    const logPath = join(testDir, '.takt', 'runs', 'active-run', 'logs', 'session.jsonl');
    mkdirSync(dirname(logPath), { recursive: true });
    writeFileSync(logPath, '{"type":"workflow_start"}\n', 'utf-8');

    execFileSync('git', ['rm', '.takt/.gitignore'], { cwd: testDir });
    execFileSync('git', ['clean', '-fd'], { cwd: testDir });

    expect(existsSync(join(testDir, '.takt', '.gitignore'))).toBe(false);
    expect(readFileSync(logPath, 'utf-8')).toBe('{"type":"workflow_start"}\n');
    const ignoreSource = execFileSync('git', ['check-ignore', '-v', '.takt/runs/active-run/logs/session.jsonl'], {
      cwd: testDir,
      encoding: 'utf-8',
    });
    expect(ignoreSource).toContain('.git/info/exclude');
  });

  it('should skip git exclude protection when the worktree has no .git', () => {
    const noGitDir = join(testDir, 'no-git-worktree');
    mkdirSync(noGitDir, { recursive: true });

    expect(() => ensureWorktreeTaktRuntimeProtection(noGitDir)).not.toThrow();

    expect(existsSync(join(noGitDir, '.takt', '.gitignore'))).toBe(true);
    expect(existsSync(join(noGitDir, '.git'))).toBe(false);
    const parentExclude = join(testDir, '.git', 'info', 'exclude');
    const parentExcludeContent = existsSync(parentExclude) ? readFileSync(parentExclude, 'utf-8') : '';
    expect(parentExcludeContent).not.toContain('/.takt/runs/');
  });
});

import { describe, it, expect, afterEach } from 'vitest';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ensureWorktreeTaktGitignore, syncProjectLocalTaktForRetry } from '../infra/task/projectLocalTaktSync.js';

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function readBuiltinProjectDotgitignore(): string {
  return readFileSync(join(__dirname, '..', '..', 'builtins', 'project', 'dotgitignore'), 'utf-8');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('syncProjectLocalTaktForRetry', () => {
  it('should sync .takt/quality-gates along with config.yaml for retry worktrees', () => {
    const projectDir = createTempDir('takt-sync-project-');
    const worktreePath = createTempDir('takt-sync-worktree-');
    mkdirSync(join(projectDir, '.takt', 'quality-gates'), { recursive: true });
    mkdirSync(join(worktreePath, '.takt'), { recursive: true });
    writeFileSync(join(projectDir, '.takt', 'config.yaml'), 'workflow_overrides: {}\n', 'utf-8');
    writeFileSync(
      join(projectDir, '.takt', 'quality-gates', 'check.sh'),
      '#!/usr/bin/env bash\nnpm test\n',
      'utf-8',
    );

    syncProjectLocalTaktForRetry(projectDir, worktreePath);

    expect(readFileSync(join(worktreePath, '.takt', 'config.yaml'), 'utf-8')).toBe('workflow_overrides: {}\n');
    expect(readFileSync(join(worktreePath, '.takt', 'quality-gates', 'check.sh'), 'utf-8')).toBe(
      '#!/usr/bin/env bash\nnpm test\n',
    );
  });

  it('should create worktree .takt/.gitignore during retry sync', () => {
    const projectDir = createTempDir('takt-sync-project-');
    const worktreePath = createTempDir('takt-sync-worktree-');
    mkdirSync(join(projectDir, '.takt'), { recursive: true });

    syncProjectLocalTaktForRetry(projectDir, worktreePath);

    expect(readFileSync(join(worktreePath, '.takt', '.gitignore'), 'utf-8')).toBe(readBuiltinProjectDotgitignore());
  });

  it('should preserve existing worktree .takt/.gitignore during retry sync', () => {
    const projectDir = createTempDir('takt-sync-project-');
    const worktreePath = createTempDir('takt-sync-worktree-');
    const existing = '# custom ignore\nruns/\n';
    mkdirSync(join(projectDir, '.takt'), { recursive: true });
    mkdirSync(join(worktreePath, '.takt'), { recursive: true });
    writeFileSync(join(worktreePath, '.takt', '.gitignore'), existing, 'utf-8');

    syncProjectLocalTaktForRetry(projectDir, worktreePath);

    expect(readFileSync(join(worktreePath, '.takt', '.gitignore'), 'utf-8')).toBe(existing);
  });

  it('should fail before creating worktree .takt/.gitignore when project .takt is a file', () => {
    const projectDir = createTempDir('takt-sync-project-');
    const worktreePath = createTempDir('takt-sync-worktree-');
    const sourceTaktPath = join(projectDir, '.takt');
    const targetTaktPath = join(worktreePath, '.takt');
    const targetGitignorePath = join(worktreePath, '.takt', '.gitignore');
    writeFileSync(sourceTaktPath, 'not a directory\n', 'utf-8');

    expect(() => syncProjectLocalTaktForRetry(projectDir, worktreePath)).toThrow(
      `Project-local .takt must be a directory: ${sourceTaktPath}`,
    );

    expect(existsSync(targetTaktPath)).toBe(false);
    expect(existsSync(targetGitignorePath)).toBe(false);
  });

  it('should remove stale quality-gates directory when the project no longer has one', () => {
    const projectDir = createTempDir('takt-sync-project-');
    const worktreePath = createTempDir('takt-sync-worktree-');
    mkdirSync(join(projectDir, '.takt'), { recursive: true });
    mkdirSync(join(worktreePath, '.takt', 'quality-gates'), { recursive: true });
    writeFileSync(join(worktreePath, '.takt', 'quality-gates', 'stale.sh'), 'exit 1\n', 'utf-8');

    syncProjectLocalTaktForRetry(projectDir, worktreePath);

    expect(existsSync(join(worktreePath, '.takt', 'quality-gates'))).toBe(false);
  });

  it('should not sync generated quality gate logs into retry worktrees', () => {
    const projectDir = createTempDir('takt-sync-project-');
    const worktreePath = createTempDir('takt-sync-worktree-');
    mkdirSync(join(projectDir, '.takt', 'quality-gates', 'logs'), { recursive: true });
    mkdirSync(join(worktreePath, '.takt', 'quality-gates', 'logs'), { recursive: true });
    writeFileSync(join(projectDir, '.takt', 'quality-gates', 'check.sh'), '#!/usr/bin/env bash\nexit 0\n', 'utf-8');
    writeFileSync(join(projectDir, '.takt', 'quality-gates', 'logs', 'source.log'), 'source output\n', 'utf-8');
    writeFileSync(join(worktreePath, '.takt', 'quality-gates', 'logs', 'stale.log'), 'stale output\n', 'utf-8');

    syncProjectLocalTaktForRetry(projectDir, worktreePath);

    expect(readFileSync(join(worktreePath, '.takt', 'quality-gates', 'check.sh'), 'utf-8')).toBe(
      '#!/usr/bin/env bash\nexit 0\n',
    );
    expect(existsSync(join(worktreePath, '.takt', 'quality-gates', 'logs'))).toBe(false);
  });
});

describe('ensureWorktreeTaktGitignore', () => {
  it('Given a worktree without .takt/.gitignore, When ensuring takt gitignore, Then built-in project gitignore is created', () => {
    const worktreePath = createTempDir('takt-gitignore-worktree-');

    ensureWorktreeTaktGitignore(worktreePath);

    expect(readFileSync(join(worktreePath, '.takt', '.gitignore'), 'utf-8')).toBe(readBuiltinProjectDotgitignore());
  });

  it('Given a worktree with existing .takt/.gitignore, When ensuring takt gitignore, Then existing content is preserved', () => {
    const worktreePath = createTempDir('takt-gitignore-worktree-');
    const taktDir = join(worktreePath, '.takt');
    const existing = '# custom ignore\nruns/\n';
    mkdirSync(taktDir, { recursive: true });
    writeFileSync(join(taktDir, '.gitignore'), existing, 'utf-8');

    ensureWorktreeTaktGitignore(worktreePath);

    expect(readFileSync(join(taktDir, '.gitignore'), 'utf-8')).toBe(existing);
  });

  it('Given a missing worktree path, When ensuring takt gitignore, Then it fails before creating files', () => {
    const parentDir = createTempDir('takt-gitignore-parent-');
    const missingWorktreePath = join(parentDir, 'missing-worktree');

    expect(() => ensureWorktreeTaktGitignore(missingWorktreePath)).toThrow(
      `Worktree path must be an existing directory: ${missingWorktreePath}`,
    );
    expect(existsSync(missingWorktreePath)).toBe(false);
  });

  it('Given .takt is a file, When ensuring takt gitignore, Then it fails without replacing it', () => {
    const worktreePath = createTempDir('takt-gitignore-worktree-');
    const taktPath = join(worktreePath, '.takt');
    writeFileSync(taktPath, 'not a directory\n', 'utf-8');

    expect(() => ensureWorktreeTaktGitignore(worktreePath)).toThrow(
      `Worktree .takt must be a directory or missing: ${taktPath}`,
    );

    expect(readFileSync(taktPath, 'utf-8')).toBe('not a directory\n');
  });

  it('Given .takt is a symlink, When ensuring takt gitignore, Then it fails without replacing it', () => {
    const worktreePath = createTempDir('takt-gitignore-worktree-');
    const outsideDir = createTempDir('takt-gitignore-outside-');
    const taktPath = join(worktreePath, '.takt');
    symlinkSync(outsideDir, taktPath);

    expect(() => ensureWorktreeTaktGitignore(worktreePath)).toThrow(
      `Worktree .takt must be a directory or missing: ${taktPath}`,
    );

    expect(lstatSync(taktPath).isSymbolicLink()).toBe(true);
  });

  it('Given a broken .takt/.gitignore symlink, When ensuring takt gitignore, Then it does not write outside the worktree', () => {
    const worktreePath = createTempDir('takt-gitignore-worktree-');
    const outsideDir = createTempDir('takt-gitignore-outside-');
    const taktDir = join(worktreePath, '.takt');
    const gitignorePath = join(taktDir, '.gitignore');
    const externalTarget = join(outsideDir, 'created-through-symlink');
    mkdirSync(taktDir, { recursive: true });
    symlinkSync(externalTarget, gitignorePath);

    expect(() => ensureWorktreeTaktGitignore(worktreePath)).toThrow(
      `Worktree .takt/.gitignore must be a regular file or missing: ${gitignorePath}`,
    );

    expect(existsSync(externalTarget)).toBe(false);
    expect(lstatSync(gitignorePath).isSymbolicLink()).toBe(true);
  });

  it('Given .takt/.gitignore is a directory, When ensuring takt gitignore, Then it fails without replacing it', () => {
    const worktreePath = createTempDir('takt-gitignore-worktree-');
    const taktDir = join(worktreePath, '.takt');
    const gitignorePath = join(taktDir, '.gitignore');
    mkdirSync(gitignorePath, { recursive: true });

    expect(() => ensureWorktreeTaktGitignore(worktreePath)).toThrow(
      `Worktree .takt/.gitignore must be a regular file or missing: ${gitignorePath}`,
    );

    expect(lstatSync(gitignorePath).isDirectory()).toBe(true);
  });

  it('Given .takt/.gitignore cannot be inspected, When ensuring takt gitignore, Then it fails without creating a partial file', () => {
    const worktreePath = createTempDir('takt-gitignore-worktree-');
    const taktDir = join(worktreePath, '.takt');
    const gitignorePath = join(taktDir, '.gitignore');
    mkdirSync(taktDir, { recursive: true });
    chmodSync(taktDir, 0o000);

    let thrown: unknown;
    try {
      ensureWorktreeTaktGitignore(worktreePath);
    } catch (error: unknown) {
      thrown = error;
    } finally {
      chmodSync(taktDir, 0o700);
    }

    expect((thrown as NodeJS.ErrnoException).code).toMatch(/^(EACCES|EPERM)$/);
    expect(existsSync(gitignorePath)).toBe(false);
  });
});

import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { syncProjectLocalTaktForRetry } from '../infra/task/projectLocalTaktSync.js';

describe('syncProjectLocalTaktForRetry', () => {
  const tempDirs: string[] = [];

  function createTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

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

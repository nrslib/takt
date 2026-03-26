import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { buildCandidateDirsWithPackage } = await import('../infra/config/loaders/resource-resolver.js');

describe('project config dir collision in resource-resolver', () => {
  let projectDir: string;
  let realGlobalDir: string;
  let originalTaktConfigDir: string | undefined;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'takt-resource-collision-'));
    realGlobalDir = mkdtempSync(join(tmpdir(), 'takt-resource-global-'));
    originalTaktConfigDir = process.env.TAKT_CONFIG_DIR;
    symlinkSync(realGlobalDir, join(projectDir, '.takt'));
    process.env.TAKT_CONFIG_DIR = realGlobalDir;
    mkdirSync(join(realGlobalDir, 'facets', 'personas'), { recursive: true });
  });

  afterEach(() => {
    if (originalTaktConfigDir === undefined) {
      delete process.env.TAKT_CONFIG_DIR;
    } else {
      process.env.TAKT_CONFIG_DIR = originalTaktConfigDir;
    }
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('should exclude the project facet dir when project and global config dirs collide', () => {
    const candidateDirs = buildCandidateDirsWithPackage('personas', {
      projectDir,
      lang: 'ja',
    });

    expect(candidateDirs).not.toContain(join(projectDir, '.takt', 'facets', 'personas'));
    expect(candidateDirs).toContain(join(realGlobalDir, 'facets', 'personas'));
  });

  it('should keep package-local, user, and builtin layers when collision happens for a package piece', () => {
    const repertoireDir = join(projectDir, '.takt', 'repertoire');
    const pieceDir = join(repertoireDir, '@nrslib', 'takt-example', 'pieces');

    const candidateDirs = buildCandidateDirsWithPackage('personas', {
      projectDir,
      lang: 'ja',
      pieceDir,
      repertoireDir,
    });

    expect(candidateDirs).toEqual([
      join(repertoireDir, '@nrslib', 'takt-example', 'facets', 'personas'),
      join(realGlobalDir, 'facets', 'personas'),
      expect.stringContaining('builtins/ja/facets/personas'),
    ]);
  });
});

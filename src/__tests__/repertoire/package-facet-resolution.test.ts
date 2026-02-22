/**
 * Tests for package-local facet resolution chain.
 *
 * Covers:
 * - isPackagePiece(): detects if pieceDir is under ~/.takt/repertoire/@owner/repo/pieces/
 * - getPackageFromPieceDir(): extracts @owner/repo from pieceDir path
 * - Package pieces use 4-layer chain: package-local → project → user → builtin
 * - Non-package pieces use 3-layer chain: project → user → builtin
 * - Package-local resolution hits before project-level
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  isPackagePiece,
  getPackageFromPieceDir,
  buildCandidateDirsWithPackage,
} from '../../infra/config/loaders/resource-resolver.js';

// ---------------------------------------------------------------------------
// isPackagePiece
// ---------------------------------------------------------------------------

describe('isPackagePiece', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-pkg-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should return true when pieceDir is under repertoire/@owner/repo/pieces/', () => {
    // Given: pieceDir under the repertoire directory structure
    const repertoireDir = join(tempDir, 'repertoire');
    const pieceDir = join(repertoireDir, '@nrslib', 'takt-fullstack', 'pieces');

    // When: checking if it is a package piece
    const result = isPackagePiece(pieceDir, repertoireDir);

    // Then: it is recognized as a package piece
    expect(result).toBe(true);
  });

  it('should return false when pieceDir is under user global pieces directory', () => {
    // Given: pieceDir in ~/.takt/pieces/ (not repertoire)
    const globalPiecesDir = join(tempDir, 'pieces');
    mkdirSync(globalPiecesDir, { recursive: true });

    const repertoireDir = join(tempDir, 'repertoire');

    // When: checking
    const result = isPackagePiece(globalPiecesDir, repertoireDir);

    // Then: not a package piece
    expect(result).toBe(false);
  });

  it('should return false when pieceDir is in project .takt/pieces/', () => {
    // Given: project-level pieces directory
    const projectPiecesDir = join(tempDir, '.takt', 'pieces');
    mkdirSync(projectPiecesDir, { recursive: true });

    const repertoireDir = join(tempDir, 'repertoire');

    // When: checking
    const result = isPackagePiece(projectPiecesDir, repertoireDir);

    // Then: not a package piece
    expect(result).toBe(false);
  });

  it('should return false when pieceDir is in builtin directory', () => {
    // Given: builtin pieces directory
    const builtinPiecesDir = join(tempDir, 'builtins', 'ja', 'pieces');
    mkdirSync(builtinPiecesDir, { recursive: true });

    const repertoireDir = join(tempDir, 'repertoire');

    // When: checking
    const result = isPackagePiece(builtinPiecesDir, repertoireDir);

    // Then: not a package piece
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getPackageFromPieceDir
// ---------------------------------------------------------------------------

describe('getPackageFromPieceDir', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-getpkg-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should extract owner and repo from repertoire pieceDir', () => {
    // Given: pieceDir under repertoire
    const repertoireDir = join(tempDir, 'repertoire');
    const pieceDir = join(repertoireDir, '@nrslib', 'takt-fullstack', 'pieces');

    // When: package is extracted
    const pkg = getPackageFromPieceDir(pieceDir, repertoireDir);

    // Then: owner and repo are correct
    expect(pkg).not.toBeUndefined();
    expect(pkg!.owner).toBe('nrslib');
    expect(pkg!.repo).toBe('takt-fullstack');
  });

  it('should return undefined for non-package pieceDir', () => {
    // Given: pieceDir not under repertoire
    const pieceDir = join(tempDir, 'pieces');
    const repertoireDir = join(tempDir, 'repertoire');

    // When: package is extracted
    const pkg = getPackageFromPieceDir(pieceDir, repertoireDir);

    // Then: undefined (not a package piece)
    expect(pkg).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// buildCandidateDirsWithPackage
// ---------------------------------------------------------------------------

describe('buildCandidateDirsWithPackage', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-candidates-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should include package-local dir as first candidate for package piece', () => {
    // Given: a package piece context
    const repertoireDir = join(tempDir, 'repertoire');
    const pieceDir = join(repertoireDir, '@nrslib', 'takt-fullstack', 'pieces');
    const projectDir = join(tempDir, 'project');
    const context = { projectDir, lang: 'ja' as const, pieceDir, repertoireDir };

    // When: candidate directories are built
    const dirs = buildCandidateDirsWithPackage('personas', context);

    // Then: package-local dir is first
    const expectedPackageLocal = join(repertoireDir, '@nrslib', 'takt-fullstack', 'facets', 'personas');
    expect(dirs[0]).toBe(expectedPackageLocal);
  });

  it('should have 4 candidate dirs for package piece: package-local, project, user, builtin', () => {
    // Given: package piece context
    const repertoireDir = join(tempDir, 'repertoire');
    const pieceDir = join(repertoireDir, '@nrslib', 'takt-fullstack', 'pieces');
    const projectDir = join(tempDir, 'project');
    const context = { projectDir, lang: 'ja' as const, pieceDir, repertoireDir };

    // When: candidate directories are built
    const dirs = buildCandidateDirsWithPackage('personas', context);

    // Then: 4 layers (package-local, project, user, builtin)
    expect(dirs).toHaveLength(4);
  });

  it('should have 3 candidate dirs for non-package piece: project, user, builtin', () => {
    // Given: non-package piece context (no repertoire path)
    const projectDir = join(tempDir, 'project');
    const userPiecesDir = join(tempDir, 'pieces');
    const context = {
      projectDir,
      lang: 'ja' as const,
      pieceDir: userPiecesDir,
      repertoireDir: join(tempDir, 'repertoire'),
    };

    // When: candidate directories are built
    const dirs = buildCandidateDirsWithPackage('personas', context);

    // Then: 3 layers (project, user, builtin)
    expect(dirs).toHaveLength(3);
  });

  it('should resolve package-local facet before project-level for package piece', () => {
    // Given: both package-local and project-level facet files exist
    const repertoireDir = join(tempDir, 'repertoire');
    const pkgFacetDir = join(repertoireDir, '@nrslib', 'takt-fullstack', 'facets', 'personas');
    mkdirSync(pkgFacetDir, { recursive: true });
    writeFileSync(join(pkgFacetDir, 'expert-coder.md'), 'Package persona');

    const projectDir = join(tempDir, 'project');
    const projectFacetDir = join(projectDir, '.takt', 'facets', 'personas');
    mkdirSync(projectFacetDir, { recursive: true });
    writeFileSync(join(projectFacetDir, 'expert-coder.md'), 'Project persona');

    const pieceDir = join(repertoireDir, '@nrslib', 'takt-fullstack', 'pieces');
    const context = { projectDir, lang: 'ja' as const, pieceDir, repertoireDir };

    // When: candidate directories are built
    const dirs = buildCandidateDirsWithPackage('personas', context);

    // Then: package-local dir comes before project dir
    const pkgLocalIdx = dirs.indexOf(pkgFacetDir);
    const projectIdx = dirs.indexOf(projectFacetDir);
    expect(pkgLocalIdx).toBeLessThan(projectIdx);
  });
});

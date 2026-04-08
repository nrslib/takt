/**
 * Tests for package-local facet resolution chain.
 *
 * Covers:
 * - isPackageWorkflow(): detects if workflowDir is under ~/.takt/repertoire/@owner/repo/workflows/
 * - getPackageFromWorkflowDir(): extracts @owner/repo from workflowDir path
 * - Package workflows use 4-layer chain: package-local → project → user → builtin
 * - Non-package workflows use 3-layer chain: project → user → builtin
 * - Package-local resolution hits before project-level
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  isPackageWorkflow,
  getPackageFromWorkflowDir,
  buildCandidateDirsWithPackage,
} from '../../infra/config/loaders/workflowPackageScope.js';

// ---------------------------------------------------------------------------
// isPackageWorkflow
// ---------------------------------------------------------------------------

describe('isPackageWorkflow', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-pkg-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should return true when workflowDir is under repertoire/@owner/repo/workflows/', () => {
    // Given: workflowDir under the repertoire directory structure
    const repertoireDir = join(tempDir, 'repertoire');
    const workflowDir = join(repertoireDir, '@nrslib', 'takt-fullstack', 'workflows');

    // When: checking if it is a package workflow
    const result = isPackageWorkflow(workflowDir, repertoireDir);

    // Then: it is recognized as a package workflow
    expect(result).toBe(true);
  });

  it('should return false when workflowDir is under user global workflows directory', () => {
    // Given: workflowDir in ~/.takt/workflows/ (not repertoire)
    const globalWorkflowsDir = join(tempDir, 'workflows');
    mkdirSync(globalWorkflowsDir, { recursive: true });

    const repertoireDir = join(tempDir, 'repertoire');

    // When: checking
    const result = isPackageWorkflow(globalWorkflowsDir, repertoireDir);

    // Then: not a package workflow
    expect(result).toBe(false);
  });

  it('should return false when workflowDir is in project .takt/workflows/', () => {
    // Given: project-level workflows directory
    const projectWorkflowsDir = join(tempDir, '.takt', 'workflows');
    mkdirSync(projectWorkflowsDir, { recursive: true });

    const repertoireDir = join(tempDir, 'repertoire');

    // When: checking
    const result = isPackageWorkflow(projectWorkflowsDir, repertoireDir);

    // Then: not a package workflow
    expect(result).toBe(false);
  });

  it('should return false when workflowDir is in builtin directory', () => {
    // Given: builtin workflows directory
    const builtinWorkflowsDir = join(tempDir, 'builtins', 'ja', 'workflows');
    mkdirSync(builtinWorkflowsDir, { recursive: true });

    const repertoireDir = join(tempDir, 'repertoire');

    // When: checking
    const result = isPackageWorkflow(builtinWorkflowsDir, repertoireDir);

    // Then: not a package workflow
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getPackageFromWorkflowDir
// ---------------------------------------------------------------------------

describe('getPackageFromWorkflowDir', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-getpkg-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should extract owner and repo from repertoire workflowDir', () => {
    // Given: workflowDir under repertoire
    const repertoireDir = join(tempDir, 'repertoire');
    const workflowDir = join(repertoireDir, '@nrslib', 'takt-fullstack', 'workflows');

    // When: package is extracted
    const pkg = getPackageFromWorkflowDir(workflowDir, repertoireDir);

    // Then: owner and repo are correct
    expect(pkg).not.toBeUndefined();
    expect(pkg!.owner).toBe('nrslib');
    expect(pkg!.repo).toBe('takt-fullstack');
  });

  it('should return undefined for non-package workflowDir', () => {
    // Given: workflowDir not under repertoire
    const workflowDir = join(tempDir, 'workflows');
    const repertoireDir = join(tempDir, 'repertoire');

    // When: package is extracted
    const pkg = getPackageFromWorkflowDir(workflowDir, repertoireDir);

    // Then: undefined (not a package workflow)
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

  it('should include package-local dir as first candidate for package workflow', () => {
    // Given: a package workflow context
    const repertoireDir = join(tempDir, 'repertoire');
    const workflowDir = join(repertoireDir, '@nrslib', 'takt-fullstack', 'workflows');
    const projectDir = join(tempDir, 'project');
    const context = { projectDir, lang: 'ja' as const, workflowDir, repertoireDir };

    // When: candidate directories are built
    const dirs = buildCandidateDirsWithPackage('personas', context);

    // Then: package-local dir is first
    const expectedPackageLocal = join(repertoireDir, '@nrslib', 'takt-fullstack', 'facets', 'personas');
    expect(dirs[0]).toBe(expectedPackageLocal);
  });

  it('should have 4 candidate dirs for package workflow: package-local, project, user, builtin', () => {
    // Given: package workflow context
    const repertoireDir = join(tempDir, 'repertoire');
    const workflowDir = join(repertoireDir, '@nrslib', 'takt-fullstack', 'workflows');
    const projectDir = join(tempDir, 'project');
    const context = { projectDir, lang: 'ja' as const, workflowDir, repertoireDir };

    // When: candidate directories are built
    const dirs = buildCandidateDirsWithPackage('personas', context);

    // Then: 4 layers (package-local, project, user, builtin)
    expect(dirs).toHaveLength(4);
  });

  it('should have 3 candidate dirs for non-package workflow: project, user, builtin', () => {
    // Given: non-package workflow context (no repertoire path)
    const projectDir = join(tempDir, 'project');
    const userWorkflowsDir = join(tempDir, 'workflows');
    const context = {
      projectDir,
      lang: 'ja' as const,
      workflowDir: userWorkflowsDir,
      repertoireDir: join(tempDir, 'repertoire'),
    };

    // When: candidate directories are built
    const dirs = buildCandidateDirsWithPackage('personas', context);

    // Then: 3 layers (project, user, builtin)
    expect(dirs).toHaveLength(3);
  });

  it('should resolve package-local facet before project-level for package workflow', () => {
    // Given: both package-local and project-level facet files exist
    const repertoireDir = join(tempDir, 'repertoire');
    const pkgFacetDir = join(repertoireDir, '@nrslib', 'takt-fullstack', 'facets', 'personas');
    mkdirSync(pkgFacetDir, { recursive: true });
    writeFileSync(join(pkgFacetDir, 'expert-coder.md'), 'Package persona');

    const projectDir = join(tempDir, 'project');
    const projectFacetDir = join(projectDir, '.takt', 'facets', 'personas');
    mkdirSync(projectFacetDir, { recursive: true });
    writeFileSync(join(projectFacetDir, 'expert-coder.md'), 'Project persona');

    const workflowDir = join(repertoireDir, '@nrslib', 'takt-fullstack', 'workflows');
    const context = { projectDir, lang: 'ja' as const, workflowDir, repertoireDir };

    // When: candidate directories are built
    const dirs = buildCandidateDirsWithPackage('personas', context);

    // Then: package-local dir comes before project dir
    const pkgLocalIdx = dirs.indexOf(pkgFacetDir);
    const projectIdx = dirs.indexOf(projectFacetDir);
    expect(pkgLocalIdx).toBeLessThan(projectIdx);
  });
});

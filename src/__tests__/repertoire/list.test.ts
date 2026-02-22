/**
 * Tests for repertoire list display data retrieval.
 *
 * Covers:
 * - readPackageInfo(): reads description from takt-repertoire.yaml and ref/commit from .takt-repertoire-lock.yaml
 * - commit is truncated to first 7 characters for display
 * - listPackages(): enumerates all installed packages under repertoire/
 * - Multiple packages are correctly listed
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  readPackageInfo,
  listPackages,
} from '../../features/repertoire/list.js';

// ---------------------------------------------------------------------------
// readPackageInfo
// ---------------------------------------------------------------------------

describe('readPackageInfo', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-list-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should read description from takt-repertoire.yaml', () => {
    // Given: a package directory with takt-repertoire.yaml and .takt-repertoire-lock.yaml
    const packageDir = join(tempDir, '@nrslib', 'takt-fullstack');
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(
      join(packageDir, 'takt-repertoire.yaml'),
      'description: フルスタック開発ワークフロー\n',
    );
    writeFileSync(
      join(packageDir, '.takt-repertoire-lock.yaml'),
      `source: github:nrslib/takt-fullstack
ref: v1.2.0
commit: abc1234def5678
imported_at: 2026-02-20T12:00:00.000Z
`,
    );

    // When: package info is read
    const info = readPackageInfo(packageDir, '@nrslib/takt-fullstack');

    // Then: description, ref, and truncated commit are returned
    expect(info.scope).toBe('@nrslib/takt-fullstack');
    expect(info.description).toBe('フルスタック開発ワークフロー');
    expect(info.ref).toBe('v1.2.0');
    expect(info.commit).toBe('abc1234'); // first 7 chars
  });

  it('should truncate commit SHA to first 7 characters', () => {
    // Given: package with a long commit SHA
    const packageDir = join(tempDir, '@nrslib', 'takt-security-facets');
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, 'takt-repertoire.yaml'), 'description: Security facets\n');
    writeFileSync(
      join(packageDir, '.takt-repertoire-lock.yaml'),
      `source: github:nrslib/takt-security-facets
ref: HEAD
commit: def5678901234567
imported_at: 2026-02-20T12:00:00.000Z
`,
    );

    // When: package info is read
    const info = readPackageInfo(packageDir, '@nrslib/takt-security-facets');

    // Then: commit is 7 chars
    expect(info.commit).toBe('def5678');
    expect(info.commit).toHaveLength(7);
  });

  it('should handle package without description field', () => {
    // Given: takt-repertoire.yaml with no description
    const packageDir = join(tempDir, '@acme', 'takt-backend');
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, 'takt-repertoire.yaml'), 'path: takt\n');
    writeFileSync(
      join(packageDir, '.takt-repertoire-lock.yaml'),
      `source: github:acme/takt-backend
ref: v2.0.0
commit: 789abcdef0123
imported_at: 2026-01-15T08:30:00.000Z
`,
    );

    // When: package info is read
    const info = readPackageInfo(packageDir, '@acme/takt-backend');

    // Then: description is undefined (not present)
    expect(info.description).toBeUndefined();
    expect(info.ref).toBe('v2.0.0');
  });

  it('should use "HEAD" ref when package was imported without a tag', () => {
    // Given: package imported from default branch
    const packageDir = join(tempDir, '@acme', 'no-tag-pkg');
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, 'takt-repertoire.yaml'), 'description: No tag\n');
    writeFileSync(
      join(packageDir, '.takt-repertoire-lock.yaml'),
      `source: github:acme/no-tag-pkg
ref: HEAD
commit: aabbccddeeff00
imported_at: 2026-02-01T00:00:00.000Z
`,
    );

    // When: package info is read
    const info = readPackageInfo(packageDir, '@acme/no-tag-pkg');

    // Then: ref is "HEAD"
    expect(info.ref).toBe('HEAD');
  });

  it('should fallback to "HEAD" ref when lock file is absent', () => {
    // Given: package directory with no lock file
    const packageDir = join(tempDir, '@acme', 'no-lock-pkg');
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, 'takt-repertoire.yaml'), 'description: No lock\n');
    // .takt-repertoire-lock.yaml intentionally not created

    // When: package info is read
    const info = readPackageInfo(packageDir, '@acme/no-lock-pkg');

    // Then: ref defaults to "HEAD" when lock file is missing
    expect(info.ref).toBe('HEAD');
    expect(info.description).toBe('No lock');
  });
});

// ---------------------------------------------------------------------------
// listPackages
// ---------------------------------------------------------------------------

describe('listPackages', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-list-all-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function createPackage(
    repertoireDir: string,
    owner: string,
    repo: string,
    description: string,
    ref: string,
    commit: string,
  ): void {
    const packageDir = join(repertoireDir, `@${owner}`, repo);
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, 'takt-repertoire.yaml'), `description: ${description}\n`);
    writeFileSync(
      join(packageDir, '.takt-repertoire-lock.yaml'),
      `source: github:${owner}/${repo}
ref: ${ref}
commit: ${commit}
imported_at: 2026-02-20T12:00:00.000Z
`,
    );
  }

  it('should list all installed packages from repertoire directory', () => {
    // Given: repertoire directory with 3 packages
    const repertoireDir = join(tempDir, 'repertoire');
    createPackage(repertoireDir, 'nrslib', 'takt-fullstack', 'Fullstack workflow', 'v1.2.0', 'abc1234def5678');
    createPackage(repertoireDir, 'nrslib', 'takt-security-facets', 'Security facets', 'HEAD', 'def5678901234');
    createPackage(repertoireDir, 'acme-corp', 'takt-backend', 'Backend facets', 'v2.0.0', '789abcdef0123');

    // When: packages are listed
    const packages = listPackages(repertoireDir);

    // Then: all 3 packages are returned
    expect(packages).toHaveLength(3);
    const scopes = packages.map((p) => p.scope);
    expect(scopes).toContain('@nrslib/takt-fullstack');
    expect(scopes).toContain('@nrslib/takt-security-facets');
    expect(scopes).toContain('@acme-corp/takt-backend');
  });

  it('should return empty list when repertoire directory has no packages', () => {
    // Given: empty repertoire directory
    const repertoireDir = join(tempDir, 'repertoire');
    mkdirSync(repertoireDir, { recursive: true });

    // When: packages are listed
    const packages = listPackages(repertoireDir);

    // Then: empty list
    expect(packages).toHaveLength(0);
  });

  it('should include correct commit (truncated to 7 chars) for each package', () => {
    // Given: repertoire with one package
    const repertoireDir = join(tempDir, 'repertoire');
    createPackage(repertoireDir, 'nrslib', 'takt-fullstack', 'Fullstack', 'v1.2.0', 'abc1234def5678');

    // When: packages are listed
    const packages = listPackages(repertoireDir);

    // Then: commit is 7 chars
    const pkg = packages.find((p) => p.scope === '@nrslib/takt-fullstack')!;
    expect(pkg.commit).toBe('abc1234');
    expect(pkg.commit).toHaveLength(7);
  });
});

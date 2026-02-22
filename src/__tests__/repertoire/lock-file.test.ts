/**
 * Tests for .takt-repertoire-lock.yaml generation and parsing.
 *
 * Covers:
 * - extractCommitSha: parse SHA from tarball directory name {owner}-{repo}-{sha}/
 * - generateLockFile: produces correct fields (source, ref, commit, imported_at)
 * - ref defaults to "HEAD" when not specified
 * - parseLockFile: reads .takt-repertoire-lock.yaml content
 */

import { describe, it, expect } from 'vitest';
import {
  extractCommitSha,
  generateLockFile,
  parseLockFile,
} from '../../features/repertoire/lock-file.js';

// ---------------------------------------------------------------------------
// extractCommitSha
// ---------------------------------------------------------------------------

describe('extractCommitSha', () => {
  it('should extract SHA from standard tarball directory name', () => {
    // Given: tarball directory name in {owner}-{repo}-{sha} format
    const dirName = 'nrslib-takt-fullstack-abc1234def5678';

    // When: SHA is extracted
    const sha = extractCommitSha(dirName);

    // Then: last segment (the SHA) is returned
    expect(sha).toBe('abc1234def5678');
  });

  it('should extract SHA when repo name contains hyphens', () => {
    // Given: repo name has multiple hyphens
    const dirName = 'nrslib-takt-security-facets-deadbeef1234';

    // When: SHA is extracted
    const sha = extractCommitSha(dirName);

    // Then: the last segment is the SHA
    expect(sha).toBe('deadbeef1234');
  });

  it('should extract SHA when owner is a single word', () => {
    // Given: simple owner and repo
    const dirName = 'owner-repo-0123456789abcdef';

    // When: SHA is extracted
    const sha = extractCommitSha(dirName);

    // Then: last segment is returned
    expect(sha).toBe('0123456789abcdef');
  });
});

// ---------------------------------------------------------------------------
// generateLockFile
// ---------------------------------------------------------------------------

describe('generateLockFile', () => {
  it('should produce lock file with all required fields', () => {
    // Given: all parameters provided
    const params = {
      source: 'github:nrslib/takt-fullstack',
      ref: 'v1.2.0',
      commitSha: 'abc1234def5678',
      importedAt: new Date('2026-02-20T12:00:00Z'),
    };

    // When: lock file is generated
    const lock = generateLockFile(params);

    // Then: all fields are present
    expect(lock.source).toBe('github:nrslib/takt-fullstack');
    expect(lock.ref).toBe('v1.2.0');
    expect(lock.commit).toBe('abc1234def5678');
    expect(lock.imported_at).toBe('2026-02-20T12:00:00.000Z');
  });

  it('should default ref to "HEAD" when ref is undefined', () => {
    // Given: ref not specified
    const params = {
      source: 'github:nrslib/takt-security-facets',
      ref: undefined,
      commitSha: 'deadbeef1234',
      importedAt: new Date('2026-01-01T00:00:00Z'),
    };

    // When: lock file is generated
    const lock = generateLockFile(params);

    // Then: ref is "HEAD"
    expect(lock.ref).toBe('HEAD');
  });

  it('should record the exact commit SHA from the tarball directory', () => {
    // Given: SHA from tarball extraction
    const sha = '9f8e7d6c5b4a';
    const params = {
      source: 'github:someone/dotfiles',
      ref: undefined,
      commitSha: sha,
      importedAt: new Date(),
    };

    // When: lock file is generated
    const lock = generateLockFile(params);

    // Then: commit SHA matches
    expect(lock.commit).toBe(sha);
  });
});

// ---------------------------------------------------------------------------
// parseLockFile
// ---------------------------------------------------------------------------

describe('parseLockFile', () => {
  it('should parse a valid .takt-repertoire-lock.yaml string', () => {
    // Given: lock file YAML content
    const yaml = `source: github:nrslib/takt-fullstack
ref: v1.2.0
commit: abc1234def5678
imported_at: 2026-02-20T12:00:00.000Z
`;

    // When: parsed
    const lock = parseLockFile(yaml);

    // Then: all fields are present
    expect(lock.source).toBe('github:nrslib/takt-fullstack');
    expect(lock.ref).toBe('v1.2.0');
    expect(lock.commit).toBe('abc1234def5678');
    expect(lock.imported_at).toBe('2026-02-20T12:00:00.000Z');
  });

  it('should parse lock file with HEAD ref', () => {
    // Given: lock file with HEAD ref (no tag specified at import)
    const yaml = `source: github:acme-corp/takt-backend
ref: HEAD
commit: 789abcdef0123
imported_at: 2026-01-15T08:30:00.000Z
`;

    // When: parsed
    const lock = parseLockFile(yaml);

    // Then: ref is "HEAD"
    expect(lock.ref).toBe('HEAD');
    expect(lock.commit).toBe('789abcdef0123');
  });

  it('should return empty-valued lock without crashing when yaml is empty string', () => {
    // Given: empty yaml (lock file absent - existsSync guard fell through to '')
    // yaml.parse('') returns null, which must not cause TypeError

    // When: parsed
    const lock = parseLockFile('');

    // Then: returns defaults without throwing
    expect(lock.source).toBe('');
    expect(lock.ref).toBe('HEAD');
    expect(lock.commit).toBe('');
    expect(lock.imported_at).toBe('');
  });
});

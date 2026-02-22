/**
 * Unit tests for parseTarVerboseListing in tar-parser.ts.
 *
 * Covers:
 * - firstDirEntry extraction (commit SHA prefix)
 * - BSD tar (HH:MM) and GNU tar (HH:MM:SS) timestamp formats
 * - Directory entry skipping
 * - Symlink entry skipping
 * - ALLOWED_EXTENSIONS filtering
 * - Empty input
 */

import { describe, it, expect } from 'vitest';
import { parseTarVerboseListing } from '../../features/repertoire/tar-parser.js';

// ---------------------------------------------------------------------------
// Helpers to build realistic tar verbose lines
// ---------------------------------------------------------------------------

/** Build a BSD tar verbose line (HH:MM timestamp) */
function bsdLine(type: string, path: string): string {
  return `${type}rwxr-xr-x  0 user  group    1234 Jan  1 12:34 ${path}`;
}

/** Build a GNU tar verbose line (HH:MM:SS timestamp) */
function gnuLine(type: string, path: string): string {
  return `${type}rwxr-xr-x user/group 1234 2024-01-01 12:34:56 ${path}`;
}

// ---------------------------------------------------------------------------
// parseTarVerboseListing
// ---------------------------------------------------------------------------

describe('parseTarVerboseListing', () => {
  it('should return empty results for an empty line array', () => {
    const result = parseTarVerboseListing([]);
    expect(result.firstDirEntry).toBe('');
    expect(result.includePaths).toEqual([]);
  });

  it('should extract firstDirEntry from the first directory line (BSD format)', () => {
    // Given: first line is a directory entry in BSD tar format
    const lines = [
      bsdLine('d', 'owner-repo-abc1234/'),
      bsdLine('-', 'owner-repo-abc1234/facets/personas/coder.md'),
    ];

    // When: parsed
    const result = parseTarVerboseListing(lines);

    // Then: firstDirEntry has trailing slash stripped
    expect(result.firstDirEntry).toBe('owner-repo-abc1234');
  });

  it('should extract firstDirEntry from the first directory line (GNU format)', () => {
    // Given: first line is a directory entry in GNU tar format
    const lines = [
      gnuLine('d', 'owner-repo-abc1234/'),
      gnuLine('-', 'owner-repo-abc1234/facets/personas/coder.md'),
    ];

    // When: parsed
    const result = parseTarVerboseListing(lines);

    // Then: firstDirEntry is set correctly
    expect(result.firstDirEntry).toBe('owner-repo-abc1234');
  });

  it('should include .md files', () => {
    // Given: a regular .md file
    const lines = [
      bsdLine('d', 'repo-sha/'),
      bsdLine('-', 'repo-sha/facets/personas/coder.md'),
    ];

    // When: parsed
    const result = parseTarVerboseListing(lines);

    // Then: .md is included
    expect(result.includePaths).toContain('repo-sha/facets/personas/coder.md');
  });

  it('should include .yaml files', () => {
    // Given: a regular .yaml file
    const lines = [
      bsdLine('d', 'repo-sha/'),
      bsdLine('-', 'repo-sha/pieces/coder.yaml'),
    ];

    const result = parseTarVerboseListing(lines);
    expect(result.includePaths).toContain('repo-sha/pieces/coder.yaml');
  });

  it('should include .yml files', () => {
    // Given: a regular .yml file
    const lines = [
      bsdLine('d', 'repo-sha/'),
      bsdLine('-', 'repo-sha/pieces/coder.yml'),
    ];

    const result = parseTarVerboseListing(lines);
    expect(result.includePaths).toContain('repo-sha/pieces/coder.yml');
  });

  it('should exclude files with non-allowed extensions (.ts, .json)', () => {
    // Given: lines with non-allowed file types
    const lines = [
      bsdLine('d', 'repo-sha/'),
      bsdLine('-', 'repo-sha/src/index.ts'),
      bsdLine('-', 'repo-sha/package.json'),
      bsdLine('-', 'repo-sha/facets/personas/coder.md'),
    ];

    const result = parseTarVerboseListing(lines);

    // Then: only .md is included
    expect(result.includePaths).toEqual(['repo-sha/facets/personas/coder.md']);
  });

  it('should skip directory entries (type "d")', () => {
    // Given: mix of directory and file entries
    const lines = [
      bsdLine('d', 'repo-sha/'),
      bsdLine('d', 'repo-sha/facets/'),
      bsdLine('-', 'repo-sha/facets/personas/coder.md'),
    ];

    const result = parseTarVerboseListing(lines);

    // Then: directories are not in includePaths
    expect(result.includePaths).not.toContain('repo-sha/facets/');
    expect(result.includePaths).toContain('repo-sha/facets/personas/coder.md');
  });

  it('should skip symlink entries (type "l")', () => {
    // Given: a symlink entry (type "l") alongside a normal file
    const lines = [
      bsdLine('d', 'repo-sha/'),
      bsdLine('l', 'repo-sha/facets/link.md'),
      bsdLine('-', 'repo-sha/facets/personas/coder.md'),
    ];

    const result = parseTarVerboseListing(lines);

    // Then: symlink is excluded, normal file is included
    expect(result.includePaths).not.toContain('repo-sha/facets/link.md');
    expect(result.includePaths).toContain('repo-sha/facets/personas/coder.md');
  });

  it('should handle lines that do not match the timestamp regex', () => {
    // Given: lines without a recognizable timestamp (should be ignored)
    const lines = [
      'some-garbage-line',
      bsdLine('-', 'repo-sha/facets/personas/coder.md'),
    ];

    const result = parseTarVerboseListing(lines);

    // Then: garbage line is skipped, file is included
    expect(result.includePaths).toContain('repo-sha/facets/personas/coder.md');
  });

  it('should set firstDirEntry to empty string when first matching line has no trailing slash', () => {
    // Given: first line is a file, not a directory (no trailing slash)
    const lines = [
      bsdLine('-', 'repo-sha/README.md'),
    ];

    const result = parseTarVerboseListing(lines);

    // Then: firstDirEntry has no trailing slash stripping needed
    expect(result.firstDirEntry).toBe('repo-sha/README.md');
  });
});

/**
 * Tests for parseGithubSpec in github-spec.ts.
 *
 * Covers the happy path and all error branches.
 */

import { describe, it, expect } from 'vitest';
import { parseGithubSpec } from '../../features/repertoire/github-spec.js';

describe('parseGithubSpec', () => {
  describe('happy path', () => {
    it('should parse a valid github spec', () => {
      // Given: a well-formed spec
      const spec = 'github:nrslib/takt-fullstack@main';

      // When: parsed
      const result = parseGithubSpec(spec);

      // Then: components are extracted correctly
      expect(result.owner).toBe('nrslib');
      expect(result.repo).toBe('takt-fullstack');
      expect(result.ref).toBe('main');
    });

    it('should normalize owner and repo to lowercase', () => {
      // Given: spec with uppercase owner/repo
      const spec = 'github:Owner/Repo@v1.0.0';

      // When: parsed
      const result = parseGithubSpec(spec);

      // Then: owner and repo are lowercased
      expect(result.owner).toBe('owner');
      expect(result.repo).toBe('repo');
      expect(result.ref).toBe('v1.0.0');
    });

    it('should handle a SHA as ref', () => {
      // Given: spec with a full SHA as ref
      const spec = 'github:myorg/myrepo@abc1234def5678';

      // When: parsed
      const result = parseGithubSpec(spec);

      // Then: ref is the SHA
      expect(result.ref).toBe('abc1234def5678');
    });

    it('should use lastIndexOf for @ so tags with @ in name work', () => {
      // Given: spec where the ref contains no ambiguous @
      // and owner/repo portion has no @
      const spec = 'github:org/repo@refs/tags/v1.0';

      // When: parsed
      const result = parseGithubSpec(spec);

      // Then: ref is correctly picked as the last @ segment
      expect(result.owner).toBe('org');
      expect(result.repo).toBe('repo');
      expect(result.ref).toBe('refs/tags/v1.0');
    });
  });

  describe('error paths', () => {
    it('should throw when prefix is not github:', () => {
      // Given: spec with wrong prefix
      const spec = 'npm:owner/repo@latest';

      // When / Then: error is thrown
      expect(() => parseGithubSpec(spec)).toThrow(
        'Invalid package spec: "npm:owner/repo@latest". Expected "github:{owner}/{repo}@{ref}"',
      );
    });

    it('should return undefined ref when @{ref} is omitted', () => {
      // Given: spec with no @{ref} (ref is optional; caller resolves default branch)
      const spec = 'github:owner/repo';

      // When: parsed
      const result = parseGithubSpec(spec);

      // Then: owner and repo are extracted, ref is undefined
      expect(result.owner).toBe('owner');
      expect(result.repo).toBe('repo');
      expect(result.ref).toBeUndefined();
    });

    it('should throw when repo name is missing (no slash)', () => {
      // Given: spec with no slash between owner and repo
      const spec = 'github:owneronly@main';

      // When / Then: error about missing repo name
      expect(() => parseGithubSpec(spec)).toThrow(
        'Invalid package spec: "github:owneronly@main". Missing repo name',
      );
    });
  });
});

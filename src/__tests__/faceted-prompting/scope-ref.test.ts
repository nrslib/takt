/**
 * Tests for @scope reference resolution.
 *
 * Covers:
 * - isScopeRef(): detects @{owner}/{repo}/{facet-name} format
 * - parseScopeRef(): parses components from scope reference
 * - resolveScopeRef(): resolves to ~/.takt/repertoire/@{owner}/{repo}/facets/{facet-type}/{facet-name}.md
 * - facet-type mapping from field context (persona→personas, policy→policies, etc.)
 * - Name constraint validation (owner, repo, facet-name patterns)
 * - Case normalization (uppercase → lowercase)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  isScopeRef,
  parseScopeRef,
  resolveScopeRef,
  validateScopeOwner,
  validateScopeRepo,
  validateScopeFacetName,
  type ScopeRef,
} from '../../faceted-prompting/scope.js';

// ---------------------------------------------------------------------------
// isScopeRef
// ---------------------------------------------------------------------------

describe('isScopeRef', () => {
  it('should return true for @owner/repo/facet-name format', () => {
    // Given: a valid scope reference
    expect(isScopeRef('@nrslib/takt-fullstack/expert-coder')).toBe(true);
  });

  it('should return true for scope with short names', () => {
    expect(isScopeRef('@a/b/c')).toBe(true);
  });

  it('should return false for plain facet name (no @ prefix)', () => {
    expect(isScopeRef('expert-coder')).toBe(false);
  });

  it('should return false for regular resource path', () => {
    expect(isScopeRef('./personas/coder.md')).toBe(false);
  });

  it('should return false for @ with only owner/repo (missing facet name)', () => {
    expect(isScopeRef('@nrslib/takt-fullstack')).toBe(false);
  });

  it('should return false for empty string', () => {
    expect(isScopeRef('')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseScopeRef
// ---------------------------------------------------------------------------

describe('parseScopeRef', () => {
  it('should parse @owner/repo/facet-name into components', () => {
    // Given: a valid scope reference
    const ref = '@nrslib/takt-fullstack/expert-coder';

    // When: parsed
    const parsed = parseScopeRef(ref);

    // Then: components are extracted correctly
    expect(parsed.owner).toBe('nrslib');
    expect(parsed.repo).toBe('takt-fullstack');
    expect(parsed.name).toBe('expert-coder');
  });

  it('should normalize uppercase owner to lowercase', () => {
    // Given: owner with uppercase letters
    const ref = '@NrsLib/takt-fullstack/coder';

    // When: parsed
    const parsed = parseScopeRef(ref);

    // Then: owner is normalized to lowercase
    expect(parsed.owner).toBe('nrslib');
  });

  it('should normalize uppercase repo to lowercase', () => {
    // Given: repo with uppercase letters
    const ref = '@nrslib/Takt-Fullstack/coder';

    // When: parsed
    const parsed = parseScopeRef(ref);

    // Then: repo is normalized to lowercase
    expect(parsed.repo).toBe('takt-fullstack');
  });

  it('should handle repo name with dots and underscores', () => {
    // Given: GitHub repo names allow dots and underscores
    const ref = '@acme/takt.backend_v2/expert';

    // When: parsed
    const parsed = parseScopeRef(ref);

    // Then: dots and underscores are preserved
    expect(parsed.repo).toBe('takt.backend_v2');
    expect(parsed.name).toBe('expert');
  });

  it('should preserve facet name exactly', () => {
    // Given: facet name with hyphens
    const ref = '@nrslib/security-facets/security-reviewer';

    // When: parsed
    const parsed = parseScopeRef(ref);

    // Then: facet name is preserved
    expect(parsed.name).toBe('security-reviewer');
  });
});

// ---------------------------------------------------------------------------
// resolveScopeRef
// ---------------------------------------------------------------------------

describe('resolveScopeRef', () => {
  let tempRepertoireDir: string;

  beforeEach(() => {
    tempRepertoireDir = mkdtempSync(join(tmpdir(), 'takt-repertoire-'));
  });

  afterEach(() => {
    rmSync(tempRepertoireDir, { recursive: true, force: true });
  });

  it('should resolve persona scope ref to facets/personas/{name}.md', () => {
    // Given: repertoire directory with the package's persona file
    const facetDir = join(tempRepertoireDir, '@nrslib', 'takt-fullstack', 'facets', 'personas');
    mkdirSync(facetDir, { recursive: true });
    writeFileSync(join(facetDir, 'expert-coder.md'), 'Expert coder persona');

    const scopeRef: ScopeRef = { owner: 'nrslib', repo: 'takt-fullstack', name: 'expert-coder' };

    // When: scope ref is resolved with facetType 'personas'
    const result = resolveScopeRef(scopeRef, 'personas', tempRepertoireDir);

    // Then: resolved to the correct file path
    expect(result).toBe(join(tempRepertoireDir, '@nrslib', 'takt-fullstack', 'facets', 'personas', 'expert-coder.md'));
  });

  it('should resolve policy scope ref to facets/policies/{name}.md', () => {
    // Given: repertoire directory with policy file
    const facetDir = join(tempRepertoireDir, '@nrslib', 'takt-fullstack', 'facets', 'policies');
    mkdirSync(facetDir, { recursive: true });
    writeFileSync(join(facetDir, 'owasp-checklist.md'), 'OWASP content');

    const scopeRef: ScopeRef = { owner: 'nrslib', repo: 'takt-fullstack', name: 'owasp-checklist' };

    // When: scope ref is resolved with facetType 'policies'
    const result = resolveScopeRef(scopeRef, 'policies', tempRepertoireDir);

    // Then: resolved to correct path
    expect(result).toBe(join(tempRepertoireDir, '@nrslib', 'takt-fullstack', 'facets', 'policies', 'owasp-checklist.md'));
  });

  it('should resolve knowledge scope ref to facets/knowledge/{name}.md', () => {
    // Given: repertoire directory with knowledge file
    const facetDir = join(tempRepertoireDir, '@nrslib', 'takt-security-facets', 'facets', 'knowledge');
    mkdirSync(facetDir, { recursive: true });
    writeFileSync(join(facetDir, 'vulnerability-patterns.md'), 'Vuln patterns');

    const scopeRef: ScopeRef = { owner: 'nrslib', repo: 'takt-security-facets', name: 'vulnerability-patterns' };

    // When: scope ref is resolved with facetType 'knowledge'
    const result = resolveScopeRef(scopeRef, 'knowledge', tempRepertoireDir);

    // Then: resolved to correct path
    expect(result).toBe(join(tempRepertoireDir, '@nrslib', 'takt-security-facets', 'facets', 'knowledge', 'vulnerability-patterns.md'));
  });

  it('should resolve instructions scope ref to facets/instructions/{name}.md', () => {
    // Given: instruction file
    const facetDir = join(tempRepertoireDir, '@acme', 'takt-backend', 'facets', 'instructions');
    mkdirSync(facetDir, { recursive: true });
    writeFileSync(join(facetDir, 'review-checklist.md'), 'Review steps');

    const scopeRef: ScopeRef = { owner: 'acme', repo: 'takt-backend', name: 'review-checklist' };

    // When: scope ref is resolved with facetType 'instructions'
    const result = resolveScopeRef(scopeRef, 'instructions', tempRepertoireDir);

    // Then: correct path
    expect(result).toBe(join(tempRepertoireDir, '@acme', 'takt-backend', 'facets', 'instructions', 'review-checklist.md'));
  });

  it('should resolve output-contracts scope ref to facets/output-contracts/{name}.md', () => {
    // Given: output contract file
    const facetDir = join(tempRepertoireDir, '@acme', 'takt-backend', 'facets', 'output-contracts');
    mkdirSync(facetDir, { recursive: true });
    writeFileSync(join(facetDir, 'review-report.md'), 'Report contract');

    const scopeRef: ScopeRef = { owner: 'acme', repo: 'takt-backend', name: 'review-report' };

    // When: scope ref is resolved with facetType 'output-contracts'
    const result = resolveScopeRef(scopeRef, 'output-contracts', tempRepertoireDir);

    // Then: correct path
    expect(result).toBe(join(tempRepertoireDir, '@acme', 'takt-backend', 'facets', 'output-contracts', 'review-report.md'));
  });
});

// ---------------------------------------------------------------------------
// Name constraint validation
// ---------------------------------------------------------------------------

describe('validateScopeOwner', () => {
  it('should accept valid owner: nrslib', () => {
    expect(() => validateScopeOwner('nrslib')).not.toThrow();
  });

  it('should accept owner with numbers: owner123', () => {
    expect(() => validateScopeOwner('owner123')).not.toThrow();
  });

  it('should accept owner with hyphens: my-org', () => {
    expect(() => validateScopeOwner('my-org')).not.toThrow();
  });

  it('should reject owner starting with hyphen: -owner', () => {
    // Pattern: /^[a-z0-9][a-z0-9-]*$/
    expect(() => validateScopeOwner('-owner')).toThrow();
  });

  it('should reject owner with uppercase letters after normalization requirement', () => {
    // Owner must be lowercase
    expect(() => validateScopeOwner('MyOrg')).toThrow();
  });

  it('should reject owner with dots', () => {
    // Dots not allowed in owner
    expect(() => validateScopeOwner('my.org')).toThrow();
  });
});

describe('validateScopeRepo', () => {
  it('should accept simple repo: takt-fullstack', () => {
    expect(() => validateScopeRepo('takt-fullstack')).not.toThrow();
  });

  it('should accept repo with dot: takt.backend', () => {
    // Dots allowed in repo names
    expect(() => validateScopeRepo('takt.backend')).not.toThrow();
  });

  it('should accept repo with underscore: takt_backend', () => {
    // Underscores allowed in repo names
    expect(() => validateScopeRepo('takt_backend')).not.toThrow();
  });

  it('should reject repo starting with hyphen: -repo', () => {
    expect(() => validateScopeRepo('-repo')).toThrow();
  });
});

describe('validateScopeFacetName', () => {
  it('should accept valid facet name: expert-coder', () => {
    expect(() => validateScopeFacetName('expert-coder')).not.toThrow();
  });

  it('should accept facet name with numbers: expert2', () => {
    expect(() => validateScopeFacetName('expert2')).not.toThrow();
  });

  it('should reject facet name starting with hyphen: -expert', () => {
    expect(() => validateScopeFacetName('-expert')).toThrow();
  });

  it('should reject facet name with dots: expert.coder', () => {
    // Dots not allowed in facet names
    expect(() => validateScopeFacetName('expert.coder')).toThrow();
  });
});

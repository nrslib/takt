/**
 * @scope reference resolution utilities for TAKT repertoire packages.
 *
 * Provides:
 * - isScopeRef(): detect @{owner}/{repo}/{facet-name} format
 * - parseScopeRef(): parse and normalize components
 * - resolveScopeRef(): build file path in repertoire directory
 * - validateScopeOwner/Repo/FacetName(): name constraint validation
 */

import { join } from 'node:path';

/** Parsed components of an @scope reference. */
export interface ScopeRef {
  /** GitHub owner (lowercase). */
  owner: string;
  /** Repository name (lowercase). */
  repo: string;
  /** Facet name. */
  name: string;
}

/** Matches @{owner}/{repo}/{facet-name} format. */
const SCOPE_REF_PATTERN = /^@[^/]+\/[^/]+\/[^/]+$/;

/**
 * Return true if the string is an @{owner}/{repo}/{facet-name} scope reference.
 */
export function isScopeRef(ref: string): boolean {
  return SCOPE_REF_PATTERN.test(ref);
}

/**
 * Parse an @scope reference into its components.
 * Normalizes owner and repo to lowercase.
 *
 * @param ref - e.g. "@nrslib/takt-fullstack/expert-coder"
 */
export function parseScopeRef(ref: string): ScopeRef {
  const withoutAt = ref.slice(1);
  const firstSlash = withoutAt.indexOf('/');
  const owner = withoutAt.slice(0, firstSlash).toLowerCase();
  const rest = withoutAt.slice(firstSlash + 1);
  const secondSlash = rest.indexOf('/');
  const repo = rest.slice(0, secondSlash).toLowerCase();
  const name = rest.slice(secondSlash + 1);
  validateScopeOwner(owner);
  validateScopeRepo(repo);
  validateScopeFacetName(name);
  return { owner, repo, name };
}

/**
 * Resolve a scope reference to a file path in the repertoire directory.
 *
 * Path: {repertoireDir}/@{owner}/{repo}/facets/{facetType}/{name}.md
 *
 * @param scopeRef      - parsed scope reference
 * @param facetType     - e.g. "personas", "policies", "knowledge"
 * @param repertoireDir - root repertoire directory (e.g. ~/.takt/repertoire)
 * @returns Absolute path to the facet file.
 */
export function resolveScopeRef(
  scopeRef: ScopeRef,
  facetType: string,
  repertoireDir: string,
): string {
  return join(
    repertoireDir,
    `@${scopeRef.owner}`,
    scopeRef.repo,
    'facets',
    facetType,
    `${scopeRef.name}.md`,
  );
}

/** Validate owner name: must match /^[a-z0-9][a-z0-9-]*$/ */
export function validateScopeOwner(owner: string): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(owner)) {
    throw new Error(
      `Invalid scope owner: "${owner}". Must match /^[a-z0-9][a-z0-9-]*$/ (lowercase alphanumeric and hyphens, not starting with hyphen).`,
    );
  }
}

/** Validate repo name: must match /^[a-z0-9][a-z0-9._-]*$/ */
export function validateScopeRepo(repo: string): void {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(repo)) {
    throw new Error(
      `Invalid scope repo: "${repo}". Must match /^[a-z0-9][a-z0-9._-]*$/ (lowercase alphanumeric, hyphens, dots, underscores, not starting with hyphen).`,
    );
  }
}

/** Validate facet name: must match /^[a-z0-9][a-z0-9-]*$/ */
export function validateScopeFacetName(name: string): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new Error(
      `Invalid scope facet name: "${name}". Must match /^[a-z0-9][a-z0-9-]*$/ (lowercase alphanumeric and hyphens, not starting with hyphen).`,
    );
  }
}

/**
 * @scope reference resolution utilities for TAKT repertoire packages.
 *
 * Provides:
 * - isScopeRef(): detect @{owner}/{repo}/{facet-name} format
 * - parseScopeRef(): parse and normalize components
 * - resolveScopeRef(): build file path in repertoire directory
 * - validateScopeOwner/Repo/FacetName(): name constraint validation
 */
/** Parsed components of an @scope reference. */
export interface ScopeRef {
    /** GitHub owner (lowercase). */
    owner: string;
    /** Repository name (lowercase). */
    repo: string;
    /** Facet name. */
    name: string;
}
/**
 * Return true if the string is an @{owner}/{repo}/{facet-name} scope reference.
 */
export declare function isScopeRef(ref: string): boolean;
/**
 * Parse an @scope reference into its components.
 * Normalizes owner and repo to lowercase.
 *
 * @param ref - e.g. "@nrslib/takt-fullstack/expert-coder"
 */
export declare function parseScopeRef(ref: string): ScopeRef;
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
export declare function resolveScopeRef(scopeRef: ScopeRef, facetType: string, repertoireDir: string): string;
/** Validate owner name: must match /^[a-z0-9][a-z0-9-]*$/ */
export declare function validateScopeOwner(owner: string): void;
/** Validate repo name: must match /^[a-z0-9][a-z0-9._-]*$/ */
export declare function validateScopeRepo(repo: string): void;
/** Validate facet name: must match /^[a-z0-9][a-z0-9-]*$/ */
export declare function validateScopeFacetName(name: string): void;

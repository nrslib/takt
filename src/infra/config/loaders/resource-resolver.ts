/**
 * Resource resolution helpers for workflow YAML parsing.
 *
 * Facade: delegates to the faceted-prompting package and re-exports
 * its types/functions. resolveFacetPath and resolveFacetByName build
 * TAKT-specific candidate directories then delegate to the generic
 * implementation.
 */

import { existsSync, readFileSync } from 'node:fs';
import type { FacetType } from '../paths.js';

import {
  resolveFacetPath as resolveFacetPathGeneric,
  resolveRefToContent as resolveRefToContentGeneric,
  resolvePersona as resolvePersonaGeneric,
  isScopeRef,
  parseScopeRef,
  resolveScopeRef,
} from 'faceted-prompting';
import {
  assertAllowedPersonaPath,
} from './workflowPersonaPathPolicy.js';
import {
  buildCandidateDirsWithPackage,
  type FacetResolutionContext,
} from './workflowPackageScope.js';

export interface WorkflowSections {
  personas?: Record<string, string>;
  resolvedPolicies?: Record<string, string>;
  resolvedKnowledge?: Record<string, string>;
  resolvedInstructions?: Record<string, string>;
  resolvedReportFormats?: Record<string, string>;
}

export {
  isResourcePath,
  resolveResourcePath,
  resolveResourceContent,
  resolveSectionMap,
  extractPersonaDisplayName,
} from 'faceted-prompting';

export type { FacetResolutionContext } from './workflowPackageScope.js';

/**
 * Resolve a facet name to its file path via 4-layer lookup (package-local → project → user → builtin).
 *
 * Handles @{owner}/{repo}/{facet-name} scope references directly when repertoireDir is provided.
 *
 * @returns Absolute file path if found, undefined otherwise.
 */
export function resolveFacetPath(
  name: string,
  facetType: FacetType,
  context: FacetResolutionContext,
): string | undefined {
  if (isScopeRef(name) && context.repertoireDir) {
    const scopeRef = parseScopeRef(name);
    const filePath = resolveScopeRef(scopeRef, facetType, context.repertoireDir);
    return existsSync(filePath) ? filePath : undefined;
  }
  return resolveFacetPathGeneric(name, buildCandidateDirsWithPackage(facetType, context));
}

/**
 * Resolve a facet name to its file content via 4-layer lookup.
 *
 * Handles @{owner}/{repo}/{facet-name} scope references when repertoireDir is provided.
 *
 * @returns File content if found, undefined otherwise.
 */
export function resolveFacetByName(
  name: string,
  facetType: FacetType,
  context: FacetResolutionContext,
): string | undefined {
  const filePath = resolveFacetPath(name, facetType, context);
  if (filePath) {
    return readFileSync(filePath, 'utf-8');
  }
  return undefined;
}

/**
 * Resolve a section reference to content.
 * Looks up ref in resolvedMap first, then falls back to path resolution.
 * If a FacetResolutionContext is provided and ref is a name (not a path),
 * falls back to 4-layer facet resolution (including package-local and @scope).
 */
export function resolveRefToContent(
  ref: string,
  resolvedMap: Record<string, string> | undefined,
  workflowDir: string,
  facetType?: FacetType,
  context?: FacetResolutionContext,
): string | undefined {
  if (facetType && context && isScopeRef(ref) && context.repertoireDir) {
    const scopeRef = parseScopeRef(ref);
    const filePath = resolveScopeRef(scopeRef, facetType, context.repertoireDir);
    return existsSync(filePath) ? readFileSync(filePath, 'utf-8') : undefined;
  }
  const candidateDirs = facetType && context
    ? buildCandidateDirsWithPackage(facetType, context)
    : undefined;
  return resolveRefToContentGeneric(ref, resolvedMap, workflowDir, candidateDirs);
}

/** Resolve multiple references to content strings (for fields that accept string | string[]). */
export function resolveRefList(
  refs: string | string[] | undefined,
  resolvedMap: Record<string, string> | undefined,
  workflowDir: string,
  facetType?: FacetType,
  context?: FacetResolutionContext,
): string[] | undefined {
  if (refs == null) return undefined;
  const list = Array.isArray(refs) ? refs : [refs];
  const contents: string[] = [];
  for (const ref of list) {
    const content = resolveRefToContent(ref, resolvedMap, workflowDir, facetType, context);
    if (content) contents.push(content);
  }
  return contents.length > 0 ? contents : undefined;
}

/** Resolve persona from YAML field to spec + absolute path. */
export function resolvePersona(
  rawPersona: string | undefined,
  sections: WorkflowSections,
  workflowDir: string,
  context?: FacetResolutionContext,
): { personaSpec?: string; personaPath?: string } {
  if (rawPersona && isScopeRef(rawPersona) && context?.repertoireDir) {
    const scopeRef = parseScopeRef(rawPersona);
    const personaPath = resolveScopeRef(scopeRef, 'personas', context.repertoireDir);
    if (existsSync(personaPath)) {
      assertAllowedPersonaPath(personaPath, context);
      return { personaSpec: rawPersona, personaPath };
    }
    return { personaSpec: rawPersona, personaPath: undefined };
  }
  const candidateDirs = context
    ? buildCandidateDirsWithPackage('personas', context)
    : undefined;
  const resolved = resolvePersonaGeneric(rawPersona, sections, workflowDir, candidateDirs);
  if (resolved.personaPath) {
    assertAllowedPersonaPath(resolved.personaPath, context);
  }
  return resolved;
}

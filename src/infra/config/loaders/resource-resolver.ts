/**
 * Resource resolution helpers for piece YAML parsing.
 *
 * Facade: delegates to faceted-prompting/resolve.ts and re-exports
 * its types/functions. resolveFacetPath and resolveFacetByName build
 * TAKT-specific candidate directories then delegate to the generic
 * implementation.
 */

import type { Language } from '../../../core/models/index.js';
import type { FacetType } from '../paths.js';
import { getProjectFacetDir, getGlobalFacetDir, getBuiltinFacetDir } from '../paths.js';

import {
  resolveFacetPath as resolveFacetPathGeneric,
  resolveFacetByName as resolveFacetByNameGeneric,
  resolveRefToContent as resolveRefToContentGeneric,
  resolveRefList as resolveRefListGeneric,
  resolvePersona as resolvePersonaGeneric,
} from '../../../faceted-prompting/index.js';

// Re-export types and pure functions that need no TAKT wrapping
export type { PieceSections } from '../../../faceted-prompting/index.js';
export {
  isResourcePath,
  resolveResourcePath,
  resolveResourceContent,
  resolveSectionMap,
  extractPersonaDisplayName,
} from '../../../faceted-prompting/index.js';

/** Context for 3-layer facet resolution (TAKT-specific). */
export interface FacetResolutionContext {
  projectDir?: string;
  lang: Language;
}

/**
 * Build TAKT-specific candidate directories for a facet type.
 */
function buildCandidateDirs(
  facetType: FacetType,
  context: FacetResolutionContext,
): string[] {
  const dirs: string[] = [];
  if (context.projectDir) {
    dirs.push(getProjectFacetDir(context.projectDir, facetType));
  }
  dirs.push(getGlobalFacetDir(facetType));
  dirs.push(getBuiltinFacetDir(context.lang, facetType));
  return dirs;
}

/**
 * Resolve a facet name to its file path via 3-layer lookup.
 *
 * Resolution order:
 * 1. Project .takt/{facetType}/{name}.md
 * 2. User ~/.takt/{facetType}/{name}.md
 * 3. Builtin builtins/{lang}/{facetType}/{name}.md
 *
 * @returns Absolute file path if found, undefined otherwise.
 */
export function resolveFacetPath(
  name: string,
  facetType: FacetType,
  context: FacetResolutionContext,
): string | undefined {
  return resolveFacetPathGeneric(name, buildCandidateDirs(facetType, context));
}

/**
 * Resolve a facet name via 3-layer lookup.
 *
 * @returns File content if found, undefined otherwise.
 */
export function resolveFacetByName(
  name: string,
  facetType: FacetType,
  context: FacetResolutionContext,
): string | undefined {
  return resolveFacetByNameGeneric(name, buildCandidateDirs(facetType, context));
}

/**
 * Resolve a section reference to content.
 * Looks up ref in resolvedMap first, then falls back to path resolution.
 * If a FacetResolutionContext is provided and ref is a name (not a path),
 * falls back to 3-layer facet resolution.
 */
export function resolveRefToContent(
  ref: string,
  resolvedMap: Record<string, string> | undefined,
  pieceDir: string,
  facetType?: FacetType,
  context?: FacetResolutionContext,
): string | undefined {
  const candidateDirs = facetType && context
    ? buildCandidateDirs(facetType, context)
    : undefined;
  return resolveRefToContentGeneric(ref, resolvedMap, pieceDir, candidateDirs);
}

/** Resolve multiple references to content strings (for fields that accept string | string[]). */
export function resolveRefList(
  refs: string | string[] | undefined,
  resolvedMap: Record<string, string> | undefined,
  pieceDir: string,
  facetType?: FacetType,
  context?: FacetResolutionContext,
): string[] | undefined {
  const candidateDirs = facetType && context
    ? buildCandidateDirs(facetType, context)
    : undefined;
  return resolveRefListGeneric(refs, resolvedMap, pieceDir, candidateDirs);
}

/** Resolve persona from YAML field to spec + absolute path. */
export function resolvePersona(
  rawPersona: string | undefined,
  sections: import('../../../faceted-prompting/index.js').PieceSections,
  pieceDir: string,
  context?: FacetResolutionContext,
): { personaSpec?: string; personaPath?: string } {
  const candidateDirs = context
    ? buildCandidateDirs('personas', context)
    : undefined;
  return resolvePersonaGeneric(rawPersona, sections, pieceDir, candidateDirs);
}

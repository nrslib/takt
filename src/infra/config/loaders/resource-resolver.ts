/**
 * Resource resolution helpers for piece YAML parsing.
 *
 * Facade: delegates to faceted-prompting/resolve.ts and re-exports
 * its types/functions. resolveFacetPath and resolveFacetByName build
 * TAKT-specific candidate directories then delegate to the generic
 * implementation.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Language } from '../../../core/models/index.js';
import type { FacetType } from '../paths.js';
import { getProjectFacetDir, getGlobalFacetDir, getBuiltinFacetDir, getRepertoireFacetDir } from '../paths.js';

import {
  resolveFacetPath as resolveFacetPathGeneric,
  resolveRefToContent as resolveRefToContentGeneric,
  resolvePersona as resolvePersonaGeneric,
  isScopeRef,
  parseScopeRef,
  resolveScopeRef,
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
  /** pieceDir of the piece being parsed — used for package-local layer detection. */
  pieceDir?: string;
  /** repertoire directory root — used together with pieceDir to detect package pieces. */
  repertoireDir?: string;
}

/**
 * Determine whether a piece is inside a repertoire package.
 *
 * @param pieceDir      - absolute path to the piece directory
 * @param repertoireDir - absolute path to the repertoire root (~/.takt/repertoire)
 */
export function isPackagePiece(pieceDir: string, repertoireDir: string): boolean {
  const resolvedPiece = resolve(pieceDir);
  const resolvedRepertoire = resolve(repertoireDir);
  return resolvedPiece.startsWith(resolvedRepertoire + '/');
}

/**
 * Extract { owner, repo } from a package piece directory path.
 *
 * Directory structure: {repertoireDir}/@{owner}/{repo}/pieces/
 *
 * @returns { owner, repo } if pieceDir is a package piece, undefined otherwise.
 */
export function getPackageFromPieceDir(
  pieceDir: string,
  repertoireDir: string,
): { owner: string; repo: string } | undefined {
  if (!isPackagePiece(pieceDir, repertoireDir)) {
    return undefined;
  }
  const resolvedRepertoire = resolve(repertoireDir);
  const resolvedPiece = resolve(pieceDir);
  const relative = resolvedPiece.slice(resolvedRepertoire.length + 1);
  const parts = relative.split('/');
  if (parts.length < 2) return undefined;
  const ownerWithAt = parts[0]!;
  if (!ownerWithAt.startsWith('@')) return undefined;
  const owner = ownerWithAt.slice(1);
  const repo = parts[1]!;
  return { owner, repo };
}

/**
 * Build candidate directories with optional package-local layer (4-layer for package pieces).
 *
 * Resolution order for package pieces:
 *   1. package-local: {repertoireDir}/@{owner}/{repo}/facets/{type}
 *   2. project:       {projectDir}/.takt/facets/{type}
 *   3. user:          ~/.takt/facets/{type}
 *   4. builtin:       builtins/{lang}/facets/{type}
 *
 * For non-package pieces: 3-layer (project → user → builtin).
 */
export function buildCandidateDirsWithPackage(
  facetType: FacetType,
  context: FacetResolutionContext,
): string[] {
  const dirs: string[] = [];

  if (context.pieceDir && context.repertoireDir) {
    const pkg = getPackageFromPieceDir(context.pieceDir, context.repertoireDir);
    if (pkg) {
      dirs.push(getRepertoireFacetDir(pkg.owner, pkg.repo, facetType, context.repertoireDir));
    }
  }

  if (context.projectDir) {
    dirs.push(getProjectFacetDir(context.projectDir, facetType));
  }
  dirs.push(getGlobalFacetDir(facetType));
  dirs.push(getBuiltinFacetDir(context.lang, facetType));

  return dirs;
}

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
  pieceDir: string,
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
  if (refs == null) return undefined;
  const list = Array.isArray(refs) ? refs : [refs];
  const contents: string[] = [];
  for (const ref of list) {
    const content = resolveRefToContent(ref, resolvedMap, pieceDir, facetType, context);
    if (content) contents.push(content);
  }
  return contents.length > 0 ? contents : undefined;
}

/** Resolve persona from YAML field to spec + absolute path. */
export function resolvePersona(
  rawPersona: string | undefined,
  sections: import('../../../faceted-prompting/index.js').PieceSections,
  pieceDir: string,
  context?: FacetResolutionContext,
): { personaSpec?: string; personaPath?: string } {
  if (rawPersona && isScopeRef(rawPersona) && context?.repertoireDir) {
    const scopeRef = parseScopeRef(rawPersona);
    const personaPath = resolveScopeRef(scopeRef, 'personas', context.repertoireDir);
    return { personaSpec: rawPersona, personaPath: existsSync(personaPath) ? personaPath : undefined };
  }
  const candidateDirs = context
    ? buildCandidateDirsWithPackage('personas', context)
    : undefined;
  return resolvePersonaGeneric(rawPersona, sections, pieceDir, candidateDirs);
}

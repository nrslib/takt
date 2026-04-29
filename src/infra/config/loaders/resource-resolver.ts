/**
 * Resource resolution helpers for workflow YAML parsing.
 *
 * Facade: delegates to the faceted-prompting package and re-exports
 * its types/functions. resolveFacetPath and resolveFacetByName build
 * TAKT-specific candidate directories then delegate to the generic
 * implementation.
 */

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { FacetType } from '../paths.js';
import {
  resolveFacetPath as resolveFacetPathGeneric,
  resolvePersona as resolvePersonaGeneric,
  isResourcePath,
  resolveResourcePath,
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
  resolvedPoliciesWithSource?: ResolvedSectionMap;
  resolvedKnowledge?: Record<string, string>;
  resolvedKnowledgeWithSource?: ResolvedSectionMap;
  resolvedInstructions?: Record<string, string>;
  resolvedInstructionsWithSource?: ResolvedSectionMap;
  resolvedReportFormats?: Record<string, string>;
  resolvedReportFormatsWithSource?: ResolvedSectionMap;
}

export {
  isResourcePath,
  resolveResourcePath,
  resolveSectionMap,
  extractPersonaDisplayName,
} from 'faceted-prompting';

export type { FacetResolutionContext } from './workflowPackageScope.js';

export interface ResolvedFacetContent {
  content: string;
  sourcePath?: string;
  facetType?: FacetType;
  refName?: string;
}

export type ResolvedSectionMap = Record<string, ResolvedFacetContent>;

type ResolvedMapInput = Record<string, string> | ResolvedSectionMap;

interface FacetInheritanceFrame {
  sourcePath?: string;
  refName?: string;
}

interface ExtendsDirective {
  parentName: string;
  start: number;
  end: number;
}

function samePath(a: string, b: string): boolean {
  return resolve(a) === resolve(b);
}

function isPathInside(basePath: string, targetPath: string): boolean {
  const rel = relative(resolve(basePath), resolve(targetPath));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

function contentSourceLabel(content: ResolvedFacetContent): string {
  return content.sourcePath ?? content.refName ?? '<inline>';
}

function formatInheritanceChain(frames: FacetInheritanceFrame[], current: ResolvedFacetContent): string {
  return [...frames.map((frame) => frame.sourcePath ?? frame.refName ?? '<inline>'), contentSourceLabel(current)].join(' -> ');
}

function isResolvedFacetContent(value: string | ResolvedFacetContent): value is ResolvedFacetContent {
  return typeof value !== 'string';
}

function toResolvedContent(
  value: string | ResolvedFacetContent,
  facetType: FacetType | undefined,
  refName: string | undefined,
): ResolvedFacetContent {
  if (isResolvedFacetContent(value)) {
    return {
      ...value,
      facetType: value.facetType ?? facetType,
      refName: value.refName ?? refName,
    };
  }
  return { content: value, facetType, refName };
}

export function unwrapResolvedSectionMap(map: ResolvedSectionMap | undefined): Record<string, string> | undefined {
  if (!map) {
    return undefined;
  }
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(map)) {
    result[name] = value.content;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export function resolveResourceContentWithSource(
  spec: string | undefined,
  workflowDir: string,
  facetType?: FacetType,
  refName?: string,
): ResolvedFacetContent | undefined {
  if (spec == null) {
    return undefined;
  }
  if (spec.endsWith('.md')) {
    const resolved = resolveResourcePath(spec, workflowDir);
    if (existsSync(resolved)) {
      return {
        content: readFileSync(resolved, 'utf-8'),
        sourcePath: resolved,
        facetType,
        refName,
      };
    }
  }
  return { content: spec, facetType, refName };
}

export function resolveSectionMapWithSource(
  raw: Record<string, string> | undefined,
  workflowDir: string,
  facetType: FacetType,
): ResolvedSectionMap | undefined {
  if (!raw) {
    return undefined;
  }
  const resolved: ResolvedSectionMap = {};
  for (const [name, value] of Object.entries(raw)) {
    const content = resolveResourceContentWithSource(value, workflowDir, facetType, name);
    if (content?.content) {
      resolved[name] = content;
    }
  }
  return Object.keys(resolved).length > 0 ? resolved : undefined;
}

const EXTENDS_LIKE_PATTERN = /\{\s*extends\s*:[^}]*\}/g;
const EXTENDS_LINE_PATTERN = /^[ \t]*\{extends:\s*([^}]+?)\s*\}[ \t]*$/gm;
const BARE_FACET_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function isBareFacetName(name: string): boolean {
  return BARE_FACET_NAME_PATTERN.test(name)
    && !isResourcePath(name)
    && !isScopeRef(name);
}

function parseExtendsDirective(content: string, sourceLabel: string): ExtendsDirective | undefined {
  const likeMatches = [...content.matchAll(EXTENDS_LIKE_PATTERN)];
  if (content.includes('{extends:') && likeMatches.length === 0) {
    throw new Error(`Malformed facet extends directive in ${sourceLabel}`);
  }
  if (likeMatches.length === 0) {
    return undefined;
  }

  const lineMatches = [...content.matchAll(EXTENDS_LINE_PATTERN)];
  if (lineMatches.length !== likeMatches.length) {
    throw new Error(`Facet extends directive must be on its own line in ${sourceLabel}`);
  }
  if (lineMatches.length > 1) {
    throw new Error(`Facet file ${sourceLabel} contains multiple extends directives`);
  }

  const match = lineMatches[0]!;
  const parentName = (match[1] ?? '').trim();
  if (!isBareFacetName(parentName)) {
    throw new Error(`Unsupported facet extends parent "${parentName}" in ${sourceLabel}; only bare facet names are supported`);
  }

  const start = match.index;
  if (start === undefined) {
    throw new Error(`Malformed facet extends directive in ${sourceLabel}`);
  }
  return {
    parentName,
    start,
    end: start + match[0].length,
  };
}

function findSourceLayerIndex(sourcePath: string, candidateDirs: readonly string[]): number | undefined {
  const index = candidateDirs.findIndex((dir) => isPathInside(dir, sourcePath));
  return index >= 0 ? index : undefined;
}

function resolveFacetFromCandidateDirs(
  name: string,
  facetType: FacetType,
  candidateDirs: readonly string[],
  refName: string,
  excludeSourcePath?: string,
): ResolvedFacetContent | undefined {
  for (const dir of candidateDirs) {
    const filePath = join(dir, `${name}.md`);
    if (excludeSourcePath && samePath(filePath, excludeSourcePath)) {
      continue;
    }
    if (existsSync(filePath)) {
      return {
        content: readFileSync(filePath, 'utf-8'),
        sourcePath: filePath,
        facetType,
        refName,
      };
    }
  }
  return undefined;
}

function resolveParentFacetWithSource(
  parentName: string,
  facetType: FacetType,
  context: FacetResolutionContext | undefined,
  currentSourcePath: string,
): ResolvedFacetContent | undefined {
  if (!context) {
    return undefined;
  }

  const candidateDirs = buildCandidateDirsWithPackage(facetType, context);
  const sourceLayerIndex = findSourceLayerIndex(currentSourcePath, candidateDirs);
  const searchDirs = candidateDirs.slice(sourceLayerIndex ?? 0);
  return resolveFacetFromCandidateDirs(parentName, facetType, searchDirs, parentName, currentSourcePath);
}

function expandFacetInheritance(
  resolved: ResolvedFacetContent,
  facetType: FacetType | undefined,
  context: FacetResolutionContext | undefined,
  frames: FacetInheritanceFrame[] = [],
): ResolvedFacetContent {
  if (!facetType) {
    return resolved;
  }

  const sourceLabel = contentSourceLabel(resolved);
  const directive = parseExtendsDirective(resolved.content, sourceLabel);
  if (!directive) {
    return resolved;
  }

  if (!resolved.sourcePath) {
    throw new Error(`Facet extends directive in ${sourceLabel} requires a source file path`);
  }

  if (frames.some((frame) => frame.sourcePath && samePath(frame.sourcePath, resolved.sourcePath!))) {
    throw new Error(`Facet inheritance cycle detected: ${formatInheritanceChain(frames, resolved)}`);
  }

  const parent = resolveParentFacetWithSource(directive.parentName, facetType, context, resolved.sourcePath);
  if (!parent) {
    throw new Error(`Facet extends parent "${directive.parentName}" not found for ${sourceLabel}`);
  }

  const expandedParent = expandFacetInheritance(parent, facetType, context, [
    ...frames,
    { sourcePath: resolved.sourcePath, refName: resolved.refName },
  ]);
  return {
    ...resolved,
    content: `${resolved.content.slice(0, directive.start)}${expandedParent.content}${resolved.content.slice(directive.end)}`,
  };
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
  return resolveFacetByNameWithSource(name, facetType, context)?.content;
}

export function resolveFacetByNameWithSource(
  name: string,
  facetType: FacetType,
  context: FacetResolutionContext,
): ResolvedFacetContent | undefined {
  const filePath = resolveFacetPath(name, facetType, context);
  if (filePath) {
    return expandFacetInheritance(
      {
        content: readFileSync(filePath, 'utf-8'),
        sourcePath: filePath,
        facetType,
        refName: name,
      },
      facetType,
      context,
    );
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
  resolvedMap: ResolvedMapInput | undefined,
  workflowDir: string,
  facetType?: FacetType,
  context?: FacetResolutionContext,
): string | undefined {
  return resolveRefToContentWithSource(ref, resolvedMap, workflowDir, facetType, context)?.content;
}

export function resolveRefToContentWithSource(
  ref: string,
  resolvedMap: ResolvedMapInput | undefined,
  workflowDir: string,
  facetType?: FacetType,
  context?: FacetResolutionContext,
): ResolvedFacetContent | undefined {
  const mapped = resolvedMap?.[ref];
  if (mapped !== undefined) {
    return expandFacetInheritance(toResolvedContent(mapped, facetType, ref), facetType, context);
  }

  if (facetType && context && isScopeRef(ref) && context.repertoireDir) {
    const scopeRef = parseScopeRef(ref);
    const filePath = resolveScopeRef(scopeRef, facetType, context.repertoireDir);
    return existsSync(filePath)
      ? expandFacetInheritance({
          content: readFileSync(filePath, 'utf-8'),
          sourcePath: filePath,
          facetType,
          refName: ref,
        }, facetType, context)
      : undefined;
  }

  if (isResourcePath(ref)) {
    const resource = resolveResourceContentWithSource(ref, workflowDir, facetType, ref);
    return resource ? expandFacetInheritance(resource, facetType, context) : undefined;
  }

  const candidateDirs = facetType && context
    ? buildCandidateDirsWithPackage(facetType, context)
    : undefined;
  if (candidateDirs) {
    const facetContent = resolveFacetFromCandidateDirs(ref, facetType!, candidateDirs, ref);
    if (facetContent !== undefined) {
      return expandFacetInheritance(facetContent, facetType, context);
    }
  }

  const resource = resolveResourceContentWithSource(ref, workflowDir, facetType, ref);
  return resource ? expandFacetInheritance(resource, facetType, context) : undefined;
}

/** Resolve multiple references to content strings (for fields that accept string | string[]). */
export function resolveRefList(
  refs: string | string[] | undefined,
  resolvedMap: ResolvedMapInput | undefined,
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

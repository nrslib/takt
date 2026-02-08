/**
 * Resource resolution helpers for piece YAML parsing.
 *
 * Resolves file paths, content references, and persona specs
 * from piece-level section maps. Supports 3-layer facet resolution
 * (project → user → builtin).
 */

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import type { Language } from '../../../core/models/index.js';
import type { FacetType } from '../paths.js';
import { getProjectFacetDir, getGlobalFacetDir, getBuiltinFacetDir } from '../paths.js';

/** Context for 3-layer facet resolution. */
export interface FacetResolutionContext {
  projectDir: string;
  lang: Language;
}

/** Pre-resolved section maps passed to movement normalization. */
export interface PieceSections {
  /** Persona name → file path (raw, not content-resolved) */
  personas?: Record<string, string>;
  /** Policy name → resolved content */
  resolvedPolicies?: Record<string, string>;
  /** Knowledge name → resolved content */
  resolvedKnowledge?: Record<string, string>;
  /** Instruction name → resolved content */
  resolvedInstructions?: Record<string, string>;
  /** Report format name → resolved content */
  resolvedReportFormats?: Record<string, string>;
}

/**
 * Check if a spec looks like a resource path (vs. a facet name).
 * Paths start with './', '../', '/', '~' or end with '.md'.
 */
export function isResourcePath(spec: string): boolean {
  return (
    spec.startsWith('./') ||
    spec.startsWith('../') ||
    spec.startsWith('/') ||
    spec.startsWith('~') ||
    spec.endsWith('.md')
  );
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
  const candidateDirs = [
    getProjectFacetDir(context.projectDir, facetType),
    getGlobalFacetDir(facetType),
    getBuiltinFacetDir(context.lang, facetType),
  ];

  for (const dir of candidateDirs) {
    const filePath = join(dir, `${name}.md`);
    if (existsSync(filePath)) {
      return filePath;
    }
  }

  return undefined;
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
  const filePath = resolveFacetPath(name, facetType, context);
  if (filePath) {
    return readFileSync(filePath, 'utf-8');
  }
  return undefined;
}

/** Resolve a resource spec to an absolute file path. */
export function resolveResourcePath(spec: string, pieceDir: string): string {
  if (spec.startsWith('./')) return join(pieceDir, spec.slice(2));
  if (spec.startsWith('~')) return join(homedir(), spec.slice(1));
  if (spec.startsWith('/')) return spec;
  return join(pieceDir, spec);
}

/**
 * Resolve a resource spec to its file content.
 * If the spec ends with .md and the file exists, returns file content.
 * Otherwise returns the spec as-is (treated as inline content).
 */
export function resolveResourceContent(spec: string | undefined, pieceDir: string): string | undefined {
  if (spec == null) return undefined;
  if (spec.endsWith('.md')) {
    const resolved = resolveResourcePath(spec, pieceDir);
    if (existsSync(resolved)) return readFileSync(resolved, 'utf-8');
  }
  return spec;
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
  const mapped = resolvedMap?.[ref];
  if (mapped) return mapped;

  if (isResourcePath(ref)) {
    return resolveResourceContent(ref, pieceDir);
  }

  if (facetType && context) {
    const facetContent = resolveFacetByName(ref, facetType, context);
    if (facetContent !== undefined) return facetContent;
  }

  return resolveResourceContent(ref, pieceDir);
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

/** Resolve a piece-level section map (each value resolved to file content or inline). */
export function resolveSectionMap(
  raw: Record<string, string> | undefined,
  pieceDir: string,
): Record<string, string> | undefined {
  if (!raw) return undefined;
  const resolved: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    const content = resolveResourceContent(value, pieceDir);
    if (content) resolved[name] = content;
  }
  return Object.keys(resolved).length > 0 ? resolved : undefined;
}

/** Extract display name from persona path (e.g., "coder.md" → "coder"). */
export function extractPersonaDisplayName(personaPath: string): string {
  return basename(personaPath, '.md');
}

/** Resolve persona from YAML field to spec + absolute path. */
export function resolvePersona(
  rawPersona: string | undefined,
  sections: PieceSections,
  pieceDir: string,
  context?: FacetResolutionContext,
): { personaSpec?: string; personaPath?: string } {
  if (!rawPersona) return {};

  // If section map has explicit mapping, use it (path-based)
  const sectionMapping = sections.personas?.[rawPersona];
  if (sectionMapping) {
    const resolved = resolveResourcePath(sectionMapping, pieceDir);
    const personaPath = existsSync(resolved) ? resolved : undefined;
    return { personaSpec: sectionMapping, personaPath };
  }

  // If rawPersona is a path, resolve it directly
  if (isResourcePath(rawPersona)) {
    const resolved = resolveResourcePath(rawPersona, pieceDir);
    const personaPath = existsSync(resolved) ? resolved : undefined;
    return { personaSpec: rawPersona, personaPath };
  }

  // Name-based: try 3-layer resolution to find the persona file
  if (context) {
    const filePath = resolveFacetPath(rawPersona, 'personas', context);
    if (filePath) {
      return { personaSpec: rawPersona, personaPath: filePath };
    }
  }

  // Fallback: try as relative path from pieceDir (backward compat)
  const resolved = resolveResourcePath(rawPersona, pieceDir);
  const personaPath = existsSync(resolved) ? resolved : undefined;
  return { personaSpec: rawPersona, personaPath };
}

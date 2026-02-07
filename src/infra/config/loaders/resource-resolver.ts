/**
 * Resource resolution helpers for piece YAML parsing.
 *
 * Resolves file paths, content references, and persona specs
 * from piece-level section maps.
 */

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';

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
 * Looks up ref in resolvedMap first, then falls back to resolveResourceContent.
 */
export function resolveRefToContent(
  ref: string,
  resolvedMap: Record<string, string> | undefined,
  pieceDir: string,
): string | undefined {
  const mapped = resolvedMap?.[ref];
  if (mapped) return mapped;
  return resolveResourceContent(ref, pieceDir);
}

/** Resolve multiple references to content strings (for fields that accept string | string[]). */
export function resolveRefList(
  refs: string | string[] | undefined,
  resolvedMap: Record<string, string> | undefined,
  pieceDir: string,
): string[] | undefined {
  if (refs == null) return undefined;
  const list = Array.isArray(refs) ? refs : [refs];
  const contents: string[] = [];
  for (const ref of list) {
    const content = resolveRefToContent(ref, resolvedMap, pieceDir);
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
): { personaSpec?: string; personaPath?: string } {
  if (!rawPersona) return {};
  const personaSpec = sections.personas?.[rawPersona] ?? rawPersona;

  const resolved = resolveResourcePath(personaSpec, pieceDir);
  const personaPath = existsSync(resolved) ? resolved : undefined;
  return { personaSpec, personaPath };
}

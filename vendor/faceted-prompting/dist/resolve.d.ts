/**
 * Facet reference resolution utilities.
 *
 * Resolves facet names / paths / content from section maps
 * and candidate directories. Directory construction is delegated
 * to the caller (TAKT provides project/global/builtin dirs).
 *
 * This module depends only on node:fs, node:os, node:path.
 */
/** Pre-resolved section maps passed to movement normalization. */
export interface PieceSections {
    /** Persona name -> file path (raw, not content-resolved) */
    personas?: Record<string, string>;
    /** Policy name -> resolved content */
    resolvedPolicies?: Record<string, string>;
    /** Knowledge name -> resolved content */
    resolvedKnowledge?: Record<string, string>;
    /** Instruction name -> resolved content */
    resolvedInstructions?: Record<string, string>;
    /** Report format name -> resolved content */
    resolvedReportFormats?: Record<string, string>;
}
/**
 * Check if a spec looks like a resource path (vs. a facet name).
 * Paths start with './', '../', '/', '~' or end with '.md'.
 */
export declare function isResourcePath(spec: string): boolean;
/**
 * Resolve a facet name to its file path by scanning candidate directories.
 *
 * The caller builds the candidate list (e.g. project/.takt/{kind},
 * ~/.takt/{kind}, builtins/{lang}/{kind}) and passes it in.
 *
 * @returns Absolute file path if found, undefined otherwise.
 */
export declare function resolveFacetPath(name: string, candidateDirs: readonly string[]): string | undefined;
/**
 * Resolve a facet name to its file content via candidate directories.
 *
 * @returns File content if found, undefined otherwise.
 */
export declare function resolveFacetByName(name: string, candidateDirs: readonly string[]): string | undefined;
/** Resolve a resource spec to an absolute file path. */
export declare function resolveResourcePath(spec: string, pieceDir: string): string;
/**
 * Resolve a resource spec to its file content.
 * If the spec ends with .md and the file exists, returns file content.
 * Otherwise returns the spec as-is (treated as inline content).
 */
export declare function resolveResourceContent(spec: string | undefined, pieceDir: string): string | undefined;
/**
 * Resolve a section reference to content.
 * Looks up ref in resolvedMap first, then falls back to path resolution.
 * If candidateDirs are provided and ref is a name (not a path),
 * falls back to facet resolution via candidate directories.
 */
export declare function resolveRefToContent(ref: string, resolvedMap: Record<string, string> | undefined, pieceDir: string, candidateDirs?: readonly string[]): string | undefined;
/** Resolve multiple references to content strings (for fields that accept string | string[]). */
export declare function resolveRefList(refs: string | string[] | undefined, resolvedMap: Record<string, string> | undefined, pieceDir: string, candidateDirs?: readonly string[]): string[] | undefined;
/** Resolve a piece-level section map (each value resolved to file content or inline). */
export declare function resolveSectionMap(raw: Record<string, string> | undefined, pieceDir: string): Record<string, string> | undefined;
/** Extract display name from persona path (e.g., "coder.md" -> "coder"). */
export declare function extractPersonaDisplayName(personaPath: string): string;
/**
 * Resolve persona from YAML field to spec + absolute path.
 *
 * Candidate directories for name-based lookup are provided by the caller.
 */
export declare function resolvePersona(rawPersona: string | undefined, sections: PieceSections, pieceDir: string, candidateDirs?: readonly string[]): {
    personaSpec?: string;
    personaPath?: string;
};

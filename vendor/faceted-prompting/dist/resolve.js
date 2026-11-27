/**
 * Facet reference resolution utilities.
 *
 * Resolves facet names / paths / content from section maps
 * and candidate directories. Directory construction is delegated
 * to the caller (TAKT provides project/global/builtin dirs).
 *
 * This module depends only on node:fs, node:os, node:path.
 */
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
/**
 * Check if a spec looks like a resource path (vs. a facet name).
 * Paths start with './', '../', '/', '~' or end with '.md'.
 */
export function isResourcePath(spec) {
    return (spec.startsWith('./') ||
        spec.startsWith('../') ||
        spec.startsWith('/') ||
        spec.startsWith('~') ||
        spec.endsWith('.md'));
}
/**
 * Resolve a facet name to its file path by scanning candidate directories.
 *
 * The caller builds the candidate list (e.g. project/.takt/{kind},
 * ~/.takt/{kind}, builtins/{lang}/{kind}) and passes it in.
 *
 * @returns Absolute file path if found, undefined otherwise.
 */
export function resolveFacetPath(name, candidateDirs) {
    for (const dir of candidateDirs) {
        const filePath = join(dir, `${name}.md`);
        if (existsSync(filePath)) {
            return filePath;
        }
    }
    return undefined;
}
/**
 * Resolve a facet name to its file content via candidate directories.
 *
 * @returns File content if found, undefined otherwise.
 */
export function resolveFacetByName(name, candidateDirs) {
    const filePath = resolveFacetPath(name, candidateDirs);
    if (filePath) {
        return readFileSync(filePath, 'utf-8');
    }
    return undefined;
}
/** Resolve a resource spec to an absolute file path. */
export function resolveResourcePath(spec, pieceDir) {
    if (spec.startsWith('./'))
        return join(pieceDir, spec.slice(2));
    if (spec.startsWith('~'))
        return join(homedir(), spec.slice(1));
    if (spec.startsWith('/'))
        return spec;
    return join(pieceDir, spec);
}
/**
 * Resolve a resource spec to its file content.
 * If the spec ends with .md and the file exists, returns file content.
 * Otherwise returns the spec as-is (treated as inline content).
 */
export function resolveResourceContent(spec, pieceDir) {
    if (spec == null)
        return undefined;
    if (spec.endsWith('.md')) {
        const resolved = resolveResourcePath(spec, pieceDir);
        if (existsSync(resolved))
            return readFileSync(resolved, 'utf-8');
    }
    return spec;
}
/**
 * Resolve a section reference to content.
 * Looks up ref in resolvedMap first, then falls back to path resolution.
 * If candidateDirs are provided and ref is a name (not a path),
 * falls back to facet resolution via candidate directories.
 */
export function resolveRefToContent(ref, resolvedMap, pieceDir, candidateDirs) {
    const mapped = resolvedMap?.[ref];
    if (mapped)
        return mapped;
    if (isResourcePath(ref)) {
        return resolveResourceContent(ref, pieceDir);
    }
    if (candidateDirs) {
        const facetContent = resolveFacetByName(ref, candidateDirs);
        if (facetContent !== undefined)
            return facetContent;
    }
    return resolveResourceContent(ref, pieceDir);
}
/** Resolve multiple references to content strings (for fields that accept string | string[]). */
export function resolveRefList(refs, resolvedMap, pieceDir, candidateDirs) {
    if (refs == null)
        return undefined;
    const list = Array.isArray(refs) ? refs : [refs];
    const contents = [];
    for (const ref of list) {
        const content = resolveRefToContent(ref, resolvedMap, pieceDir, candidateDirs);
        if (content)
            contents.push(content);
    }
    return contents.length > 0 ? contents : undefined;
}
/** Resolve a piece-level section map (each value resolved to file content or inline). */
export function resolveSectionMap(raw, pieceDir) {
    if (!raw)
        return undefined;
    const resolved = {};
    for (const [name, value] of Object.entries(raw)) {
        const content = resolveResourceContent(value, pieceDir);
        if (content)
            resolved[name] = content;
    }
    return Object.keys(resolved).length > 0 ? resolved : undefined;
}
/** Extract display name from persona path (e.g., "coder.md" -> "coder"). */
export function extractPersonaDisplayName(personaPath) {
    return basename(personaPath, '.md');
}
/**
 * Resolve persona from YAML field to spec + absolute path.
 *
 * Candidate directories for name-based lookup are provided by the caller.
 */
export function resolvePersona(rawPersona, sections, pieceDir, candidateDirs) {
    if (!rawPersona)
        return {};
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
    // Name-based: try candidate directories
    if (candidateDirs) {
        const filePath = resolveFacetPath(rawPersona, candidateDirs);
        if (filePath) {
            return { personaSpec: rawPersona, personaPath: filePath };
        }
    }
    // Fallback: try as relative path from pieceDir
    const resolved = resolveResourcePath(rawPersona, pieceDir);
    const personaPath = existsSync(resolved) ? resolved : undefined;
    return { personaSpec: rawPersona, personaPath };
}

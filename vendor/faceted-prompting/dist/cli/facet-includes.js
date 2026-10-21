import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isScopeRef, parseScopeRef, resolveScopeRef } from '../scope.js';
import { ensurePathWithinRoots } from './path-guard.js';
import { facetPartialsDir, facetPartialsFacetDir, isFacetPartialKind, } from '../facet-partial-paths.js';
const INCLUDE_TOKEN_PATTERN = /\{\{\s*include\s*:\s*([^}]*)\}\}/gu;
const LOCAL_INCLUDE_NAME_PATTERN = /^[A-Za-z0-9._-]+$/u;
function readFacetPartial(params) {
    const boundedPath = ensurePathWithinRoots(params.path, params.allowedRoots, `facet include "${params.ref}"`);
    if (!statSync(boundedPath).isFile()) {
        throw new Error(`Facet include "${params.ref}" must resolve to a file: ${boundedPath}`);
    }
    return {
        ref: params.ref,
        body: readFileSync(boundedPath, 'utf-8'),
        path: boundedPath,
    };
}
function parseFacetIncludeRef(rawRef) {
    const ref = rawRef.trim();
    if (ref.length === 0) {
        throw new Error('Invalid facet include: missing include name');
    }
    const separatorIndex = ref.indexOf('/');
    if (separatorIndex < 0) {
        throw new Error(`Invalid facet include "${ref}": expected {{include:<kind>/<name>}}`);
    }
    const kind = ref.slice(0, separatorIndex);
    const name = ref.slice(separatorIndex + 1);
    if (!isFacetPartialKind(kind) || name.length === 0) {
        throw new Error(`Invalid facet include "${ref}": expected {{include:<kind>/<name>}}`);
    }
    if (isScopeRef(name) || LOCAL_INCLUDE_NAME_PATTERN.test(name)) {
        return { kind, ref, name };
    }
    throw new Error(`Invalid facet include "${ref}": expected {{include:<kind>/<name>}}`);
}
function resolveScopedFacetPartial(params) {
    const parsed = parseScopeRef(params.scopeRef);
    const candidatePaths = params.repertoireDirs.map(repertoireDir => resolveScopeRef(parsed, facetPartialsFacetDir(params.kind), repertoireDir));
    const candidatePath = candidatePaths.find(path => existsSync(path));
    if (!candidatePath) {
        throw new Error(`Missing facet include "${params.ref}": ${candidatePaths.join(', ')}`);
    }
    return readFacetPartial({
        path: candidatePath,
        ref: params.ref,
        allowedRoots: params.allowedRoots,
    });
}
function resolveFacetPartial(params) {
    if (isScopeRef(params.name)) {
        return resolveScopedFacetPartial({
            ref: params.ref,
            scopeRef: params.name,
            kind: params.kind,
            repertoireDirs: params.repertoireDirs,
            allowedRoots: params.allowedRoots,
        });
    }
    const candidatePaths = params.facetsRoots.map(facetsRoot => join(facetPartialsDir(facetsRoot, params.kind), `${params.name}.md`));
    for (const candidatePath of candidatePaths) {
        if (!existsSync(candidatePath)) {
            continue;
        }
        return readFacetPartial({
            path: candidatePath,
            ref: params.ref,
            allowedRoots: params.allowedRoots,
        });
    }
    throw new Error(`Missing facet include "${params.ref}": ${candidatePaths.join(', ')}`);
}
function collectIncludeTokens(body) {
    return Array.from(body.matchAll(INCLUDE_TOKEN_PATTERN), match => {
        const token = match[0];
        const rawRef = match[1];
        const index = match.index;
        if (rawRef === undefined || index === undefined) {
            throw new Error(`Invalid facet include token: ${token}`);
        }
        return { token, rawRef, index };
    });
}
function requireNonCyclicInclude(partial, stack) {
    const cycleStart = stack.findIndex(frame => frame.path === partial.path);
    if (cycleStart < 0) {
        return;
    }
    const chain = stack
        .slice(cycleStart)
        .map(frame => frame.ref)
        .concat(partial.ref);
    throw new Error(`Cyclic facet include: ${chain.join(' -> ')}`);
}
function expandBody(params) {
    const initial = { body: '', sourcePaths: [], cursor: 0 };
    const expanded = collectIncludeTokens(params.body).reduce((accumulator, includeToken) => {
        const parsed = parseFacetIncludeRef(includeToken.rawRef);
        const partial = resolveFacetPartial({
            ref: parsed.ref,
            name: parsed.name,
            kind: parsed.kind,
            facetsRoots: params.facetsRoots,
            repertoireDirs: params.repertoireDirs,
            allowedRoots: params.allowedRoots,
        });
        requireNonCyclicInclude(partial, params.stack);
        const nested = expandBody({
            body: partial.body,
            facetsRoots: params.facetsRoots,
            repertoireDirs: params.repertoireDirs,
            allowedRoots: params.allowedRoots,
            stack: params.stack.concat({ ref: partial.ref, path: partial.path }),
        });
        return {
            body: `${accumulator.body}${params.body.slice(accumulator.cursor, includeToken.index)}${nested.body}`,
            sourcePaths: [...accumulator.sourcePaths, partial.path, ...nested.sourcePaths],
            cursor: includeToken.index + includeToken.token.length,
        };
    }, initial);
    return {
        body: expanded.body + params.body.slice(expanded.cursor),
        sourcePaths: expanded.sourcePaths,
    };
}
export function expandFacetIncludes(params) {
    return expandBody({
        body: params.body,
        facetsRoots: params.facetsRoots,
        repertoireDirs: params.repertoireDirs,
        allowedRoots: params.allowedRoots,
        stack: [],
    });
}

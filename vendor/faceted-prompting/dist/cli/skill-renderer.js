import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isResourcePath, resolveResourcePath } from '../resolve.js';
import { isScopeRef, parseScopeRef, resolveScopeRef } from '../scope.js';
import { ensurePathWithinRoots } from './path-guard.js';
import { expandFacetIncludes } from './facet-includes.js';
export { hasYamlFrontmatter, renderSkillDocument, renderSkillFrontmatter } from './skill-document-renderer.js';
function requireFile(path, label) {
    if (!existsSync(path)) {
        throw new Error(`Missing ${label}: ${path}`);
    }
    return readFileSync(path, 'utf-8');
}
export function ensureSafeDefinitionName(name) {
    if (!/^[A-Za-z0-9._-]+$/u.test(name)) {
        throw new Error(`Invalid compose definition name: ${name}`);
    }
    return name;
}
function resolveFacetRefContent(options) {
    const resolved = resolveOptionalFacetRefContent(options);
    if (resolved) {
        return resolved;
    }
    const primaryFacetDir = options.facetDirs[0];
    if (!primaryFacetDir) {
        throw new Error(`Missing ${options.label}: facet directory is required`);
    }
    throw new Error(`Missing ${options.label}: ${join(primaryFacetDir, `${options.ref}.md`)}`);
}
function resolveOptionalFacetRefContent(options) {
    const { ref, label, baseDir, facetDirs, allowedRoots, resourceAllowedRoots, repertoireRoots, scopeFacetKind } = options;
    const primaryFacetDir = facetDirs[0];
    if (!primaryFacetDir) {
        throw new Error(`Missing ${label}: facet directory is required`);
    }
    if (isScopeRef(ref)) {
        if (repertoireRoots.length === 0) {
            throw new Error(`Missing ${label}: scope reference requires repertoire roots`);
        }
        const scopeRef = parseScopeRef(ref);
        for (const repertoireRoot of repertoireRoots) {
            const scopePath = resolveScopeRef(scopeRef, scopeFacetKind, repertoireRoot);
            if (!existsSync(scopePath)) {
                continue;
            }
            const boundedPath = ensurePathWithinRoots(scopePath, repertoireRoots, label);
            return { path: boundedPath, body: requireFile(boundedPath, label) };
        }
        throw new Error(`Missing ${label}: ${resolveScopeRef(scopeRef, scopeFacetKind, repertoireRoots[0])}`);
    }
    if (isResourcePath(ref)) {
        const resourcePath = resolveResourcePath(ref, baseDir);
        if (!existsSync(resourcePath)) {
            throw new Error(`Missing ${label}: ${resourcePath}`);
        }
        const boundedPath = ensurePathWithinRoots(resourcePath, resourceAllowedRoots, label);
        return { path: boundedPath, body: readFileSync(boundedPath, 'utf-8') };
    }
    for (const facetDir of facetDirs) {
        const facetPath = join(facetDir, `${ref}.md`);
        if (!existsSync(facetPath)) {
            continue;
        }
        const boundedPath = ensurePathWithinRoots(facetPath, allowedRoots, label);
        return { path: boundedPath, body: requireFile(boundedPath, label) };
    }
    return undefined;
}
function resolveFacetsRoots(params) {
    if (params.facetsRoots && params.facetsRoots.length > 0) {
        return params.facetsRoots;
    }
    if (params.facetsRoot) {
        return [params.facetsRoot];
    }
    throw new Error('Facet roots are required');
}
function expandFileBackedFacetSection(params) {
    const expanded = expandFacetIncludes({
        body: params.resolved.body,
        facetsRoots: params.facetsRoots,
        repertoireDirs: params.repertoireRoots,
        allowedRoots: params.allowedRoots,
    });
    return {
        ref: params.ref,
        body: expanded.body,
        path: params.resolved.path,
        sourcePaths: [params.resolved.path, ...expanded.sourcePaths],
    };
}
function expandFileBackedInstructionSection(params) {
    const section = expandFileBackedFacetSection(params);
    return {
        ref: section.ref,
        body: section.body,
        path: section.path,
        sourcePaths: section.sourcePaths,
    };
}
export function resolveDefinitionSections(params) {
    const { definition, definitionDir } = params;
    const facetsRoots = resolveFacetsRoots(params);
    const facetAllowedRoots = facetsRoots;
    const resourceAllowedRoots = [definitionDir, ...facetsRoots];
    const repertoireRoots = params.facetedRoots?.map(facetedRoot => join(facetedRoot, 'repertoire')) ?? [];
    const includeRepertoireRoots = repertoireRoots.length > 0
        ? repertoireRoots
        : facetsRoots.map(facetsRoot => join(dirname(facetsRoot), 'repertoire'));
    const includeAllowedRoots = [...facetsRoots, ...includeRepertoireRoots];
    const personaContent = resolveFacetRefContent({
        ref: definition.persona,
        label: `persona facet "${definition.persona}"`,
        baseDir: definitionDir,
        facetDirs: facetsRoots.map(facetsRoot => join(facetsRoot, 'persona')),
        allowedRoots: facetAllowedRoots,
        resourceAllowedRoots,
        repertoireRoots,
        scopeFacetKind: 'personas',
    });
    const policies = definition.policies?.map(ref => {
        const resolved = resolveFacetRefContent({
            ref,
            label: `policy facet "${ref}"`,
            baseDir: definitionDir,
            facetDirs: facetsRoots.map(facetsRoot => join(facetsRoot, 'policies')),
            allowedRoots: facetAllowedRoots,
            resourceAllowedRoots,
            repertoireRoots,
            scopeFacetKind: 'policies',
        });
        return expandFileBackedFacetSection({
            ref,
            resolved,
            facetsRoots,
            repertoireRoots: includeRepertoireRoots,
            allowedRoots: includeAllowedRoots,
        });
    }) ?? [];
    const knowledge = definition.knowledge?.map(ref => {
        const resolved = resolveFacetRefContent({
            ref,
            label: `knowledge facet "${ref}"`,
            baseDir: definitionDir,
            facetDirs: facetsRoots.map(facetsRoot => join(facetsRoot, 'knowledge')),
            allowedRoots: facetAllowedRoots,
            resourceAllowedRoots,
            repertoireRoots,
            scopeFacetKind: 'knowledge',
        });
        return expandFileBackedFacetSection({
            ref,
            resolved,
            facetsRoots,
            repertoireRoots: includeRepertoireRoots,
            allowedRoots: includeAllowedRoots,
        });
    }) ?? [];
    const instructions = definition.instructions?.map((ref) => {
        const resolved = resolveOptionalFacetRefContent({
            ref,
            label: `instruction facet "${ref}"`,
            baseDir: definitionDir,
            facetDirs: facetsRoots.map(facetsRoot => join(facetsRoot, 'instructions')),
            allowedRoots: facetAllowedRoots,
            resourceAllowedRoots,
            repertoireRoots,
            scopeFacetKind: 'instructions',
        });
        if (!resolved) {
            return { ref: 'literal', body: ref };
        }
        return expandFileBackedInstructionSection({
            ref,
            resolved,
            facetsRoots,
            repertoireRoots: includeRepertoireRoots,
            allowedRoots: includeAllowedRoots,
        });
    }) ?? [];
    const outputContracts = definition.outputContracts?.map(ref => {
        const resolved = resolveFacetRefContent({
            ref,
            label: `output-contracts facet "${ref}"`,
            baseDir: definitionDir,
            facetDirs: facetsRoots.map(facetsRoot => join(facetsRoot, 'output-contracts')),
            allowedRoots: facetAllowedRoots,
            resourceAllowedRoots,
            repertoireRoots,
            scopeFacetKind: 'output-contracts',
        });
        return expandFileBackedFacetSection({
            ref,
            resolved,
            facetsRoots,
            repertoireRoots: includeRepertoireRoots,
            allowedRoots: includeAllowedRoots,
        });
    }) ?? [];
    return {
        persona: {
            ref: definition.persona,
            body: personaContent.body,
            path: personaContent.path,
        },
        policies,
        knowledge,
        instructions,
        outputContracts,
    };
}
export function listCompositionDefinitions(compositionsDirs) {
    const dirs = Array.isArray(compositionsDirs) ? compositionsDirs : [compositionsDirs];
    const definitions = {};
    for (const compositionsDir of dirs) {
        if (!existsSync(compositionsDir)) {
            continue;
        }
        const entries = readdirSync(compositionsDir, { withFileTypes: true })
            .filter(entry => !entry.isDirectory() && (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml')))
            .map(entry => entry.name)
            .sort();
        for (const entry of entries) {
            const name = entry.replace(/\.(yaml|yml)$/u, '');
            if (name in definitions) {
                continue;
            }
            const definitionPath = join(compositionsDir, entry);
            definitions[name] = ensurePathWithinRoots(definitionPath, [compositionsDir], `compose definition "${entry}"`);
        }
    }
    return definitions;
}
export function buildFacetSet(params) {
    const resolved = resolveDefinitionSections(params);
    return buildFacetSetFromResolvedSections(resolved);
}
export function buildFacetSetFromResolvedSections(resolved) {
    return {
        persona: { body: resolved.persona.body, sourcePath: resolved.persona.path },
        policies: resolved.policies.map(policy => ({ body: policy.body, sourcePath: policy.path })),
        knowledge: resolved.knowledge.map(item => ({ body: item.body, sourcePath: item.path })),
        instructions: resolved.instructions.map(instruction => 'path' in instruction
            ? { body: instruction.body, sourcePath: instruction.path }
            : { body: instruction.body }),
        outputContracts: resolved.outputContracts.map(outputContract => ({
            body: outputContract.body,
            sourcePath: outputContract.path,
        })),
    };
}
export function buildSkillSections(params) {
    const { definition } = params;
    const resolved = resolveDefinitionSections(params);
    return {
        definition,
        persona: resolved.persona,
        policies: resolved.policies,
        knowledge: resolved.knowledge,
        instructions: resolved.instructions,
        outputContracts: resolved.outputContracts,
    };
}
export function resolveDefinitionPathFromSource(source, compositionsDir) {
    return ensurePathWithinRoots(join(compositionsDir, source), [compositionsDir], `compose definition "${source}"`);
}

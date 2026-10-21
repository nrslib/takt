import { compose } from './compose.js';
import { buildFacetSetFromResolvedSections, resolveDefinitionSections } from './cli/skill-renderer.js';
import { facetPartialKindFromPath } from './facet-partial-paths.js';
function instructionFacetPath(instruction) {
    if ('path' in instruction) {
        return instruction.path;
    }
    return undefined;
}
function partialSourcePaths(section) {
    if (!('path' in section) || !section.sourcePaths) {
        return [];
    }
    return section.sourcePaths.filter(path => path !== section.path);
}
function dedupePaths(paths) {
    return paths.reduce((deduped, path) => deduped.includes(path) ? deduped : [...deduped, path], []);
}
function buildCopyFiles(resolved) {
    const facetPartials = dedupePaths([
        ...resolved.knowledge.flatMap(section => partialSourcePaths(section)),
        ...resolved.policies.flatMap(section => partialSourcePaths(section)),
        ...resolved.instructions.flatMap(section => partialSourcePaths(section)),
        ...resolved.outputContracts.flatMap(section => partialSourcePaths(section)),
    ]);
    const instructionPartials = facetPartials.filter(path => facetPartialKindFromPath(path) === 'instructions');
    return {
        persona: [resolved.persona.path],
        knowledge: resolved.knowledge.map(section => section.path),
        policies: resolved.policies.map(section => section.path),
        instructions: dedupePaths(resolved.instructions
            .map(instruction => instructionFacetPath(instruction))
            .filter(path => path !== undefined)),
        outputContracts: resolved.outputContracts.map(section => section.path),
        ...(facetPartials.length > 0 ? { facetPartials } : {}),
        ...(instructionPartials.length > 0 ? { instructionPartials } : {}),
    };
}
export function composePromptPayload(params) {
    const resolved = resolveDefinitionSections(params);
    const facetSet = buildFacetSetFromResolvedSections(resolved);
    const composed = compose(facetSet, {
        ...params.composeOptions,
        userMessageOrder: params.definition.order,
    });
    return {
        systemPrompt: composed.systemPrompt,
        userPrompt: composed.userMessage,
        copyFiles: buildCopyFiles(resolved),
    };
}

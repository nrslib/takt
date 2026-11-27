/**
 * Facet composition — the core placement rule.
 *
 *   system prompt:  persona only    (WHO)
 *   user message:   knowledge + instructions + output-contracts + policies
 *                   (WHAT TO KNOW / WHAT TO DO / HOW TO ANSWER / HOW)
 *
 * This module has ZERO dependencies on TAKT internals.
 */
import { DEFAULT_USER_MESSAGE_ORDER } from './types.js';
import { prepareKnowledgeContent, preparePolicyContent } from './truncation.js';
function renderOrderedUserPart(entry, facets, contextMaxChars) {
    if (entry === 'policies') {
        if (!facets.policies || facets.policies.length === 0)
            return [];
        const joined = facets.policies.map(p => p.body).join('\n\n---\n\n');
        const sourcePath = facets.policies.length === 1
            ? facets.policies[0].sourcePath
            : undefined;
        return [preparePolicyContent(joined, contextMaxChars, sourcePath)];
    }
    if (entry === 'knowledge') {
        if (!facets.knowledge || facets.knowledge.length === 0)
            return [];
        const joined = facets.knowledge.map(k => k.body).join('\n\n---\n\n');
        const sourcePath = facets.knowledge.length === 1
            ? facets.knowledge[0].sourcePath
            : undefined;
        return [prepareKnowledgeContent(joined, contextMaxChars, sourcePath)];
    }
    if (entry === 'instructions') {
        return facets.instructions?.map(instruction => instruction.body) ?? [];
    }
    return facets.outputContracts?.map(outputContract => outputContract.body) ?? [];
}
/**
 * Compose facets into an LLM-ready prompt according to Faceted Prompting
 * placement rules.
 *
 * - persona → systemPrompt
 * - knowledge / instructions / output-contracts / policies → userMessage
 *
 * Policies are placed last so they serve as the most recent constraint
 * the model sees before generating output.
 */
export function compose(facets, options) {
    const systemPrompt = facets.persona?.body ?? '';
    const order = options.userMessageOrder ?? DEFAULT_USER_MESSAGE_ORDER;
    const userParts = order.flatMap(entry => renderOrderedUserPart(entry, facets, options.contextMaxChars));
    return {
        systemPrompt,
        userMessage: userParts.join('\n\n'),
    };
}

/**
 * Facet composition — the core placement rule.
 *
 *   system prompt:  persona only    (WHO)
 *   user message:   knowledge + instructions + output-contracts + policies
 *                   (WHAT TO KNOW / WHAT TO DO / HOW TO ANSWER / HOW)
 *
 * This module has ZERO dependencies on TAKT internals.
 */
import type { FacetSet, ComposedPrompt, ComposeOptions } from './types.js';
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
export declare function compose(facets: FacetSet, options: ComposeOptions): ComposedPrompt;

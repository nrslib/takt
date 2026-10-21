/**
 * Core type definitions for Faceted Prompting.
 *
 * Defines the vocabulary of facets (persona, policy, knowledge, instruction,
 * output-contracts) and the structures used by compose() and DataEngine.
 *
 * This module has ZERO dependencies on TAKT internals.
 */
/** Plural directory names used in facet resolution. */
export type FacetKind = 'personas' | 'policies' | 'knowledge' | 'instructions' | 'output-contracts';
/** A single piece of facet content with optional metadata. */
export interface FacetContent {
    /** Raw text body of the facet. */
    readonly body: string;
    /** Filesystem path the content was loaded from, if applicable. */
    readonly sourcePath?: string;
}
/**
 * A complete set of resolved facet contents to be composed.
 *
 * All fields are optional — a FacetSet may contain only a subset of facets.
 */
export interface FacetSet {
    readonly persona?: FacetContent;
    readonly policies?: readonly FacetContent[];
    readonly knowledge?: readonly FacetContent[];
    readonly instructions?: readonly FacetContent[];
    readonly outputContracts?: readonly FacetContent[];
}
/**
 * The output of compose(): facet content assigned to LLM message slots.
 *
 * persona → systemPrompt
 * knowledge + instructions + output-contracts + policies → userMessage
 */
export interface ComposedPrompt {
    readonly systemPrompt: string;
    readonly userMessage: string;
}
export interface CopyFiles {
    readonly persona: readonly string[];
    readonly knowledge: readonly string[];
    readonly policies: readonly string[];
    readonly instructions: readonly string[];
    readonly outputContracts: readonly string[];
    readonly facetPartials?: readonly string[];
    readonly instructionPartials?: readonly string[];
}
export interface ComposedPromptPayload {
    readonly systemPrompt: string;
    readonly userPrompt: string;
    readonly copyFiles: CopyFiles;
}
/** User-message sections that can be ordered in compose definitions. */
export type ComposeOrderEntry = 'policies' | 'knowledge' | 'instructions' | 'output-contracts';
export declare const DEFAULT_USER_MESSAGE_ORDER: readonly ComposeOrderEntry[];
/** CLI compose definition loaded from YAML. */
export interface ComposeDefinition {
    readonly name: string;
    readonly description?: string;
    readonly persona: string;
    readonly template?: string;
    readonly knowledge?: readonly string[];
    readonly policies?: readonly string[];
    readonly instructions?: readonly string[];
    readonly outputContracts?: readonly string[];
    readonly order?: readonly ComposeOrderEntry[];
}
/** Options controlling compose() behaviour. */
export interface ComposeOptions {
    /** Maximum character length for knowledge/policy content before truncation. */
    readonly contextMaxChars: number;
    /** Optional user-message section order for knowledge/instructions/output-contracts/policies. */
    readonly userMessageOrder?: readonly ComposeOrderEntry[];
}

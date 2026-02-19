/**
 * Core type definitions for Faceted Prompting.
 *
 * Defines the vocabulary of facets (persona, policy, knowledge, instruction,
 * output-contract) and the structures used by compose() and DataEngine.
 *
 * This module has ZERO dependencies on TAKT internals.
 */

/** Plural directory names used in facet resolution. */
export type FacetKind =
  | 'personas'
  | 'policies'
  | 'knowledge'
  | 'instructions'
  | 'output-contracts';

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
  readonly instruction?: FacetContent;
}

/**
 * The output of compose(): facet content assigned to LLM message slots.
 *
 * persona → systemPrompt
 * policy + knowledge + instruction → userMessage
 */
export interface ComposedPrompt {
  readonly systemPrompt: string;
  readonly userMessage: string;
}

/** Options controlling compose() behaviour. */
export interface ComposeOptions {
  /** Maximum character length for knowledge/policy content before truncation. */
  readonly contextMaxChars: number;
}

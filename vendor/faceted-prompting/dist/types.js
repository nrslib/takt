/**
 * Core type definitions for Faceted Prompting.
 *
 * Defines the vocabulary of facets (persona, policy, knowledge, instruction,
 * output-contracts) and the structures used by compose() and DataEngine.
 *
 * This module has ZERO dependencies on TAKT internals.
 */
export const DEFAULT_USER_MESSAGE_ORDER = [
    'knowledge',
    'instructions',
    'output-contracts',
    'policies',
];

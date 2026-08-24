/**
 * Interactive mode variants for conversational task input.
 *
 * Defines the modes available when using interactive mode:
 * - assistant: Asks clarifying questions before generating instructions (default)
 * - grill-me: Resolves requirement decisions one question at a time
 * - persona: Uses the first step's persona for conversation
 */

/** Available interactive mode variants */
export const INTERACTIVE_MODES = ['assistant', 'grill-me', 'persona'] as const;

/** Interactive mode type */
export type InteractiveMode = typeof INTERACTIVE_MODES[number];

/** Interactive modes backed by the assistant conversation loop. */
export type AssistantInteractiveMode = Extract<InteractiveMode, 'assistant' | 'grill-me'>;

/** Default interactive mode */
export const DEFAULT_INTERACTIVE_MODE: InteractiveMode = 'assistant';

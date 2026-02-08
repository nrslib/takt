/**
 * Interactive mode variants for conversational task input.
 *
 * Defines the four modes available when using interactive mode:
 * - assistant: Asks clarifying questions before generating instructions (default)
 * - persona: Uses the first movement's persona for conversation
 * - quiet: Generates instructions without asking questions (best-effort)
 * - passthrough: Passes user input directly as task text
 */

/** Available interactive mode variants */
export const INTERACTIVE_MODES = ['assistant', 'persona', 'quiet', 'passthrough'] as const;

/** Interactive mode type */
export type InteractiveMode = typeof INTERACTIVE_MODES[number];

/** Default interactive mode */
export const DEFAULT_INTERACTIVE_MODE: InteractiveMode = 'assistant';

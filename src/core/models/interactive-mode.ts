/** Available interactive mode variants */
export const INTERACTIVE_MODES = ['assistant', 'persona', 'quiet', 'passthrough', 'none'] as const;

/** Interactive mode type */
export type InteractiveMode = typeof INTERACTIVE_MODES[number];

/** Default interactive mode */
export const DEFAULT_INTERACTIVE_MODE: InteractiveMode = 'assistant';

/**
 * Interactive mode selection UI.
 *
 * Presents the four interactive mode options after piece selection
 * and returns the user's choice.
 */

import type { InteractiveMode } from '../../core/models/index.js';
import { DEFAULT_INTERACTIVE_MODE, INTERACTIVE_MODES } from '../../core/models/index.js';
import { selectOptionWithDefault } from '../../shared/prompt/index.js';
import { getLabel } from '../../shared/i18n/index.js';

/**
 * Prompt the user to select an interactive mode.
 *
 * @param lang - Display language
 * @param pieceDefault - Piece-level default mode (overrides user default)
 * @returns Selected mode, or null if cancelled
 */
export async function selectInteractiveMode(
  lang: 'en' | 'ja',
  pieceDefault?: InteractiveMode,
): Promise<InteractiveMode | null> {
  const defaultMode = pieceDefault ?? DEFAULT_INTERACTIVE_MODE;

  const options: { label: string; value: InteractiveMode; description: string }[] = INTERACTIVE_MODES.map((mode) => ({
    label: getLabel(`interactive.modeSelection.${mode}`, lang),
    value: mode,
    description: getLabel(`interactive.modeSelection.${mode}Description`, lang),
  }));

  const prompt = getLabel('interactive.modeSelection.prompt', lang);

  return selectOptionWithDefault<InteractiveMode>(prompt, options, defaultMode);
}

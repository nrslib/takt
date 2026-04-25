/**
 * Interactive mode selection UI.
 *
 * Presents the four interactive mode options after workflow selection
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
 * @param workflowDefault - Workflow-level default mode (overrides user default)
 * @returns Selected mode, or null if cancelled
 */
export async function selectInteractiveMode(
  lang: 'en' | 'ja',
  workflowDefault?: InteractiveMode,
  availableModes?: readonly InteractiveMode[],
): Promise<InteractiveMode | null> {
  const resolvedModes = availableModes ?? INTERACTIVE_MODES;
  if (resolvedModes.length === 0) {
    throw new Error('At least one interactive mode must be available.');
  }
  const [firstMode] = resolvedModes;
  if (!firstMode) {
    throw new Error('At least one interactive mode must be available.');
  }

  const defaultMode = workflowDefault && resolvedModes.includes(workflowDefault)
    ? workflowDefault
    : (resolvedModes.includes(DEFAULT_INTERACTIVE_MODE)
      ? DEFAULT_INTERACTIVE_MODE
      : firstMode);

  const options: { label: string; value: InteractiveMode; description: string }[] = resolvedModes.map((mode) => ({
    label: getLabel(`interactive.modeSelection.${mode}`, lang),
    value: mode,
    description: getLabel(`interactive.modeSelection.${mode}Description`, lang),
  }));

  const prompt = getLabel('interactive.modeSelection.prompt', lang);

  return selectOptionWithDefault<InteractiveMode>(prompt, options, defaultMode);
}

/**
 * Asks one question on the TUI and gives the terminal straight back.
 *
 * The exec menus run on the bare terminal, so a question that comes up inside
 * one mounts Ink for as long as the answer takes and no longer.
 */

import { getLabel } from '../../shared/i18n/index.js';
import { mountInk } from './inkMount.js';
import { PromptScreen } from './PromptScreen.js';

export interface RunTuiPromptOptions {
  readonly lang: 'en' | 'ja';
  /** The question, as the caller words it. */
  readonly question: string;
  /** Prefilled answer; empty for a blank prompt. */
  readonly initialText?: string;
  /**
   * True when an empty answer keeps whatever the setting already holds, which
   * is what the hint has to say for the user to rely on it.
   */
  readonly emptyKeepsCurrent?: boolean;
}

/** The answer, or null when the user backed out. */
export function runTuiPrompt(options: RunTuiPromptOptions): Promise<string | null> {
  const hint = getLabel(
    options.emptyKeepsCurrent === true ? 'tui.ui.promptKeepHint' : 'tui.ui.promptHint',
    options.lang,
  );
  return mountInk<string | null>(({ settle }) => (
    <PromptScreen
      question={options.question}
      hint={hint}
      placeholder={getLabel('tui.ui.promptPlaceholder', options.lang)}
      initialText={options.initialText ?? ''}
      onDone={settle}
    />
  ), getLabel('tui.errors.exitedEarly', options.lang));
}

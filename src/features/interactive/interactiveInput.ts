import type { Language } from '../../core/models/config-types.js';
import { getLabel } from '../../shared/i18n/index.js';
import { readMultilineInput } from './lineEditor.js';
import { filterSlashCommands } from './slashCommandRegistry.js';

/**
 * Build localized slash-command completion candidates for the current input.
 */
export const getSlashCommandCompletions = (
  prefix: string,
  lang: Language,
): readonly {
  readonly value: string;
  readonly description?: string;
  readonly applyValue?: string;
}[] =>
  filterSlashCommands(prefix).map((entry) => ({
    value: entry.command,
    applyValue: `${entry.command} `,
    description: getLabel(entry.labelKey, lang),
  }));

/**
 * Create the slash-command completion provider used by interactive conversation modes.
 */
export const createSlashCommandCompletionProvider = (
  lang: Language,
): ((context: { buffer: string }) => readonly {
  readonly value: string;
  readonly description?: string;
  readonly applyValue?: string;
}[]) =>
  ({ buffer }) => {
    if (!buffer.startsWith('/') || buffer.includes('\n')) {
      return [];
    }
    return getSlashCommandCompletions(buffer, lang);
  };

/**
 * Read interactive input with slash-command completion enabled.
 */
export const readInteractiveInput = (prompt: string, lang: Language): Promise<string | null> =>
  readMultilineInput(prompt, {
    completionProvider: createSlashCommandCompletionProvider(lang),
  });

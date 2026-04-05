import type { Language } from '../../core/models/config-types.js';
import { getLabel } from '../../shared/i18n/index.js';
import { readMultilineInput } from './lineEditor.js';
import { filterSlashCommands, type CommandAvailability } from './slashCommandRegistry.js';

/**
 * Build localized slash-command completion candidates for the current input.
 */
export const getSlashCommandCompletions = (
  prefix: string,
  lang: Language,
  availability?: CommandAvailability,
): readonly {
  readonly value: string;
  readonly description?: string;
  readonly applyValue?: string;
}[] =>
  filterSlashCommands(prefix, availability).map((entry) => ({
    value: entry.command,
    applyValue: `${entry.command} `,
    description: getLabel(entry.labelKey, lang),
  }));

/**
 * Extract the slash command token from the buffer for completion.
 *
 * Supports both prefix form ("/go") and suffix form ("some text /go").
 * Returns the slash token and its start position, or null if none found.
 */
const extractSlashToken = (buffer: string): { token: string; start: number } | null => {
  if (buffer.includes('\n')) return null;

  if (buffer.startsWith('/')) return { token: buffer, start: 0 };

  const lastSlashIndex = buffer.lastIndexOf(' /');
  if (lastSlashIndex >= 0) {
    const token = buffer.slice(lastSlashIndex + 1);
    if (!token.includes(' ')) return { token, start: lastSlashIndex + 1 };
  }

  return null;
};

/**
 * Create the slash-command completion provider used by interactive conversation modes.
 */
export const createSlashCommandCompletionProvider = (
  lang: Language,
  availability?: CommandAvailability,
): ((context: { buffer: string }) => readonly {
  readonly value: string;
  readonly description?: string;
  readonly applyValue?: string;
}[]) =>
  ({ buffer }) => {
    const match = extractSlashToken(buffer);
    if (!match) return [];

    const prefix = buffer.slice(0, match.start);
    return getSlashCommandCompletions(match.token, lang, availability).map((entry) => ({
      ...entry,
      applyValue: entry.applyValue
        ? `${prefix}${entry.applyValue}`
        : undefined,
      value: `${prefix}${entry.value}`,
    }));
  };

/**
 * Read interactive input with slash-command completion enabled.
 */
export const readInteractiveInput = (
  prompt: string,
  lang: Language,
  availability?: CommandAvailability,
): Promise<string | null> =>
  readMultilineInput(prompt, {
    completionProvider: createSlashCommandCompletionProvider(lang, availability),
  });

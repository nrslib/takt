import type { Language } from '../../core/models/config-types.js';
import { getLabel } from '../../shared/i18n/index.js';
import { readMultilineInput } from './lineEditor.js';
import { filterSlashCommands, type CommandAvailability } from './slashCommandRegistry.js';
import type { CompletionCandidate, CompletionContext, CompletionProvider } from './completionMenu.js';

/**
 * Build localized slash-command completion candidates for the current input.
 */
export const getSlashCommandCompletions = (
  prefix: string,
  lang: Language,
  availability?: CommandAvailability,
): readonly CompletionCandidate[] =>
  filterSlashCommands(prefix, availability).map((entry) => ({
    value: entry.command,
    applyValue: `${entry.command} `,
    description: getLabel(entry.labelKey, lang),
  }));

/**
 * Extract the slash command token from the buffer for completion.
 *
 * Supports both prefix form ("/go") and suffix form ("some text /go"), but only
 * when the cursor is currently inside the slash-command token being edited.
 */
const extractSlashToken = (
  buffer: string,
  cursorPos: number,
): { token: string; start: number; end: number } | null => {
  if (buffer.includes('\n')) return null;
  if (cursorPos <= 0 || cursorPos > buffer.length) return null;

  const tokenStart = buffer.lastIndexOf(' ', cursorPos - 1) + 1;
  if (cursorPos <= tokenStart) return null;
  const nextSpace = buffer.indexOf(' ', tokenStart);
  const tokenEnd = nextSpace >= 0 ? nextSpace : buffer.length;
  const token = buffer.slice(tokenStart, tokenEnd);
  if (!token.startsWith('/')) return null;

  return { token, start: tokenStart, end: tokenEnd };
};

/**
 * Create the slash-command completion provider used by interactive conversation modes.
 */
export const createSlashCommandCompletionProvider = (
  lang: Language,
  availability?: CommandAvailability,
): CompletionProvider =>
  ({ buffer, cursorPos }: CompletionContext) => {
    const match = extractSlashToken(buffer, cursorPos);
    if (!match) return [];

    const prefix = buffer.slice(0, match.start);
    const suffix = buffer.slice(match.end);
    const typedPrefix = buffer.slice(match.start, cursorPos);

    return getSlashCommandCompletions(typedPrefix, lang, availability).map((entry) => ({
      ...entry,
      applyValue: `${prefix}${suffix.length === 0 ? (entry.applyValue ?? entry.value) : entry.value}${suffix}`,
      value: `${prefix}${entry.value}${suffix}`,
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

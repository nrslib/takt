/**
 * Slash command registry with metadata for inline completion.
 *
 * Assembles slash command entries from the shared constants
 * and provides filtering utilities for the completion menu.
 */

import { SlashCommand } from '../../shared/constants.js';

/** i18n label key for each slash command description */
const SLASH_COMMAND_LABEL_KEYS: Readonly<Record<SlashCommand, string>> = {
  '/play': 'interactive.commands.play',
  '/go': 'interactive.commands.go',
  '/retry': 'interactive.commands.retry',
  '/replay': 'interactive.commands.replay',
  '/cancel': 'interactive.commands.cancel',
  '/resume': 'interactive.commands.resume',
} as const;

/**
 * Registry of all slash commands.
 */
const SLASH_COMMAND_REGISTRY: readonly {
  readonly command: SlashCommand;
  readonly labelKey: string;
}[] = (Object.values(SlashCommand)).map(
  (command) => ({ command, labelKey: SLASH_COMMAND_LABEL_KEYS[command] }),
);

/**
 * Filter slash commands by prefix match.
 */
export const filterSlashCommands = (
  prefix: string,
): readonly {
  readonly command: SlashCommand;
  readonly labelKey: string;
}[] => {
  const lower = prefix.toLowerCase();
  return SLASH_COMMAND_REGISTRY.filter((entry) => entry.command.startsWith(lower));
};

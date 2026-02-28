import { SlashCommand } from '../../shared/constants.js';

const SLASH_COMMAND_VALUES = Object.values(SlashCommand);

/**
 * Slash command parser for interactive mode.
 *
 * Detects slash commands at the beginning or end of user input.
 * Commands in the middle of text are not recognized.
 *
 * @param input - User input string.
 * @returns Parsed command and associated text, or null if no command found.
 */
export const matchSlashCommand = (input: string): {command: SlashCommand, text: string} | null => {
  if (!input) return null;

  const prefixMatch = SLASH_COMMAND_VALUES.find((cmd) => {
    if (!input.startsWith(cmd)) return false;
    const rest = input.slice(cmd.length);
    return rest === '' || rest.startsWith(' ');
  });
  if (prefixMatch) {
    const rest = input.slice(prefixMatch.length);
    return { command: prefixMatch, text: rest.trim() };
  }

  const suffixMatch = SLASH_COMMAND_VALUES.find((cmd) =>
    input.endsWith(` ${cmd}`),
  );
  if (suffixMatch) {
    const precedingText = input.slice(0, -(suffixMatch.length + 1)).trim();
    return { command: suffixMatch, text: precedingText };
  }

  return null;
};

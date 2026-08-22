import { SlashCommand } from '../../shared/constants.js';
import type { CommandAvailability } from './slashCommandRegistry.js';

const SLASH_COMMAND_VALUES = Object.values(SlashCommand);

function isCommandMatchEnabled(command: SlashCommand, availability?: CommandAvailability): boolean {
  if (availability?.enabledCommands && !availability.enabledCommands.includes(command)) {
    return false;
  }
  if (command === SlashCommand.Setup) {
    return availability?.enableSetupCommand === true;
  }
  return true;
}

/**
 * Slash command parser for interactive mode.
 *
 * Detects slash commands at the beginning or end of user input.
 * Commands in the middle of text are not recognized.
 *
 * @param input - User input string.
 * @returns Parsed command and associated text, or null if no command found.
 */
export const matchSlashCommand = (
  input: string,
  availability?: CommandAvailability,
): {command: SlashCommand, text: string} | null => {
  if (!input) return null;

  const prefixMatch = SLASH_COMMAND_VALUES.find((cmd) => {
    if (!isCommandMatchEnabled(cmd, availability)) return false;
    if (!input.startsWith(cmd)) return false;
    const rest = input.slice(cmd.length);
    return rest === '' || rest.startsWith(' ');
  });
  if (prefixMatch) {
    const rest = input.slice(prefixMatch.length);
    return { command: prefixMatch, text: rest.trim() };
  }

  const suffixMatch = SLASH_COMMAND_VALUES.find((cmd) => (
    isCommandMatchEnabled(cmd, availability) && input.endsWith(` ${cmd}`)
  ));
  if (suffixMatch) {
    const precedingText = input.slice(0, -(suffixMatch.length + 1)).trim();
    return { command: suffixMatch, text: precedingText };
  }

  return null;
};

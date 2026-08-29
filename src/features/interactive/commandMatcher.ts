import { INTERACTIVE_SETTING_COMMANDS, SlashCommand } from '../../shared/constants.js';
import type { CommandAvailability } from './slashCommandRegistry.js';

const SLASH_COMMAND_VALUES = Object.values(SlashCommand);

function isCommandMatchEnabled(command: SlashCommand, availability?: CommandAvailability): boolean {
  if (availability?.enabledCommands && !availability.enabledCommands.includes(command)) {
    return false;
  }
  if (command === SlashCommand.Setup) {
    return availability?.enableSetupCommand === true;
  }
  if (INTERACTIVE_SETTING_COMMANDS.has(command)) {
    return availability?.enableSettingsCommands === true;
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
    !INTERACTIVE_SETTING_COMMANDS.has(cmd)
    && isCommandMatchEnabled(cmd, availability)
    && input.endsWith(` ${cmd}`)
  ));
  if (suffixMatch) {
    const precedingText = input.slice(0, -(suffixMatch.length + 1)).trim();
    return { command: suffixMatch, text: precedingText };
  }

  return null;
};

export const isDisabledVerifyCommand = (
  input: string,
  availability?: CommandAvailability,
): boolean => (
  availability?.enabledCommands?.includes(SlashCommand.Verify) === false
  && matchSlashCommand(input)?.command === SlashCommand.Verify
);

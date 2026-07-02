import { SlashCommand } from '../../shared/constants.js';
import type { CommandAvailability } from '../interactive/slashCommandRegistry.js';

export const EXEC_CONVERSATION_COMMAND_AVAILABILITY: CommandAvailability = {
  enableSetupCommand: true,
  enabledCommands: [SlashCommand.Setup, SlashCommand.Go, SlashCommand.Cancel, SlashCommand.PasteImage],
};

export const EXEC_TEXT_INPUT_COMMAND_AVAILABILITY: CommandAvailability = {
  enableSetupCommand: false,
  enabledCommands: [],
};

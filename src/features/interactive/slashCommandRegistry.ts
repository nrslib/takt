/**
 * Slash command registry with metadata for inline completion.
 *
 * Assembles slash command entries from the shared constants
 * and provides filtering utilities for the completion menu.
 */

import { INTERACTIVE_SETTING_COMMANDS, SlashCommand } from '../../shared/constants.js';

/** i18n label key for each slash command description */
const SLASH_COMMAND_LABEL_KEYS: Readonly<Record<SlashCommand, string>> = {
  '/accept': 'interactive.commands.accept',
  '/go': 'interactive.commands.go',
  '/retry': 'interactive.commands.retry',
  '/replay': 'interactive.commands.replay',
  '/cancel': 'interactive.commands.cancel',
  '/resume': 'interactive.commands.resume',
  '/paste-image': 'interactive.commands.pasteImage',
  '/setup': 'interactive.commands.setup',
  '/workflow': 'interactive.commands.workflow',
  '/interaction': 'interactive.commands.mode',
  '/provider': 'interactive.commands.provider',
  '/model': 'interactive.commands.model',
  '/effort': 'interactive.commands.effort',
  '/verify': 'interactive.commands.verify',
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
 * Conditions controlling which slash commands are available.
 */
export interface CommandAvailability {
  readonly enableRetryCommand?: boolean;
  readonly hasPreviousOrder?: boolean;
  readonly enableSetupCommand?: boolean;
  readonly enableSettingsCommands?: boolean;
  readonly formalSpec?: boolean;
  readonly enabledCommands?: readonly SlashCommand[];
}

export function resolveFormalSpecCommandAvailability(
  availability: CommandAvailability,
  formalSpec: boolean,
): CommandAvailability {
  type MutableCommandAvailability = {
    -readonly [Key in keyof CommandAvailability]: CommandAvailability[Key];
  };
  const baseAvailability: MutableCommandAvailability = { ...availability };
  delete baseAvailability.formalSpec;
  delete baseAvailability.enabledCommands;
  const { enabledCommands } = availability;
  const resolvedEnabledCommands = enabledCommands === undefined
    ? formalSpec
      ? undefined
      : Object.values(SlashCommand).filter((command) => command !== SlashCommand.Verify)
    : formalSpec
      ? enabledCommands.includes(SlashCommand.Verify)
        ? enabledCommands
        : [...enabledCommands, SlashCommand.Verify]
      : enabledCommands.filter((command) => command !== SlashCommand.Verify);

  return {
    ...baseAvailability,
    ...(resolvedEnabledCommands === undefined ? {} : { enabledCommands: resolvedEnabledCommands }),
    ...(formalSpec ? { formalSpec: true } : {}),
  };
}

/**
 * Filter slash commands by prefix match and availability conditions.
 */
export const filterSlashCommands = (
  prefix: string,
  availability?: CommandAvailability,
): readonly {
  readonly command: SlashCommand;
  readonly labelKey: string;
}[] => {
  const lower = prefix.toLowerCase();
  const matches = SLASH_COMMAND_REGISTRY.filter((entry) => {
    if (!entry.command.startsWith(lower)) return false;
    if (availability?.enabledCommands && !availability.enabledCommands.includes(entry.command)) return false;
    if (entry.command === SlashCommand.Setup && availability?.enableSetupCommand !== true) return false;
    if (INTERACTIVE_SETTING_COMMANDS.has(entry.command) && availability?.enableSettingsCommands !== true) return false;
    if (entry.command === SlashCommand.Verify && availability?.formalSpec !== true) return false;
    if (!availability) return true;
    if (entry.command === SlashCommand.Retry && !availability.enableRetryCommand) return false;
    if (entry.command === SlashCommand.Replay && !availability.hasPreviousOrder) return false;
    return true;
  });
  const exact = matches.find((entry) => entry.command === lower);
  return exact === undefined ? matches : [exact];
};

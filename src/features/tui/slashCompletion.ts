import { SlashCommand } from '../../shared/constants.js';
import { getLabel } from '../../shared/i18n/index.js';
import { filterSlashCommands, type CommandAvailability } from '../interactive/slashCommandRegistry.js';

/**
 * What the plain conversation offers when the mode names no list of its own.
 * `/setup` is not on it because it belongs to exec, which does name its list.
 */
const TUI_ENABLED_COMMANDS: readonly SlashCommand[] = [
  SlashCommand.Accept,
  SlashCommand.Go,
  SlashCommand.Retry,
  SlashCommand.Replay,
  SlashCommand.Cancel,
  SlashCommand.Resume,
  SlashCommand.PasteImage,
  SlashCommand.Workflow,
  SlashCommand.Mode,
  SlashCommand.Provider,
  SlashCommand.Model,
  SlashCommand.Effort,
  SlashCommand.Verify,
];

export interface SlashCompletion {
  readonly command: SlashCommand;
  readonly description: string;
}

export function resolveSlashCompletions(
  draft: string,
  lang: 'en' | 'ja',
  availability: CommandAvailability,
): readonly SlashCompletion[] {
  if (!draft.startsWith('/') || draft.includes(' ')) {
    return [];
  }
  // A mode with a guarded execution path names the commands it allows, and the
  // list must not offer one the conversation would then refuse to run.
  return filterSlashCommands(draft, {
    ...availability,
    enabledCommands: availability.enabledCommands ?? TUI_ENABLED_COMMANDS,
  }).map((entry) => ({
    command: entry.command,
    description: getLabel(entry.labelKey, lang),
  }));
}

import { SlashCommand } from '../../shared/constants.js';
import { getLabel } from '../../shared/i18n/index.js';
import { filterSlashCommands, type CommandAvailability, type SlashCommandDefinition } from '../interactive/slashCommandRegistry.js';

/**
 * What the plain conversation offers when the mode names no list of its own.
 * `/setup` is not on it because it belongs to exec, which does name its list.
 */
const TUI_ENABLED_COMMANDS: readonly SlashCommand[] = [
  SlashCommand.Accept,
  SlashCommand.Go,
  SlashCommand.Issue,
  SlashCommand.Tell,
  SlashCommand.Requeue,
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
  readonly command: string;
  readonly description: string;
}

export function resolveSlashCompletions(
  draft: string,
  lang: 'en' | 'ja',
  availability: CommandAvailability,
  definitions?: readonly SlashCommandDefinition[],
): readonly SlashCompletion[] {
  if (!draft.startsWith('/') || draft.includes(' ')) {
    return [];
  }
  // A mode with a guarded execution path names the commands it allows, and the
  // list must not offer one the conversation would then refuse to run.
  return filterSlashCommands(draft, {
    ...availability,
    ...(definitions === undefined ? { enabledCommands: availability.enabledCommands ?? TUI_ENABLED_COMMANDS } : {}),
  }, definitions).map((entry) => ({
    command: entry.command,
    description: getLabel(entry.labelKey, lang),
  }));
}

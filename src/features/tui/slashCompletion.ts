import { SlashCommand } from '../../shared/constants.js';
import { getLabel } from '../../shared/i18n/index.js';
import { filterSlashCommands, type CommandAvailability } from '../interactive/slashCommandRegistry.js';

/**
 * Every command the TUI conversation acts on. `/setup` is excluded because it
 * belongs to exec mode, exactly as in the readline conversation loop.
 */
const TUI_ENABLED_COMMANDS: readonly SlashCommand[] = [
  SlashCommand.Accept,
  SlashCommand.Play,
  SlashCommand.Go,
  SlashCommand.Retry,
  SlashCommand.Replay,
  SlashCommand.Cancel,
  SlashCommand.Resume,
  SlashCommand.PasteImage,
];

export interface SlashCompletion {
  readonly command: SlashCommand;
  readonly description: string;
}

export function resolveSlashCompletions(
  draft: string,
  lang: 'en' | 'ja',
  availability: Pick<CommandAvailability, 'enableRetryCommand' | 'hasPreviousOrder'>,
): readonly SlashCompletion[] {
  if (!draft.startsWith('/') || draft.includes(' ')) {
    return [];
  }
  return filterSlashCommands(draft, {
    ...availability,
    enabledCommands: TUI_ENABLED_COMMANDS,
  }).map((entry) => ({
    command: entry.command,
    description: getLabel(entry.labelKey, lang),
  }));
}

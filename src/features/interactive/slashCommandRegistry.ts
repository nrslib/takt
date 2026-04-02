/**
 * Slash command registry with metadata for inline completion.
 *
 * Defines all slash commands recognized in interactive mode,
 * along with localized descriptions for the completion menu.
 */

import { SlashCommand } from '../../shared/constants.js';

/** Slash command entry with localized description */
export interface SlashCommandEntry {
  readonly command: SlashCommand;
  readonly description: Readonly<Record<'en' | 'ja', string>>;
}

/**
 * Registry of all slash commands with their descriptions.
 */
const SLASH_COMMAND_REGISTRY: readonly SlashCommandEntry[] = [
  { command: SlashCommand.Play, description: { en: 'Run a task immediately', ja: 'タスクを即実行する' } },
  { command: SlashCommand.Go, description: { en: 'Create instruction & run', ja: '指示書を作成して実行' } },
  { command: SlashCommand.Retry, description: { en: 'Rerun with previous order', ja: '前回の指示書を確認して再実行' } },
  { command: SlashCommand.Replay, description: { en: 'Resubmit previous order', ja: '前回の指示書で即再実行' } },
  { command: SlashCommand.Cancel, description: { en: 'Exit interactive mode', ja: '対話モードを終了' } },
  { command: SlashCommand.Resume, description: { en: 'Load a previous session', ja: 'セッションを読み込む' } },
] as const;

/**
 * Filter slash commands by prefix match.
 */
export const filterSlashCommands = (
  prefix: string,
): readonly SlashCommandEntry[] => {
  const lower = prefix.toLowerCase();
  return SLASH_COMMAND_REGISTRY.filter((entry) => entry.command.startsWith(lower));
};

/**
 * Get all registered slash commands.
 */
export const getAllSlashCommands = (): readonly SlashCommandEntry[] => SLASH_COMMAND_REGISTRY;

import { readInteractiveInput } from '../interactive/interactiveInput.js';
import { selectOption, type SelectOptionItem } from '../../shared/prompt/index.js';
import { sanitizeTerminalText } from '../../shared/utils/index.js';
import type { SessionContext } from '../interactive/aiCaller.js';
import { EXEC_TEXT_INPUT_COMMAND_AVAILABILITY } from './commandAvailability.js';
import { execLabel, type ExecLanguage } from './labels.js';

export async function selectExecOption<T extends string>(
  lang: ExecLanguage,
  message: string,
  options: SelectOptionItem<T>[],
): Promise<T | null> {
  return await selectOption<T>(message, options, { cancelLabel: execLabel(lang, 'common.cancel') });
}

export async function promptTextOrCancel(prompt: string, current: string, lang: SessionContext['lang']): Promise<string | null> {
  const input = await readInteractiveInput(`${prompt} (${sanitizeTerminalText(current)}): `, lang, EXEC_TEXT_INPUT_COMMAND_AVAILABILITY);
  if (input === null) {
    return null;
  }
  const trimmed = input.trim();
  return trimmed.length > 0 ? trimmed : current;
}

export async function promptText(prompt: string, current: string, lang: SessionContext['lang']): Promise<string> {
  const input = await promptTextOrCancel(prompt, current, lang);
  return input ?? current;
}

export async function promptInteger(prompt: string, current: number, lang: SessionContext['lang']): Promise<number> {
  const input = await readInteractiveInput(`${prompt} (${current}): `, lang, EXEC_TEXT_INPUT_COMMAND_AVAILABILITY);
  if (input === null || input.trim().length === 0) {
    return current;
  }
  const parsed = Number(input.trim());
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${prompt} must be a positive integer.`);
  }
  return parsed;
}

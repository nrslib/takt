import { readMultilineInput } from '../interactive/lineEditor.js';
import { runTuiPrompt } from '../tui/runTuiPrompt.js';
import { selectMultipleOptions, selectOption, type SelectOptionItem } from '../../shared/prompt/index.js';
import { sanitizeTerminalText } from '../../shared/utils/index.js';
import type { SessionContext } from '../interactive/aiCaller.js';
import { execLabel, type ExecLanguage } from './labels.js';

export async function selectExecOption<T extends string>(
  lang: ExecLanguage,
  message: string,
  options: SelectOptionItem<T>[],
): Promise<T | null> {
  return await selectOption<T>(message, options, { cancelLabel: execLabel(lang, 'common.cancel') });
}

export async function selectMultipleExecOptions<T extends string>(
  lang: ExecLanguage,
  message: string,
  options: SelectOptionItem<T>[],
  initialValues: T[],
): Promise<T[] | null> {
  return await selectMultipleOptions(message, options, initialValues, {
    cancelLabel: execLabel(lang, 'common.cancel'),
    instructions: execLabel(lang, 'facets.multiSelectInstructions'),
  });
}

/**
 * A terminal answers on the TUI; piped input keeps the readline reader the
 * non-interactive callers and the E2E suite depend on.
 */
export function askExecQuestion(
  question: string,
  lang: SessionContext['lang'],
  emptyKeepsCurrent: boolean,
): Promise<string | null> {
  if (process.stdin.isTTY === true && process.stdout.isTTY === true) {
    return runTuiPrompt({ lang, question, emptyKeepsCurrent });
  }
  return readMultilineInput(question);
}

export async function promptTextOrCancel(prompt: string, current: string, lang: SessionContext['lang']): Promise<string | null> {
  const input = await askExecQuestion(`${prompt} (${sanitizeTerminalText(current)}): `, lang, true);
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
  const input = await askExecQuestion(`${prompt} (${current}): `, lang, true);
  if (input === null || input.trim().length === 0) {
    return current;
  }
  const parsed = Number(input.trim());
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${prompt} must be a positive integer.`);
  }
  return parsed;
}

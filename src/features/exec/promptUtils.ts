import { readInteractiveInput } from '../interactive/interactiveInput.js';
import { sanitizeTerminalText } from '../../shared/utils/index.js';
import type { SessionContext } from '../interactive/aiCaller.js';

export async function promptText(prompt: string, current: string, lang: SessionContext['lang']): Promise<string> {
  const input = await readInteractiveInput(`${prompt} (${sanitizeTerminalText(current)}): `, lang, { enableSetupCommand: false });
  if (input === null) {
    return current;
  }
  const trimmed = input.trim();
  return trimmed.length > 0 ? trimmed : current;
}

export async function promptInteger(prompt: string, current: number, lang: SessionContext['lang']): Promise<number> {
  const input = await readInteractiveInput(`${prompt} (${current}): `, lang, { enableSetupCommand: false });
  if (input === null || input.trim().length === 0) {
    return current;
  }
  const parsed = Number(input.trim());
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${prompt} must be a positive integer.`);
  }
  return parsed;
}

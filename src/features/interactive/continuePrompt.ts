import type { InteractiveMode, Language } from '../../core/models/index.js';
import { getLabel } from '../../shared/i18n/index.js';
import { resolveTtyPolicy } from '../../shared/prompt/tty.js';
import { isQuietMode } from '../../shared/context.js';
import { info } from '../../shared/ui/index.js';
import { readMultilineInput } from './lineEditor.js';

export interface InteractiveContinuePromptOptions {
  selectedMode: InteractiveMode;
}

export function shouldPromptForInteractiveContinue(options: InteractiveContinuePromptOptions): boolean {
  if (options.selectedMode === 'quiet') {
    return false;
  }
  if (isQuietMode()) {
    return false;
  }
  if (isCiEnvironment()) {
    return false;
  }
  return resolveTtyPolicy().useTty;
}

function isCiEnvironment(): boolean {
  const value = process.env.CI;
  return value !== undefined && value !== '' && value !== '0' && value !== 'false';
}

export async function promptContinueAfterTaskResult(success: boolean, lang: Language): Promise<boolean> {
  info(getLabel(success ? 'interactive.taskResult.completed' : 'interactive.taskResult.failed', lang));
  const input = await readMultilineInput(`${getLabel('interactive.taskResult.continuePrompt', lang)} [Y/n]`);
  if (input === null) {
    return false;
  }

  const normalizedInput = input.trim().toLowerCase();
  return normalizedInput === '' || normalizedInput === 'y' || normalizedInput === 'yes';
}

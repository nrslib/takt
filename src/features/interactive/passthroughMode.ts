/**
 * Passthrough interactive mode.
 *
 * Passes user input directly as the task string without any
 * AI-assisted instruction generation or system prompt injection.
 */

import chalk from 'chalk';
import { info, blankLine } from '../../shared/ui/index.js';
import { getLabel } from '../../shared/i18n/index.js';
import { readMultilineInput } from './lineEditor.js';
import type { InteractiveModeResult } from './interactive.js';
import {
  buildInteractiveResultWithAttachments,
  createImagePasteHandler,
  createSessionImageAttachmentStore,
} from './imageAttachments.js';

/**
 * Run passthrough mode: collect user input and return it as-is.
 *
 * If initialInput is provided, it is used directly as the task.
 * Otherwise, prompts the user for input.
 *
 * @param lang - Display language
 * @param initialInput - Pre-filled input (e.g., from issue reference)
 * @returns Result with the raw user input as task
 */
export async function passthroughMode(
  lang: 'en' | 'ja',
  initialInput?: string,
): Promise<InteractiveModeResult> {
  if (initialInput) {
    return { action: 'execute', task: initialInput };
  }

  const attachmentStore = createSessionImageAttachmentStore();

  info(getLabel('interactive.ui.introPassthrough', lang));
  blankLine();

  const input = await readMultilineInput(chalk.green('> '), {
    onImagePaste: createImagePasteHandler(attachmentStore),
  });

  if (input === null) {
    blankLine();
    info(getLabel('interactive.ui.cancelled', lang));
    return buildInteractiveResultWithAttachments({ action: 'cancel', task: '' }, attachmentStore);
  }

  const trimmed = input.trim();
  if (!trimmed) {
    info(getLabel('interactive.ui.cancelled', lang));
    return buildInteractiveResultWithAttachments({ action: 'cancel', task: '' }, attachmentStore);
  }

  return buildInteractiveResultWithAttachments({ action: 'execute', task: trimmed }, attachmentStore);
}

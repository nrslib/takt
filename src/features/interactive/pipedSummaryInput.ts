import { readPipeLine } from '../../shared/prompt/pipe-reader.js';
import type { CancellablePromptResult } from '../../shared/prompt/confirm.js';
import { getLabel } from '../../shared/i18n/index.js';
import { blankLine, info } from '../../shared/ui/index.js';
import type { SummaryActionOption, SummaryActionValue } from './interactive-summary-types.js';

export async function selectPipedSummaryAction(
  task: string,
  proposedLabel: string,
  message: string,
  options: readonly SummaryActionOption[],
  initialAction: SummaryActionValue | undefined,
  lang: 'en' | 'ja',
): Promise<SummaryActionValue | null> {
  blankLine();
  info(proposedLabel);
  info(task);
  const cancelNumber = options.length + 1;
  process.stdout.write(`${message}\n${options.map((option, index) => `${index + 1}. ${option.label}`).join('\n')}\n${cancelNumber}. ${getLabel('exec.common.cancel', lang)}\n> `);
  while (true) {
    const line = await readPipeLine(process.stdin);
    if (line === null || line === '\x1B') return null;
    const answer = line.trim();
    if (answer === '') return initialAction ?? options[0]!.value;
    if (/^[1-9]\d*$/.test(answer)) {
      if (Number(answer) === cancelNumber) return null;
      const option = options[Number(answer) - 1];
      if (option !== undefined) return option.value;
    }
    process.stdout.write(`1-${cancelNumber}: `);
  }
}

export async function confirmPipedSummaryAction(
  message: string,
  defaultYes: boolean,
): Promise<CancellablePromptResult<boolean> | null> {
  process.stdout.write(`${message} ${defaultYes ? '[Y/n]' : '[y/N]'}: `);
  while (true) {
    const line = await readPipeLine(process.stdin);
    if (line === null) return null;
    if (line === '\x1B') return { kind: 'cancelled' };
    const answer = line.trim().toLowerCase();
    if (answer === '') return { kind: 'value', value: defaultYes };
    if (answer === 'y' || answer === 'yes') return { kind: 'value', value: true };
    if (answer === 'n' || answer === 'no') return { kind: 'value', value: false };
    process.stdout.write(`${defaultYes ? '[Y/n]' : '[y/N]'}: `);
  }
}

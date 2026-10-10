import { readPipeLine } from '../../shared/prompt/pipe-reader.js';
import type { CancellablePromptResult } from '../../shared/prompt/confirm.js';
import { blankLine, info } from '../../shared/ui/index.js';
import type { SummaryActionOption, SummaryActionValue } from './interactive-summary-types.js';

export async function selectPipedSummaryAction(
  task: string,
  proposedLabel: string,
  message: string,
  options: readonly SummaryActionOption[],
  initialAction: SummaryActionValue | undefined,
): Promise<SummaryActionValue | null> {
  blankLine();
  info(proposedLabel);
  info(task);
  process.stdout.write(`${message}\n${options.map((option, index) => `${index + 1}. ${option.label}`).join('\n')}\n> `);
  while (true) {
    const line = await readPipeLine(process.stdin);
    if (line === null || line === '\x1B') return null;
    const answer = line.trim();
    if (answer === '') return initialAction ?? options[0]!.value;
    if (/^[1-9]\d*$/.test(answer)) {
      const option = options[Number(answer) - 1];
      if (option !== undefined) return option.value;
    }
    process.stdout.write(`1-${options.length}: `);
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

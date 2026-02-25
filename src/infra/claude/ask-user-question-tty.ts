/**
 * TTY interactive handler for AskUserQuestion.
 *
 * Displays selection UI in the terminal when Claude invokes the
 * AskUserQuestion tool in interactive (TTY) mode.
 */

import chalk from 'chalk';
import { selectOption, type SelectOptionItem } from '../../shared/prompt/select.js';
import { promptInput } from '../../shared/prompt/confirm.js';
import type { AskUserQuestionInput, AskUserQuestionHandler } from './types.js';
import { AskUserQuestionDeniedError } from '../../core/piece/ask-user-question-error.js';

const OTHER_VALUE = '__other__';

/**
 * Build a display message from a question, prefixing with header if present.
 */
function buildDisplayMessage(question: string, header: string | undefined): string {
  if (header) {
    return `[${header}] ${question}`;
  }
  return question;
}

/**
 * Handle a single-select question using cursor-based menu navigation.
 */
async function handleSingleSelect(
  displayMessage: string,
  options: Array<{ label: string; description?: string }>,
): Promise<string> {
  const items: SelectOptionItem<string>[] = options.map((opt) => ({
    label: opt.label,
    value: opt.label,
    description: opt.description,
  }));

  items.push({
    label: 'Other',
    value: OTHER_VALUE,
    description: 'Enter custom text',
  });

  const selected = await selectOption(displayMessage, items);

  if (selected === null) {
    throw new AskUserQuestionDeniedError();
  }

  if (selected === OTHER_VALUE) {
    return handleFreeText(displayMessage);
  }

  return selected;
}

/**
 * Handle a multi-select question using numbered list and text input.
 */
async function handleMultiSelect(
  displayMessage: string,
  options: Array<{ label: string; description?: string }>,
): Promise<string> {
  console.log();
  console.log(chalk.cyan(displayMessage));
  console.log(chalk.gray('  (Enter comma-separated numbers, e.g. 1,3)'));
  console.log();

  const otherIndex = options.length + 1;
  for (let i = 0; i < options.length; i++) {
    const opt = options[i]!;
    const desc = opt.description ? chalk.gray(` — ${opt.description}`) : '';
    console.log(`  ${chalk.yellow(`${i + 1}.`)} ${opt.label}${desc}`);
  }
  console.log(`  ${chalk.yellow(`${otherIndex}.`)} Other ${chalk.gray('— Enter custom text')}`);

  const rawInput = await promptInput('Your selection');
  if (rawInput === null) {
    throw new AskUserQuestionDeniedError();
  }

  const indices = parseNumberInput(rawInput, otherIndex);
  const selectedLabels: string[] = [];
  let includesOther = false;

  for (const idx of indices) {
    if (idx === otherIndex) {
      includesOther = true;
    } else {
      const opt = options[idx - 1];
      if (opt) {
        selectedLabels.push(opt.label);
      }
    }
  }

  if (includesOther) {
    const customText = await promptInput('Enter custom text');
    if (customText === null) {
      throw new AskUserQuestionDeniedError();
    }
    selectedLabels.push(customText);
  }

  if (selectedLabels.length === 0) {
    throw new AskUserQuestionDeniedError();
  }

  return selectedLabels.join(', ');
}

/**
 * Parse comma-separated number input, filtering invalid values.
 */
function parseNumberInput(raw: string, maxValue: number): number[] {
  const parts = raw.split(',');
  const result: number[] = [];

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    const num = parseInt(trimmed, 10);
    if (!Number.isNaN(num) && num >= 1 && num <= maxValue) {
      result.push(num);
    }
  }

  return result;
}

/**
 * Handle a free-text question using text input.
 */
async function handleFreeText(displayMessage: string): Promise<string> {
  const answer = await promptInput(displayMessage);
  if (answer === null) {
    throw new AskUserQuestionDeniedError();
  }
  return answer;
}

/**
 * Create a TTY interactive handler for AskUserQuestion.
 *
 * Processes each question sequentially, dispatching to the appropriate
 * UI handler based on question type (single-select, multi-select, free-text).
 */
export function createTtyAskUserQuestionHandler(): AskUserQuestionHandler {
  return async (input: AskUserQuestionInput): Promise<Record<string, string>> => {
    const answers: Record<string, string> = {};

    for (const question of input.questions) {
      const displayMessage = buildDisplayMessage(question.question, question.header);
      const hasOptions = question.options && question.options.length > 0;

      let answer: string;
      if (hasOptions && question.multiSelect) {
        answer = await handleMultiSelect(displayMessage, question.options!);
      } else if (hasOptions) {
        answer = await handleSingleSelect(displayMessage, question.options!);
      } else {
        answer = await handleFreeText(displayMessage);
      }

      answers[question.question] = answer;
    }

    return answers;
  };
}

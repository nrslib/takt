/**
 * Interactive prompts for CLI
 *
 * Provides simple input prompts for user interaction.
 */

import * as readline from 'node:readline';
import chalk from 'chalk';

/**
 * Prompt user to select from a list of options
 * @returns Selected option or null if cancelled
 */
export async function selectOption<T extends string>(
  message: string,
  options: { label: string; value: T; description?: string; details?: string[] }[]
): Promise<T | null> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log();
  console.log(chalk.cyan(message));
  console.log();

  options.forEach((opt, idx) => {
    console.log(chalk.yellow(`  ${idx + 1}. `) + opt.label);
    // Display description if provided
    if (opt.description) {
      console.log(chalk.gray(`     ${opt.description}`));
    }
    // Display additional details if provided
    if (opt.details && opt.details.length > 0) {
      opt.details.forEach((detail) => {
        console.log(chalk.dim(`       • ${detail}`));
      });
    }
  });
  console.log(chalk.gray(`  0. Cancel`));
  console.log();

  return new Promise((resolve) => {
    rl.question(chalk.green('Select [0-' + options.length + ']: '), (answer) => {
      rl.close();

      const num = parseInt(answer.trim(), 10);

      if (isNaN(num) || num === 0) {
        resolve(null);
        return;
      }

      if (num >= 1 && num <= options.length) {
        const selected = options[num - 1];
        if (selected) {
          resolve(selected.value);
          return;
        }
      }

      console.log(chalk.red('Invalid selection'));
      resolve(null);
    });
  });
}

/**
 * Prompt user for simple text input
 * @returns User input or null if cancelled
 */
export async function promptInput(message: string): Promise<string | null> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(chalk.green(message + ': '), (answer) => {
      rl.close();

      const trimmed = answer.trim();
      if (!trimmed) {
        resolve(null);
        return;
      }

      resolve(trimmed);
    });
  });
}

/**
 * Prompt user to select from a list of options with a default value
 * User can press Enter to select default, or enter a number to select specific option
 * @returns Selected option value
 */
export async function selectOptionWithDefault<T extends string>(
  message: string,
  options: { label: string; value: T }[],
  defaultValue: T
): Promise<T> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log();
  console.log(chalk.cyan(message));
  console.log();

  const defaultIndex = options.findIndex((opt) => opt.value === defaultValue);

  options.forEach((opt, idx) => {
    const isDefault = opt.value === defaultValue;
    const marker = isDefault ? chalk.green(' (default)') : '';
    console.log(chalk.yellow(`  ${idx + 1}. `) + opt.label + marker);
  });
  console.log();

  const hint = defaultIndex >= 0 ? ` [Enter=${defaultIndex + 1}]` : '';

  return new Promise((resolve) => {
    rl.question(chalk.green(`Select [1-${options.length}]${hint}: `), (answer) => {
      rl.close();

      const trimmed = answer.trim();

      // Empty input = use default
      if (!trimmed) {
        resolve(defaultValue);
        return;
      }

      const num = parseInt(trimmed, 10);

      if (num >= 1 && num <= options.length) {
        const selected = options[num - 1];
        if (selected) {
          resolve(selected.value);
          return;
        }
      }

      // Invalid input, use default
      console.log(chalk.gray(`Invalid selection, using default: ${defaultValue}`));
      resolve(defaultValue);
    });
  });
}

/**
 * Prompt user for yes/no confirmation
 * @returns true for yes, false for no
 */
export async function confirm(message: string, defaultYes = true): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const hint = defaultYes ? '[Y/n]' : '[y/N]';

  return new Promise((resolve) => {
    rl.question(chalk.green(`${message} ${hint}: `), (answer) => {
      rl.close();

      const trimmed = answer.trim().toLowerCase();

      if (!trimmed) {
        resolve(defaultYes);
        return;
      }

      resolve(trimmed === 'y' || trimmed === 'yes');
    });
  });
}

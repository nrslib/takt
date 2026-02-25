/**
 * Confirmation and text input prompts.
 *
 * Provides yes/no confirmation, single-line text input,
 * and multiline text input from readable streams.
 */

import * as readline from 'node:readline';
import chalk from 'chalk';
import { resolveTtyPolicy, assertTtyIfForced } from './tty.js';

function pauseStdinSafely(): void {
  try {
    if (process.stdin.readable && !process.stdin.destroyed) {
      process.stdin.pause();
    }
  } catch {
    return;
  }
}

/**
 * Prompt user for simple text input
 * @returns User input or null if cancelled
 */
export async function promptInput(message: string): Promise<string | null> {
  const { useTty, forceTouchTty } = resolveTtyPolicy();
  assertTtyIfForced(forceTouchTty);
  if (!useTty) {
    return null;
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(chalk.green(message + ': '), (answer) => {
      rl.close();
      pauseStdinSafely();

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
 * Read multiline input from a readable stream.
 * An empty line finishes input. If the first line is empty, returns null.
 * Exported for testing.
 */
export function readMultilineFromStream(input: NodeJS.ReadableStream): Promise<string | null> {
  const lines: string[] = [];
  const rl = readline.createInterface({ input });

  return new Promise((resolve) => {
    let resolved = false;

    rl.on('line', (line) => {
      if (line === '' && lines.length > 0) {
        resolved = true;
        rl.close();
        const result = lines.join('\n').trim();
        resolve(result || null);
        return;
      }

      if (line === '' && lines.length === 0) {
        resolved = true;
        rl.close();
        resolve(null);
        return;
      }

      lines.push(line);
    });

    rl.on('close', () => {
      if (!resolved) {
        resolve(lines.length > 0 ? lines.join('\n').trim() : null);
      }
    });
  });
}

/**
 * Prompt user for yes/no confirmation
 * @returns true for yes, false for no
 */
export async function confirm(message: string, defaultYes = true): Promise<boolean> {
  const { useTty, forceTouchTty } = resolveTtyPolicy();
  assertTtyIfForced(forceTouchTty);
  if (!useTty) {
    // Support piped stdin (e.g. echo "y" | takt repertoire add ...)
    // Once the pipe queue is initialized, stdin may be destroyed but queued lines remain.
    if (pipeLineQueue !== null || (!process.stdin.isTTY && process.stdin.readable && !process.stdin.destroyed)) {
      return readConfirmFromPipe(defaultYes);
    }
    return defaultYes;
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const hint = defaultYes ? '[Y/n]' : '[y/N]';

  return new Promise((resolve) => {
    rl.question(chalk.green(`${message} ${hint}: `), (answer) => {
      rl.close();
      pauseStdinSafely();

      const trimmed = answer.trim().toLowerCase();

      if (!trimmed) {
        resolve(defaultYes);
        return;
      }

      resolve(trimmed === 'y' || trimmed === 'yes');
    });
  });
}

/**
 * Shared pipe reader singleton.
 *
 * readline.createInterface buffers data from stdin internally.
 * Creating and closing multiple interfaces loses buffered lines.
 * This singleton reads all lines once and serves them as a queue.
 */
let pipeLineQueue: string[] | null = null;
let pipeQueueReady: Promise<void> | null = null;

function ensurePipeQueue(): Promise<void> {
  if (pipeQueueReady) return pipeQueueReady;

  pipeQueueReady = new Promise((resolve) => {
    const lines: string[] = [];
    const rl = readline.createInterface({ input: process.stdin });

    rl.on('line', (line) => {
      lines.push(line);
    });

    rl.on('close', () => {
      pipeLineQueue = lines;
      resolve();
    });
  });

  return pipeQueueReady;
}

async function readConfirmFromPipe(defaultYes: boolean): Promise<boolean> {
  await ensurePipeQueue();

  const line = pipeLineQueue!.shift();
  if (line === undefined) {
    return defaultYes;
  }
  const trimmed = line.trim().toLowerCase();
  if (!trimmed) {
    return defaultYes;
  }
  return trimmed === 'y' || trimmed === 'yes';
}

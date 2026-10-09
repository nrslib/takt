/**
 * Confirmation and text input prompts.
 *
 * Provides yes/no confirmation, single-line text input,
 * and multiline text input from readable streams.
 */

import * as readline from 'node:readline';
import chalk from 'chalk';
import { resolveTtyPolicy, assertTtyIfForced } from './tty.js';
import { statusLine } from '../ui/StatusLine.js';
import { EXIT_SIGINT } from '../exitCodes.js';
import { ESCAPE_SEQUENCE_TIMEOUT_MS, KeyInputDecoder } from './select-key-input.js';

export type CancellablePromptResult<T> =
  | { readonly kind: 'value'; readonly value: T }
  | { readonly kind: 'cancelled' };

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
  statusLine.suspend();
  try {
    const { useTty, forceTouchTty } = resolveTtyPolicy();
    assertTtyIfForced(forceTouchTty);
    if (!useTty) {
      return null;
    }
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const result = await new Promise<string | null>((resolve) => {
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
    return result;
  } finally {
    statusLine.resume();
  }
}

async function promptTerminalLineWithCancel(prompt: string, signal?: AbortSignal): Promise<CancellablePromptResult<string>> {
  if (signal?.aborted) return { kind: 'cancelled' };
  statusLine.suspend();

  const decoder = new KeyInputDecoder();
  const wasRaw = Boolean(process.stdin.isRaw);
  let rl: readline.Interface | undefined;
  let pendingInputTimer: NodeJS.Timeout | undefined;
  let onData: ((input: Buffer | string) => void) | undefined;
  let onAbort: (() => void) | undefined;
  let cleanedUp = false;

  const cleanup = (): unknown[] => {
    if (cleanedUp) return [];
    cleanedUp = true;
    const errors: unknown[] = [];

    if (pendingInputTimer !== undefined) {
      clearTimeout(pendingInputTimer);
      pendingInputTimer = undefined;
    }
    decoder.dispose();
    if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort);

    if (onData !== undefined) {
      try {
        process.stdin.removeListener('data', onData);
      } catch (caught) {
        errors.push(caught);
      }
    }

    if (rl !== undefined) {
      try {
        rl.close();
      } catch (caught) {
        errors.push(caught);
      }
    }

    if (Boolean(process.stdin.isRaw) !== wasRaw) {
      try {
        process.stdin.setRawMode(wasRaw);
      } catch (caught) {
        errors.push(caught);
      }
    }

    try {
      pauseStdinSafely();
    } catch (caught) {
      errors.push(caught);
    }

    return errors;
  };

  let result: CancellablePromptResult<string> | undefined;
  let operationError: unknown;
  let operationFailed = false;

  try {
    result = await new Promise<CancellablePromptResult<string>>((resolve, reject) => {
      onAbort = () => resolve({ kind: 'cancelled' });
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      let receivedCtrlC = false;
      onData = (input) => {
        const text = Buffer.isBuffer(input) ? input.toString('utf8') : input;
        receivedCtrlC ||= text.includes('\x03');
        decoder.push(text);
        if (!decoder.hasPendingInput) {
          if (pendingInputTimer !== undefined) {
            clearTimeout(pendingInputTimer);
            pendingInputTimer = undefined;
          }
          return;
        }

        if (pendingInputTimer !== undefined) {
          clearTimeout(pendingInputTimer);
        }
        pendingInputTimer = setTimeout(() => {
          pendingInputTimer = undefined;
          if (decoder.expire().includes('\x1B')) {
            resolve({ kind: 'cancelled' });
          }
        }, ESCAPE_SEQUENCE_TIMEOUT_MS);
      };
      process.stdin.on('data', onData);

      const listenersBeforeCreate = new Map(
        (['keypress', 'end', 'error'] as const).map((event) => [
          event,
          new Set(process.stdin.listeners(event)),
        ]),
      );
      const resizeListenersBeforeCreate = new Set(process.stdout.listeners('resize'));

      try {
        rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
          terminal: true,
          escapeCodeTimeout: ESCAPE_SEQUENCE_TIMEOUT_MS,
        });
      } catch (caught) {
        // readline installs stream listeners before enabling raw mode. If raw
        // mode setup throws, remove its partial interface listeners while
        // leaving readline's shared keypress decoder available for a retry.
        for (const event of ['keypress', 'end', 'error'] as const) {
          const existing = listenersBeforeCreate.get(event)!;
          for (const listener of process.stdin.listeners(event)) {
            if (!existing.has(listener)) {
              process.stdin.removeListener(event, listener as (...args: unknown[]) => void);
            }
          }
        }
        for (const listener of process.stdout.listeners('resize')) {
          if (!resizeListenersBeforeCreate.has(listener)) {
            process.stdout.removeListener('resize', listener as (...args: unknown[]) => void);
          }
        }
        reject(caught);
        return;
      }

      // Match selection menus: restore terminal state before exiting on Ctrl+C.
      rl.once('SIGINT', () => {
        if (signal !== undefined) {
          resolve({ kind: 'cancelled' });
          return;
        }
        receivedCtrlC = true;
        const errors = cleanup();
        if (errors.length > 0) {
          reject(errors.length === 1
            ? errors[0]
            : new AggregateError(errors, 'Failed to restore terminal input'));
          return;
        }
        process.exit(EXIT_SIGINT);
      });
      rl.once('close', () => {
        if (!receivedCtrlC) resolve({ kind: 'cancelled' });
      });
      rl.question(prompt, (answer) => {
        resolve({ kind: 'value', value: answer });
      });
    });
  } catch (caught) {
    operationError = caught;
    operationFailed = true;
  }

  const cleanupErrors = cleanup();
  try {
    statusLine.resume();
  } catch (caught) {
    cleanupErrors.push(caught);
  }

  if (operationFailed) {
    if (cleanupErrors.length > 0) {
      throw new AggregateError([operationError, ...cleanupErrors], 'Failed to restore terminal input');
    }
    throw operationError;
  }
  if (cleanupErrors.length > 0) {
    throw cleanupErrors.length === 1
      ? cleanupErrors[0]
      : new AggregateError(cleanupErrors, 'Failed to restore terminal input');
  }
  return result!;
}

/** Prompt for text while treating a standalone Escape as cancellation. */
export async function promptInputWithCancel(
  message: string,
): Promise<CancellablePromptResult<string | null>> {
  const { useTty, forceTouchTty } = resolveTtyPolicy();
  assertTtyIfForced(forceTouchTty);
  if (!useTty) {
    return { kind: 'value', value: await promptInput(message) };
  }

  const result = await promptTerminalLineWithCancel(chalk.green(message + ': '));
  if (result.kind === 'cancelled') {
    return result;
  }
  const trimmed = result.value.trim();
  return { kind: 'value', value: trimmed || null };
}

/**
 * Read multiline input from a readable stream.
 * An empty line finishes input. If the first line is empty, returns null.
 * Exported for testing.
 */
export async function readMultilineFromStream(input: NodeJS.ReadableStream): Promise<string | null> {
  statusLine.suspend();
  try {
    const lines: string[] = [];
    const rl = readline.createInterface({ input });

    const result = await new Promise<string | null>((resolve) => {
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
    return result;
  } finally {
    statusLine.resume();
  }
}

/**
 * Prompt user for yes/no confirmation
 * @returns true for yes, false for no
 */
export async function confirm(message: string, defaultYes = true): Promise<boolean> {
  statusLine.suspend();
  try {
    const { useTty, forceTouchTty } = resolveTtyPolicy();
    assertTtyIfForced(forceTouchTty);
    if (!useTty) {
      // Support piped stdin (e.g. echo "y" | takt repertoire add ...)
      // Once the pipe queue is initialized, stdin may be destroyed but queued lines remain.
      if (pipeLineQueue !== null || (!process.stdin.isTTY && process.stdin.readable && !process.stdin.destroyed)) {
        return await readConfirmFromPipe(defaultYes);
      }
      return defaultYes;
    }
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const hint = defaultYes ? '[Y/n]' : '[y/N]';

    const result = await new Promise<boolean>((resolve) => {
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
    return result;
  } finally {
    statusLine.resume();
  }
}

/** Confirm while treating a standalone Escape as cancellation. */
export async function confirmWithCancel(
  message: string,
  defaultYes = true,
  signal?: AbortSignal,
): Promise<CancellablePromptResult<boolean>> {
  if (signal?.aborted) return { kind: 'cancelled' };
  const { useTty, forceTouchTty } = resolveTtyPolicy();
  assertTtyIfForced(forceTouchTty);
  if (!useTty) {
    if (signal !== undefined) return { kind: 'value', value: false };
    return { kind: 'value', value: await confirm(message, defaultYes) };
  }

  const hint = defaultYes ? '[Y/n]' : '[y/N]';
  const result = await promptTerminalLineWithCancel(chalk.green(`${message} ${hint}: `), signal);
  if (result.kind === 'cancelled') {
    return result;
  }
  const trimmed = result.value.trim().toLowerCase();
  return {
    kind: 'value',
    value: trimmed ? trimmed === 'y' || trimmed === 'yes' : defaultYes,
  };
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

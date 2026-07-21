/**
 * Interactive cursor-based selection menus.
 *
 * Provides arrow-key navigation for option selection in the terminal.
 * Pure functions live in select-menu.ts (rendering, input) and
 * select-viewport.ts (viewport scrolling).
 */

import chalk from 'chalk';
import { resolveTtyPolicy, assertTtyIfForced } from './tty.js';
import {
  type SelectOptionItem,
  type ViewportState,
  renderMenu,
  handleKeyInput,
} from './select-menu.js';
import {
  createViewportState,
  adjustScrollOffset,
  renderMenuWithViewport,
} from './select-viewport.js';
import { ESCAPE_SEQUENCE_TIMEOUT_MS, KeyInputDecoder } from './select-key-input.js';

const MAX_STDIN_CHUNK_BYTES = 64 * 1024;

// Re-export public symbols so index.ts imports stay unchanged
export {
  type SelectOptionItem,
  type KeyInputResult,
  renderMenu,
  countRenderedLines,
  handleKeyInput,
} from './select-menu.js';

function printHeader<T extends string>(message: string, callbacks?: InteractiveSelectCallbacks<T>): void {
  console.log();
  console.log(chalk.cyan(message));
  const hint = callbacks?.instructions
    ? `  (${callbacks.instructions})`
    : callbacks?.onKeyPress
    ? '  (↑↓ to move, Enter to select, b to bookmark, r to remove)'
    : '  (↑↓ to move, Enter to select)';
  console.log(chalk.gray(hint));
  console.log();
}

interface RawMode {
  cleanup(): void;
}

let pendingRawModeState: boolean | undefined;

function combineErrors(errors: unknown[], message: string): unknown {
  if (errors.length === 1) return errors[0];
  return new AggregateError(errors, message);
}

function appendError(errors: unknown[], error: unknown): void {
  if (typeof error === 'object' && error !== null && 'errors' in error) {
    const nestedErrors = (error as { errors: unknown }).errors;
    if (Array.isArray(nestedErrors)) {
      errors.push(...nestedErrors);
      return;
    }
  }
  errors.push(error);
}

function restoreStdin(wasRaw: boolean): unknown[] {
  const errors: unknown[] = [];

  try {
    process.stdin.setRawMode(wasRaw);
  } catch (error) {
    errors.push(error);
  }

  try {
    process.stdin.pause();
  } catch (error) {
    errors.push(error);
  }

  return errors;
}

function setupRawMode(): RawMode {
  const wasRaw = pendingRawModeState ?? Boolean(process.stdin.isRaw);
  process.stdin.setRawMode(true);

  try {
    process.stdin.resume();
  } catch (error) {
    const restoreErrors = restoreStdin(wasRaw);
    if (restoreErrors.length > 0) {
      pendingRawModeState = wasRaw;
      throw combineErrors([error, ...restoreErrors], 'Failed to initialize terminal input');
    }
    pendingRawModeState = undefined;
    throw error;
  }

  return {
    cleanup(): void {
      const cleanupErrors = restoreStdin(wasRaw);
      if (cleanupErrors.length === 0) {
        pendingRawModeState = undefined;
        return;
      }
      pendingRawModeState = wasRaw;
      throw combineErrors(cleanupErrors, 'Failed to restore terminal input');
    },
  };
}

/** Redraw the menu using relative cursor motion. */
function redrawMenu<T extends string>(
  options: SelectOptionItem<T>[],
  selectedIndex: number,
  hasCancelOption: boolean,
  prevTotalLines: number,
  cancelLabel: string,
  viewport: ViewportState,
): number {
  process.stdout.write(`\x1B[${prevTotalLines}A`);
  process.stdout.write('\x1B[J');

  const newLines = viewport.active
    ? renderMenuWithViewport(
        options, selectedIndex, hasCancelOption,
        viewport.scrollOffset, viewport.maxOptionLines, cancelLabel,
      )
    : renderMenu(options, selectedIndex, hasCancelOption, cancelLabel);

  process.stdout.write(newLines.join('\n') + '\n');
  return newLines.length;
}

export interface InteractiveSelectCallbacks<T extends string> {
  /**
   * Custom key handler called before default key handling.
   * Return updated options to handle the key and re-render.
   * Return null to delegate to default handler.
   */
  onKeyPress?: (key: string, value: T, index: number) => SelectOptionItem<T>[] | null;
  /** Custom label for cancel option (default: "Cancel") */
  cancelLabel?: string;
  instructions?: string;
  showConfirmation?: boolean;
}

interface InteractiveSelectResult<T extends string> {
  selectedIndex: number;
  finalOptions: SelectOptionItem<T>[];
}

function interactiveSelect<T extends string>(
  message: string,
  options: SelectOptionItem<T>[],
  initialIndex: number,
  hasCancelOption: boolean,
  callbacks?: InteractiveSelectCallbacks<T>,
): Promise<InteractiveSelectResult<T>> {
  return new Promise((resolve, reject) => {
    let currentOptions = options;
    let totalItems = hasCancelOption ? currentOptions.length + 1 : currentOptions.length;
    let selectedIndex = initialIndex;
    let rawMode: RawMode | undefined;
    let cleanedUp = false;
    const keyInputDecoder = new KeyInputDecoder();
    let pendingInputTimer: NodeJS.Timeout | undefined;
    const cancelLabel = callbacks?.cancelLabel ?? 'Cancel';

    const terminalRows = process.stdout.rows ?? 24;
    let viewport = createViewportState(terminalRows, currentOptions, hasCancelOption);
    let totalLines = 0;

    const cleanup = (): unknown => {
      if (cleanedUp) return undefined;
      cleanedUp = true;

      if (pendingInputTimer !== undefined) {
        clearTimeout(pendingInputTimer);
        pendingInputTimer = undefined;
      }
      keyInputDecoder.dispose();

      const cleanupErrors: unknown[] = [];

      try {
        process.stdin.removeListener('data', onKeypress);
      } catch (error) {
        appendError(cleanupErrors, error);
      }

      try {
        rawMode?.cleanup();
      } catch (error) {
        appendError(cleanupErrors, error);
      }

      try {
        process.stdout.write('\x1B[?7h');
      } catch (error) {
        appendError(cleanupErrors, error);
      }

      return cleanupErrors.length > 0
        ? combineErrors(cleanupErrors, 'Failed to clean up interactive selection')
        : undefined;
    };

    const finish = (result: InteractiveSelectResult<T>): void => {
      const cleanupError = cleanup();
      if (cleanupError) {
        reject(cleanupError);
        return;
      }
      resolve(result);
    };

    const fail = (error: unknown): void => {
      const cleanupError = cleanup();
      if (!cleanupError) {
        reject(error);
        return;
      }
      const errors = [error];
      appendError(errors, cleanupError);
      reject(combineErrors(errors, 'Interactive selection failed during cleanup'));
    };

    const processKey = (key: string): boolean => {
      try {
        if (callbacks?.onKeyPress && selectedIndex < currentOptions.length) {
          const item = currentOptions[selectedIndex];
          if (item) {
            const customResult = callbacks.onKeyPress(key, item.value, selectedIndex);
            if (customResult !== null) {
              const currentValue = item.value;
              currentOptions = customResult;
              totalItems = hasCancelOption ? currentOptions.length + 1 : currentOptions.length;
              const newIdx = currentOptions.findIndex((o) => o.value === currentValue);
              selectedIndex = newIdx >= 0 ? newIdx : Math.min(selectedIndex, currentOptions.length - 1);
              const newViewport = createViewportState(terminalRows, currentOptions, hasCancelOption);
              viewport = {
                ...newViewport,
                scrollOffset: adjustScrollOffset(
                  selectedIndex, newViewport.scrollOffset, currentOptions, hasCancelOption, newViewport.maxOptionLines,
                ),
              };
              totalLines = redrawMenu(currentOptions, selectedIndex, hasCancelOption, totalLines, cancelLabel, viewport);
              return false;
            }
          }
        }

        const result = handleKeyInput(
          key, selectedIndex, totalItems, hasCancelOption, currentOptions.length,
        );

        switch (result.action) {
          case 'move':
            selectedIndex = result.newIndex;
            if (viewport.active) {
              viewport = {
                ...viewport,
                scrollOffset: adjustScrollOffset(
                  selectedIndex, viewport.scrollOffset, currentOptions, hasCancelOption, viewport.maxOptionLines,
                ),
              };
            }
            totalLines = redrawMenu(currentOptions, selectedIndex, hasCancelOption, totalLines, cancelLabel, viewport);
            break;
          case 'confirm':
            finish({ selectedIndex: result.selectedIndex, finalOptions: currentOptions });
            return true;
          case 'cancel':
            finish({ selectedIndex: result.cancelIndex, finalOptions: currentOptions });
            return true;
          case 'bookmark':
          case 'remove_bookmark':
            break;
          case 'exit': {
            const cleanupError = cleanup();
            if (cleanupError) {
              reject(cleanupError);
              return true;
            }
            process.exit(130);
            return true;
          }
          case 'none':
            break;
        }
      } catch (error) {
        fail(error);
        return true;
      }
      return false;
    };

    const schedulePendingKeyInput = (): void => {
      if (!keyInputDecoder.hasPendingInput || pendingInputTimer !== undefined) return;

      pendingInputTimer = setTimeout(() => {
        pendingInputTimer = undefined;
        for (const key of keyInputDecoder.expire()) {
          if (processKey(key)) {
            return;
          }
        }
      }, ESCAPE_SEQUENCE_TIMEOUT_MS);
    };

    const onKeypress = (data: Buffer): void => {
      if (pendingInputTimer !== undefined) {
        clearTimeout(pendingInputTimer);
        pendingInputTimer = undefined;
      }

      if (data.length > MAX_STDIN_CHUNK_BYTES) {
        fail(new Error(`Interactive selection input exceeds ${MAX_STDIN_CHUNK_BYTES} byte limit`));
        return;
      }

      for (const key of keyInputDecoder.push(data.toString())) {
        if (processKey(key)) {
          return;
        }
      }

      schedulePendingKeyInput();
    };

    try {
      printHeader(message, callbacks);
      process.stdout.write('\x1B[?7l');

      const initialLines = viewport.active
        ? renderMenuWithViewport(
            currentOptions, selectedIndex, hasCancelOption,
            viewport.scrollOffset, viewport.maxOptionLines, cancelLabel,
          )
        : renderMenu(currentOptions, selectedIndex, hasCancelOption, cancelLabel);
      totalLines = initialLines.length;
      process.stdout.write(initialLines.join('\n') + '\n');

      const { useTty, forceTouchTty } = resolveTtyPolicy();
      assertTtyIfForced(forceTouchTty);
      if (!useTty) {
        finish({ selectedIndex: initialIndex, finalOptions: currentOptions });
        return;
      }

      rawMode = setupRawMode();
      process.stdin.on('data', onKeypress);
    } catch (error) {
      fail(error);
    }
  });
}

/**
 * Prompt user to select from a list of options using cursor navigation.
 * @returns Selected option or null if cancelled
 */
export async function selectOption<T extends string>(
  message: string,
  options: SelectOptionItem<T>[],
  callbacks?: InteractiveSelectCallbacks<T>,
): Promise<T | null> {
  if (options.length === 0) return null;

  const { selectedIndex, finalOptions } = await interactiveSelect(message, options, 0, true, callbacks);

  if (selectedIndex === finalOptions.length || selectedIndex === -1) {
    return null;
  }

  const selected = finalOptions[selectedIndex];
  if (selected && callbacks?.showConfirmation !== false) {
    console.log(chalk.green(`  ✓ ${selected.label}`));
  }

  if (selected) return selected.value;

  return null;
}

/**
 * Prompt user to select from a list of options with a default value.
 * @returns Selected option value, or null if cancelled (ESC pressed)
 */
export async function selectOptionWithDefault<T extends string>(
  message: string,
  options: { label: string; value: T }[],
  defaultValue: T,
): Promise<T | null> {
  if (options.length === 0) return defaultValue;

  const defaultIndex = options.findIndex((opt) => opt.value === defaultValue);
  const initialIndex = defaultIndex >= 0 ? defaultIndex : 0;

  const decoratedOptions: SelectOptionItem<T>[] = options.map((opt) => ({
    ...opt,
    label: opt.value === defaultValue ? `${opt.label} ${chalk.green('(default)')}` : opt.label,
  }));

  const { selectedIndex } = await interactiveSelect(message, decoratedOptions, initialIndex, true);

  if (selectedIndex === options.length || selectedIndex === -1) {
    return null;
  }

  const selected = options[selectedIndex];
  if (selected) {
    console.log(chalk.green(`  ✓ ${selected.label}`));
    return selected.value;
  }

  return defaultValue;
}

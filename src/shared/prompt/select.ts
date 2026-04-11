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

// Re-export public symbols so index.ts imports stay unchanged
export {
  type SelectOptionItem,
  type KeyInputResult,
  renderMenu,
  countRenderedLines,
  handleKeyInput,
} from './select-menu.js';

function printHeader(message: string, hasCustomKeyHandler: boolean): void {
  console.log();
  console.log(chalk.cyan(message));
  const hint = hasCustomKeyHandler
    ? '  (↑↓ to move, Enter to select, b to bookmark, r to remove)'
    : '  (↑↓ to move, Enter to select)';
  console.log(chalk.gray(hint));
  console.log();
}

function setupRawMode(): { cleanup: (listener: (data: Buffer) => void) => void; wasRaw: boolean } {
  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();

  return {
    wasRaw,
    cleanup(listener: (data: Buffer) => void): void {
      process.stdin.removeListener('data', listener);
      process.stdin.setRawMode(wasRaw ?? false);
      process.stdin.pause();
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
  return new Promise((resolve) => {
    let currentOptions = options;
    let totalItems = hasCancelOption ? currentOptions.length + 1 : currentOptions.length;
    let selectedIndex = initialIndex;
    const cancelLabel = callbacks?.cancelLabel ?? 'Cancel';

    const terminalRows = process.stdout.rows ?? 24;
    let viewport = createViewportState(terminalRows, currentOptions, hasCancelOption);

    printHeader(message, !!callbacks?.onKeyPress);

    process.stdout.write('\x1B[?7l');

    const initialLines = viewport.active
      ? renderMenuWithViewport(
          currentOptions, selectedIndex, hasCancelOption,
          viewport.scrollOffset, viewport.maxOptionLines, cancelLabel,
        )
      : renderMenu(currentOptions, selectedIndex, hasCancelOption, cancelLabel);
    let totalLines = initialLines.length;
    process.stdout.write(initialLines.join('\n') + '\n');

    const { useTty, forceTouchTty } = resolveTtyPolicy();
    assertTtyIfForced(forceTouchTty);
    if (!useTty) {
      process.stdout.write('\x1B[?7h');
      resolve({ selectedIndex: initialIndex, finalOptions: currentOptions });
      return;
    }

    const rawMode = setupRawMode();

    const cleanup = (listener: (data: Buffer) => void): void => {
      rawMode.cleanup(listener);
      process.stdout.write('\x1B[?7h');
    };

    const onKeypress = (data: Buffer): void => {
      try {
        const key = data.toString();

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
              return;
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
            cleanup(onKeypress);
            resolve({ selectedIndex: result.selectedIndex, finalOptions: currentOptions });
            break;
          case 'cancel':
            cleanup(onKeypress);
            resolve({ selectedIndex: result.cancelIndex, finalOptions: currentOptions });
            break;
          case 'bookmark':
          case 'remove_bookmark':
            break;
          case 'exit':
            cleanup(onKeypress);
            process.exit(130);
            break;
          case 'none':
            break;
        }
      } catch {
        cleanup(onKeypress);
        resolve({ selectedIndex: -1, finalOptions: currentOptions });
      }
    };

    process.stdin.on('data', onKeypress);
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
  if (selected) {
    console.log(chalk.green(`  ✓ ${selected.label}`));
    return selected.value;
  }

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

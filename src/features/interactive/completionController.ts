/**
 * Completion menu state management and operations.
 *
 * Manages the lifecycle of the inline completion menu:
 * filtering candidates, selection navigation, applying completions,
 * and coordinating with the terminal renderer.
 *
 * Separated from lineEditor to keep input handling and completion
 * logic as distinct concerns.
 */

import {
  renderCompletionMenu,
  writeCompletionMenu,
  clearCompletionMenu,
  type CompletionCandidate,
  type CompletionProvider,
} from './completionMenu.js';

/**
 * Create a completion controller bound to a line editor instance.
 */
export const createCompletionController = (
  accessors: {
    getBuffer: () => string;
    getCursorPos: () => number;
    getTermWidth: () => number;
    getTerminalColumn: (pos: number) => number;
    countRowsBelowCursor: () => number;
    getCursorRow: () => number;
  },
  mutators: {
    setBuffer: (value: string) => void;
    setCursorPos: (value: number) => void;
  },
  promptWidth: number,
  completionProvider?: CompletionProvider,
): {
  readonly getState: () => {
    readonly candidates: readonly CompletionCandidate[];
    readonly selectedIndex: number;
  } | null;
  readonly update: () => void;
  readonly hide: () => void;
  readonly moveSelection: (delta: number) => void;
  readonly apply: () => void;
  readonly acceptSelection: () => boolean;
} => {
  let completionState: {
    readonly candidates: readonly CompletionCandidate[];
    readonly selectedIndex: number;
  } | null = null;

  /**
   * Render current completionState to the terminal and restore cursor column.
   */
  const redraw = (): void => {
    if (!completionState) return;
    const termWidth = accessors.getTermWidth();
    const rowsBelow = accessors.countRowsBelowCursor();
    const lines = renderCompletionMenu(completionState.candidates, completionState.selectedIndex, termWidth);
    const termCol = accessors.getTerminalColumn(accessors.getCursorPos());
    writeCompletionMenu(lines, rowsBelow);
    process.stdout.write(`\x1B[${termCol}G`);
  };

  /**
   * Hide the completion menu if visible.
   */
  const hide = (): void => {
    if (!completionState) return;
    const rowsBelow = accessors.countRowsBelowCursor();
    const termCol = accessors.getTerminalColumn(accessors.getCursorPos());
    clearCompletionMenu(rowsBelow);
    process.stdout.write(`\x1B[${termCol}G`);
    completionState = null;
  };

  /**
   * Update completion menu state based on current buffer.
   */
  const update = (): void => {
    if (!completionProvider) {
      hide();
      return;
    }

    const buffer = accessors.getBuffer();
    const candidates = completionProvider({
      buffer,
      cursorPos: accessors.getCursorPos(),
    });

    if (candidates.length === 0) {
      hide();
      return;
    }

    const clampedIndex = completionState
      ? Math.min(completionState.selectedIndex, candidates.length - 1)
      : 0;
    completionState = { candidates, selectedIndex: clampedIndex };

    redraw();
  };

  /**
   * Move completion selection by delta (+1 = down, -1 = up) with wrap-around.
   */
  const moveSelection = (delta: number): void => {
    if (!completionState || completionState.candidates.length === 0) return;
    const len = completionState.candidates.length;
    const nextIndex = ((completionState.selectedIndex + delta) % len + len) % len;
    completionState = {
      ...completionState,
      selectedIndex: nextIndex,
    };
    redraw();
  };

  /**
   * Replace the active buffer from the prompt row and clear the menu.
   */
  const replaceBuffer = (newBuffer: string): void => {
    const rowsBelow = accessors.countRowsBelowCursor();
    const cursorRow = accessors.getCursorRow();

    if (rowsBelow > 0) {
      process.stdout.write(`\x1B[${rowsBelow}B`);
    }
    process.stdout.write('\r\n');
    process.stdout.write('\x1B[J');

    const moveUp = 1 + cursorRow + rowsBelow;
    if (moveUp > 0) {
      process.stdout.write(`\x1B[${moveUp}A`);
    }
    process.stdout.write(`\x1B[${promptWidth + 1}G`);

    mutators.setBuffer(newBuffer);
    mutators.setCursorPos(newBuffer.length);
    process.stdout.write(newBuffer);
    process.stdout.write('\x1B[J');

    completionState = null;
  };

  /**
   * Apply the selected completion value to the buffer.
   */
  const apply = (): void => {
    if (!completionState) return;
    const selected = completionState.candidates[completionState.selectedIndex];
    if (!selected) return;
    replaceBuffer(selected.applyValue ?? selected.value);
  };

  /**
   * Accept the currently selected completion without adding trailing editing space.
   */
  const acceptSelection = (): boolean => {
    if (!completionState) return false;
    const selected = completionState.candidates[completionState.selectedIndex];
    if (!selected) return false;
    replaceBuffer(selected.value);
    return true;
  };

  return {
    getState: () => completionState,
    update,
    hide,
    moveSelection,
    apply,
    acceptSelection,
  };
};

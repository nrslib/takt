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
  completionProvider?: (
    context: { buffer: string },
  ) => readonly CompletionCandidate[],
): {
  readonly getState: () => {
    readonly candidates: readonly CompletionCandidate[];
    selectedIndex: number;
  } | null;
  readonly update: () => void;
  readonly hide: () => void;
  readonly moveSelection: (delta: number) => void;
  readonly apply: () => void;
} => {
  let completionState: {
    readonly candidates: readonly CompletionCandidate[];
    selectedIndex: number;
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
    const candidates = completionProvider({ buffer });

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
    completionState.selectedIndex = ((completionState.selectedIndex + delta) % len + len) % len;
    redraw();
  };

  /**
   * Apply the selected completion value to the buffer.
   */
  const apply = (): void => {
    if (!completionState) return;
    const selected = completionState.candidates[completionState.selectedIndex];
    if (!selected) return;

    const newBuffer = selected.applyValue ?? selected.value;
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

  return {
    getState: () => completionState,
    update,
    hide,
    moveSelection,
    apply,
  };
};

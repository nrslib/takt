/**
 * Interactive prompts for CLI — re-export hub.
 *
 * Implementations have been split into:
 * - select.ts: Cursor-based menu selection (arrow key navigation)
 * - confirm.ts: Yes/no confirmation and text input prompts
 */

export {
  type SelectOptionItem,
  type InteractiveSelectCallbacks,
  renderMenu,
  countRenderedLines,
  type KeyInputResult,
  handleKeyInput,
  selectOption,
  selectOptionWithDefault,
} from './select.js';

export {
  selectMultipleOptions,
  type MultipleSelectOptions,
} from './multi-select.js';

export {
  promptInput,
  readMultilineFromStream,
  confirm,
} from './confirm.js';

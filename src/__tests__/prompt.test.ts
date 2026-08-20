/**
 * Tests for prompt module (cursor-based interactive menu)
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { Readable } from 'node:stream';
import chalk from 'chalk';
import { setupRawStdin, restoreStdin } from './helpers/stdinSimulator.js';
import type { SelectOptionItem } from '../shared/prompt/index.js';
import {
  renderMenu,
  countRenderedLines,
  handleKeyInput,
  firstSelectableIndex,
  readMultilineFromStream,
} from '../shared/prompt/index.js';

// Disable chalk colors for predictable test output
const originalChalkLevel = chalk.level;
chalk.level = 0;
afterAll(() => {
  chalk.level = originalChalkLevel;
});

describe('prompt', () => {
  describe('renderMenu', () => {
    const basicOptions: SelectOptionItem<string>[] = [
      { label: 'Option A', value: 'a' },
      { label: 'Option B', value: 'b' },
      { label: 'Option C', value: 'c' },
    ];

    it('should render all options with cursor on selected item', () => {
      const lines = renderMenu(basicOptions, 0, false);

      // 3 options = 3 lines
      expect(lines).toHaveLength(3);
      // First item selected - contains cursor marker
      expect(lines[0]).toContain('❯');
      expect(lines[0]).toContain('Option A');
      // Other items should not have cursor
      expect(lines[1]).not.toContain('❯');
      expect(lines[2]).not.toContain('❯');
    });

    it('should move cursor to second item when selectedIndex is 1', () => {
      const lines = renderMenu(basicOptions, 1, false);

      expect(lines[0]).not.toContain('❯');
      expect(lines[1]).toContain('❯');
      expect(lines[1]).toContain('Option B');
      expect(lines[2]).not.toContain('❯');
    });

    it('should move cursor to last item', () => {
      const lines = renderMenu(basicOptions, 2, false);

      expect(lines[0]).not.toContain('❯');
      expect(lines[1]).not.toContain('❯');
      expect(lines[2]).toContain('❯');
      expect(lines[2]).toContain('Option C');
    });

    it('should render a non-selectable heading without a cursor even if index matches', () => {
      const treeOptions: SelectOptionItem<string>[] = [
        { label: 'group:', value: 'h', selectable: false },
        { label: 'plan', value: 'p' },
      ];
      const lines = renderMenu(treeOptions, 0, false);

      expect(lines).toHaveLength(2);
      // Heading never carries the cursor marker.
      expect(lines[0]).not.toContain('❯');
      expect(lines[0]).toContain('group:');
      // Leaves still render normally.
      expect(lines[1]).toContain('plan');
    });

    it('should include Cancel option when hasCancelOption is true', () => {
      const lines = renderMenu(basicOptions, 0, true);

      // 3 options + 1 cancel = 4 lines
      expect(lines).toHaveLength(4);
      expect(lines[3]).toContain('Cancel');
    });

    it('should highlight Cancel when it is selected', () => {
      const lines = renderMenu(basicOptions, 3, true);

      // Cancel is at index 3 (options.length)
      expect(lines[3]).toContain('❯');
      expect(lines[3]).toContain('Cancel');
      // Other items should not have cursor
      expect(lines[0]).not.toContain('❯');
      expect(lines[1]).not.toContain('❯');
      expect(lines[2]).not.toContain('❯');
    });

    it('should render description lines', () => {
      const optionsWithDesc: SelectOptionItem<string>[] = [
        { label: 'Option A', value: 'a', description: 'Description for A' },
        { label: 'Option B', value: 'b' },
      ];

      const lines = renderMenu(optionsWithDesc, 0, false);

      // Option A has label + description = 2 lines, Option B = 1 line
      expect(lines).toHaveLength(3);
      expect(lines[1]).toContain('Description for A');
    });

    it('should render detail lines', () => {
      const optionsWithDetails: SelectOptionItem<string>[] = [
        {
          label: 'Option A',
          value: 'a',
          description: 'Desc A',
          details: ['Detail 1', 'Detail 2'],
        },
        { label: 'Option B', value: 'b' },
      ];

      const lines = renderMenu(optionsWithDetails, 0, false);

      // Option A: label + description + 2 details = 4 lines, Option B = 1 line
      expect(lines).toHaveLength(5);
      expect(lines[2]).toContain('Detail 1');
      expect(lines[3]).toContain('Detail 2');
    });

    it('should handle empty options array', () => {
      const lines = renderMenu([], 0, false);
      expect(lines).toHaveLength(0);
    });

    it('should handle empty options with cancel', () => {
      const lines = renderMenu([], 0, true);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('Cancel');
    });
  });

  describe('countRenderedLines', () => {
    it('should count basic options (1 line each)', () => {
      const options: SelectOptionItem<string>[] = [
        { label: 'A', value: 'a' },
        { label: 'B', value: 'b' },
        { label: 'C', value: 'c' },
      ];

      expect(countRenderedLines(options, false)).toBe(3);
    });

    it('should add 1 for cancel option', () => {
      const options: SelectOptionItem<string>[] = [
        { label: 'A', value: 'a' },
        { label: 'B', value: 'b' },
      ];

      expect(countRenderedLines(options, true)).toBe(3);
    });

    it('should count description lines', () => {
      const options: SelectOptionItem<string>[] = [
        { label: 'A', value: 'a', description: 'Desc A' },
        { label: 'B', value: 'b' },
      ];

      // A: label + desc = 2, B: label = 1, total = 3
      expect(countRenderedLines(options, false)).toBe(3);
    });

    it('should count detail lines', () => {
      const options: SelectOptionItem<string>[] = [
        {
          label: 'A',
          value: 'a',
          description: 'Desc',
          details: ['D1', 'D2', 'D3'],
        },
      ];

      // label + desc + 3 details = 5
      expect(countRenderedLines(options, false)).toBe(5);
    });

    it('should count combined description and details with cancel', () => {
      const options: SelectOptionItem<string>[] = [
        {
          label: 'A',
          value: 'a',
          description: 'Desc A',
          details: ['D1'],
        },
        { label: 'B', value: 'b', description: 'Desc B' },
      ];

      // A: 1 + 1 + 1 = 3, B: 1 + 1 = 2, cancel: 1, total = 6
      expect(countRenderedLines(options, true)).toBe(6);
    });

    it('should return 0 for empty options without cancel', () => {
      expect(countRenderedLines([], false)).toBe(0);
    });

    it('should return 1 for empty options with cancel', () => {
      expect(countRenderedLines([], true)).toBe(1);
    });
  });

  describe('non-selectable heading rows', () => {
    // index 0 = heading, 1 = leaf, 2 = heading, 3 = leaf, plus cancel (index 4)
    const options: SelectOptionItem<string>[] = [
      { label: 'group-a', value: 'ha', selectable: false },
      { label: 'plan', value: 'la' },
      { label: 'group-b', value: 'hb', selectable: false },
      { label: 'review', value: 'lb' },
    ];
    const totalItems = options.length + 1; // includes Cancel
    const optionCount = options.length;

    it('should keep line counting aligned when a heading has details', () => {
      const optionsWithDetails: SelectOptionItem<string>[] = [
        {
          label: 'group-a',
          value: 'ha',
          selectable: false,
          description: 'heading note',
          details: ['not rendered for headings'],
        },
        { label: 'plan', value: 'la' },
      ];

      const renderedLines = renderMenu(optionsWithDetails, 1, false);
      expect(renderedLines).toHaveLength(3);
      const renderedText = renderedLines.join('\n');
      expect(renderedText).toContain('heading note');
      expect(renderedText).not.toContain('not rendered for headings');
      expect(countRenderedLines(optionsWithDetails, false)).toBe(3);
    });

    it('should skip a heading when moving down', () => {
      // From leaf index 1, down should skip heading index 2 and land on leaf 3.
      const result = handleKeyInput('\x1B[B', 1, totalItems, true, optionCount, options);
      expect(result).toEqual({ action: 'move', newIndex: 3 });
    });

    it('should skip a heading when moving up', () => {
      // From leaf index 1, up should skip heading index 0 and wrap to Cancel (4).
      const result = handleKeyInput('\x1B[A', 1, totalItems, true, optionCount, options);
      expect(result).toEqual({ action: 'move', newIndex: 4 });
    });

    it('should land on the Cancel row, which is always selectable', () => {
      const result = handleKeyInput('\x1B[B', 3, totalItems, true, optionCount, options);
      expect(result).toEqual({ action: 'move', newIndex: 4 });
    });

    it('should ignore Enter on a heading row', () => {
      const result = handleKeyInput('\r', 0, totalItems, true, optionCount, options);
      expect(result).toEqual({ action: 'none' });
    });

    it('should confirm Enter on a leaf row', () => {
      const result = handleKeyInput('\r', 1, totalItems, true, optionCount, options);
      expect(result).toEqual({ action: 'confirm', selectedIndex: 1 });
    });

    it('firstSelectableIndex should advance past a leading heading', () => {
      expect(firstSelectableIndex(options, 0, true)).toBe(1);
    });

    it('firstSelectableIndex should keep an already-selectable start', () => {
      expect(firstSelectableIndex(options, 3, true)).toBe(3);
    });

    it('firstSelectableIndex should fall back to Cancel when no option is selectable', () => {
      const allHeadings: SelectOptionItem<string>[] = [
        { label: 'group-a', value: 'ha', selectable: false },
        { label: 'group-b', value: 'hb', selectable: false },
      ];
      expect(firstSelectableIndex(allHeadings, 0, true)).toBe(allHeadings.length);
    });
  });

  describe('handleKeyInput', () => {
    // 3 options + cancel = 4 total items
    const totalItems = 4;
    const optionCount = 3;
    const hasCancelOption = true;

    describe('move up (arrow up / k)', () => {
      it('should move up with arrow key', () => {
        const result = handleKeyInput('\x1B[A', 1, totalItems, hasCancelOption, optionCount);
        expect(result).toEqual({ action: 'move', newIndex: 0 });
      });

      it('should move up with vim k key', () => {
        const result = handleKeyInput('k', 2, totalItems, hasCancelOption, optionCount);
        expect(result).toEqual({ action: 'move', newIndex: 1 });
      });

      it('should wrap around from first item to last', () => {
        const result = handleKeyInput('\x1B[A', 0, totalItems, hasCancelOption, optionCount);
        expect(result).toEqual({ action: 'move', newIndex: 3 });
      });
    });

    describe('move down (arrow down / j)', () => {
      it('should move down with arrow key', () => {
        const result = handleKeyInput('\x1B[B', 0, totalItems, hasCancelOption, optionCount);
        expect(result).toEqual({ action: 'move', newIndex: 1 });
      });

      it('should move down with vim j key', () => {
        const result = handleKeyInput('j', 1, totalItems, hasCancelOption, optionCount);
        expect(result).toEqual({ action: 'move', newIndex: 2 });
      });

      it('should wrap around from last item to first', () => {
        const result = handleKeyInput('\x1B[B', 3, totalItems, hasCancelOption, optionCount);
        expect(result).toEqual({ action: 'move', newIndex: 0 });
      });
    });

    describe('confirm (Enter)', () => {
      it('should confirm with carriage return', () => {
        const result = handleKeyInput('\r', 2, totalItems, hasCancelOption, optionCount);
        expect(result).toEqual({ action: 'confirm', selectedIndex: 2 });
      });

      it('should confirm with newline', () => {
        const result = handleKeyInput('\n', 0, totalItems, hasCancelOption, optionCount);
        expect(result).toEqual({ action: 'confirm', selectedIndex: 0 });
      });

      it('should confirm cancel position when Enter on cancel item', () => {
        const result = handleKeyInput('\r', 3, totalItems, hasCancelOption, optionCount);
        expect(result).toEqual({ action: 'confirm', selectedIndex: 3 });
      });
    });

    describe('cancel (Escape)', () => {
      it('should return optionCount as cancelIndex when hasCancelOption', () => {
        const result = handleKeyInput('\x1B', 1, totalItems, true, optionCount);
        expect(result).toEqual({ action: 'cancel', cancelIndex: 3 });
      });

      it('should return -1 as cancelIndex when no cancel option', () => {
        const result = handleKeyInput('\x1B', 1, 3, false, optionCount);
        expect(result).toEqual({ action: 'cancel', cancelIndex: -1 });
      });
    });

    describe('exit (Ctrl+C)', () => {
      it('should return exit action', () => {
        const result = handleKeyInput('\x03', 0, totalItems, hasCancelOption, optionCount);
        expect(result).toEqual({ action: 'exit' });
      });
    });

    describe('unrecognized keys', () => {
      it('should return none for regular characters', () => {
        const result = handleKeyInput('a', 0, totalItems, hasCancelOption, optionCount);
        expect(result).toEqual({ action: 'none' });
      });

      it('should return none for space', () => {
        const result = handleKeyInput(' ', 0, totalItems, hasCancelOption, optionCount);
        expect(result).toEqual({ action: 'none' });
      });

      it('should return none for numbers', () => {
        const result = handleKeyInput('1', 0, totalItems, hasCancelOption, optionCount);
        expect(result).toEqual({ action: 'none' });
      });
    });

    describe('without cancel option', () => {
      const noCancelTotal = 3;

      it('should wrap up correctly without cancel', () => {
        const result = handleKeyInput('\x1B[A', 0, noCancelTotal, false, optionCount);
        expect(result).toEqual({ action: 'move', newIndex: 2 });
      });

      it('should wrap down correctly without cancel', () => {
        const result = handleKeyInput('\x1B[B', 2, noCancelTotal, false, optionCount);
        expect(result).toEqual({ action: 'move', newIndex: 0 });
      });
    });

    describe('single option', () => {
      it('should wrap around with 1 item + cancel (totalItems=2)', () => {
        const result = handleKeyInput('\x1B[B', 1, 2, true, 1);
        expect(result).toEqual({ action: 'move', newIndex: 0 });
      });

      it('should confirm single option', () => {
        const result = handleKeyInput('\r', 0, 1, false, 1);
        expect(result).toEqual({ action: 'confirm', selectedIndex: 0 });
      });
    });
  });

  describe('selectOption', () => {
    it('should return null for empty options', async () => {
      const { selectOption } = await import('../shared/prompt/index.js');
      const result = await selectOption('Test:', []);
      expect(result).toBeNull();
    });
  });

  describe('selectOptionWithDefault', () => {
    it('should return default for empty options', async () => {
      const { selectOptionWithDefault } = await import('../shared/prompt/index.js');
      const result = await selectOptionWithDefault('Test:', [], 'fallback');
      expect(result).toBe('fallback');
    });

    it('should have return type that allows null (cancel)', async () => {
      const { selectOptionWithDefault } = await import('../shared/prompt/index.js');
      // When options are empty, default is returned (not null)
      const result: string | null = await selectOptionWithDefault('Test:', [], 'fallback');
      expect(result).toBe('fallback');
    });
  });

  describe('selectOptionWithDefault (stdin E2E)', () => {
    afterEach(() => {
      restoreStdin();
    });

    it('should place cursor on default value and confirm it with Enter', async () => {
      // Enter key only — confirms whatever the cursor is on
      setupRawStdin(['\r']);

      const { selectOptionWithDefault } = await import('../shared/prompt/index.js');
      const options = [
        { label: 'plan', value: 'plan' },
        { label: 'implement', value: 'implement' },
        { label: 'review', value: 'review' },
      ];

      const result = await selectOptionWithDefault('Start from:', options, 'review');

      // If cursor starts at 'review' (index 2), Enter should select it
      expect(result).toBe('review');
    });

    it('should place cursor on first item when default is the first option', async () => {
      setupRawStdin(['\r']);

      const { selectOptionWithDefault } = await import('../shared/prompt/index.js');
      const options = [
        { label: 'plan', value: 'plan' },
        { label: 'implement', value: 'implement' },
        { label: 'review', value: 'review' },
      ];

      const result = await selectOptionWithDefault('Start from:', options, 'plan');

      expect(result).toBe('plan');
    });

    it('should place cursor on middle item when default is the middle option', async () => {
      setupRawStdin(['\r']);

      const { selectOptionWithDefault } = await import('../shared/prompt/index.js');
      const options = [
        { label: 'plan', value: 'plan' },
        { label: 'implement', value: 'implement' },
        { label: 'review', value: 'review' },
      ];

      const result = await selectOptionWithDefault('Start from:', options, 'implement');

      expect(result).toBe('implement');
    });

    it('should fall back to first item when default value does not exist', async () => {
      setupRawStdin(['\r']);

      const { selectOptionWithDefault } = await import('../shared/prompt/index.js');
      const options = [
        { label: 'plan', value: 'plan' },
        { label: 'implement', value: 'implement' },
      ];

      const result = await selectOptionWithDefault('Start from:', options, 'nonexistent');

      // defaultValue not found → falls back to index 0
      expect(result).toBe('plan');
    });

    it('should scroll the initial viewport to a deep default leaf', async () => {
      const rowsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
      Object.defineProperty(process.stdout, 'rows', { value: 8, configurable: true });

      try {
        setupRawStdin(['\r']);

        const { selectOptionWithDefault } = await import('../shared/prompt/index.js');
        const options = Array.from({ length: 20 }, (_, index) => ({
          label: `leaf-${index}`,
          value: `leaf-${index}`,
        }));

        const result = await selectOptionWithDefault('Start position:', options, 'leaf-19');
        const writes = (process.stdout.write as unknown as { mock: { calls: unknown[][] } }).mock.calls;
        const output = writes.map((call) => String(call[0] ?? '')).join('');
        const defaultLine = output.split('\n').find((line) => line.includes('leaf-19'));

        expect(defaultLine).toContain('❯');
        expect(defaultLine).toContain('(default)');
        expect(result).toBe('leaf-19');
      } finally {
        if (rowsDescriptor) {
          Object.defineProperty(process.stdout, 'rows', rowsDescriptor);
        } else {
          Reflect.deleteProperty(process.stdout, 'rows');
        }
      }
    });
  });

  describe('readMultilineFromStream', () => {
    it('should return null when first line is empty (cancel)', async () => {
      const input = Readable.from(['\n']);
      const result = await readMultilineFromStream(input);
      expect(result).toBeNull();
    });

    it('should return single line when followed by empty line', async () => {
      const input = Readable.from(['hello world\n\n']);
      const result = await readMultilineFromStream(input);
      expect(result).toBe('hello world');
    });

    it('should return multiple lines joined by newline', async () => {
      const input = Readable.from(['line 1\nline 2\nline 3\n\n']);
      const result = await readMultilineFromStream(input);
      expect(result).toBe('line 1\nline 2\nline 3');
    });

    it('should trim leading and trailing whitespace from the joined result', async () => {
      const input = Readable.from(['  hello  \n  world  \n\n']);
      const result = await readMultilineFromStream(input);
      // .trim() is applied to the joined string, so leading spaces on first line are trimmed
      expect(result).toBe('hello  \n  world');
    });

    it('should handle stream close without empty line (Ctrl+C)', async () => {
      // Stream ends without empty line terminator
      const input = Readable.from(['some content\n']);
      const result = await readMultilineFromStream(input);
      expect(result).toBe('some content');
    });

    it('should return null when stream closes with no input', async () => {
      const input = Readable.from([]);
      const result = await readMultilineFromStream(input);
      expect(result).toBeNull();
    });
  });

  describe('selectOptionWithDefault cancel behavior', () => {
    it('handleKeyInput should return cancel with optionCount when hasCancelOption is true', () => {
      // Simulates ESC key press with cancel option enabled (as selectOptionWithDefault now does)
      const result = handleKeyInput('\x1B', 0, 4, true, 3);
      expect(result).toEqual({ action: 'cancel', cancelIndex: 3 });
    });

    it('handleKeyInput should support navigating to Cancel item', () => {
      // With 3 options + cancel, totalItems = 4, cancel is at index 3
      const downResult = handleKeyInput('\x1B[B', 2, 4, true, 3);
      expect(downResult).toEqual({ action: 'move', newIndex: 3 });

      // Confirming on cancel index (3) should return confirm with selectedIndex 3
      const confirmResult = handleKeyInput('\r', 3, 4, true, 3);
      expect(confirmResult).toEqual({ action: 'confirm', selectedIndex: 3 });
    });
  });
});

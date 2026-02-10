/**
 * Tests for TaskPrefixWriter
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { TaskPrefixWriter } from '../shared/ui/TaskPrefixWriter.js';

describe('TaskPrefixWriter', () => {
  let output: string[];
  let writeFn: (text: string) => void;

  beforeEach(() => {
    output = [];
    writeFn = (text: string) => output.push(text);
  });

  describe('constructor', () => {
    it('should cycle colors for different colorIndex values', () => {
      const writer0 = new TaskPrefixWriter({ taskName: 'task-a', colorIndex: 0, writeFn });
      const writer4 = new TaskPrefixWriter({ taskName: 'task-a', colorIndex: 4, writeFn });

      writer0.writeLine('hello');
      writer4.writeLine('hello');

      // Both index 0 and 4 should use cyan (\x1b[36m)
      expect(output[0]).toContain('\x1b[36m');
      expect(output[1]).toContain('\x1b[36m');
    });

    it('should assign correct colors in order', () => {
      const writers = [0, 1, 2, 3].map(
        (i) => new TaskPrefixWriter({ taskName: `t${i}`, colorIndex: i, writeFn }),
      );

      writers.forEach((w) => w.writeLine('x'));

      expect(output[0]).toContain('\x1b[36m'); // cyan
      expect(output[1]).toContain('\x1b[33m'); // yellow
      expect(output[2]).toContain('\x1b[35m'); // magenta
      expect(output[3]).toContain('\x1b[32m'); // green
    });
  });

  describe('writeLine', () => {
    it('should output single line with truncated task prefix', () => {
      const writer = new TaskPrefixWriter({ taskName: 'my-task', colorIndex: 0, writeFn });

      writer.writeLine('Hello World');

      expect(output).toHaveLength(1);
      expect(output[0]).toContain('[my-t]');
      expect(output[0]).toContain('Hello World');
      expect(output[0]).toMatch(/\n$/);
    });

    it('should output empty line as bare newline', () => {
      const writer = new TaskPrefixWriter({ taskName: 'my-task', colorIndex: 0, writeFn });

      writer.writeLine('');

      expect(output).toHaveLength(1);
      expect(output[0]).toBe('\n');
    });

    it('should split multi-line text and prefix each non-empty line', () => {
      const writer = new TaskPrefixWriter({ taskName: 'my-task', colorIndex: 0, writeFn });

      writer.writeLine('Line 1\nLine 2\n\nLine 4');

      expect(output).toHaveLength(4);
      expect(output[0]).toContain('Line 1');
      expect(output[1]).toContain('Line 2');
      expect(output[2]).toBe('\n'); // empty line
      expect(output[3]).toContain('Line 4');
    });

    it('should strip ANSI codes from input text', () => {
      const writer = new TaskPrefixWriter({ taskName: 'my-task', colorIndex: 0, writeFn });

      writer.writeLine('\x1b[31mRed Text\x1b[0m');

      expect(output).toHaveLength(1);
      expect(output[0]).toContain('Red Text');
      expect(output[0]).not.toContain('\x1b[31m');
    });
  });

  describe('writeChunk (line buffering)', () => {
    it('should buffer partial line and output on newline', () => {
      const writer = new TaskPrefixWriter({ taskName: 'task-a', colorIndex: 0, writeFn });

      writer.writeChunk('Hello');
      expect(output).toHaveLength(0);

      writer.writeChunk(' World\n');
      expect(output).toHaveLength(1);
      expect(output[0]).toContain('[task]');
      expect(output[0]).toContain('Hello World');
    });

    it('should handle multiple lines in single chunk', () => {
      const writer = new TaskPrefixWriter({ taskName: 'task-a', colorIndex: 0, writeFn });

      writer.writeChunk('Line 1\nLine 2\n');

      expect(output).toHaveLength(2);
      expect(output[0]).toContain('Line 1');
      expect(output[1]).toContain('Line 2');
    });

    it('should output empty line without prefix', () => {
      const writer = new TaskPrefixWriter({ taskName: 'task-a', colorIndex: 0, writeFn });

      writer.writeChunk('Hello\n\nWorld\n');

      expect(output).toHaveLength(3);
      expect(output[0]).toContain('Hello');
      expect(output[1]).toBe('\n');
      expect(output[2]).toContain('World');
    });

    it('should keep trailing partial in buffer', () => {
      const writer = new TaskPrefixWriter({ taskName: 'task-a', colorIndex: 0, writeFn });

      writer.writeChunk('Complete\nPartial');

      expect(output).toHaveLength(1);
      expect(output[0]).toContain('Complete');

      writer.flush();
      expect(output).toHaveLength(2);
      expect(output[1]).toContain('Partial');
    });

    it('should strip ANSI codes from streamed chunks', () => {
      const writer = new TaskPrefixWriter({ taskName: 'task-a', colorIndex: 0, writeFn });

      writer.writeChunk('\x1b[31mHello');
      writer.writeChunk(' World\x1b[0m\n');

      expect(output).toHaveLength(1);
      expect(output[0]).toContain('Hello World');
      expect(output[0]).not.toContain('\x1b[31m');
    });
  });

  describe('flush', () => {
    it('should output remaining buffered content with prefix', () => {
      const writer = new TaskPrefixWriter({ taskName: 'task-a', colorIndex: 0, writeFn });

      writer.writeChunk('partial content');
      expect(output).toHaveLength(0);

      writer.flush();

      expect(output).toHaveLength(1);
      expect(output[0]).toContain('[task]');
      expect(output[0]).toContain('partial content');
      expect(output[0]).toMatch(/\n$/);
    });

    it('should not output anything when buffer is empty', () => {
      const writer = new TaskPrefixWriter({ taskName: 'task-a', colorIndex: 0, writeFn });

      writer.writeChunk('complete line\n');
      output.length = 0;

      writer.flush();
      expect(output).toHaveLength(0);
    });

    it('should clear buffer after flush', () => {
      const writer = new TaskPrefixWriter({ taskName: 'task-a', colorIndex: 0, writeFn });

      writer.writeChunk('content');
      writer.flush();
      output.length = 0;

      writer.flush();
      expect(output).toHaveLength(0);
    });
  });

  describe('setMovementContext', () => {
    it('should include movement context in prefix after context update', () => {
      const writer = new TaskPrefixWriter({ taskName: 'override-persona-provider', colorIndex: 0, writeFn });

      writer.setMovementContext({
        movementName: 'implement',
        iteration: 4,
        maxMovements: 30,
        movementIteration: 2,
      });
      writer.writeLine('content');

      expect(output).toHaveLength(1);
      expect(output[0]).toContain('[over]');
      expect(output[0]).toContain('[implement](4/30)(2)');
      expect(output[0]).toContain('content');
    });
  });

});

/**
 * Tests for parallel-logger module
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ParallelLogger } from '../core/piece/index.js';
import type { StreamEvent } from '../core/piece/index.js';

describe('ParallelLogger', () => {
  let output: string[];
  let writeFn: (text: string) => void;

  beforeEach(() => {
    output = [];
    writeFn = (text: string) => output.push(text);
  });

  describe('buildPrefix', () => {
    it('should build colored prefix with padding', () => {
      const logger = new ParallelLogger({
        subMovementNames: ['arch-review', 'sec'],
        writeFn,
      });

      // arch-review is longest (11 chars), sec gets padding
      const prefix = logger.buildPrefix('sec', 1);
      // yellow color for index 1
      expect(prefix).toContain('[sec]');
      expect(prefix).toContain('\x1b[33m'); // yellow
      expect(prefix).toContain('\x1b[0m');  // reset
      // 11 - 3 = 8 spaces of padding
      expect(prefix).toMatch(/\x1b\[0m {8} $/);
    });

    it('should cycle colors for index >= 4', () => {
      const logger = new ParallelLogger({
        subMovementNames: ['a', 'b', 'c', 'd', 'e'],
        writeFn,
      });

      const prefix0 = logger.buildPrefix('a', 0);
      const prefix4 = logger.buildPrefix('e', 4);
      // Both should use cyan (\x1b[36m)
      expect(prefix0).toContain('\x1b[36m');
      expect(prefix4).toContain('\x1b[36m');
    });

    it('should assign correct colors in order', () => {
      const logger = new ParallelLogger({
        subMovementNames: ['a', 'b', 'c', 'd'],
        writeFn,
      });

      expect(logger.buildPrefix('a', 0)).toContain('\x1b[36m'); // cyan
      expect(logger.buildPrefix('b', 1)).toContain('\x1b[33m'); // yellow
      expect(logger.buildPrefix('c', 2)).toContain('\x1b[35m'); // magenta
      expect(logger.buildPrefix('d', 3)).toContain('\x1b[32m'); // green
    });

    it('should have no extra padding for longest name', () => {
      const logger = new ParallelLogger({
        subMovementNames: ['long-name', 'short'],
        writeFn,
      });

      const prefix = logger.buildPrefix('long-name', 0);
      // No padding needed (0 spaces)
      expect(prefix).toMatch(/\x1b\[0m $/);
    });

    it('should build rich prefix with task and parent movement for parallel task mode', () => {
      const logger = new ParallelLogger({
        subMovementNames: ['arch-review'],
        writeFn,
        progressInfo: {
          iteration: 4,
          maxMovements: 30,
        },
        taskLabel: 'override-persona-provider',
        taskColorIndex: 0,
        parentMovementName: 'reviewers',
        movementIteration: 1,
      });

      const prefix = logger.buildPrefix('arch-review', 0);
      expect(prefix).toContain('\x1b[36m');
      expect(prefix).toContain('[over]');
      expect(prefix).toContain('[reviewers]');
      expect(prefix).toContain('[arch-review]');
      expect(prefix).toContain('(4/30)(1)');
      expect(prefix).not.toContain('step 1/1');
    });
  });

  describe('text event line buffering', () => {
    it('should buffer partial line and output on newline', () => {
      const logger = new ParallelLogger({
        subMovementNames: ['step-a'],
        writeFn,
      });
      const handler = logger.createStreamHandler('step-a', 0);

      // Partial text (no newline)
      handler({ type: 'text', data: { text: 'Hello' } } as StreamEvent);
      expect(output).toHaveLength(0);

      // Complete the line
      handler({ type: 'text', data: { text: ' World\n' } } as StreamEvent);
      expect(output).toHaveLength(1);
      expect(output[0]).toContain('[step-a]');
      expect(output[0]).toContain('Hello World');
      expect(output[0]).toMatch(/\n$/);
    });

    it('should handle multiple lines in single text event', () => {
      const logger = new ParallelLogger({
        subMovementNames: ['step-a'],
        writeFn,
      });
      const handler = logger.createStreamHandler('step-a', 0);

      handler({ type: 'text', data: { text: 'Line 1\nLine 2\n' } } as StreamEvent);
      expect(output).toHaveLength(2);
      expect(output[0]).toContain('Line 1');
      expect(output[1]).toContain('Line 2');
    });

    it('should output empty line without prefix', () => {
      const logger = new ParallelLogger({
        subMovementNames: ['step-a'],
        writeFn,
      });
      const handler = logger.createStreamHandler('step-a', 0);

      handler({ type: 'text', data: { text: 'Hello\n\nWorld\n' } } as StreamEvent);
      expect(output).toHaveLength(3);
      expect(output[0]).toContain('Hello');
      expect(output[1]).toBe('\n'); // empty line without prefix
      expect(output[2]).toContain('World');
    });

    it('should keep trailing partial in buffer', () => {
      const logger = new ParallelLogger({
        subMovementNames: ['step-a'],
        writeFn,
      });
      const handler = logger.createStreamHandler('step-a', 0);

      handler({ type: 'text', data: { text: 'Complete\nPartial' } } as StreamEvent);
      expect(output).toHaveLength(1);
      expect(output[0]).toContain('Complete');

      // Flush remaining
      logger.flush();
      expect(output).toHaveLength(2);
      expect(output[1]).toContain('Partial');
    });
  });

  describe('block events (tool_use, tool_result, tool_output, thinking)', () => {
    it('should prefix tool_use events', () => {
      const logger = new ParallelLogger({
        subMovementNames: ['sub-a'],
        writeFn,
      });
      const handler = logger.createStreamHandler('sub-a', 0);

      handler({
        type: 'tool_use',
        data: { tool: 'Read', input: {}, id: '1' },
      } as StreamEvent);

      expect(output).toHaveLength(1);
      expect(output[0]).toContain('[sub-a]');
      expect(output[0]).toContain('[tool] Read');
    });

    it('should prefix tool_result events', () => {
      const logger = new ParallelLogger({
        subMovementNames: ['sub-a'],
        writeFn,
      });
      const handler = logger.createStreamHandler('sub-a', 0);

      handler({
        type: 'tool_result',
        data: { content: 'File content here', isError: false },
      } as StreamEvent);

      expect(output).toHaveLength(1);
      expect(output[0]).toContain('File content here');
    });

    it('should prefix multi-line tool output', () => {
      const logger = new ParallelLogger({
        subMovementNames: ['sub-a'],
        writeFn,
      });
      const handler = logger.createStreamHandler('sub-a', 0);

      handler({
        type: 'tool_output',
        data: { tool: 'Bash', output: 'line1\nline2' },
      } as StreamEvent);

      expect(output).toHaveLength(2);
      expect(output[0]).toContain('line1');
      expect(output[1]).toContain('line2');
    });

    it('should prefix thinking events', () => {
      const logger = new ParallelLogger({
        subMovementNames: ['sub-a'],
        writeFn,
      });
      const handler = logger.createStreamHandler('sub-a', 0);

      handler({
        type: 'thinking',
        data: { thinking: 'Considering options...' },
      } as StreamEvent);

      expect(output).toHaveLength(1);
      expect(output[0]).toContain('Considering options...');
    });
  });

  describe('delegated events (init, result, error)', () => {
    it('should delegate init event to parent callback', () => {
      const parentEvents: StreamEvent[] = [];
      const logger = new ParallelLogger({
        subMovementNames: ['sub-a'],
        parentOnStream: (event) => parentEvents.push(event),
        writeFn,
      });
      const handler = logger.createStreamHandler('sub-a', 0);

      const initEvent: StreamEvent = {
        type: 'init',
        data: { model: 'claude-3', sessionId: 'sess-1' },
      };
      handler(initEvent);

      expect(parentEvents).toHaveLength(1);
      expect(parentEvents[0]).toBe(initEvent);
      expect(output).toHaveLength(0); // Not written to stdout
    });

    it('should delegate result event to parent callback', () => {
      const parentEvents: StreamEvent[] = [];
      const logger = new ParallelLogger({
        subMovementNames: ['sub-a'],
        parentOnStream: (event) => parentEvents.push(event),
        writeFn,
      });
      const handler = logger.createStreamHandler('sub-a', 0);

      const resultEvent: StreamEvent = {
        type: 'result',
        data: { result: 'done', sessionId: 'sess-1', success: true },
      };
      handler(resultEvent);

      expect(parentEvents).toHaveLength(1);
      expect(parentEvents[0]).toBe(resultEvent);
    });

    it('should delegate error event to parent callback', () => {
      const parentEvents: StreamEvent[] = [];
      const logger = new ParallelLogger({
        subMovementNames: ['sub-a'],
        parentOnStream: (event) => parentEvents.push(event),
        writeFn,
      });
      const handler = logger.createStreamHandler('sub-a', 0);

      const errorEvent: StreamEvent = {
        type: 'error',
        data: { message: 'Something went wrong' },
      };
      handler(errorEvent);

      expect(parentEvents).toHaveLength(1);
      expect(parentEvents[0]).toBe(errorEvent);
    });

    it('should not crash when no parent callback for delegated events', () => {
      const logger = new ParallelLogger({
        subMovementNames: ['sub-a'],
        writeFn,
      });
      const handler = logger.createStreamHandler('sub-a', 0);

      // Should not throw
      handler({ type: 'init', data: { model: 'claude-3', sessionId: 'sess-1' } } as StreamEvent);
      handler({ type: 'result', data: { result: 'done', sessionId: 'sess-1', success: true } } as StreamEvent);
      handler({ type: 'error', data: { message: 'err' } } as StreamEvent);

      expect(output).toHaveLength(0);
    });
  });

  describe('flush', () => {
    it('should output remaining buffered content', () => {
      const logger = new ParallelLogger({
        subMovementNames: ['step-a', 'step-b'],
        writeFn,
      });
      const handlerA = logger.createStreamHandler('step-a', 0);
      const handlerB = logger.createStreamHandler('step-b', 1);

      handlerA({ type: 'text', data: { text: 'partial-a' } } as StreamEvent);
      handlerB({ type: 'text', data: { text: 'partial-b' } } as StreamEvent);

      expect(output).toHaveLength(0);

      logger.flush();

      expect(output).toHaveLength(2);
      expect(output[0]).toContain('partial-a');
      expect(output[1]).toContain('partial-b');
    });

    it('should not output empty buffers', () => {
      const logger = new ParallelLogger({
        subMovementNames: ['step-a', 'step-b'],
        writeFn,
      });
      const handlerA = logger.createStreamHandler('step-a', 0);

      handlerA({ type: 'text', data: { text: 'content\n' } } as StreamEvent);
      output.length = 0; // Clear previous output

      logger.flush();
      expect(output).toHaveLength(0); // Nothing to flush
    });
  });

  describe('printSummary', () => {
    it('should print completion summary', () => {
      const logger = new ParallelLogger({
        subMovementNames: ['arch-review', 'security-review'],
        writeFn,
      });

      logger.printSummary('parallel-review', [
        { name: 'arch-review', condition: 'approved' },
        { name: 'security-review', condition: 'rejected' },
      ]);

      const fullOutput = output.join('');
      expect(fullOutput).toContain('parallel-review results');
      expect(fullOutput).toContain('arch-review:');
      expect(fullOutput).toContain('approved');
      expect(fullOutput).toContain('security-review:');
      expect(fullOutput).toContain('rejected');
      // Header and footer contain ─
      expect(fullOutput).toContain('─');
    });

    it('should show (no result) for undefined condition', () => {
      const logger = new ParallelLogger({
        subMovementNames: ['step-a'],
        writeFn,
      });

      logger.printSummary('parallel-step', [
        { name: 'step-a', condition: undefined },
      ]);

      const fullOutput = output.join('');
      expect(fullOutput).toContain('(no result)');
    });

    it('should right-pad sub-movement names to align results', () => {
      const logger = new ParallelLogger({
        subMovementNames: ['short', 'very-long-name'],
        writeFn,
      });

      logger.printSummary('test', [
        { name: 'short', condition: 'done' },
        { name: 'very-long-name', condition: 'done' },
      ]);

      // Find the result lines (indented with 2 spaces)
      const resultLines = output.filter((l) => l.startsWith('  '));
      expect(resultLines).toHaveLength(2);

      // Both 'done' values should be at the same column
      const doneIndex0 = resultLines[0]!.indexOf('done');
      const doneIndex1 = resultLines[1]!.indexOf('done');
      expect(doneIndex0).toBe(doneIndex1);
    });

    it('should prepend task prefix to all summary lines in rich mode', () => {
      const logger = new ParallelLogger({
        subMovementNames: ['arch-review', 'security-review'],
        writeFn,
        progressInfo: { iteration: 5, maxMovements: 30 },
        taskLabel: 'override-persona-provider',
        taskColorIndex: 0,
        parentMovementName: 'reviewers',
        movementIteration: 1,
      });

      logger.printSummary('reviewers', [
        { name: 'arch-review', condition: 'approved' },
        { name: 'security-review', condition: 'needs_fix' },
      ]);

      // Every output line should have the task prefix
      for (const line of output) {
        expect(line).toContain('[over]');
        expect(line).toContain('[reviewers]');
        expect(line).toContain('(5/30)(1)');
      }

      // Verify task color (cyan for index 0)
      expect(output[0]).toContain('\x1b[36m');

      // Verify summary content is still present
      const fullOutput = output.join('');
      expect(fullOutput).toContain('reviewers results');
      expect(fullOutput).toContain('arch-review:');
      expect(fullOutput).toContain('approved');
      expect(fullOutput).toContain('security-review:');
      expect(fullOutput).toContain('needs_fix');
    });

    it('should not prepend task prefix to summary lines in non-rich mode', () => {
      const logger = new ParallelLogger({
        subMovementNames: ['arch-review'],
        writeFn,
      });

      logger.printSummary('reviewers', [
        { name: 'arch-review', condition: 'approved' },
      ]);

      // No task prefix should appear
      for (const line of output) {
        expect(line).not.toContain('[over]');
      }

      // Summary content is present
      const fullOutput = output.join('');
      expect(fullOutput).toContain('reviewers results');
      expect(fullOutput).toContain('arch-review:');
      expect(fullOutput).toContain('approved');
    });

    it('should flush remaining buffers before printing summary', () => {
      const logger = new ParallelLogger({
        subMovementNames: ['step-a'],
        writeFn,
      });
      const handler = logger.createStreamHandler('step-a', 0);

      // Leave partial content in buffer
      handler({ type: 'text', data: { text: 'trailing content' } } as StreamEvent);

      logger.printSummary('test', [
        { name: 'step-a', condition: 'done' },
      ]);

      // First output should be the flushed buffer
      expect(output[0]).toContain('trailing content');
      // Then the summary
      const fullOutput = output.join('');
      expect(fullOutput).toContain('test results');
    });
  });

  describe('ANSI escape sequence stripping', () => {
    it('should strip ANSI codes from text events', () => {
      const logger = new ParallelLogger({
        subMovementNames: ['step-a'],
        writeFn,
      });
      const handler = logger.createStreamHandler('step-a', 0);

      handler({ type: 'text', data: { text: '\x1b[41mRed background\x1b[0m\n' } } as StreamEvent);

      expect(output).toHaveLength(1);
      expect(output[0]).toContain('Red background');
      expect(output[0]).not.toContain('\x1b[41m');
    });

    it('should strip ANSI codes from thinking events', () => {
      const logger = new ParallelLogger({
        subMovementNames: ['step-a'],
        writeFn,
      });
      const handler = logger.createStreamHandler('step-a', 0);

      handler({
        type: 'thinking',
        data: { thinking: '\x1b[31mColored thought\x1b[0m' },
      } as StreamEvent);

      expect(output).toHaveLength(1);
      expect(output[0]).toContain('Colored thought');
      expect(output[0]).not.toContain('\x1b[31m');
    });

    it('should strip ANSI codes from tool_output events', () => {
      const logger = new ParallelLogger({
        subMovementNames: ['step-a'],
        writeFn,
      });
      const handler = logger.createStreamHandler('step-a', 0);

      handler({
        type: 'tool_output',
        data: { tool: 'Bash', output: '\x1b[32mGreen output\x1b[0m' },
      } as StreamEvent);

      expect(output).toHaveLength(1);
      expect(output[0]).toContain('Green output');
      expect(output[0]).not.toContain('\x1b[32m');
    });

    it('should strip ANSI codes from tool_result events', () => {
      const logger = new ParallelLogger({
        subMovementNames: ['step-a'],
        writeFn,
      });
      const handler = logger.createStreamHandler('step-a', 0);

      handler({
        type: 'tool_result',
        data: { content: '\x1b[31mResult with ANSI\x1b[0m', isError: false },
      } as StreamEvent);

      expect(output).toHaveLength(1);
      expect(output[0]).toContain('Result with ANSI');
      expect(output[0]).not.toContain('\x1b[31m');
    });

    it('should strip ANSI codes from buffered text across multiple events', () => {
      const logger = new ParallelLogger({
        subMovementNames: ['step-a'],
        writeFn,
      });
      const handler = logger.createStreamHandler('step-a', 0);

      handler({ type: 'text', data: { text: '\x1b[31mHello' } } as StreamEvent);
      handler({ type: 'text', data: { text: ' World\x1b[0m\n' } } as StreamEvent);

      expect(output).toHaveLength(1);
      expect(output[0]).toContain('Hello World');
      // The prefix contains its own ANSI codes (\x1b[36m, \x1b[0m), so
      // verify the AI-originated \x1b[31m was stripped, not the prefix's codes
      expect(output[0]).not.toContain('\x1b[31m');
    });
  });

  describe('interleaved output from multiple sub-movements', () => {
    it('should correctly interleave prefixed output', () => {
      const logger = new ParallelLogger({
        subMovementNames: ['step-a', 'step-b'],
        writeFn,
      });
      const handlerA = logger.createStreamHandler('step-a', 0);
      const handlerB = logger.createStreamHandler('step-b', 1);

      handlerA({ type: 'text', data: { text: 'A output\n' } } as StreamEvent);
      handlerB({ type: 'text', data: { text: 'B output\n' } } as StreamEvent);
      handlerA({ type: 'text', data: { text: 'A second\n' } } as StreamEvent);

      expect(output).toHaveLength(3);
      expect(output[0]).toContain('[step-a]');
      expect(output[0]).toContain('A output');
      expect(output[1]).toContain('[step-b]');
      expect(output[1]).toContain('B output');
      expect(output[2]).toContain('[step-a]');
      expect(output[2]).toContain('A second');
    });
  });

  describe('progress info display', () => {
    it('should include progress info in prefix when provided', () => {
      const logger = new ParallelLogger({
        subMovementNames: ['step-a', 'step-b'],
        writeFn,
        progressInfo: {
          iteration: 3,
          maxMovements: 10,
        },
      });

      const prefix = logger.buildPrefix('step-a', 0);
      expect(prefix).toContain('[step-a]');
      expect(prefix).toContain('(3/10)');
      expect(prefix).toContain('step 1/2'); // 0-indexed -> 1-indexed, 2 total sub-movements
    });

    it('should show correct step number for each sub-movement', () => {
      const logger = new ParallelLogger({
        subMovementNames: ['step-a', 'step-b', 'step-c'],
        writeFn,
        progressInfo: {
          iteration: 5,
          maxMovements: 20,
        },
      });

      const prefixA = logger.buildPrefix('step-a', 0);
      const prefixB = logger.buildPrefix('step-b', 1);
      const prefixC = logger.buildPrefix('step-c', 2);

      expect(prefixA).toContain('step 1/3');
      expect(prefixB).toContain('step 2/3');
      expect(prefixC).toContain('step 3/3');
    });

    it('should not include progress info when not provided', () => {
      const logger = new ParallelLogger({
        subMovementNames: ['step-a'],
        writeFn,
      });

      const prefix = logger.buildPrefix('step-a', 0);
      expect(prefix).toContain('[step-a]');
      expect(prefix).not.toMatch(/\(\d+\/\d+\)/);
      expect(prefix).not.toMatch(/step \d+\/\d+/);
    });

    it('should include progress info in streamed output', () => {
      const logger = new ParallelLogger({
        subMovementNames: ['step-a'],
        writeFn,
        progressInfo: {
          iteration: 2,
          maxMovements: 5,
        },
      });
      const handler = logger.createStreamHandler('step-a', 0);

      handler({ type: 'text', data: { text: 'Hello world\n' } } as StreamEvent);

      expect(output).toHaveLength(1);
      expect(output[0]).toContain('[step-a]');
      expect(output[0]).toContain('(2/5) step 1/1');
      expect(output[0]).toContain('Hello world');
    });
  });
});

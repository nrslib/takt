/**
 * Tests for parallel-logger module
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ParallelLogger } from '../core/workflow/index.js';
import type { StreamEvent } from '../core/workflow/index.js';

describe('ParallelLogger', () => {
  let output: string[];
  let writeFn: (text: string) => void;

  beforeEach(() => {
    vi.useRealTimers();
    output = [];
    writeFn = (text: string) => output.push(text);
  });

  describe('buildPrefix', () => {
    it('should keep raw dynamic part IDs as keys while bounding their terminal label', () => {
      const rawPartId = `part\nforged\x1b[31m-${'x'.repeat(200)}`;
      const logger = new ParallelLogger({
        subStepNames: ['initial'],
        writeFn,
      });

      const index = logger.addSubStep(rawPartId);
      const prefix = logger.buildPrefix(rawPartId, index);
      const handler = logger.createStreamHandler(rawPartId, index);
      handler({ type: 'text', data: { text: 'done\n' } } as StreamEvent);

      expect(prefix).toContain('[part\\nforged-');
      expect(prefix).toContain('…');
      expect(prefix).not.toContain('\n');
      expect(prefix).not.toContain('\x1b[31m');
      expect(prefix.length).toBeLessThan(120);
      expect(output[0]).toContain('done');
      expect(output[0]).not.toContain('\nforged');
      expect(output[0]).not.toContain('\x1b[31m');
    });
  });

  describe('text event line buffering', () => {
    it('should buffer partial line and output on newline', () => {
      const logger = new ParallelLogger({
        subStepNames: ['step-a'],
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
        subStepNames: ['step-a'],
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
        subStepNames: ['step-a'],
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
        subStepNames: ['step-a'],
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
        subStepNames: ['sub-a'],
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
        subStepNames: ['sub-a'],
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
        subStepNames: ['sub-a'],
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
        subStepNames: ['sub-a'],
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
        subStepNames: ['sub-a'],
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
        subStepNames: ['sub-a'],
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
        subStepNames: ['sub-a'],
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

    it('should delegate permission_asked event to parent callback', () => {
      const parentEvents: StreamEvent[] = [];
      const logger = new ParallelLogger({
        subStepNames: ['sub-a'],
        parentOnStream: (event) => parentEvents.push(event),
        writeFn,
      });
      const handler = logger.createStreamHandler('sub-a', 0);

      const permissionEvent: StreamEvent = {
        type: 'permission_asked',
        data: {
          requestId: 'perm-1',
          sessionId: 'sess-1',
          permission: 'bash',
          patterns: ['**'],
          always: [],
          reply: 'reject',
        },
      };
      handler(permissionEvent);

      expect(parentEvents).toHaveLength(1);
      expect(parentEvents[0]).toBe(permissionEvent);
    });

    it('should delegate permission_summary event to parent callback', () => {
      const parentEvents: StreamEvent[] = [];
      const logger = new ParallelLogger({
        subStepNames: ['sub-a'],
        parentOnStream: (event) => parentEvents.push(event),
        writeFn,
      });
      const handler = logger.createStreamHandler('sub-a', 0);

      const permissionEvent: StreamEvent = {
        type: 'permission_summary',
        data: {
          sessionId: 'sess-1',
          permissionMode: 'readonly',
          allowedTools: ['Read', 'Bash'],
          networkAccess: false,
          resolvedPermissions: [
            { permission: '*', pattern: '*', action: 'deny' },
            { permission: 'read', pattern: '*', action: 'allow' },
          ],
        },
      };
      handler(permissionEvent);

      expect(parentEvents).toHaveLength(1);
      expect(parentEvents[0]).toBe(permissionEvent);
    });

    it('should not crash when no parent callback for delegated events', () => {
      const logger = new ParallelLogger({
        subStepNames: ['sub-a'],
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
        subStepNames: ['step-a', 'step-b'],
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
        subStepNames: ['step-a', 'step-b'],
        writeFn,
      });
      const handlerA = logger.createStreamHandler('step-a', 0);

      handlerA({ type: 'text', data: { text: 'content\n' } } as StreamEvent);
      output.length = 0; // Clear previous output

      logger.flush();
      expect(output).toHaveLength(0); // Nothing to flush
    });

    it('should flush partial lines by time-slice', async () => {
      vi.useFakeTimers();
      const logger = new ParallelLogger({
        subStepNames: ['step-a'],
        writeFn,
        flushIntervalMs: 50,
        minTimedFlushChars: 1,
      });
      const handler = logger.createStreamHandler('step-a', 0);

      handler({ type: 'text', data: { text: 'partial' } } as StreamEvent);
      expect(output).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(60);
      expect(output).toHaveLength(1);
      expect(output[0]).toContain('[step-a]');
      expect(output[0]).toContain('partial');
    });

    it('should prefer boundary-aware timed flush to reduce mid-word splits', async () => {
      vi.useFakeTimers();
      const logger = new ParallelLogger({
        subStepNames: ['step-a'],
        writeFn,
        flushIntervalMs: 50,
        minTimedFlushChars: 10,
      });
      const handler = logger.createStreamHandler('step-a', 0);

      handler({ type: 'text', data: { text: 'alpha beta gamma delta' } } as StreamEvent);
      await vi.advanceTimersByTimeAsync(60);

      expect(output).toHaveLength(1);
      expect(output[0]).toContain('alpha beta gamma ');

      logger.flush();
      expect(output[1]).toContain('delta');
    });
  });

  describe('ANSI escape sequence stripping', () => {
    it('should strip ANSI codes from text events', () => {
      const logger = new ParallelLogger({
        subStepNames: ['step-a'],
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
        subStepNames: ['step-a'],
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
        subStepNames: ['step-a'],
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
        subStepNames: ['step-a'],
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
        subStepNames: ['step-a'],
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

  describe('interleaved output from multiple sub-steps', () => {
    it('should correctly interleave prefixed output', () => {
      const logger = new ParallelLogger({
        subStepNames: ['step-a', 'step-b'],
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

});

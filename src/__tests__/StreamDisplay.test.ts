/**
 * Tests for StreamDisplay progress info feature
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StreamDisplay, type ProgressInfo } from '../shared/ui/index.js';

describe('StreamDisplay', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let stdoutWriteSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    stdoutWriteSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    stdoutWriteSpy.mockRestore();
  });

  describe('progress info display', () => {
    const progressInfo: ProgressInfo = {
      iteration: 3,
      maxSteps: 10,
      stepIndex: 1,
      totalSteps: 4,
    };

    describe('showInit', () => {
      it('should not display anything in quiet mode', () => {
        const display = new StreamDisplay('test-agent', true, progressInfo);
        display.showInit('claude-3');

        expect(consoleLogSpy).not.toHaveBeenCalled();
      });
    });

    describe('showText', () => {
      it('should output text content to stdout', () => {
        const display = new StreamDisplay('test-agent', false, progressInfo);
        const text = 'streamed text';
        display.showText(text);

        expect(stdoutWriteSpy).toHaveBeenCalledWith(text);
      });

      it('should not display anything in quiet mode', () => {
        const display = new StreamDisplay('test-agent', true, progressInfo);
        display.showText('Hello');

        expect(consoleLogSpy).not.toHaveBeenCalled();
        expect(stdoutWriteSpy).not.toHaveBeenCalled();
      });
    });

    describe('showThinking', () => {
      it('should not display anything in quiet mode', () => {
        const display = new StreamDisplay('test-agent', true, progressInfo);
        display.showThinking('Thinking...');

        expect(consoleLogSpy).not.toHaveBeenCalled();
        expect(stdoutWriteSpy).not.toHaveBeenCalled();
      });
    });
  });

  describe('ANSI escape sequence stripping', () => {
    it('should strip ANSI codes from text before writing to stdout', () => {
      const display = new StreamDisplay('test-agent', false);
      display.showText('\x1b[41mRed background\x1b[0m');

      expect(stdoutWriteSpy).toHaveBeenCalledWith('Red background');
    });

    it('should strip ANSI codes from thinking before writing to stdout', () => {
      const display = new StreamDisplay('test-agent', false);
      display.showThinking('\x1b[31mColored thinking\x1b[0m');

      // chalk.gray.italic wraps the stripped text, so check it does NOT contain raw ANSI
      const writtenText = stdoutWriteSpy.mock.calls[0]?.[0] as string;
      expect(writtenText).not.toContain('\x1b[41m');
      expect(writtenText).not.toContain('\x1b[31m');
      expect(writtenText).toContain('Colored thinking');
    });

    it('should accumulate stripped text in textBuffer', () => {
      const display = new StreamDisplay('test-agent', false);
      display.showText('\x1b[31mRed\x1b[0m');
      display.showText('\x1b[32m Green\x1b[0m');

      // Flush should work correctly with stripped content
      display.flushText();

      // After flush, buffer is cleared — verify no crash and text was output
      expect(stdoutWriteSpy).toHaveBeenCalledWith('Red');
      expect(stdoutWriteSpy).toHaveBeenCalledWith(' Green');
    });

    it('should accumulate stripped text in thinkingBuffer', () => {
      const display = new StreamDisplay('test-agent', false);
      display.showThinking('\x1b[31mThought 1\x1b[0m');
      display.showThinking('\x1b[32m Thought 2\x1b[0m');

      display.flushThinking();

      // Verify stripped text was written (wrapped in chalk styling)
      expect(stdoutWriteSpy).toHaveBeenCalledTimes(2);
    });

    it('should not strip ANSI from text that has no ANSI codes', () => {
      const display = new StreamDisplay('test-agent', false);
      display.showText('Plain text');

      expect(stdoutWriteSpy).toHaveBeenCalledWith('Plain text');
    });

    it('should strip ANSI codes from tool output before buffering', () => {
      const display = new StreamDisplay('test-agent', false);
      display.showToolUse('Bash', { command: 'ls' });
      display.showToolOutput('\x1b[32mgreen output\x1b[0m\n');

      const outputLine = consoleLogSpy.mock.calls.find(
        (call) => typeof call[0] === 'string' && (call[0] as string).includes('green output'),
      );
      expect(outputLine).toBeDefined();
      expect(outputLine![0]).not.toContain('\x1b[32m');
    });

    it('should strip ANSI codes from tool output across multiple chunks', () => {
      const display = new StreamDisplay('test-agent', false);
      display.showToolUse('Bash', { command: 'ls' });
      display.showToolOutput('\x1b[31mpartial');
      display.showToolOutput(' line\x1b[0m\n');

      const outputLine = consoleLogSpy.mock.calls.find(
        (call) => typeof call[0] === 'string' && (call[0] as string).includes('partial line'),
      );
      expect(outputLine).toBeDefined();
      expect(outputLine![0]).not.toContain('\x1b[31m');
    });

    it('should strip ANSI codes from tool result content', () => {
      const display = new StreamDisplay('test-agent', false);
      display.showToolUse('Read', { file_path: '/test.ts' });
      display.showToolResult('\x1b[41mResult with red bg\x1b[0m', false);

      const fullOutput = consoleLogSpy.mock.calls.flat().map((value) => String(value)).join(' ');
      expect(fullOutput).toContain('Result with red bg');
      expect(fullOutput).not.toContain('\x1b[41m');
    });

    it('should strip ANSI codes from tool result error content', () => {
      const display = new StreamDisplay('test-agent', false);
      display.showToolUse('Bash', { command: 'fail' });
      display.showToolResult('\x1b[31mError message\x1b[0m', true);

      const fullOutput = consoleLogSpy.mock.calls.flat().map((value) => String(value)).join(' ');
      expect(fullOutput).toContain('Error message');
      expect(fullOutput).not.toContain('\x1b[31m');
    });

    it('should strip ANSI and OSC codes from result error content', () => {
      const display = new StreamDisplay('test-agent', false);
      display.showResult(false, '\x1b]52;c;secret\x07Cursor failed: \x1b[41mparse error\x1b[0m');

      const errorLine = consoleLogSpy.mock.calls.find(
        (call) => typeof call[0] === 'string' && (call[0] as string).includes('Cursor failed'),
      );
      expect(errorLine).toBeDefined();
      const fullOutput = errorLine!.join(' ');
      expect(fullOutput).toContain('Cursor failed: parse error');
      expect(fullOutput).not.toContain('secret');
      expect(fullOutput).not.toContain('\x1b]52');
      expect(fullOutput).not.toContain('\x1b[41m');
    });
  });

  describe('showToolUse spinner suppression', () => {
    it('should not start spinner for AskUserQuestion tool', () => {
      vi.useFakeTimers();
      try {
        const display = new StreamDisplay('test-agent', false);
        display.showToolUse('AskUserQuestion', { questions: [] });

        // Advance time past spinner interval (80ms)
        vi.advanceTimersByTime(200);

        // Spinner writes to stdout via setInterval — should NOT have been called
        expect(stdoutWriteSpy).not.toHaveBeenCalled();

        display.flush();
      } finally {
        vi.useRealTimers();
      }
    });

    it('should start spinner for non-AskUserQuestion tools', () => {
      vi.useFakeTimers();
      try {
        const display = new StreamDisplay('test-agent', false);
        display.showToolUse('Bash', { command: 'ls' });

        // Advance time past spinner interval (80ms)
        vi.advanceTimersByTime(200);

        // Spinner should have written to stdout
        expect(stdoutWriteSpy).toHaveBeenCalled();

        display.flush();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('showToolResult AskUserQuestion content suppression', () => {
    it('should suppress content preview for AskUserQuestion non-error result', () => {
      const display = new StreamDisplay('test-agent', false);
      display.showToolUse('AskUserQuestion', { questions: [] });
      display.showToolResult('Error: Answer questions?', false);

      // Find the result line containing the tool name.
      // The tool name remains visible while the returned content is suppressed.
      const fullOutput = consoleLogSpy.mock.calls.flat().map((value) => String(value)).join(' ');
      expect(fullOutput).toContain('AskUserQuestion');
      expect(fullOutput).not.toContain('Error:');
      expect(fullOutput).not.toContain('Answer questions');
    });

    it('should still show error for AskUserQuestion when isError is true', () => {
      const display = new StreamDisplay('test-agent', false);
      display.showToolUse('AskUserQuestion', { questions: [] });
      display.showToolResult('Something went wrong', true);

      // Find the error line containing the returned content.
      const fullOutput = consoleLogSpy.mock.calls.flat().map((value) => String(value)).join(' ');
      expect(fullOutput).toContain('AskUserQuestion');
      expect(fullOutput).toContain('Something went wrong');
    });

    it('should still show content preview for non-AskUserQuestion tools', () => {
      const display = new StreamDisplay('test-agent', false);
      display.showToolUse('Read', { file_path: '/test.ts' });
      display.showToolResult('File content here', false);

      const fullOutput = consoleLogSpy.mock.calls.flat().map((value) => String(value)).join(' ');
      expect(fullOutput).toContain('Read');
      expect(fullOutput).toContain('File content here');
    });
  });

});

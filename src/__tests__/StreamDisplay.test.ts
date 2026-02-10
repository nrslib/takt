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
      maxMovements: 10,
      movementIndex: 1,
      totalMovements: 4,
    };

    describe('showInit', () => {
      it('should include progress info when provided', () => {
        const display = new StreamDisplay('test-agent', false, progressInfo);
        display.showInit('claude-3');

        expect(consoleLogSpy).toHaveBeenCalledWith(
          expect.stringContaining('[test-agent]')
        );
        expect(consoleLogSpy).toHaveBeenCalledWith(
          expect.stringContaining('(3/10) step 2/4')
        );
        expect(consoleLogSpy).toHaveBeenCalledWith(
          expect.stringContaining('Model: claude-3')
        );
      });

      it('should not include progress info when not provided', () => {
        const display = new StreamDisplay('test-agent', false);
        display.showInit('claude-3');

        expect(consoleLogSpy).toHaveBeenCalledWith(
          expect.stringContaining('[test-agent]')
        );
        expect(consoleLogSpy).toHaveBeenCalledWith(
          expect.stringContaining('Model: claude-3')
        );
        // Should not contain progress format
        expect(consoleLogSpy).not.toHaveBeenCalledWith(
          expect.stringMatching(/\(\d+\/\d+\) step \d+\/\d+/)
        );
      });

      it('should not display anything in quiet mode', () => {
        const display = new StreamDisplay('test-agent', true, progressInfo);
        display.showInit('claude-3');

        expect(consoleLogSpy).not.toHaveBeenCalled();
      });
    });

    describe('showText', () => {
      it('should include progress info in first text header when provided', () => {
        const display = new StreamDisplay('test-agent', false, progressInfo);
        display.showText('Hello');

        // First call is blank line, second is the header
        expect(consoleLogSpy).toHaveBeenCalledTimes(2);
        expect(consoleLogSpy).toHaveBeenNthCalledWith(2,
          expect.stringContaining('[test-agent]')
        );
        expect(consoleLogSpy).toHaveBeenNthCalledWith(2,
          expect.stringContaining('(3/10) step 2/4')
        );
      });

      it('should not include progress info in header when not provided', () => {
        const display = new StreamDisplay('test-agent', false);
        display.showText('Hello');

        expect(consoleLogSpy).toHaveBeenCalledTimes(2);
        const headerCall = consoleLogSpy.mock.calls[1]?.[0] as string;
        expect(headerCall).toContain('[test-agent]');
        expect(headerCall).not.toMatch(/\(\d+\/\d+\) step \d+\/\d+/);
      });

      it('should output text content to stdout', () => {
        const display = new StreamDisplay('test-agent', false, progressInfo);
        display.showText('Hello');

        expect(stdoutWriteSpy).toHaveBeenCalledWith('Hello');
      });

      it('should not display anything in quiet mode', () => {
        const display = new StreamDisplay('test-agent', true, progressInfo);
        display.showText('Hello');

        expect(consoleLogSpy).not.toHaveBeenCalled();
        expect(stdoutWriteSpy).not.toHaveBeenCalled();
      });
    });

    describe('showThinking', () => {
      it('should include progress info in thinking header when provided', () => {
        const display = new StreamDisplay('test-agent', false, progressInfo);
        display.showThinking('Thinking...');

        expect(consoleLogSpy).toHaveBeenCalledTimes(2);
        expect(consoleLogSpy).toHaveBeenNthCalledWith(2,
          expect.stringContaining('[test-agent]')
        );
        expect(consoleLogSpy).toHaveBeenNthCalledWith(2,
          expect.stringContaining('(3/10) step 2/4')
        );
        expect(consoleLogSpy).toHaveBeenNthCalledWith(2,
          expect.stringContaining('thinking')
        );
      });

      it('should not include progress info in header when not provided', () => {
        const display = new StreamDisplay('test-agent', false);
        display.showThinking('Thinking...');

        expect(consoleLogSpy).toHaveBeenCalledTimes(2);
        const headerCall = consoleLogSpy.mock.calls[1]?.[0] as string;
        expect(headerCall).toContain('[test-agent]');
        expect(headerCall).not.toMatch(/\(\d+\/\d+\) step \d+\/\d+/);
      });

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

      const resultLine = consoleLogSpy.mock.calls.find(
        (call) => typeof call[0] === 'string' && (call[0] as string).includes('✓'),
      );
      expect(resultLine).toBeDefined();
      const fullOutput = resultLine!.join(' ');
      expect(fullOutput).toContain('Result with red bg');
      expect(fullOutput).not.toContain('\x1b[41m');
    });

    it('should strip ANSI codes from tool result error content', () => {
      const display = new StreamDisplay('test-agent', false);
      display.showToolUse('Bash', { command: 'fail' });
      display.showToolResult('\x1b[31mError message\x1b[0m', true);

      const errorLine = consoleLogSpy.mock.calls.find(
        (call) => typeof call[0] === 'string' && (call[0] as string).includes('✗'),
      );
      expect(errorLine).toBeDefined();
      const fullOutput = errorLine!.join(' ');
      expect(fullOutput).toContain('Error message');
      expect(fullOutput).not.toContain('\x1b[31m');
    });
  });

  describe('progress prefix format', () => {
    it('should format progress as (iteration/max) step index/total', () => {
      const progressInfo: ProgressInfo = {
        iteration: 5,
        maxMovements: 20,
        movementIndex: 2,
        totalMovements: 6,
      };
      const display = new StreamDisplay('agent', false, progressInfo);
      display.showText('test');

      const headerCall = consoleLogSpy.mock.calls[1]?.[0] as string;
      expect(headerCall).toContain('(5/20) step 3/6');
    });

    it('should convert 0-indexed movementIndex to 1-indexed display', () => {
      const progressInfo: ProgressInfo = {
        iteration: 1,
        maxMovements: 10,
        movementIndex: 0, // First movement (0-indexed)
        totalMovements: 4,
      };
      const display = new StreamDisplay('agent', false, progressInfo);
      display.showText('test');

      const headerCall = consoleLogSpy.mock.calls[1]?.[0] as string;
      expect(headerCall).toContain('step 1/4'); // Should display as 1-indexed
    });
  });
});

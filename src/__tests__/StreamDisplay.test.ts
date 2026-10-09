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
        display.showInit('demo\x07');

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

  describe('model terminal output', () => {
    it.each([
      { model: 'demo', expected: 'demo' },
      { model: 'モデル/demo-1', expected: 'モデル/demo-1' },
      { model: 'demo52;c;c2FmZQ==', expected: 'demo52;c;c2FmZQ==' },
      { model: 'demo\x1b]52;c;c2FmZQ==\x07', expected: 'demo' },
      { model: 'demo\x1b[2JX', expected: 'demoX' },
      { model: 'demo\x1b]', expected: 'demo\\x1b]' },
      { model: 'demo\x07', expected: 'demo\\x07' },
      { model: 'demo\x7f', expected: 'demo\\x7f' },
      { model: 'demo\x9b', expected: 'demo\\x9b' },
      { model: 'demo\r\n\tX', expected: 'demo\\r\\n\\tX' },
    ])('safely displays $expected from init while preserving progress and the input', ({ model, expected }) => {
      const display = new StreamDisplay('test-agent', false, {
        iteration: 3, maxSteps: 10, stepIndex: 1, totalSteps: 4,
      });
      const event = { type: 'init' as const, data: { model, sessionId: 'session' } };

      display.createHandler()(event);

      expect(consoleLogSpy).toHaveBeenCalledOnce();
      const rawLine = consoleLogSpy.mock.calls[0]!.join(' ');
      expect(rawLine).not.toMatch(/\x1b(?!\[[0-9;]*m)|[\x00-\x1a\x1c-\x1f\x7f-\x9f]/u);
      expect(rawLine.replace(/\x1b\[[0-9;]*m/g, '')).toBe(`[test-agent] (3/10) step 2/4 Model: ${expected}`);
      expect(event.data.model).toBe(model);
      expect(stdoutWriteSpy).not.toHaveBeenCalled();
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

    it('should neutralize private CSI in result error content', () => {
      const display = new StreamDisplay('test-agent', false);
      display.showResult(false, '\x1b[?25lCursor failed');

      const errorLine = consoleLogSpy.mock.calls.find(
        (call) => typeof call[0] === 'string' && (call[0] as string).includes('Cursor failed'),
      );
      expect(errorLine).toBeDefined();
      const output = errorLine!.join(' ');
      expect(output).toContain('\\x1b[?25lCursor failed');
      expect(output).not.toContain('\x1b[?25l');
    });
  });

  describe('stream control character sanitization', () => {
    const streamCases = [
      { name: 'LF and TAB', chunks: ['one\n\ttwo\n'], expected: 'one\n\ttwo\n' },
      { name: 'CRLF', chunks: ['one\r\n\ttwo\n'], expected: 'one\n\ttwo\n' },
      { name: 'split CRLF', chunks: ['one\r', '\n\ttwo\n'], expected: 'one\n\ttwo\n' },
      { name: 'split standalone CR', chunks: ['one\r', '\ttwo\n'], expected: 'one\ttwo\n' },
      { name: 'consecutive CR', chunks: ['\r\rone\r\rtwo\r\n'], expected: 'onetwo\n' },
      { name: 'unterminated remainder', chunks: ['one\r', '\ttwo\r'], expected: 'one\ttwo' },
    ];

    describe.each(['text', 'thinking', 'tool_output'] as const)('%s events', (type) => {
      it.each(streamCases)('removes CR while preserving $name in raw output', ({ chunks, expected }) => {
        const display = new StreamDisplay('test-agent', false);
        const handler = display.createHandler();
        for (const chunk of chunks) {
          switch (type) {
            case 'text': handler({ type, data: { text: chunk } }); break;
            case 'thinking': handler({ type, data: { thinking: chunk } }); break;
            case 'tool_output': handler({ type, data: { output: chunk } }); break;
          }
        }
        handler({ type: 'tool_result', data: { content: '', isError: false } });
        display.flush();
        const rawConsole = consoleLogSpy.mock.calls.map((args) => args.join(' ') + '\n').join('');
        const rawStream = stdoutWriteSpy.mock.calls.map(([chunk]) => String(chunk)).join('');
        expect(rawConsole + rawStream).not.toContain('\r');
        if (type === 'tool_output') {
          const lines = consoleLogSpy.mock.calls.map((args) => args.join(' '))
            .filter((line) => line.includes('  │ '));
          const expectedLines = expected.split('\n');
          if (expected.endsWith('\n')) expectedLines.pop();
          expect(lines).toHaveLength(expectedLines.length);
          for (const [index, line] of expectedLines.entries()) {
            expect(lines[index]).toContain(`  │ ${line}`);
          }
        } else {
          expect(rawStream.replace(/\x1b\[[0-9;]*m/g, '')).toBe(expected);
        }
      });
    });

    it.each([[false, false], [true, false], [true, true]])('removes CR in raw tool results (error=%s, quiet=%s)', (isError, quiet) => {
      const display = new StreamDisplay('test-agent', quiet);
      display.createHandler()({ type: 'tool_result', data: { content: '\rone\r\ttwo\r\nnext\r', isError } });
      display.flush();
      const raw = consoleLogSpy.mock.calls.map((args) => args.join(' ') + '\n').join('')
        + stdoutWriteSpy.mock.calls.map(([chunk]) => String(chunk)).join('');
      expect(raw).not.toContain('\r');
      expect(raw).toContain('one\ttwo');
    });

    it.each(['text', 'thinking', 'tool_output'] as const)('neutralizes split OSC in %s events and preserves ordinary text', (type) => {
      const display = new StreamDisplay('test-agent', false);
      const handler = display.createHandler();
      for (const chunk of ['safe \x1b]52;c;', 'c2FmZQ==\x07\nnext\n', 'safe \x1b]52;c;payload\x1b', '\\\nlast\n', '\x1b]', 'ordinary\n', 'safe 52;c;', 'c2FmZQ==\n', 'tail\x1b]']) {
        switch (type) {
          case 'text': handler({ type, data: { text: chunk } }); break;
          case 'thinking': handler({ type, data: { thinking: chunk } }); break;
          case 'tool_output': handler({ type, data: { output: chunk } }); break;
        }
      }
      display.showToolResult('', false);
      display.flush();
      const raw = consoleLogSpy.mock.calls.map((args) => args.join(' ') + '\n').join('')
        + stdoutWriteSpy.mock.calls.map(([chunk]) => String(chunk)).join('');
      expect(raw).not.toMatch(/\x1b(?!\[[0-9;]*m)|[\x07\x80-\x9f]/u);
      for (const text of ['safe', 'next', 'last', 'ordinary', 'safe 52;c;c2FmZQ==', 'tail']) {
        expect(raw).toContain(text);
      }
    });

    it.each([[false, false], [true, false], [true, true]])('neutralizes incomplete controls in tool results (error=%s, quiet=%s)', (isError, quiet) => {
      const display = new StreamDisplay('test-agent', quiet);
      display.showToolResult('safe \x1b]52;c;payload\x07\x9bnext\x1b]', isError);
      const raw = consoleLogSpy.mock.calls.map((args) => args.join(' ')).join('\n');
      expect(raw).toContain('safe');
      expect(raw).toContain('next');
      expect(raw).not.toMatch(/\x1b(?!\[[0-9;]*m)|[\x07\x80-\x9f]/u);
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

  describe('tool spinner terminal output', () => {
    it.each([
      { tool: 'Bash', key: 'command', value: 'echo   safe\n next', expected: 'echo safe next' },
      { tool: 'Bash', key: 'command', value: 'echo \x1b]52;c;c2FmZQ==\x07safe', expected: 'echo safe' },
      { tool: 'Read', key: 'file_path', value: '\x1b[2Jsafe.ts', expected: 'safe.ts' },
      { tool: 'Write', key: 'file_path', value: 'safe.ts\x1b]', expected: 'safe.ts\\x1b]' },
      { tool: 'Edit', key: 'file_path', value: 'safe.ts\x1b', expected: 'safe.ts\\x1b' },
      { tool: 'Glob', key: 'pattern', value: 'safe\x07*\x7f', expected: 'safe\\x07*\\x7f' },
      { tool: 'Grep', key: 'pattern', value: 'safe\x9b*', expected: 'safe\\x9b*' },
      { tool: 'CustomTool', key: 'input', value: 'safe\x1b]52;c;c2FmZQ==\x07', expected: 'safe' },
    ])('sanitizes $tool previews before initial and resumed spinner output: $expected', ({ tool, key, value, expected }) => {
      vi.useFakeTimers();
      const display = new StreamDisplay('test-agent', false);
      try {
        const handler = display.createHandler();
        handler({ type: 'tool_use', data: { tool, input: { [key]: value } } });
        vi.advanceTimersByTime(160);
        handler({ type: 'tool_output', data: { output: 'ordinary output\n' } });
        vi.advanceTimersByTime(80);
        const writes = stdoutWriteSpy.mock.calls.map(([chunk]) => String(chunk));
        const frames = writes.filter((chunk) => chunk.startsWith('\r  '));
        expect(frames).toHaveLength(3);
        for (const frame of frames) {
          const body = frame.slice(1);
          expect(body).not.toMatch(/\x1b(?!\[[0-9;]*m)|[\x00-\x1a\x1c-\x1f\x7f-\x9f]/u);
          expect(body).toContain(expected);
          expect(body).toContain(tool);
        }
        expect(writes).toContain('\r\x1b[K');
      } finally {
        display.reset();
        vi.useRealTimers();
      }
    });

    describe.each([
      { tool: 'Bash', key: 'command', limit: 60 },
      { tool: 'CustomTool', key: 'input', limit: 50 },
    ])('$tool preview length', ({ tool, key, limit }) => {
      it.each([-1, 0, 1])('preserves truncation at limit offset %i after sanitizing', (offset) => {
        vi.useFakeTimers();
        const display = new StreamDisplay('test-agent', false);
        try {
          const plain = 'x'.repeat(limit + offset);
          display.createHandler()({ type: 'tool_use', data: { tool, input: { [key]: `\x1b]52;c;payload\x07${plain}` } } });
          vi.advanceTimersByTime(80);
          const frame = String(stdoutWriteSpy.mock.calls[0]?.[0]);
          const body = frame.slice(1);
          expect(body).not.toMatch(/\x1b(?!\[[0-9;]*m)|[\x00-\x1a\x1c-\x1f\x7f-\x9f]/u);
          const preview = body.replace(/\x1b\[[0-9;]*m/g, '').split(`${tool} `)[1];
          expect(preview).toBe(offset > 0 ? `${'x'.repeat(limit - 3)}...` : plain);
        } finally {
          display.reset();
          vi.useRealTimers();
        }
      });
    });

    it.each([
      { tool: 'AskUserQuestion', quiet: false, input: { questions: ['\x1b]52;c;payload\x07'] } },
      { tool: 'Bash', quiet: true, input: { command: '\x1b]52;c;payload\x07' } },
    ])('preserves spinner suppression for $tool (quiet=$quiet)', ({ tool, quiet, input }) => {
      vi.useFakeTimers();
      const display = new StreamDisplay('test-agent', quiet);
      try {
        display.createHandler()({ type: 'tool_use', data: { tool, input } });
        vi.advanceTimersByTime(160);
        display.flush();
        expect(stdoutWriteSpy).not.toHaveBeenCalled();
        expect(consoleLogSpy).not.toHaveBeenCalled();
      } finally {
        display.reset();
        vi.useRealTimers();
      }
    });

    it('keeps an empty input preview empty and does not restart it after tool output', () => {
      vi.useFakeTimers();
      const display = new StreamDisplay('test-agent', false);
      try {
        const handler = display.createHandler();
        handler({ type: 'tool_use', data: { tool: 'CustomTool', input: {} } });
        vi.advanceTimersByTime(80);
        handler({ type: 'tool_output', data: { output: 'ordinary output\n' } });
        vi.advanceTimersByTime(80);
        const frames = stdoutWriteSpy.mock.calls.map(([chunk]) => String(chunk))
          .filter((chunk) => chunk.startsWith('\r  '));
        expect(frames).toHaveLength(1);
        expect(frames[0]?.replace(/\x1b\[[0-9;]*m/g, '')).toMatch(/CustomTool $/u);
      } finally {
        display.reset();
        vi.useRealTimers();
      }
    });

    it('should keep multiline Bash previews on one line', () => {
      vi.useFakeTimers();
      try {
        const display = new StreamDisplay('test-agent', false);
        display.showToolUse('Bash', {
          command: `first   second\n third    fourth ${'x'.repeat(50)}`,
        });

        vi.advanceTimersByTime(80);

        const spinnerWrites = stdoutWriteSpy.mock.calls
          .map(([chunk]) => String(chunk))
          .filter((chunk) => chunk.startsWith('\r  '));
        expect(spinnerWrites).toHaveLength(1);
        expect(spinnerWrites[0]).not.toContain('\n');
        expect(spinnerWrites[0]).toContain(`first second third fourth ${'x'.repeat(31)}...`);

        display.flush();
      } finally {
        vi.useRealTimers();
      }
    });

    it('should keep unregistered tool previews on one line', () => {
      vi.useFakeTimers();
      try {
        const display = new StreamDisplay('test-agent', false);
        display.showToolUse('CustomTool', { input: 'first\nsecond' });

        vi.advanceTimersByTime(80);

        const spinnerWrites = stdoutWriteSpy.mock.calls
          .map(([chunk]) => String(chunk))
          .filter((chunk) => chunk.startsWith('\r  '));
        expect(spinnerWrites).toHaveLength(1);
        expect(spinnerWrites[0]).not.toContain('\n');

        display.flush();
      } finally {
        vi.useRealTimers();
      }
    });

    it('should clear a spinner within a narrow terminal width', () => {
      vi.useFakeTimers();
      try {
        const display = new StreamDisplay('test-agent', false);
        display.showToolUse('Bash', { command: 'ls' });

        vi.advanceTimersByTime(80);
        display.flush();

        const clearWrite = stdoutWriteSpy.mock.calls
          .map(([chunk]) => String(chunk))
          .find((chunk) => chunk === '\r\x1b[K');
        expect(clearWrite).toBe('\r\x1b[K');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('tool name terminal output', () => {
    it.each([
      { tool: 'Custom\x1b]52;c;c2FmZQ==\x07', expected: 'Custom' },
      { tool: 'Custom52;c;c2FmZQ==', expected: 'Custom52;c;c2FmZQ==' },
      { tool: 'Custom\x1b[2JTool', expected: 'CustomTool' },
      { tool: 'Custom\x1b]', expected: 'Custom\\x1b]' },
      { tool: 'Custom\x1b', expected: 'Custom\\x1b' },
      { tool: 'Custom\x07Tool', expected: 'Custom\\x07Tool' },
      { tool: 'Custom\x7fTool', expected: 'Custom\\x7fTool' },
      { tool: 'Custom\x9bTool', expected: 'Custom\\x9bTool' },
      { tool: 'Custom\r\n\tTool', expected: 'Custom\\r\\n\\tTool' },
    ])('sanitizes $expected in initial, continued and resumed spinners, headers and results', ({ tool, expected }) => {
      vi.useFakeTimers();
      const display = new StreamDisplay('test-agent', false);
      try {
        const handler = display.createHandler();
        handler({ type: 'tool_use', data: { tool, input: { input: 'ordinary' } } });
        vi.advanceTimersByTime(160);
        handler({ type: 'tool_output', data: { output: 'ordinary output\n' } });
        vi.advanceTimersByTime(80);
        handler({ type: 'tool_result', data: { content: 'done', isError: false } });
        const frames = stdoutWriteSpy.mock.calls.map(([chunk]) => String(chunk))
          .filter((chunk) => chunk.startsWith('\r  '));
        expect(frames).toHaveLength(3);
        for (const frame of frames) {
          const body = frame.slice(1);
          expect(body).not.toMatch(/\x1b(?!\[[0-9;]*m)|[\x00-\x1a\x1c-\x1f\x7f-\x9f]/u);
          expect(body.replace(/\x1b\[[0-9;]*m/g, '')).toContain(`${expected} ordinary`);
        }
        const lines = consoleLogSpy.mock.calls.map((args) => args.join(' '));
        const header = lines.find((line) => line.includes(' output:'))!;
        const result = lines.find((line) => line.includes('✓'))!;
        for (const line of [header, result]) {
          expect(line).toBeDefined();
          expect(line).not.toMatch(/\x1b(?!\[[0-9;]*m)|[\x00-\x1a\x1c-\x1f\x7f-\x9f]/u);
        }
        expect(header.replace(/\x1b\[[0-9;]*m/g, '')).toBe(`  ${expected} output:`);
        expect(result.replace(/\x1b\[[0-9;]*m/g, '')).toBe(`  ✓ ${expected} done`);
      } finally {
        display.reset();
        vi.useRealTimers();
      }
    });

    it.each([
      { tool: 'Custom\x7f', expected: 'Custom\\x7f', content: '', isError: false },
      { tool: 'Custom\r', expected: 'Custom\\r', content: 'failed', isError: true },
    ])('sanitizes result names with content=$content and error=$isError', ({ tool, expected, content, isError }) => {
      const display = new StreamDisplay('test-agent', false);
      try {
        const handler = display.createHandler();
        handler({ type: 'tool_use', data: { tool, input: {} } });
        handler({ type: 'tool_result', data: { content, isError } });
        const result = consoleLogSpy.mock.calls.map((args) => args.join(' ')).find((line) => /[✓✗]/u.test(line))!;
        expect(result).toBeDefined();
        expect(result).not.toMatch(/\x1b(?!\[[0-9;]*m)|[\x00-\x1a\x1c-\x1f\x7f-\x9f]/u);
        expect(result.replace(/\x1b\[[0-9;]*m/g, '')).toBe(isError ? `  ✗ ${expected}: failed` : `  ✓ ${expected}`);
      } finally {
        display.reset();
      }
    });

    it.each([
      { stored: 'Bash', outputTool: 'Custom\x1b[2J', expectedHeader: 'Custom', expectedResult: 'Bash', output: 'line\n' },
      { stored: undefined, outputTool: 'Custom\x1b]52;c;c2FmZQ==\x07', expectedHeader: 'Custom', expectedResult: 'Custom', output: 'line\n' },
      { stored: 'Custom\x1b]', outputTool: undefined, expectedHeader: 'Custom\\x1b]', expectedResult: 'Custom\\x1b]', output: 'tail' },
    ])('sanitizes output headers while preserving explicit and stored name precedence: $expectedHeader', ({ stored, outputTool, expectedHeader, expectedResult, output }) => {
      const display = new StreamDisplay('test-agent', false);
      try {
        const handler = display.createHandler();
        if (stored !== undefined) handler({ type: 'tool_use', data: { tool: stored, input: {} } });
        handler({ type: 'tool_output', data: { tool: outputTool, output } });
        handler({ type: 'tool_result', data: { content: '', isError: false } });
        const lines = consoleLogSpy.mock.calls.map((args) => args.join(' '));
        for (const line of lines) {
          expect(line).not.toMatch(/\x1b(?!\[[0-9;]*m)|[\x00-\x1a\x1c-\x1f\x7f-\x9f]/u);
        }
        const visible = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ''));
        expect(visible).toContain(`  ${expectedHeader} output:`);
        expect(visible).toContain(`  │ ${output.trimEnd()}`);
        expect(visible).toContain(`  ✓ ${expectedResult}`);
      } finally {
        display.reset();
      }
    });

    it('uses the original name for tool input selection and AskUserQuestion suppression', () => {
      vi.useFakeTimers();
      const display = new StreamDisplay('test-agent', false);
      try {
        const handler = display.createHandler();
        handler({ type: 'tool_use', data: { tool: 'Bash\x1b[2J', input: { input: 'ordinary', command: 'bash-only' } } });
        vi.advanceTimersByTime(80);
        handler({ type: 'tool_result', data: { content: '', isError: false } });
        handler({ type: 'tool_use', data: { tool: 'AskUserQuestion\x1b[2J', input: { input: 'ordinary' } } });
        vi.advanceTimersByTime(80);
        handler({ type: 'tool_result', data: { content: 'returned content', isError: false } });
        const frames = stdoutWriteSpy.mock.calls.map(([chunk]) => String(chunk))
          .filter((chunk) => chunk.startsWith('\r  '));
        expect(frames).toHaveLength(2);
        for (const frame of frames) {
          expect(frame.slice(1)).not.toMatch(/\x1b(?!\[[0-9;]*m)|[\x00-\x1a\x1c-\x1f\x7f-\x9f]/u);
          expect(frame).toContain('ordinary');
          expect(frame).not.toContain('bash-only');
        }
        const result = consoleLogSpy.mock.calls.map((args) => args.join(' ')).find((line) => line.includes('AskUserQuestion'))!;
        expect(result).not.toContain('\x1b[2J');
        expect(result.replace(/\x1b\[[0-9;]*m/g, '')).toBe('  ✓ AskUserQuestion returned content');
      } finally {
        display.reset();
        vi.useRealTimers();
      }
    });

    it('preserves the quiet error fallback without storing suppressed tool names', () => {
      const display = new StreamDisplay('test-agent', true);
      const handler = display.createHandler();
      handler({ type: 'tool_use', data: { tool: 'Custom\x1b[2J', input: {} } });
      handler({ type: 'tool_output', data: { tool: 'Custom\x07', output: 'suppressed\n' } });
      handler({ type: 'tool_result', data: { content: 'failed', isError: true } });
      expect(stdoutWriteSpy).not.toHaveBeenCalled();
      expect(consoleLogSpy).toHaveBeenCalledOnce();
      const result = consoleLogSpy.mock.calls[0]!.join(' ');
      expect(result).not.toMatch(/\x1b(?!\[[0-9;]*m)|[\x00-\x1a\x1c-\x1f\x7f-\x9f]/u);
      expect(result.replace(/\x1b\[[0-9;]*m/g, '')).toBe('  ✗ Tool: failed');
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

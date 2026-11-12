import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamCallback, StreamEvent } from '../shared/types/provider.js';
import { StreamDisplay } from '../shared/ui/StreamDisplay.js';
import { TaskPrefixWriter } from '../shared/ui/TaskPrefixWriter.js';
import { createPrefixedStreamHandler } from '../features/tasks/execute/outputFns.js';
import { ParallelLogger } from '../core/workflow/engine/parallel-logger.js';
import { emitToolUse } from '../infra/opencode/OpenCodeStreamHandler.js';

interface TerminalAdapter {
  handler: StreamCallback;
  flush: () => void;
}

function start(id: string, tool: string, input: Record<string, unknown>): StreamEvent {
  return { type: 'tool_use', data: { id, tool, input } };
}

function finish(id: string, content: string, isError = false): StreamEvent {
  return { type: 'tool_result', data: { id, content, isError } };
}

const adapters: Array<{
  name: string;
  create: (write: (text: string) => void) => TerminalAdapter;
}> = [
  {
    name: 'StreamDisplay',
    create: () => {
      const display = new StreamDisplay('coder', false);
      return { handler: display.createHandler(), flush: () => display.flush() };
    },
  },
  {
    name: 'task prefix',
    create: (writeFn) => {
      const writer = new TaskPrefixWriter({ taskName: 'task', colorIndex: 0, writeFn });
      const handler = createPrefixedStreamHandler(writer);
      return { handler, flush: () => { handler.flush(); writer.flush(); } };
    },
  },
  {
    name: 'parallel prefix',
    create: (writeFn) => {
      const logger = new ParallelLogger({ subStepNames: ['coder'], writeFn });
      return { handler: logger.createStreamHandler('coder', 0), flush: () => logger.flush() };
    },
  },
];

describe.each(adapters)('$name non-interactive tool activity', ({ create }) => {
  let output: string[];
  let adapter: TerminalAdapter;
  let ttyDescriptor: PropertyDescriptor | undefined;

  const visible = (): string => output.join('').replace(/\x1b\[[0-9;]*m/g, '');
  const lines = (): string[] => visible().split('\n').filter(Boolean);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });
    output = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      output.push(`${args.map(String).join(' ')}\n`);
    });
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    adapter = create((text) => output.push(text));
  });

  afterEach(() => {
    adapter.flush();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (ttyDescriptor) Object.defineProperty(process.stdout, 'isTTY', ttyDescriptor);
    else Reflect.deleteProperty(process.stdout, 'isTTY');
  });

  it('should log the command at start without waiting for completion', () => {
    adapter.handler(start('shell', 'Bash', { command: 'printf 日本語' }));

    expect(visible()).toContain('printf 日本語');
    expect(visible()).toMatch(/Bash|Ran/);
  });

  it.each([
    ['MCP', '{"content":[{"type":"text","text":"ready"}],"structured_content":null}', 'ready'],
    ['ANSI JSON', '\x1b[32m{"stdout":"ready secret123","api\\u005fkey":"secret123"}\x1b[0m', 'ready'],
    ['log', '[INFO] ready\n', '[INFO] ready'],
  ])('should display safe %s results through the real output adapter', (_name, content, expected) => {
    adapter.handler(start('shell', 'Bash', { command: 'printf tool-output' }));
    const event = finish('shell', content);
    const original = structuredClone(event);
    adapter.handler(event);
    adapter.flush();
    expect(visible()).toContain(expected);
    expect(visible()).not.toContain('secret123');
    expect(visible()).not.toContain('structured_content');
    expect(event).toEqual(original);
  });

  it('should safely flush split ANSI JSON through the real output adapter', () => {
    adapter.handler(start('shell', 'Bash', { command: 'printf tool-output' }));
    for (const chunk of ['\x1b[', '32m{"stdout":"ready secret', '123","api\\u005fkey":"secret123"}', '\x1b[0m']) {
      adapter.handler({ type: 'tool_output', data: { id: 'shell', tool: 'Bash', output: chunk } });
      expect(visible()).not.toContain('secret123');
    }
    adapter.flush();
    expect(visible()).toContain('ready');
    expect(visible()).toContain('[running]');
    expect(visible()).not.toContain('secret123');
    expect(visible()).not.toContain('api\\u005fkey');
  });

  it('should keep unknown tool names within the log budget', () => {
    adapter.handler(start('custom', 'Custom' + '日'.repeat(10_000), { query: 'safe-query' }));
    adapter.handler(finish('custom', 'safe-result'));
    adapter.flush();
    expect(visible()).toContain('safe-query');
    expect(visible()).toContain('safe-result');
    expect(visible()).toContain('[name truncated]');
    expect(Buffer.byteLength(visible())).toBeLessThan(2048);
  });

  it('should display the filePath emitted by the real OpenCode adapter', () => {
    emitToolUse(adapter.handler, 'read', { filePath: '日本語.ts' }, 'read-1');
    adapter.handler(finish('read-1', 'file-result'));
    adapter.flush();
    expect(visible()).toContain('日本語.ts');
    expect(visible()).toContain('Read');
    expect(visible()).toContain('file-result');
  });

  it('should flush observed output without inventing completion when no result arrives', () => {
    adapter.handler(start('shell', 'Bash', { command: 'printf pending' }));
    adapter.handler({ type: 'tool_output', data: { id: 'shell', tool: 'Bash', output: 'observed-while-running' } });
    adapter.flush();
    expect(visible()).toContain('observed-while-running');
    expect(visible()).toContain('[running]');
    expect(visible()).not.toMatch(/✓|success|成功/);
  });

  it('should not emit spinner frames or terminal erase sequences on non-TTY output', () => {
    adapter.handler(start('shell', 'Bash', { command: 'printf 日本語' }));
    vi.advanceTimersByTime(240);
    adapter.handler(finish('shell', 'done'));
    adapter.flush();

    expect(output.join('')).not.toMatch(/\r|\x1b\[K/);
  });

  it('should retain a full command and expanded result beyond the compact preview', () => {
    const command = `printf ${'日本語'.repeat(24)} command-end`;
    adapter.handler(start('shell', 'Bash', { command }));
    adapter.handler(finish('shell', 'first\nsecond\nthird\nfourth'));
    adapter.flush();

    expect(visible()).toContain(command);
    for (const result of ['first', 'second', 'third', 'fourth']) {
      expect(lines().some((line) => line.includes(result))).toBe(true);
    }
    expect(visible()).toMatch(/✓|success|成功/);
  });

  it('should report success and 250 ms for the tool started at time 1000', () => {
    adapter.handler(start('item_0', 'Bash', { command: 'printf done' }));
    vi.setSystemTime(1250);
    adapter.handler(finish('item_0', 'done'));
    adapter.flush();

    expect(visible()).toContain('done');
    expect(visible()).toMatch(/Bash|Ran/);
    expect(visible()).toMatch(/✓|success|成功/);
    expect(visible()).toMatch(/250\s*ms|0\.25\s*s|250\s*ミリ秒/);
  });

  it('should associate delayed failure with its own tool and preserve completion reception order', () => {
    adapter.handler(start('read-a', 'Read', { file_path: 'src/a.ts' }));
    adapter.handler(start('shell-b', 'Bash', { command: 'printf beta' }));
    adapter.handler(finish('shell-b', 'beta-result'));
    const beforeFailure = visible();

    adapter.handler(finish('read-a', 'alpha-result', true));
    adapter.flush();

    const delayedCompletion = visible().slice(beforeFailure.length);
    expect(beforeFailure).toContain('beta-result');
    expect(delayedCompletion).toContain('Read');
    expect(delayedCompletion).toContain('alpha-result');
    expect(delayedCompletion).toMatch(/✗|fail|失敗/i);
    expect(visible().indexOf('beta-result')).toBeLessThan(visible().indexOf('alpha-result'));
  });

  it('should report every ID in a batched completion without inventing separate results', () => {
    adapter.handler(start('read-a', 'Read', { file_path: 'src/a.ts' }));
    adapter.handler(start('shell-b', 'Bash', { command: 'printf beta' }));
    const beforeResult = visible();
    adapter.handler({
      type: 'tool_result',
      data: { id: 'read-a', completedToolIds: ['shell-b', 'read-a'], content: 'batch-result', isError: true },
    });
    adapter.flush();

    const completion = visible().slice(beforeResult.length);
    expect(completion).toContain('Read');
    expect(completion).toMatch(/Bash|Ran/);
    expect(completion).toContain('batch-result');
    expect(completion).toMatch(/✗|fail|失敗/i);
    expect(completion).not.toMatch(/✓|success|成功/);
  });

  it('should not change a failed execution to success on a later successful result', () => {
    adapter.handler(start('shell', 'Bash', { command: 'false' }));
    adapter.handler(finish('shell', 'original-result', true));
    const failureOutput = visible();
    expect(failureOutput).toContain('original-result');
    expect(failureOutput).toMatch(/✗|fail|失敗/i);

    adapter.handler(finish('shell', 'late-result'));
    adapter.flush();

    expect(visible().slice(failureOutput.length)).not.toMatch(/✓|success|成功/);
  });

  it('should keep response text visible and hidden thinking private between tool events', () => {
    adapter.handler(start('read', 'Read', { file_path: 'src/a.ts' }));
    adapter.handler({ type: 'thinking', data: { thinking: 'hidden-reasoning-first\nhidden-reasoning-second' } });
    adapter.handler({ type: 'text', data: { text: '回答本文\n' } });
    adapter.handler(finish('read', 'file-result'));
    adapter.flush();

    expect(visible()).toContain('回答本文');
    expect(visible()).toContain('file-result');
    for (const line of lines()) {
      expect(line).not.toContain('hidden-reasoning-first');
      expect(line).not.toContain('hidden-reasoning-second');
    }
  });

  it('should redact structured input and output at display time without modifying the events', () => {
    const use = start('shell', 'Bash', { command: 'printf ready', api_key: 'secret123' });
    const result = finish('shell', '{"stdout":"ready\\nsecret123","token":"secret456"}');
    const original = structuredClone([use, result]);

    adapter.handler(use);
    adapter.handler(result);
    adapter.flush();

    for (const line of lines()) {
      expect(line).not.toContain('secret123');
      expect(line).not.toContain('secret456');
    }
    expect(visible()).toContain('printf ready');
    expect(visible()).toContain('ready');
    expect([use, result]).toEqual(original);
  });

  it.each([
    '{"private_blob":{"text":"do-not-display"}}',
    '[{"token":"secret123"}]',
    '{"token":"secret123',
    '{"stdout":"ready","api\\u005fkey":"secret123"}',
  ])('should not fall back to displaying raw structured output: %s', (content) => {
    adapter.handler(start('shell', 'Bash', { command: 'printf ready' }));
    adapter.handler(finish('shell', content));
    adapter.flush();

    for (const line of lines()) {
      expect(line).not.toContain('do-not-display');
      expect(line).not.toContain('secret123');
      expect(line).not.toContain(content);
    }
    expect(visible()).toContain('printf ready');
  });

  it('should redact known secrets split across tool output chunks and neutralize terminal controls', () => {
    adapter.handler(start('shell', 'Bash', { command: 'printf ready', token: 'test-only-secret' }));
    adapter.handler({ type: 'tool_output', data: { id: 'shell', tool: 'Bash', output: 'ready test-only-' } });
    adapter.handler({ type: 'tool_output', data: { id: 'shell', tool: 'Bash', output: 'secret\x1b]52;c;payload\x07\n' } });
    adapter.handler(finish('shell', 'ready test-only-secret\n'));
    adapter.flush();

    expect(visible()).toContain('ready');
    for (const line of lines()) {
      expect(line).not.toContain('test-only-');
      expect(line).not.toMatch(/\x1b|[\x00-\x08\x0b-\x1f\x7f-\x9f]/u);
    }
  });

  it.each([
    Array.from({ length: 10_000 }, (_, index) => `output-${index}`).join('\n'),
    '日本語'.repeat(100_000),
  ])('should bound long results and explicitly record omission', (content) => {
    adapter.handler(start('shell', 'Bash', { command: 'produce-large-output' }));
    const beforeResult = visible();
    adapter.handler(finish('shell', content));
    adapter.flush();

    const resultOutput = visible().slice(beforeResult.length);
    expect(resultOutput.length).toBeLessThan(content.length);
    expect(resultOutput).toMatch(/truncat|omitt|省略|…|\.\.\./i);
    expect(visible()).toContain('produce-large-output');
    expect(visible()).toMatch(/✓|success|成功/);
  });

  it('should apply one output budget across streaming chunks and final completion', () => {
    const chunk = Array.from({ length: 100 }, (_, index) => `stream-line-${index}\n`).join('');
    adapter.handler(start('shell', 'Bash', { command: 'produce-stream-output' }));
    for (let index = 0; index < 100; index += 1) {
      adapter.handler({ type: 'tool_output', data: { id: 'shell', tool: 'Bash', output: chunk } });
    }
    adapter.handler(finish('shell', chunk.repeat(100)));
    adapter.flush();

    expect(visible().length).toBeLessThan(chunk.length * 100);
    expect(visible()).toMatch(/truncat|omitt|省略|…|\.\.\./i);
    expect(visible()).toMatch(/✓|success|成功/);
  });
});

it('prints a new task thinking heading after the previous task handler is flushed', () => {
  const output: string[] = [];
  const writer = new TaskPrefixWriter({ taskName: 'task', colorIndex: 0, writeFn: (text) => output.push(text) });
  const handler = createPrefixedStreamHandler(writer, 'expanded');
  const thinking: StreamEvent = { type: 'thinking', data: { thinking: 'hidden' } };

  handler(thinking);
  handler.flush();
  handler(thinking);

  expect(output.filter((line) => line.includes('thinking:'))).toHaveLength(2);
  expect(output.join('')).not.toContain('hidden');
});

describe('quiet non-interactive tool activity', () => {
  it('should preserve tool commands and results while suppressing response text', () => {
    const output: string[] = [];
    const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => output.push(`${args.map(String).join(' ')}\n`));
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { output.push(String(chunk)); return true; });
    const display = new StreamDisplay('coder', true);
    try {
      const handler = display.createHandler();
      handler(start('success', 'Bash', { command: 'printf ready' }));
      handler(finish('success', 'ready-result'));
      handler(start('failure', 'Read', { file_path: 'missing.ts' }));
      handler(finish('failure', 'missing-file-result', true));
      handler({ type: 'text', data: { text: 'suppressed-response' } });
      display.flush();

      const rendered = output.join('').replace(/\x1b\[[0-9;]*m/g, '');
      for (const expected of ['printf ready', 'ready-result', 'missing.ts', 'missing-file-result']) {
        expect(rendered).toContain(expected);
      }
      expect(rendered).toMatch(/✓|success|成功/);
      expect(rendered).toMatch(/✗|fail|失敗/i);
      expect(rendered).not.toContain('suppressed-response');
    } finally {
      display.flush();
      vi.restoreAllMocks();
      if (ttyDescriptor) Object.defineProperty(process.stdout, 'isTTY', ttyDescriptor);
      else Reflect.deleteProperty(process.stdout, 'isTTY');
    }
  });
});

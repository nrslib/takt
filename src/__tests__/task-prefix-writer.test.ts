import { beforeEach, describe, expect, it } from 'vitest';
import { TaskPrefixWriter } from '../shared/ui/TaskPrefixWriter.js';

describe('TaskPrefixWriter boundary behavior', () => {
  let output: string[];

  beforeEach(() => {
    output = [];
  });

  it('buffers fragments until a complete line and preserves dynamic content', () => {
    const text = 'dynamic streamed content';
    const writer = new TaskPrefixWriter({
      taskName: 'dynamic-task',
      colorIndex: 0,
      writeFn: (chunk) => output.push(chunk),
    });

    writer.writeChunk(text.slice(0, 7));
    expect(output).toHaveLength(0);
    writer.writeChunk(`${text.slice(7)}\n`);

    expect(output).toHaveLength(1);
    expect(output[0]).toContain(text);
    expect(output[0]).toMatch(/\n$/);
  });

  it.each([
    { input: 'one\n\ttwo\n', lines: ['one', '\ttwo', ''] },
    { input: 'one\r\n\ttwo\n', lines: ['one', '\ttwo', ''] },
    { input: 'one\r\ttwo\n', lines: ['one\ttwo', ''] },
    { input: '\r\rone\r\rtwo\r', lines: ['onetwo'] },
    { input: 'one\r\n\r\nnext', lines: ['one', '', 'next'] },
  ])('removes CR from complete lines before styling and prefixing: $input', ({ input, lines }) => {
    const prefix = '\x1b[35m[parent-label]\x1b[0m ';
    const style = (line: string) => `\x1b[32m${line}\x1b[0m`;
    const writer = new TaskPrefixWriter({
      taskName: 'parent-task', displayLabel: 'parent-label', colorIndex: 2,
      writeFn: (chunk) => output.push(chunk),
    });

    writer.writeLine(input, style);

    expect(output.join('')).not.toContain('\r');
    expect(output).toEqual(lines.map((line) => line === '' ? '\n' : `${prefix}${style(line)}\n`));
  });

  it.each([
    { chunks: ['one\n\ttwo\n'], lines: ['one', '\ttwo'] },
    { chunks: ['one\r\n\ttwo\n'], lines: ['one', '\ttwo'] },
    { chunks: ['one\r', '\n\ttwo\n'], lines: ['one', '\ttwo'] },
    { chunks: ['one\r', '\ttwo\n'], lines: ['one\ttwo'] },
    { chunks: ['\r\rone\r', '\rtwo\r\n\r\n'], lines: ['onetwo', ''] },
  ])('removes CR before buffering chunks while preserving styled lines: $chunks', ({ chunks, lines }) => {
    const prefix = '\x1b[35m[parent-label]\x1b[0m ';
    const style = (line: string) => `\x1b[32m${line}\x1b[0m`;
    const writer = new TaskPrefixWriter({
      taskName: 'parent-task', displayLabel: 'parent-label', colorIndex: 2,
      writeFn: (chunk) => output.push(chunk),
    });

    for (const chunk of chunks) writer.writeChunk(chunk, style);
    writer.writeChunk('remaining\r');
    writer.flush();
    writer.flush();

    expect(output.join('')).not.toContain('\r');
    expect(output).toEqual([
      ...lines.map((line) => line === '' ? '\n' : `${prefix}${style(line)}\n`),
      `${prefix}remaining\n`,
    ]);
  });

  it('removes terminal control sequences from untrusted task output', () => {
    const writer = new TaskPrefixWriter({
      taskName: 'task\x1b[31m\nforged',
      colorIndex: 0,
      writeFn: (chunk) => output.push(chunk),
    });

    writer.writeLine('safe\x1b]52;c;secret\x07\nnext');

    const rendered = output.join('');
    expect(rendered).toContain('safe');
    expect(rendered).toContain('next');
    expect(rendered).not.toContain('\x1b]52');
    expect(rendered).not.toContain('\x07');
    expect(rendered).not.toContain('\nforged');
  });

  it('neutralizes split OSC before buffering, styling, and flushing while preserving prefix colors', () => {
    const writer = new TaskPrefixWriter({
      taskName: 'parent-task', displayLabel: 'parent-label', colorIndex: 2,
      writeFn: (chunk) => output.push(chunk),
    });
    const style = (line: string) => `\x1b[32m${line}\x1b[0m`;
    writer.writeChunk('safe \x1b]52;c;', style);
    expect(output).toEqual([]);
    writer.writeChunk('c2FmZQ==\x07\nnext\n', style);
    writer.writeChunk('safe \x1b]52;c;payload\x1b', style);
    writer.writeChunk('\\\nlast\n', style);
    writer.writeLine('safe \x1b]\x9b\x07\n\nnext', style);
    writer.writeChunk('safe 52;c;');
    writer.writeChunk('c2FmZQ==\nremaining\x1b]');
    writer.flush();
    writer.flush();
    const raw = output.join('');
    expect(raw).not.toMatch(/\x1b(?!\[[0-9;]*m)|[\x07\x80-\x9f]/u);
    for (const text of ['safe', 'next', 'last', 'safe 52;c;c2FmZQ==', 'remaining']) {
      expect(raw).toContain(text);
    }
    for (const line of output.filter((line) => line !== '\n')) {
      expect(line.startsWith('\x1b[35m[parent-label]\x1b[0m ')).toBe(true);
    }
    expect(output).toContain('\n');
    expect(raw).toContain('\x1b[32m');
  });

  it.each([
    { taskName: 'alpha', expected: 'alph' },
    { taskName: '\x1b[2Jbeta', expected: 'beta' },
    { taskName: '\x07beta', expected: '\\x07' },
    { taskName: '\x9bbeta', expected: '\\x9b' },
    { taskName: '\r\nbeta', expected: '\\r\\n' },
    { taskName: '\x7fbeta', expected: '\\x7f' },
    { taskName: 'alpha', displayLabel: 'alpha-label', expected: 'alpha-label' },
    { taskName: 'alpha', displayLabel: '\x1b[2J\x9balpha\r\n\x07\x7f', expected: '\\x9balpha\\r\\n\\x07\\x7f' },
    { taskName: '\x1b[2Jbeta', displayLabel: '', expected: '' },
    { taskName: '\x1b[2Jbeta', displayLabel: '\x9blabel', issue: 42, expected: '#42' },
    { taskName: '\x1b[2Jbeta', displayLabel: '\x9blabel', issue: 43, expected: '#43' },
  ])('sanitizes the selected prefix before truncating: $expected', ({ expected, ...options }) => {
    const writer = new TaskPrefixWriter({
      ...options,
      colorIndex: 1,
      writeFn: (chunk) => output.push(chunk),
    });
    const prefix = `\x1b[33m[${expected}]\x1b[0m `;

    writer.writeLine('first\n\nsecond', (line) => `\x1b[32m${line}\x1b[0m`);
    writer.writeChunk('str');
    writer.writeChunk('eam\nremaining');
    writer.flush();
    writer.flush();

    expect(output).toEqual([
      `${prefix}\x1b[32mfirst\x1b[0m\n`, '\n', `${prefix}\x1b[32msecond\x1b[0m\n`,
      `${prefix}stream\n`, `${prefix}remaining\n`,
    ]);
  });
});

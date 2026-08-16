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
});

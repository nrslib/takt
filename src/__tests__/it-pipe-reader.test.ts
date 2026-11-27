import { PassThrough, Readable } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { readPipeLine } from '../shared/prompt/pipe-reader.js';

function chunkedInput(chunks: readonly string[]) {
  let index = 0;
  const delivered: Buffer[] = [];
  const input = new Readable({
    highWaterMark: 6,
    read() {
      const chunk = chunks[index++];
      this.push(chunk === undefined ? null : Buffer.from(chunk));
    },
  });
  input.on('data', (chunk: Buffer) => delivered.push(chunk));
  return { input, delivered };
}

describe('pipe line ownership', () => {
  it('stops delivering chunks without readers and resumes for each new request', async () => {
    const chunks = ['first\n', ...Array.from({ length: 63 }, (_, index) => `${String(index).padStart(5, '0')}\n`)];
    const { input, delivered } = chunkedInput(chunks);
    try {
      for (let index = 0; index < chunks.length; index++) {
        await expect(readPipeLine(input)).resolves.toBe(chunks[index]!.trimEnd());
        await setImmediate();
        expect({ chunks: delivered.length, bytes: Buffer.concat(delivered).length })
          .toEqual({ chunks: index + 1, bytes: (index + 1) * 6 });
      }
      await expect(readPipeLine(input)).resolves.toBeNull();
    } finally {
      input.destroy();
    }
  });

  it.each([
    { chunks: ['first\n\nlast\n', 'later\n'], counts: [1, 1, 1, 2] },
    { chunks: ['first\n', '\n', 'last\n', 'later\n'], counts: [1, 2, 3, 4] },
    { chunks: ['fi', 'rst\n\nla', 'st\n', 'later\n'], counts: [2, 2, 3, 4] },
  ])('preserves empty and remaining lines across chunk boundaries: $chunks', async ({ chunks, counts }) => {
    const { input, delivered } = chunkedInput(chunks);
    try {
      const lines = ['first', '', 'last', 'later'];
      for (let index = 0; index < lines.length; index++) {
        await expect(readPipeLine(input)).resolves.toBe(lines[index]);
        await setImmediate();
        expect(delivered.length).toBe(counts[index]);
        expect(Buffer.concat(delivered).length).toBe(Buffer.byteLength(chunks.slice(0, counts[index]).join('')));
      }
      await expect(readPipeLine(input)).resolves.toBeNull();
    } finally {
      input.destroy();
    }
  });

  it.each([1, 2])('delivers separate chunks in order to %i waiting readers', async (count) => {
    const { input, delivered } = chunkedInput(['a\n', 'b\n', 'c\n']);
    try {
      const pending = Array.from({ length: count }, () => readPipeLine(input));
      await expect(Promise.all(pending)).resolves.toEqual(['a', 'b'].slice(0, count));
      await setImmediate();
      expect(delivered.length).toBe(count);
      for (const line of ['a', 'b', 'c'].slice(count)) {
        await expect(readPipeLine(input)).resolves.toBe(line);
      }
      await expect(readPipeLine(input)).resolves.toBeNull();
    } finally {
      input.destroy();
    }
  });

  it('returns lines before EOF and retains empty and unconsumed lines after close', async () => {
    const input = new PassThrough();
    const first = readPipeLine(input);
    input.write('first\n\n');
    await expect(first).resolves.toBe('first');
    input.end('last');
    await expect(readPipeLine(input)).resolves.toBe('');
    await expect(readPipeLine(input)).resolves.toBe('last');
    await expect(readPipeLine(input)).resolves.toBeNull();
    expect(input.listenerCount('data')).toBe(0);
  });

  it('keeps answers separate for different streams', async () => {
    const left = new PassThrough();
    const right = new PassThrough();
    const first = readPipeLine(left);
    const second = readPipeLine(right);
    left.end('left\n');
    right.end('right\n');
    await expect(first).resolves.toBe('left');
    await expect(second).resolves.toBe('right');
  });

  it('reports stream failures and releases the readline listeners', async () => {
    const input = new PassThrough();
    const failure = new Error('pipe failed');
    const pending = readPipeLine(input);
    input.destroy(failure);
    await expect(pending).rejects.toBe(failure);
    await expect(readPipeLine(input)).rejects.toBe(failure);
    expect(input.listenerCount('data')).toBe(0);
  });

  it('reports a failure while paused before returning retained lines', async () => {
    const input = new PassThrough();
    const failure = new Error('paused pipe failed');
    const first = readPipeLine(input);
    input.write('first\n\nlast\n');
    await expect(first).resolves.toBe('first');
    const closed = new Promise<void>((resolve) => input.once('close', resolve));
    input.destroy(failure);
    await closed;
    await expect(readPipeLine(input)).rejects.toBe(failure);
    await expect(readPipeLine(input)).rejects.toBe(failure);
    expect(input.listenerCount('data')).toBe(0);
  });
});

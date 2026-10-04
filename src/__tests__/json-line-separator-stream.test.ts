import { describe, expect, it } from 'vitest';
import { createInterface } from 'node:readline';
import { PassThrough, Readable } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import {
  createJsonLineSeparatorEscapeStream,
  escapeChildStdoutLineSeparators,
} from '../infra/codex/json-line-separator-stream.js';

async function collectBytes(chunks: Buffer[]): Promise<Buffer> {
  const escaped = Readable.from(chunks).pipe(createJsonLineSeparatorEscapeStream());
  const parts: Buffer[] = [];
  for await (const part of escaped) {
    parts.push(part as Buffer);
  }
  return Buffer.concat(parts);
}

async function readLines(chunks: Buffer[]): Promise<string[]> {
  const escaped = Readable.from(chunks).pipe(createJsonLineSeparatorEscapeStream());
  const rl = createInterface({ input: escaped, crlfDelay: Infinity });
  const lines: string[] = [];
  for await (const line of rl) {
    lines.push(line);
  }
  return lines;
}

describe('json-line-separator-stream', () => {
  it('keeps a JSON line containing raw U+2028 / U+2029 as a single parseable line', async () => {
    const line = '{"msg":"abc\u2028def\u2029ghi"}';
    const lines = await readLines([Buffer.from(`${line}\n`, 'utf8')]);

    expect(lines).toHaveLength(1);
    const escapedLine = lines[0] as string;
    expect(escapedLine).toBe(line.replace(/[\u2028\u2029]/g, (char) =>
      char === '\u2028' ? '\\u2028' : '\\u2029',
    ));
    expect(JSON.parse(escapedLine)).toEqual({ msg: 'abc\u2028def\u2029ghi' });
  });

  it('decodes separators whose three UTF-8 bytes are split across chunk boundaries', async () => {
    const lineSeparatorBytes = Buffer.from('\u2028', 'utf8');
    const paragraphSeparatorBytes = Buffer.from('\u2029', 'utf8');
    const lines = await readLines([
      Buffer.concat([Buffer.from('{"a":"x', 'utf8'), lineSeparatorBytes.subarray(0, 2)]),
      Buffer.concat([
        lineSeparatorBytes.subarray(2),
        Buffer.from('y","b":"p', 'utf8'),
        paragraphSeparatorBytes.subarray(0, 1),
      ]),
      Buffer.concat([paragraphSeparatorBytes.subarray(1), Buffer.from('q"}\n', 'utf8')]),
    ]);

    expect(lines).toHaveLength(1);
    const parsed: unknown = JSON.parse(lines[0] as string);
    expect(parsed).toEqual({ a: 'x\u2028y', b: 'p\u2029q' });
  });

  it('passes lines without separators through byte-for-byte unchanged', async () => {
    const raw = Buffer.from('{"a":1,"s":"日本語テキスト"}\n{"b":[true,null]}\n', 'utf8');
    const chunks = [raw.subarray(0, 7), raw.subarray(7, 40), raw.subarray(40)];

    const output = await collectBytes(chunks);

    expect(output.equals(raw)).toBe(true);
  });

  it('replaces child.stdout with the escaping stream the SDK reads', async () => {
    const rawStdout = new PassThrough();
    const child = { stdout: rawStdout } as unknown as ChildProcess;

    escapeChildStdoutLineSeparators(child);

    expect(child.stdout).not.toBe(rawStdout);
    const linesPromise = (async (): Promise<string[]> => {
      const rl = createInterface({ input: child.stdout as Readable, crlfDelay: Infinity });
      const lines: string[] = [];
      for await (const line of rl) {
        lines.push(line);
      }
      return lines;
    })();
    rawStdout.end(Buffer.from('{"a":"x\u2028y"}\n', 'utf8'));

    const lines = await linesPromise;
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toEqual({ a: 'x\u2028y' });
  });

  it('leaves a child without stdout untouched', () => {
    const child = { stdout: null } as unknown as ChildProcess;

    escapeChildStdoutLineSeparators(child);

    expect(child.stdout).toBeNull();
  });

  it('forwards a source stdout error to the replacement stream', async () => {
    const rawStdout = new PassThrough();
    const child = { stdout: rawStdout } as unknown as ChildProcess;
    escapeChildStdoutLineSeparators(child);

    const failure = new Promise<Error>((resolve) => {
      (child.stdout as Readable).once('error', resolve);
    });
    rawStdout.destroy(new Error('boom'));

    await expect(failure).resolves.toMatchObject({ message: 'boom' });
  });
});

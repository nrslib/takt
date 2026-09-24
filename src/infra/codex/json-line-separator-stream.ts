/**
 * Escapes raw U+2028 / U+2029 on a Codex child's stdout before the SDK's
 * readline-based JSONL parser consumes it.
 *
 * Node's readline splits lines on U+2028 (LINE SEPARATOR) and U+2029
 * (PARAGRAPH SEPARATOR) in addition to \n and \r. The Codex CLI embeds raw
 * separator characters from tool output into JSON event lines without
 * escaping them, so the SDK's readline splits a single JSON event into
 * fragments and `JSON.parse` fails with "Failed to parse item:".
 *
 * Within a JSONL event line, U+2028 / U+2029 can only appear inside string
 * literals, where the six-character escapes \u2028/\u2029 parse back to the
 * identical code points — the replacement never changes the JSON value.
 */

import { StringDecoder } from 'node:string_decoder';
import { Transform, type TransformCallback } from 'node:stream';
import type { ChildProcess } from 'node:child_process';

const LINE_SEPARATOR_PATTERN = /[\u2028\u2029]/g;

function escapeLineSeparators(text: string): string {
  return text.replace(LINE_SEPARATOR_PATTERN, (char) =>
    char === '\u2028' ? '\\u2028' : '\\u2029',
  );
}

export function createJsonLineSeparatorEscapeStream(): Transform {
  const decoder = new StringDecoder('utf8');
  const encode = (text: string): Buffer | undefined =>
    text.length === 0 ? undefined : Buffer.from(escapeLineSeparators(text), 'utf8');
  return new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
      callback(null, encode(decoder.write(chunk)));
    },
    flush(callback: TransformCallback): void {
      callback(null, encode(decoder.end()));
    },
  });
}

export function escapeChildStdoutLineSeparators(child: ChildProcess): void {
  const stdout = child.stdout;
  if (stdout === null) {
    return;
  }
  const escapeStream = createJsonLineSeparatorEscapeStream();
  stdout.on('error', (error) => {
    escapeStream.destroy(error);
  });
  child.stdout = stdout.pipe(escapeStream);
}

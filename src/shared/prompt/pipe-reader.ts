import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';

interface PipeReader {
  read(): Promise<string | null>;
}

const readers = new WeakMap<Readable, PipeReader>();

/** Keep unconsumed lines when a pipe passes from one prompt to another. */
export function readPipeLine(input: Readable): Promise<string | null> {
  const existing = readers.get(input);
  if (existing !== undefined) return existing.read();
  if (input.readableEnded || input.destroyed) return Promise.resolve(null);

  const lines: string[] = [];
  const waiting: { resolve: (line: string | null) => void; reject: (error: Error) => void }[] = [];
  let closed = false;
  let failure: Error | undefined;
  const rl = createInterface({ input });
  rl.pause();
  rl.on('line', (line: string) => {
    const next = waiting.shift();
    if (next === undefined) lines.push(line);
    else next.resolve(line);
    if (waiting.length === 0) rl.pause();
  });
  rl.on('close', () => {
    closed = true;
    for (const next of waiting.splice(0)) next.resolve(null);
  });
  function onError(error: Error): void {
    failure = error;
    for (const next of waiting.splice(0)) next.reject(error);
    rl.close();
  }
  rl.on('error', onError);
  const reader: PipeReader = {
    read() {
      if (failure !== undefined) return Promise.reject(failure);
      const line = lines.shift();
      if (line !== undefined) return Promise.resolve(line);
      if (closed) return Promise.resolve(null);
      const nextLine = new Promise<string | null>((resolve, reject) => waiting.push({ resolve, reject }));
      rl.resume();
      return nextLine;
    },
  };
  readers.set(input, reader);
  return reader.read();
}

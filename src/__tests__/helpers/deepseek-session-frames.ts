import { zstdDecompressSync } from 'node:zlib';

/** Harness appends Zstd frames; Node's one-shot decoder reads only the first. */
export function decompressSessionFrames(data: Buffer): Buffer {
  const frames: Buffer[] = [];
  let offset = 0;
  while (offset < data.length) {
    const decoded = zstdDecompressSync(data.subarray(offset), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    if (decoded.engine.bytesWritten <= 0 || decoded.engine.bytesWritten > data.length - offset) {
      throw new Error('Session decoder did not consume a valid frame');
    }
    offset += decoded.engine.bytesWritten;
    frames.push(decoded.buffer);
  }
  return Buffer.concat(frames);
}

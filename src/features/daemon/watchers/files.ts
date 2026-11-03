import { open, opendir } from 'node:fs/promises';
import type { Dirent } from 'node:fs';

export const MAX_WATCH_FILE_BYTES = 256 * 1024;
export const MAX_WATCH_ENTRIES = 128;

export function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/** 上限を超えたファイルは全体を取得・解析せず、観測不能として返す。 */
export async function readSmallText(path: string): Promise<string> {
  const file = await open(path, 'r');
  try {
    const stats = await file.stat();
    if (!stats.isFile() || stats.size > MAX_WATCH_FILE_BYTES) throw new Error('Watch file exceeds the read limit or is not regular');
    const buffer = Buffer.alloc(MAX_WATCH_FILE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_WATCH_FILE_BYTES) throw new Error('Watch file exceeds the read limit');
    return buffer.toString('utf8', 0, length);
  } finally {
    await file.close();
  }
}

export async function readSmallJson(path: string): Promise<unknown> {
  return JSON.parse(await readSmallText(path)) as unknown;
}

export async function listWatchEntries(path: string): Promise<readonly Dirent[]> {
  let directory;
  try { directory = await opendir(path, { bufferSize: 16 }); }
  catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const entries: Dirent[] = [];
  for await (const entry of directory) {
    if (entries.length === MAX_WATCH_ENTRIES) throw new Error('Watch directory exceeds the entry limit');
    entries.push(entry);
  }
  return entries.sort((left, right) => left.name.localeCompare(right.name));
}

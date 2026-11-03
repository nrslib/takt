import { constants } from 'node:fs';
import { chmod, mkdir, open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, relative, sep } from 'node:path';

export function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

export async function ensurePrivateDirectory(path: string): Promise<void> {
  const first = await mkdir(path, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    if (first !== undefined) {
      let current = first;
      await chmod(current, 0o700);
      for (const component of relative(first, path).split(sep).filter(Boolean)) {
        current = join(current, component);
        await chmod(current, 0o700);
      }
    }
    await chmod(path, 0o700);
  }
}

/** サイズ確認後に同じ記述子から読む。増大中のファイルも上限を越えて保持しない。 */
export async function readPrivateFile(path: string, maxBytes: number): Promise<Buffer | undefined> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('Invalid file capacity');
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch((error: unknown) => {
    if (hasCode(error, 'ENOENT')) return undefined;
    throw error;
  });
  if (file === undefined) return undefined;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error(`Invalid or oversized private file: ${path}`);
    const chunks: Buffer[] = [];
    let size = 0;
    while (true) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - size));
      const { bytesRead } = await file.read(buffer);
      if (bytesRead === 0) return Buffer.concat(chunks, size);
      size += bytesRead;
      if (size > maxBytes) throw new Error(`Private file exceeds capacity: ${path}`);
      chunks.push(buffer.subarray(0, bytesRead));
    }
  } finally {
    await file.close();
  }
}

export async function writePrivateFile(path: string, content: string | Uint8Array, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const directory = dirname(path);
  await ensurePrivateDirectory(directory);
  const temporary = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
  const file = await open(temporary, 'wx', 0o600);
  let failure: unknown;
  let failed = false;
  try {
    try {
      await file.chmod(0o600);
      await file.writeFile(content);
      await file.sync();
    } finally {
      await file.close();
    }
    signal?.throwIfAborted();
    await rename(temporary, path);
    if (process.platform !== 'win32') {
      const parent = await open(directory, 'r');
      try { await parent.sync(); } finally { await parent.close(); }
    }
  } catch (error) {
    failed = true;
    failure = error;
  }
  try {
    await unlink(temporary).catch((error: unknown) => { if (!hasCode(error, 'ENOENT')) throw error; });
  } catch (error) {
    if (failed) throw new AggregateError([failure, error], 'Private file write and cleanup failed');
    throw error;
  }
  if (failed) throw failure;
}

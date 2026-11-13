import { constants } from 'node:fs';
import { chmod, mkdir, open, rename, unlink, type FileHandle } from 'node:fs/promises';
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

async function readRegularFile(path: string, read: (file: FileHandle, size: number) => Promise<Buffer>): Promise<Buffer | undefined> {
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch((error: unknown) => {
    if (hasCode(error, 'ENOENT')) return undefined;
    throw error;
  });
  if (file === undefined) return undefined;
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error(`Invalid private file: ${path}`);
    return await read(file, stat.size);
  } finally {
    await file.close();
  }
}

/** サイズ確認後に同じ記述子から読む。増大中のファイルも上限を越えて保持しない。 */
export async function readPrivateFile(path: string, maxBytes: number): Promise<Buffer | undefined> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('Invalid file capacity');
  return readRegularFile(path, async (file, initialSize) => {
    if (initialSize > maxBytes) throw new Error(`Private file exceeds capacity: ${path}`);
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
  });
}

/** 業務データとして保存したファイルを、大きさで拒否せず全体を読む。 */
export async function readEntirePrivateFile(path: string): Promise<Buffer | undefined> {
  return readRegularFile(path, (file) => file.readFile());
}

/** writePrivateFile で作成済みのファイルの末尾へ追記する。ファイルがなければ作らずに失敗する。 */
export async function appendPrivateFile(path: string, content: string): Promise<void> {
  const file = await open(path, constants.O_WRONLY | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0));
  try {
    await file.writeFile(content);
    await file.sync();
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

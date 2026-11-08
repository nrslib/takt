import { chmodSync, existsSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

/** Write a file atomically using a temporary file and rename. */
export function writeFileAtomic(filePath: string, content: string, mode = 0o644): void {
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tempPath, content, { encoding: 'utf-8', mode, flag: 'wx' });
    chmodSync(tempPath, mode);
    renameSync(tempPath, filePath);
  } catch (error) {
    try {
      if (existsSync(tempPath)) unlinkSync(tempPath);
    } catch {
      // Ignore cleanup errors.
    }
    throw error;
  }
}

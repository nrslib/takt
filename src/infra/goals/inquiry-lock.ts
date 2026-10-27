import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { runPrivateFileExclusiveAsync } from '../../shared/utils/private-file-lock.js';

export async function withInquiryLock<T>(configDirectory: string, action: () => Promise<T>): Promise<T> {
  await mkdir(configDirectory, { recursive: true, mode: 0o700 });
  const directory = await realpath(configDirectory);
  return runPrivateFileExclusiveAsync(join(directory, 'inquiries.lock'), action, { timeoutMs: Infinity });
}

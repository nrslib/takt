import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { withFileLocks } from '../daemon/fileLocks.js';
import { ConversationIdSchema } from './schema.js';

export async function withManagerLifecycleLock<T>(configDirectory: string, managerId: string, signal: AbortSignal,
  action: () => Promise<T>): Promise<T> {
  return withManagerLifecycleLocks(configDirectory, [managerId], signal, action);
}

export async function withManagerLifecycleLocks<T>(configDirectory: string, managerIds: readonly string[], signal: AbortSignal,
  action: () => Promise<T>): Promise<T> {
  const directory = await realpath(configDirectory);
  const ids = [...new Set(managerIds.map((id) => ConversationIdSchema.parse(id)))].sort();
  return withFileLocks(ids.map((id) => join(directory, 'conversations', 'manager-locks', `${id}.lock`)), signal, action);
}

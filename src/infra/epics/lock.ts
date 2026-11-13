import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { ensurePrivateDirectory } from '../../shared/utils/private-file.js';
import { assertSafePath } from '../../shared/utils/private-path-identity.js';
import { runPrivateFileExclusiveAsync } from '../../shared/utils/private-file-lock.js';
import { EpicIdSchema } from './schema.js';

export async function withWorkspaceEpicLock<T>(configDirectory: string, workspaceId: string, action: () => Promise<T>): Promise<T> {
  const path = join(configDirectory, 'workspaces', EpicIdSchema.parse(workspaceId));
  assertSafePath(path, true);
  ensurePrivateDirectory(path);
  const canonical = await realpath(path);
  return runPrivateFileExclusiveAsync(join(canonical, 'epics.lock'), action, { timeoutMs: 60_000 });
}

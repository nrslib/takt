import { withRetry } from './retry.js';
import { UserStore } from './user-store.js';
import { Logger } from './logger.js';

export async function syncUsers(
  store: UserStore,
  fetchJson: () => Promise<string>,
): Promise<number> {
  const json = await withRetry(() => fetchJson());
  return store.loadFromJson(json).length;
}

export function logSyncResult(logger: Logger, count: number): void {
  if (count > 0) {
    logger.log('info', `synced ${count} users`);
  } else {
    logger.log('info', `synced ${count} users`);
  }
}

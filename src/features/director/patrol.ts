import { prepareDirectorTurn } from './conversationRuntime.js';
import { listDirectorManagers } from './managers.js';
import type { DirectorNotifications } from './mcp.js';
import type { DirectorNotificationDelivery } from './notificationDelivery.js';
import type { Language } from '../../core/models/types.js';
import { getLabel } from '../../shared/i18n/index.js';
import { createLogger } from '../../shared/utils/debug.js';
import { getErrorMessage } from '../../shared/utils/error.js';
import { sanitizeSensitiveText } from '../../shared/utils/sensitiveText.js';

const log = createLogger('director-patrol');

export function createDirectorPatrol(
  configDirectory: string,
  notifications: DirectorNotifications,
  intervalSeconds: number,
  language: Language,
  delivery?: DirectorNotificationDelivery,
) {
  let pending: Promise<void> | undefined;
  let completedAt: number | undefined;
  return {
    get running() { return pending !== undefined; },
    poll(signal: AbortSignal): void {
      if (signal.aborted || pending !== undefined) return;
      if (completedAt !== undefined && Date.now() - completedAt < intervalSeconds * 1000) return;
      pending = Promise.resolve().then(async () => {
        signal.throwIfAborted();
        if ((await listDirectorManagers(configDirectory)).length === 0) return;
        signal.throwIfAborted();
        const prepared = await prepareDirectorTurn(configDirectory, notifications, signal, {}, true, delivery);
        try {
          const prompt = JSON.stringify({
            event: 'director_patrol',
            observedAt: new Date().toISOString(),
            patrolIntervalSeconds: intervalSeconds,
          });
          await prepared.executor.execute({
            prompt, instruction: prompt, sessionId: undefined,
            assignment: undefined, configDirectory, abortSignal: signal,
          });
        } finally {
          await prepared.dispose();
        }
      }).catch((error: unknown) => {
        if (!signal.aborted) {
          log.error(getLabel('director.patrolFailed', language), { error: sanitizeSensitiveText(getErrorMessage(error)) });
        }
      }).finally(() => {
        completedAt = Date.now();
        pending = undefined;
      });
    },
    async close(): Promise<void> { await pending; },
  };
}

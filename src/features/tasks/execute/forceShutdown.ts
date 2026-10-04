import { EXIT_SIGINT } from '../../../shared/exitCodes.js';
import { createLogger, getErrorMessage } from '../../../shared/utils/index.js';
import { sanitizeSensitiveText } from '../../../shared/utils/sensitiveText.js';
import { prepareSharedServerPoolForForcedShutdown } from '../../../infra/opencode/server-pool.js';

const log = createLogger('force-shutdown');
let forceExitPromise: Promise<void> | undefined;

export function forceExitAfterOpenCodeCleanup(): Promise<void> {
  if (forceExitPromise !== undefined) return forceExitPromise;

  forceExitPromise = (async () => {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        prepareSharedServerPoolForForcedShutdown(),
        new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(() => reject(new Error('OpenCode forced cleanup exceeded 5000ms')), 5_000);
        }),
      ]);
    } catch (error: unknown) {
      log.error('Failed to stop OpenCode servers before forced exit', {
        error: sanitizeSensitiveText(getErrorMessage(error)),
      });
    } finally {
      if (deadline !== undefined) clearTimeout(deadline);
    }
    process.exit(EXIT_SIGINT);
  })();
  return forceExitPromise;
}

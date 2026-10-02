import { EXIT_SIGINT } from '../../../shared/exitCodes.js';
import { createLogger, getErrorMessage } from '../../../shared/utils/index.js';
import { sanitizeSensitiveText } from '../../../shared/utils/sensitiveText.js';
import { prepareSharedServerPoolForForcedShutdown } from '../../../infra/opencode/server-pool.js';

const log = createLogger('force-shutdown');
let forceExitPromise: Promise<void> | undefined;

export function forceExitAfterOpenCodeCleanup(): Promise<void> {
  if (forceExitPromise !== undefined) return forceExitPromise;

  forceExitPromise = prepareSharedServerPoolForForcedShutdown()
    .then(() => {
      process.exit(EXIT_SIGINT);
    })
    .catch((error: unknown) => {
      log.error('Failed to stop OpenCode servers before forced exit', {
        error: sanitizeSensitiveText(getErrorMessage(error)),
      });
    });
  return forceExitPromise;
}

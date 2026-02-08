/**
 * Shared SIGINT handler for graceful/force shutdown pattern.
 *
 * 1st Ctrl+C = graceful abort via onAbort callback
 * 2nd Ctrl+C = force exit
 */

import { blankLine, warn, error } from '../../../shared/ui/index.js';
import { EXIT_SIGINT } from '../../../shared/exitCodes.js';
import { getLabel } from '../../../shared/i18n/index.js';

interface SigIntHandler {
  cleanup: () => void;
}

export function installSigIntHandler(onAbort: () => void): SigIntHandler {
  let sigintCount = 0;
  const handler = () => {
    sigintCount++;
    if (sigintCount === 1) {
      blankLine();
      warn(getLabel('piece.sigintGraceful'));
      onAbort();
    } else {
      blankLine();
      error(getLabel('piece.sigintForce'));
      process.exit(EXIT_SIGINT);
    }
  };
  process.on('SIGINT', handler);
  return { cleanup: () => process.removeListener('SIGINT', handler) };
}

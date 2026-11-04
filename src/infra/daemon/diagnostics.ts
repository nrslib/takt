import { getErrorMessage } from '../../shared/utils/error.js';
import { sanitizeSensitiveText } from '../../shared/utils/sensitive-text.js';

let errorLog: ((message: string) => Promise<void>) | undefined;

export function installDaemonErrorLog(write: (message: string) => Promise<void>): () => void {
  const previous = errorLog;
  errorLog = write;
  return () => { errorLog = previous; };
}

export function reportDaemonError(error: unknown): void {
  const message = sanitizeSensitiveText(getErrorMessage(error));
  process.stderr.write(`${message}\n`);
  const writing = errorLog?.(message);
  if (writing !== undefined) void writing.catch((failure: unknown) => {
    process.stderr.write(`Cannot write daemon diagnostic: ${sanitizeSensitiveText(getErrorMessage(failure))}\n`);
  });
}

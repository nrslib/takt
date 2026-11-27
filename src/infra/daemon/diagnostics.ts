import { getErrorMessage } from '../../shared/utils/error.js';
import { sanitizeSensitiveText } from '../../shared/utils/sensitive-text.js';

let errorLog: ((message: string) => Promise<void>) | undefined;

function diagnosticMessage(error: unknown): string {
  if (error instanceof AggregateError) return [error.message, ...error.errors.map(diagnosticMessage)].join('\n');
  return getErrorMessage(error);
}

export function installDaemonErrorLog(write: (message: string) => Promise<void>): () => void {
  const previous = errorLog;
  errorLog = write;
  return () => { errorLog = previous; };
}

export function reportDaemonError(error: unknown): void {
  const message = sanitizeSensitiveText(diagnosticMessage(error));
  process.stderr.write(`${message}\n`);
  const writing = errorLog?.(message);
  if (writing !== undefined) void writing.catch((failure: unknown) => {
    process.stderr.write(`Cannot write daemon diagnostic: ${sanitizeSensitiveText(getErrorMessage(failure))}\n`);
  });
}

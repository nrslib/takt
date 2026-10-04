export function createAbortError(reason?: unknown): Error {
  const message = reason instanceof Error ? reason.message : 'Aborted';
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

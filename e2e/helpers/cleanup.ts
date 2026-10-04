export function cleanupResources(...cleanups: Array<() => void>): void {
  const errors: unknown[] = [];

  for (const cleanup of cleanups) {
    try {
      cleanup();
    } catch (error) {
      errors.push(error);
    }
  }

  if (errors.length > 0) {
    throw new AggregateError(errors, 'Failed to clean up E2E resources');
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function throwAfterCleanup(
  primaryError: unknown,
  cleanupActions: ReadonlyArray<() => void>,
): never {
  const errors = [primaryError];
  for (const cleanup of cleanupActions) {
    try {
      cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) {
    throw primaryError;
  }
  throw new AggregateError(
    errors,
    errorMessage(primaryError),
    { cause: primaryError },
  );
}

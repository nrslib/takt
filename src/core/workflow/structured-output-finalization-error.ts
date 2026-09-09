export type StructuredOutputFinalizationOrigin = 'normal' | 'live_intervention';

export class StructuredOutputFinalizationError extends Error {
  readonly origin: StructuredOutputFinalizationOrigin;

  constructor(message: string, origin: StructuredOutputFinalizationOrigin) {
    super(message);
    this.name = 'StructuredOutputFinalizationError';
    this.origin = origin;
  }
}

export function isStructuredOutputFinalizationError(
  error: unknown,
): error is StructuredOutputFinalizationError {
  return error instanceof StructuredOutputFinalizationError;
}

export function isLiveInterventionStructuredOutputFinalizationError(
  error: unknown,
): error is StructuredOutputFinalizationError {
  return isStructuredOutputFinalizationError(error) && error.origin === 'live_intervention';
}

import type { StreamCallback } from './runner.js';

const DECOMPOSITION_MAX_ATTEMPTS = 3;
const DIAGNOSTIC_MESSAGE_MAX_LENGTH = 2_000;

export interface TeamLeaderDecompositionDiagnostic {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export interface RejectedTeamLeaderDecomposition {
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly diagnostic: TeamLeaderDecompositionDiagnostic;
}

export class TeamLeaderDecompositionValidationError extends Error {
  readonly diagnostic: TeamLeaderDecompositionDiagnostic;

  constructor(code: string, path: string, error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const boundedMessage = message.length <= DIAGNOSTIC_MESSAGE_MAX_LENGTH
      ? message
      : `${message.slice(0, DIAGNOSTIC_MESSAGE_MAX_LENGTH - 1)}…`;
    super(boundedMessage);
    this.name = 'TeamLeaderDecompositionValidationError';
    this.diagnostic = { code, path, message: boundedMessage };
  }
}

export function createPublicationGuardedStreamCallback(
  onStream: StreamCallback | undefined,
  publicationSignal: AbortSignal | undefined,
): StreamCallback | undefined {
  if (onStream === undefined || publicationSignal === undefined) {
    return onStream;
  }
  return (event) => {
    if (!publicationSignal.aborted) {
      onStream(event);
    }
  };
}

export async function requestValidTeamLeaderDecomposition<T>(options: {
  readonly abortSignal?: AbortSignal;
  readonly request: (
    rejectedDecomposition: RejectedTeamLeaderDecomposition | undefined,
  ) => Promise<T>;
}): Promise<T> {
  let rejectedDecomposition: RejectedTeamLeaderDecomposition | undefined;

  for (let attempt = 1; attempt <= DECOMPOSITION_MAX_ATTEMPTS; attempt++) {
    options.abortSignal?.throwIfAborted();
    try {
      const result = await waitForRequestOrAbort(
        () => options.request(rejectedDecomposition),
        options.abortSignal,
      );
      options.abortSignal?.throwIfAborted();
      return result;
    } catch (error) {
      options.abortSignal?.throwIfAborted();
      if (!(error instanceof TeamLeaderDecompositionValidationError)) {
        throw error;
      }
      if (attempt === DECOMPOSITION_MAX_ATTEMPTS) {
        throw error;
      }
      rejectedDecomposition = {
        attempt,
        maxAttempts: DECOMPOSITION_MAX_ATTEMPTS,
        diagnostic: error.diagnostic,
      };
    }
  }

  throw new Error('Team Leader decomposition regeneration completed without a result');
}

async function waitForRequestOrAbort<T>(
  request: () => Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (signal === undefined) {
    return request();
  }
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const settle = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      operation();
    };
    const onAbort = (): void => settle(() => reject(signal.reason));
    signal.addEventListener('abort', onAbort, { once: true });
    let requestPromise: Promise<T>;
    try {
      requestPromise = request();
    } catch (error) {
      settle(() => reject(error));
      return;
    }
    requestPromise.then(
      (result) => settle(() => resolve(result)),
      (error: unknown) => settle(() => reject(error)),
    );
  });
}

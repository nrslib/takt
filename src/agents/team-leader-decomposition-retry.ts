const DECOMPOSITION_MAX_ATTEMPTS = 3;
const VALIDATION_MESSAGE_MAX_LENGTH = 2_000;

export interface TeamLeaderDecompositionValidationIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export interface RejectedTeamLeaderDecomposition {
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly issues: readonly TeamLeaderDecompositionValidationIssue[];
}

export class TeamLeaderDecompositionValidationError extends Error {
  readonly issues: readonly TeamLeaderDecompositionValidationIssue[];

  constructor(issues: readonly TeamLeaderDecompositionValidationIssue[]) {
    if (issues.length === 0) {
      throw new Error('Team Leader decomposition validation error requires at least one issue');
    }
    const boundedIssues = issues.map((issue) => ({
      ...issue,
      message: boundValidationMessage(issue.message),
    }));
    super(boundedIssues.map((issue) => issue.message).join('; '));
    this.name = 'TeamLeaderDecompositionValidationError';
    this.issues = boundedIssues;
  }
}

export function createTeamLeaderDecompositionValidationError(
  code: string,
  path: string,
  error: unknown,
): TeamLeaderDecompositionValidationError {
  if (error instanceof TeamLeaderDecompositionValidationError) {
    return error;
  }
  return new TeamLeaderDecompositionValidationError([{
    code,
    path,
    message: error instanceof Error ? error.message : String(error),
  }]);
}

export async function requestValidTeamLeaderDecomposition<T>(options: {
  readonly abortSignal?: AbortSignal;
  readonly request: (
    rejectedDecomposition: RejectedTeamLeaderDecomposition | undefined,
  ) => Promise<T>;
  readonly onRejected?: (rejectedDecomposition: RejectedTeamLeaderDecomposition) => void;
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
        issues: error.issues,
      };
      options.onRejected?.(rejectedDecomposition);
    }
  }

  throw new Error('Team Leader decomposition retry completed without a result');
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
    const cleanup = (): void => signal.removeEventListener('abort', onAbort);
    const onAbort = (): void => {
      cleanup();
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    let requestPromise: Promise<T>;
    try {
      requestPromise = request();
    } catch (error) {
      cleanup();
      reject(error);
      return;
    }
    requestPromise.then(
      (result) => {
        cleanup();
        resolve(result);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function boundValidationMessage(message: string): string {
  return message.length <= VALIDATION_MESSAGE_MAX_LENGTH
    ? message
    : `${message.slice(0, VALIDATION_MESSAGE_MAX_LENGTH - 1)}…`;
}

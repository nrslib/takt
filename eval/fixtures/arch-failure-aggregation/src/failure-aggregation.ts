export interface Failure {
  category: 'rate_limited' | 'parse_error' | 'provider_error';
  detail: string;
  retryable: boolean;
}

export interface AggregateFailure {
  status: 'retry' | 'failed';
  category: Failure['category'];
  abortReason: string;
}

export function aggregateFailures(
  failures: readonly [Failure, ...Failure[]],
): AggregateFailure {
  const retryable = failures.find((failure) => failure.retryable);
  const fatal = failures.find((failure) => !failure.retryable);

  return {
    status: retryable ? 'retry' : 'failed',
    category: (fatal ?? failures[0]).category,
    abortReason: (retryable ?? failures[0]).detail,
  };
}

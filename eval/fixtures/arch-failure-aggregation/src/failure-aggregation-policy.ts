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
  const primary = failures.find((failure) => failure.retryable) ?? failures[0];

  return {
    status: primary.retryable ? 'retry' : 'failed',
    category: primary.category,
    abortReason: primary.detail,
  };
}

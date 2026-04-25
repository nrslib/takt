export const AGENT_FAILURE_CATEGORIES = {
  EXTERNAL_ABORT: 'external_abort',
  PART_TIMEOUT: 'part_timeout',
  PROVIDER_ERROR: 'provider_error',
  STREAM_IDLE_TIMEOUT: 'stream_idle_timeout',
} as const;

export type AgentFailureCategory =
  typeof AGENT_FAILURE_CATEGORIES[keyof typeof AGENT_FAILURE_CATEGORIES];

export interface AgentFailureDetail {
  category: AgentFailureCategory;
  reason: string;
}

interface FormatAgentFailureOptions {
  includeCategoryPrefix?: boolean;
}

const FAILURE_CATEGORY_PREFIX: Record<AgentFailureCategory, string> = {
  [AGENT_FAILURE_CATEGORIES.EXTERNAL_ABORT]: 'external abort',
  [AGENT_FAILURE_CATEGORIES.PART_TIMEOUT]: 'part timeout',
  [AGENT_FAILURE_CATEGORIES.PROVIDER_ERROR]: 'provider error',
  [AGENT_FAILURE_CATEGORIES.STREAM_IDLE_TIMEOUT]: 'stream idle timeout',
};

function stringifyFailureReason(reason: unknown): string {
  if (reason instanceof Error) {
    return reason.message;
  }
  if (typeof reason === 'string') {
    return reason;
  }
  if (reason == null) {
    return '';
  }

  return String(reason);
}

function withPrefix(prefix: string, reason: string): string {
  return reason.startsWith(`${prefix}: `) ? reason : `${prefix}: ${reason}`;
}

function isPartTimeoutReason(reason: unknown): boolean {
  return stringifyFailureReason(reason).startsWith(createPartTimeoutReasonPrefix());
}

function createFailureDetail(
  category: AgentFailureCategory,
  reason: unknown,
  fallbackReason: string,
): AgentFailureDetail {
  return {
    category,
    reason: stringifyFailureReason(reason) || fallbackReason,
  };
}

function createPartTimeoutReasonPrefix(): string {
  return 'Part timeout after ';
}

export function createPartTimeoutReason(timeoutMs: number): string {
  return `${createPartTimeoutReasonPrefix()}${timeoutMs}ms`;
}

export function createExternalAbortFailure(reason: unknown): AgentFailureDetail {
  return createFailureDetail(
    AGENT_FAILURE_CATEGORIES.EXTERNAL_ABORT,
    reason,
    'Execution aborted',
  );
}

export function createPartTimeoutFailure(reason: unknown): AgentFailureDetail {
  return createFailureDetail(
    AGENT_FAILURE_CATEGORIES.PART_TIMEOUT,
    reason,
    'Part timeout',
  );
}

export function createProviderErrorFailure(reason: unknown): AgentFailureDetail {
  return createFailureDetail(
    AGENT_FAILURE_CATEGORIES.PROVIDER_ERROR,
    reason,
    'Codex execution failed',
  );
}

export function createStreamIdleTimeoutFailure(reason: unknown): AgentFailureDetail {
  return createFailureDetail(
    AGENT_FAILURE_CATEGORIES.STREAM_IDLE_TIMEOUT,
    reason,
    'Codex stream timed out',
  );
}

export function classifyAbortSignalReason(reason: unknown): AgentFailureDetail {
  const message = stringifyFailureReason(reason);
  if (isPartTimeoutReason(message)) {
    return createPartTimeoutFailure(message);
  }

  return createExternalAbortFailure(message);
}

export function formatAgentFailure(
  detail: AgentFailureDetail,
  options?: FormatAgentFailureOptions,
): string {
  if (
    detail.category === AGENT_FAILURE_CATEGORIES.EXTERNAL_ABORT
    || detail.category === AGENT_FAILURE_CATEGORIES.PART_TIMEOUT
  ) {
    return withPrefix(FAILURE_CATEGORY_PREFIX[detail.category], detail.reason);
  }
  if (!options?.includeCategoryPrefix) {
    return detail.reason;
  }
  return withPrefix(FAILURE_CATEGORY_PREFIX[detail.category], detail.reason);
}

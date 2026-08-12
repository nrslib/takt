export const AGENT_FAILURE_CATEGORIES = {
  EXTERNAL_ABORT: 'external_abort',
  PART_TIMEOUT: 'part_timeout',
  PROVIDER_ERROR: 'provider_error',
  PROVIDER_STREAM_PARSE_ERROR: 'provider_stream_parse_error',
  STREAM_IDLE_TIMEOUT: 'stream_idle_timeout',
} as const;

export const MAX_AGENT_FAILURE_MESSAGE_BYTES = 8 * 1024;

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
  [AGENT_FAILURE_CATEGORIES.PROVIDER_STREAM_PARSE_ERROR]: 'provider stream parse error',
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

export function createProviderStreamParseFailure(reason: unknown): AgentFailureDetail {
  return createFailureDetail(
    AGENT_FAILURE_CATEGORIES.PROVIDER_STREAM_PARSE_ERROR,
    reason,
    'Codex stream item parsing failed',
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
    || detail.category === AGENT_FAILURE_CATEGORIES.PROVIDER_STREAM_PARSE_ERROR
  ) {
    return withPrefix(FAILURE_CATEGORY_PREFIX[detail.category], detail.reason);
  }
  if (!options?.includeCategoryPrefix) {
    return detail.reason;
  }
  return withPrefix(FAILURE_CATEGORY_PREFIX[detail.category], detail.reason);
}

export class ProviderStreamParseError extends Error {
  readonly failureCategory = AGENT_FAILURE_CATEGORIES.PROVIDER_STREAM_PARSE_ERROR;
  readonly reason: string;

  constructor(reason: unknown) {
    const message = stringifyFailureReason(reason);
    const prefix = `${FAILURE_CATEGORY_PREFIX[AGENT_FAILURE_CATEGORIES.PROVIDER_STREAM_PARSE_ERROR]}: `;
    const normalizedReason = message.startsWith(prefix) ? message.slice(prefix.length) : message;
    const detail = createProviderStreamParseFailure(normalizedReason);
    super(formatAgentFailure(detail));
    this.name = 'ProviderStreamParseError';
    this.reason = detail.reason;
  }
}

export class AgentFailureError extends Error {
  readonly failureCategory: AgentFailureCategory;
  readonly reason: string;

  constructor(detail: AgentFailureDetail) {
    super(formatAgentFailure(detail));
    this.name = 'AgentFailureError';
    this.failureCategory = detail.category;
    this.reason = detail.reason;
  }
}

export function createAgentFailureError(
  category: AgentFailureCategory,
  reason: unknown,
): AgentFailureError {
  return new AgentFailureError({
    category,
    reason: stringifyFailureReason(reason),
  });
}

export function isAgentFailureError(error: unknown): error is AgentFailureError {
  return error instanceof AgentFailureError;
}

export function stripProviderStreamParsePrefix(reason: unknown): string {
  const message = stringifyFailureReason(reason);
  const prefix = `${FAILURE_CATEGORY_PREFIX[AGENT_FAILURE_CATEGORIES.PROVIDER_STREAM_PARSE_ERROR]}: `;
  return message.startsWith(prefix) ? message.slice(prefix.length) : message;
}

export function createProviderStreamParseError(reason: unknown): ProviderStreamParseError {
  return new ProviderStreamParseError(stripProviderStreamParsePrefix(reason));
}

export function isProviderStreamParseError(error: unknown): error is ProviderStreamParseError {
  if (error instanceof ProviderStreamParseError) {
    return true;
  }
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as { name?: unknown; failureCategory?: unknown; reason?: unknown };
  return candidate.name === 'ProviderStreamParseError'
    && candidate.failureCategory === AGENT_FAILURE_CATEGORIES.PROVIDER_STREAM_PARSE_ERROR
    && typeof candidate.reason === 'string';
}

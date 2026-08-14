export const PROVIDER_CALL_TIMEOUT_MIN_MS = 60_000;
export const PROVIDER_CALL_TIMEOUT_MAX_MS = 86_400_000;
export const PROVIDER_CALL_TIMEOUT_DEFAULT_MS = 3_600_000;
export const STALE_IN_FLIGHT_TOOL_FACTOR = 6;

export function resolveProviderCallTimeoutMs(configured: number | undefined): number {
  const timeoutMs = configured ?? PROVIDER_CALL_TIMEOUT_DEFAULT_MS;
  if (
    !Number.isInteger(timeoutMs)
    || timeoutMs < PROVIDER_CALL_TIMEOUT_MIN_MS
    || timeoutMs > PROVIDER_CALL_TIMEOUT_MAX_MS
  ) {
    throw new Error(
      `Provider call timeout must be an integer between ${PROVIDER_CALL_TIMEOUT_MIN_MS} and ${PROVIDER_CALL_TIMEOUT_MAX_MS} ms`,
    );
  }
  return timeoutMs;
}

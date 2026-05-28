export const TIMEOUT_CONTINUATION_ID_PREFIX = 'timeout-continuation';

export function isTimeoutContinuationPartId(partId: string): boolean {
  return partId === TIMEOUT_CONTINUATION_ID_PREFIX
    || partId.startsWith(`${TIMEOUT_CONTINUATION_ID_PREFIX}-`);
}

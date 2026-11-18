import { sliceUtf8, truncateUtf8 } from '../utils/utf8.js';

export const RETAINED_TOOL_OUTPUT_BYTES = 1024 * 1024;
export const SAVED_TOOL_OUTPUT_BYTES = 64 * 1024;
export const LIVE_TOOL_OUTPUT_LIMIT = 10_000;
const OMITTED = '\n[output truncated; more available]\n';

/** 容量超過でも実行は継続し、診断に必要な先頭と最新の末尾を残す。 */
export function limitToolOutput(text: string, limit: number): string {
  if (Buffer.byteLength(text) <= limit) return text;
  const available = limit - Buffer.byteLength(OMITTED);
  const head = Math.floor(available / 2);
  return truncateUtf8(text, head).value + OMITTED + sliceUtf8(text, 0, available - head, true).content;
}

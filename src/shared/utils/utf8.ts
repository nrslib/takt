import { StringDecoder } from 'node:string_decoder';

export interface TruncatedUtf8 {
  value: string;
  bytes: number;
}

export function truncateUtf8(value: string, maxBytes: number): TruncatedUtf8 {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maxBytes) {
    return { value, bytes: bytes.length };
  }
  const decoder = new StringDecoder('utf8');
  const truncated = decoder.write(bytes.subarray(0, Math.max(0, maxBytes)));
  return {
    value: truncated,
    bytes: Buffer.byteLength(truncated, 'utf8'),
  };
}

export function sliceUtf8(value: string, offset: number, maxBytes: number, tail = false) {
  const bytes = Buffer.from(value);
  let start = tail ? Math.max(0, bytes.length - offset - maxBytes) : Math.min(offset, bytes.length);
  let end = tail ? Math.max(0, bytes.length - offset) : Math.min(bytes.length, start + maxBytes);
  while (start < end && (bytes[start]! & 0xc0) === 0x80) start++;
  while (end > start && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
  const content = bytes.subarray(start, end).toString('utf8');
  return { content, totalBytes: bytes.length, offset: start, returnedBytes: end - start,
    direction: tail ? 'backward' as const : 'forward' as const,
    truncated: start > 0 || end < bytes.length,
    nextOffset: tail ? (start > 0 ? bytes.length - start : null) : (end < bytes.length ? end : null) };
}

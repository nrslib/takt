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

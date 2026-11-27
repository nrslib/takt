import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { GOAL_READ_MAX_BYTES } from '../../infra/goals/inspection.js';
import { truncateUtf8, sliceUtf8 } from '../../shared/utils/utf8.js';

// 既存のゴール読取と同じ64 KiBを使い、tool setによる差を作らない。
// 本文だけでなくJSONエスケープ、content構造、参照マーカーも上限に含める。
export const MCP_RESPONSE_MAX_BYTES = GOAL_READ_MAX_BYTES;
// 制御文字がJSON化で膨らんでも、範囲情報と参照マーカーを返せる本文量にする。
export const MCP_TEXT_PAGE_BYTES = 4096;

interface Omission {
  path: string;
  totalBytes?: number;
  returnedBytes?: number;
  totalCount?: number;
  returnedCount?: number;
  count?: number;
}

function envelope(text: string, isError: boolean | undefined): CallToolResult {
  return { ...(isError ? { isError: true } : {}), content: [{ type: 'text', text }] };
}

export function responseBytes(result: CallToolResult): number {
  return Buffer.byteLength(JSON.stringify(result));
}

export function jsonResult(value: Record<string, unknown>, isError?: boolean, suffix = ''): CallToolResult {
  const complete = envelope(JSON.stringify(value) + suffix, isError);
  if (responseBytes(complete) <= MCP_RESPONSE_MAX_BYTES) return complete;
  let stringBytes = MCP_TEXT_PAGE_BYTES;
  let items = 50;
  for (;;) {
    const omissions = new Map<string, Omission>();
    let omittedDetails = 0;
    const note = (omission: Omission) => {
      const path = omission.path.replace(/\.\d+(?=\.|$)/g, '[]');
      const previous = omissions.get(path);
      if (previous !== undefined) {
        const combined = { ...previous, count: (previous.count ?? 1) + 1 };
        for (const field of ['totalBytes', 'returnedBytes', 'totalCount', 'returnedCount'] as const) {
          const amount = omission[field];
          if (amount !== undefined) combined[field] = (previous[field] ?? 0) + amount;
        }
        omissions.set(path, combined);
      } else if (omissions.size < 50) omissions.set(path, { ...omission, path });
      else omittedDetails++;
    };
    const shorten = (entry: unknown, path: string): unknown => {
      if (typeof entry === 'string') {
        const totalBytes = Buffer.byteLength(entry);
        const shortened = truncateUtf8(entry, stringBytes);
        if (shortened.bytes < totalBytes) note({ path, totalBytes, returnedBytes: shortened.bytes });
        return shortened.value;
      }
      if (Array.isArray(entry)) {
        if (entry.length > items) note({ path, totalCount: entry.length, returnedCount: items });
        return entry.slice(0, items).map((item, index) => shorten(item, `${path}.${index}`));
      }
      if (entry !== null && typeof entry === 'object') {
        const fields = entry as Record<string, unknown>;
        const totalBytes = fields.totalBytes;
        if (typeof fields.content === 'string' && typeof fields.offset === 'number'
          && typeof fields.returnedBytes === 'number' && typeof totalBytes === 'number'
          && (fields.direction === 'forward' || fields.direction === 'backward')) {
          const page = sliceUtf8(fields.content, 0, stringBytes, fields.direction === 'backward');
          const offset = fields.offset + page.offset;
          const end = offset + page.returnedBytes;
          if (page.returnedBytes < fields.returnedBytes) note({ path: `${path}.content`, totalBytes: fields.returnedBytes, returnedBytes: page.returnedBytes });
          const bounded = { ...fields, offset, returnedBytes: page.returnedBytes,
            truncated: offset > 0 || end < totalBytes,
            nextOffset: fields.direction === 'backward'
              ? (offset > 0 ? totalBytes - offset : null) : (end < totalBytes ? end : null) };
          return Object.fromEntries(Object.entries(bounded).map(([key, item]) => [key,
            key === 'content' ? page.content : shorten(item, path ? `${path}.${key}` : key)]));
        }
        const shortened = Object.fromEntries(Object.entries(fields).map(([key, item]) => [key, shorten(item, path ? `${path}.${key}` : key)]));
        const alignPage = (page: Record<string, unknown>): Record<string, unknown> => {
          if (typeof page.collection !== 'string' || typeof page.totalCount !== 'number' || typeof page.offset !== 'number') return page;
          const collection = shortened[page.collection];
          if (!Array.isArray(collection)) return page;
          const returnedCount = collection.length;
          return { ...page, returnedCount, omittedCount: page.totalCount - returnedCount,
            nextOffset: page.offset + returnedCount < page.totalCount ? page.offset + returnedCount : null,
            truncated: page.truncated === true || returnedCount < page.totalCount };
        };
        return Object.fromEntries(Object.entries(alignPage(shortened)).map(([key, item]) => [key,
          item !== null && typeof item === 'object' && !Array.isArray(item) ? alignPage(item as Record<string, unknown>) : item]));
      }
      return entry;
    };
    const result = envelope(JSON.stringify({
      ...shorten(value, '') as Record<string, unknown>, truncated: true,
      omissions: [...omissions.values()], omittedDetails,
      retrieval: 'Read the selected goal with path and textOffset, or repeat the list with offset and a smaller limit. Omission paths use [] for collection totals; select a saved index or recordId for one entry. Use run view, stepIndex or report for run artifacts.',
    }) + suffix, isError);
    if (responseBytes(result) <= MCP_RESPONSE_MAX_BYTES) return result;
    if (stringBytes === 64 && items === 0) return result;
    if (stringBytes > 64) stringBytes = Math.floor(stringBytes / 2);
    else items = Math.floor(items / 2);
  }
}

export function textResult(text: string, isError?: boolean): CallToolResult {
  const complete = envelope(text, isError);
  return responseBytes(complete) <= MCP_RESPONSE_MAX_BYTES ? complete : jsonResult({ message: text }, isError);
}

export function pagedResult(key: string, values: readonly unknown[], totalCount: number, offset: number, isError?: boolean, extra: Record<string, unknown> = {}): CallToolResult {
  let count = values.length;
  for (;;) {
    const value = { ...extra, [key]: values.slice(0, count), collection: key, totalCount, returnedCount: count,
      omittedCount: totalCount - count, offset, nextOffset: offset + count < totalCount ? offset + count : null,
      truncated: count < totalCount };
    if (count <= 1 || responseBytes(envelope(JSON.stringify(value), isError)) <= MCP_RESPONSE_MAX_BYTES) return jsonResult(value, isError);
    count--;
  }
}

import { sliceUtf8 } from '../../shared/utils/utf8.js';
import { jsonResult, pagedResult } from './response.js';

type EpicResponseInput = { offset?: number; limit?: number; path?: string; textOffset?: number; maxBytes?: number };

export function epicListPage(input: EpicResponseInput): { offset: number; limit: number } {
  if (input.path === undefined) return { offset: input.offset ?? 0, limit: input.limit ?? 50 };
  const index = input.path.split('.')[0]!;
  return /^(0|[1-9]\d*)$/.test(index) && Number.isSafeInteger(Number(index))
    ? { offset: Number(index), limit: 1 } : { offset: 0, limit: 0 };
}

export function epicListResult(page: { epics: readonly unknown[]; totalCount: number; offset: number }, input: EpicResponseInput) {
  if (input.path !== undefined) {
    const fields: Record<string, unknown> = { length: page.totalCount };
    for (const [index, epic] of page.epics.entries()) fields[page.offset + index] = epic;
    return epicResult(fields, input);
  }
  return pagedResult('epics', page.epics, page.totalCount, page.offset);
}

export function epicResult(value: unknown, input: EpicResponseInput, operation?: { tool: string; reason: string; eventPublicationPending?: boolean }) {
  if (input.path !== undefined) {
    let selected: unknown = value;
    for (const key of input.path.split('.')) {
      if (selected === null || typeof selected !== 'object' || !Object.hasOwn(selected, key)) throw new Error('Unknown Epic field');
      selected = (selected as Record<string, unknown>)[key];
    }
    const text = typeof selected === 'string' ? selected : JSON.stringify(selected);
    return jsonResult({ path: input.path, ...sliceUtf8(text, input.textOffset ?? 0, input.maxBytes ?? 4096), operation });
  }
  if (Array.isArray(value)) {
    const offset = input.offset ?? 0;
    return pagedResult('epics', value.slice(offset, offset + (input.limit ?? 50)), value.length, offset, undefined, { operation });
  }
  return jsonResult({ epic: value, operation });
}

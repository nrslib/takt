import { FINDING_EVIDENCE_ISSUANCE_LIMITS } from '../../models/finding-contract-limits.js';

export type SourceQuoteMaterialization =
  | { ok: true; verbatimExcerpt: string; quoteBytes: number }
  | {
      ok: false;
      kind: 'invalid' | 'unverifiable' | 'resource_exhausted';
      reason: string;
    };

export function decodeSourceUtf8(content: Buffer): string {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content);
}

function countLines(content: Buffer): number {
  if (content.length === 0) return 0;
  let lineFeeds = 0;
  for (const byte of content) {
    if (byte === 0x0a) lineFeeds += 1;
  }
  return content[content.length - 1] === 0x0a ? lineFeeds : lineFeeds + 1;
}

function lineRangeBytes(content: Buffer, startLine: number, endLine: number): Buffer {
  let currentLine = 1;
  let startOffset = 0;
  let endOffset = content.length;
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] !== 0x0a) continue;
    if (currentLine < startLine) startOffset = index + 1;
    if (currentLine === endLine) {
      endOffset = index > startOffset && content[index - 1] === 0x0d
        ? index - 1
        : index;
      break;
    }
    currentLine += 1;
  }
  return content.subarray(startOffset, endOffset);
}

export function materializeSourceQuote(input: {
  path: string;
  content: Buffer;
  startLine: number;
  endLine: number;
}): SourceQuoteMaterialization {
  if (input.content.length > FINDING_EVIDENCE_ISSUANCE_LIMITS.maxSourceFileBytes) {
    return {
      ok: false,
      kind: 'unverifiable',
      reason: `source file "${input.path}" is ${input.content.length} bytes, exceeding the ${FINDING_EVIDENCE_ISSUANCE_LIMITS.maxSourceFileBytes}-byte evidence source limit`,
    };
  }
  if (!Number.isSafeInteger(input.startLine) || !Number.isSafeInteger(input.endLine)
    || input.startLine < 1 || input.endLine < input.startLine) {
    return {
      ok: false,
      kind: 'invalid',
      reason: `line range ${input.startLine}-${input.endLine} is invalid for "${input.path}"`,
    };
  }
  try {
    decodeSourceUtf8(input.content);
  } catch (error) {
    return {
      ok: false,
      kind: 'unverifiable',
      reason: `source file "${input.path}" is not valid UTF-8: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const lineCount = countLines(input.content);
  if (input.endLine > lineCount) {
    return {
      ok: false,
      kind: 'invalid',
      reason: `line range ${input.startLine}-${input.endLine} is out of range for "${input.path}" (file has ${lineCount} lines)`,
    };
  }
  const lineSpan = input.endLine - input.startLine + 1;
  if (lineSpan > FINDING_EVIDENCE_ISSUANCE_LIMITS.maxFileQuoteLines) {
    return {
      ok: false,
      kind: 'resource_exhausted',
      reason: `line range ${input.startLine}-${input.endLine} spans ${lineSpan} lines, exceeding the ${FINDING_EVIDENCE_ISSUANCE_LIMITS.maxFileQuoteLines}-line quote limit`,
    };
  }
  const excerptBytes = lineRangeBytes(input.content, input.startLine, input.endLine);
  if (excerptBytes.length === 0) {
    return { ok: false, kind: 'invalid', reason: 'materialized file quote is empty' };
  }
  if (excerptBytes.length > FINDING_EVIDENCE_ISSUANCE_LIMITS.maxFileQuoteBytes) {
    return {
      ok: false,
      kind: 'resource_exhausted',
      reason: `materialized file quote is ${excerptBytes.length} bytes, exceeding the ${FINDING_EVIDENCE_ISSUANCE_LIMITS.maxFileQuoteBytes}-byte quote limit`,
    };
  }
  return {
    ok: true,
    verbatimExcerpt: decodeSourceUtf8(excerptBytes),
    quoteBytes: excerptBytes.length,
  };
}

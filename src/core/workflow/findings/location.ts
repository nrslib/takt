/**
 * UI・監査・裁定の境界で使う "path:line" 表示を解析する。
 * Raw finding は typed evidence を保持し、ledger finding は evidence record
 * を id 参照するため、この表示文字列は finding の同一性を決めない。
 * 同一性の根拠は claimIdentityHash、完全な位置集合の扱いは
 * evidence-location.ts に集約する。
 */

export interface ParsedFindingLocation {
  path: string;
  line?: number;
}

/**
 * Parses a "path:line" location string. Locations without a trailing ":<digits>"
 * are treated as a bare path (line is undefined) rather than rejected, since some
 * findings only have file-level evidence. Returns undefined for empty/undefined
 * input.
 */
export function parseFindingLocation(location: string | undefined): ParsedFindingLocation | undefined {
  if (location === undefined) {
    return undefined;
  }
  const trimmed = location.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const match = /^(.+?):(\d+)$/.exec(trimmed);
  if (match) {
    return { path: match[1]!.trim(), line: Number(match[2]) };
  }
  return { path: trimmed };
}

export interface ParsedFindingLocationRange {
  path: string;
  startLine: number;
  endLine: number;
}

/**
 * Parses a "path:start-end" range location string;
 * see admission-validation.ts). Returns undefined for any other shape,
 * including a bare "path:line" (single line — callers that accept both should
 * fall back to parseFindingLocation and treat startLine === endLine === line).
 * 入力境界で表示用 citation を解釈する呼び出し元が、range の定義から
 * ずれないように共有する。
 */
export function parseFindingLocationRange(location: string | undefined): ParsedFindingLocationRange | undefined {
  if (location === undefined) {
    return undefined;
  }
  const match = /^(.+?):(\d+)-(\d+)$/.exec(location.trim());
  if (!match) {
    return undefined;
  }
  return { path: match[1]!.trim(), startLine: Number(match[2]), endLine: Number(match[3]) };
}

/** Normalizes free text for identity comparisons: trims and collapses internal whitespace. Case is preserved because exact-duplicate checks should not conflate differently-cased identifiers. */
export function normalizeFindingText(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

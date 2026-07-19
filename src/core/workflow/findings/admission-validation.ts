import { createHash } from 'node:crypto';
import { lstatSync, realpathSync, type Stats } from 'node:fs';
import { resolve, sep } from 'node:path';
import { readRegularFileNoFollow } from '../../../shared/utils/private-file.js';
import { parseFindingLocation, parseFindingLocationRange } from './location.js';
import type { SourceQuoteEvidence } from '../../models/finding-types.js';

/**
 * Deterministic, cwd-based verification that a "path:line" location string
 * points at a real file within the project and (when a line is present) a line
 * number within that file's range. This is the "raw admission validation" from
 * the Finding Contract admission boundary: hallucinated locations (a reviewer
 * cites a file/line that doesn't exist) must never be able to promote a raw
 * finding into a ledger entry, and must never be treated as evidence for an
 * existing finding. It is also reused, unmodified, to re-verify manager-proposed
 * `invalidate` decisions against an existing ledger finding's own location — in
 * both cases the LLM's claim alone is never sufficient; this function is the
 * single source of truth.
 *
 * Lives outside decision-assembly.ts/manager-output-validation.ts on purpose:
 * those modules are pure functions of their inputs (no fs access) so they stay
 * cheap to unit test. This module is the one place in the raw-admission path
 * that touches the filesystem, and callers (manager-runner.ts) thread `cwd`
 * into it explicitly rather than letting fs access leak into the pure layers.
 */
export type LocationAdmissionResult =
  | { ok: true }
  | { ok: false; outcome: 'invalid' | 'unverifiable'; reason: string };

const NO_LOCATION_RESULT: LocationAdmissionResult = { ok: true };

/**
 * admission 前段の機械正規化。実運用のレビュア表現が一律
 * 「存在しないパス」化していた実測への対処:
 * - 行範囲 `path:start-end` → path として実在検証する（行は範囲情報として扱い、
 *   行検証はしない — Finding Contract）
 * - `N/A`（大文字小文字・前後空白許容の厳密一致）と空文字 → locationless
 *   （空文字は従来から admissible なので、N/A → none は新しい権限ではない）
 * - カンマ区切り複数 location → 曖昧なので正規化しない（従来どおり invalid）
 */
const NOT_APPLICABLE_PATTERN = /^n\/a$/i;

export type LocationAdmissionNormalization = 'location-line-range-interpreted' | 'location-not-applicable';

/**
 * この location に正規化が適用されるかの分類（監査記録用）。適用事実は
 * rawNormalizations（store.ts）に記録される。空文字は従来から locationless で
 * あり正規化イベントではないため undefined を返す。
 */
export function classifyLocationAdmissionNormalization(
  location: string | undefined,
): LocationAdmissionNormalization | undefined {
  if (location === undefined) {
    return undefined;
  }
  const trimmed = location.trim();
  if (trimmed.length > 0 && NOT_APPLICABLE_PATTERN.test(trimmed)) {
    return 'location-not-applicable';
  }
  if (parseFindingLocationRange(trimmed) !== undefined) {
    return 'location-line-range-interpreted';
  }
  return undefined;
}

function isInsideBase(base: string, path: string): boolean {
  const basePrefix = base.endsWith(sep) ? base : base + sep;
  return path === base || path.startsWith(basePrefix);
}

/**
 * ファイルの行数。末尾改行は「最後の行の終端」であって空行ではない
 * （"a\nb\n" は2行。split('\n') の 3 要素目は行ではない）。素朴な
 * split('\n').length は 134 行のファイルで ":135" を範囲内と誤判定していた
 * （regression requirement）。
 */
function countLines(content: string): number {
  if (content.length === 0) {
    return 0;
  }
  const segments = content.split('\n');
  return content.endsWith('\n') ? segments.length - 1 : segments.length;
}

type RealPathResolution =
  | { ok: true; realPath: string; stat: Stats }
  | { ok: false; outcome: 'invalid' | 'unverifiable'; reason: string; error?: unknown };

function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

export const MAX_EVIDENCE_SOURCE_FILE_BYTES = 1024 * 1024;

function evidenceFileLimitReason(path: string, size: number): string {
  return `location path "${path}" is ${size} bytes, exceeding the evidence inspection limit of ${MAX_EVIDENCE_SOURCE_FILE_BYTES} bytes`;
}

/**
 * project 境界内かつ symlink 脱出していない実体ファイルへ path を解決する。
 * validateLocationAdmission（行範囲チェックなしの寛容版）と
 * verifySourceQuoteEvidence（verbatimExcerpt 機械照合、review-integrity protocol）の両方が
 * 使う唯一の実装。node_modules/... のようなプロジェクト外実体を受理しない規則を
 * 一元化し、検証経路間の不一致を防ぐ。
 */
function resolveRealPathWithinProject(cwd: string, path: string): RealPathResolution {
  const resolvedBase = resolve(cwd);
  const resolvedPath = resolve(resolvedBase, path);
  if (!isInsideBase(resolvedBase, resolvedPath)) {
    // Raw finding text is untrusted reviewer evidence (see manager-runner.ts).
    // A path that escapes the project is treated as inadmissible rather than
    // as a thrown error, matching the rest of this validation (evidence that
    // fails a deterministic check is dropped, not a hard failure of the run).
    return { ok: false, outcome: 'invalid', reason: `location path "${path}" resolves outside the project` };
  }

  // 字句的な resolve() だけでは symlink 経由の脱出を検出できない（statSync が
  // リンクを追跡するため node_modules/... のようなプロジェクト外実体が受理
  // されていた — regression requirement）。実体パス（realpath）同士で包含を
  // 検証する。realpathSync は存在しないパスで throw するので存在確認も兼ねる。
  let realBase: string;
  let realPath: string;
  try {
    realBase = realpathSync(resolvedBase);
  } catch (error) {
    return {
      ok: false,
      outcome: 'unverifiable',
      reason: `project root "${cwd}" cannot be resolved: ${error instanceof Error ? error.message : String(error)}`,
      ...(!isMissingPathError(error) ? { error } : {}),
    };
  }
  try {
    realPath = realpathSync(resolvedPath);
  } catch (error) {
    return isMissingPathError(error)
      ? { ok: false, outcome: 'invalid', reason: `location path "${path}" does not exist` }
      : {
        ok: false,
        outcome: 'unverifiable',
        reason: `location path "${path}" could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
        error,
      };
  }
  if (!isInsideBase(realBase, realPath)) {
    return { ok: false, outcome: 'invalid', reason: `location path "${path}" resolves outside the project (via symlink)` };
  }

  let stat: Stats;
  try {
    stat = lstatSync(realPath);
  } catch (error) {
    return isMissingPathError(error)
      ? { ok: false, outcome: 'invalid', reason: `location path "${path}" does not exist` }
      : {
        ok: false,
        outcome: 'unverifiable',
        reason: `location path "${path}" could not be inspected: ${error instanceof Error ? error.message : String(error)}`,
        error,
      };
  }
  if (!stat.isFile()) {
    return { ok: false, outcome: 'invalid', reason: `location path "${path}" is not a file` };
  }

  return { ok: true, realPath, stat };
}

/**
 * true if this location string asserts no location at all — either genuinely
 * empty/undefined, or the N/A marker. Shared by manager-runner.ts's
 * evidence admission gate (review-integrity protocol) so a claim that legacy-normalizes to
 * "no location" isn't held to the source_quote verbatim-evidence bar, which
 * only makes sense for claims that assert code exists at a specific site.
 */
export function isLocationClaimAbsent(location: string | undefined): boolean {
  const trimmed = location?.trim() ?? '';
  return trimmed.length === 0 || NOT_APPLICABLE_PATTERN.test(trimmed);
}

export function validateLocationAdmission(cwd: string, location: string | undefined): LocationAdmissionResult {
  // N/A は locationless、行範囲は path + 範囲として解釈する。
  const trimmed = location?.trim() ?? '';
  if (trimmed.length > 0 && NOT_APPLICABLE_PATTERN.test(trimmed)) {
    return NO_LOCATION_RESULT;
  }
  const rangeMatch = parseFindingLocationRange(trimmed);
  const parsed = rangeMatch !== undefined
    // 行範囲の実在検証は path で行う（行番号の範囲チェックはしない — Finding Contract）。
    ? { path: rangeMatch.path, line: undefined as number | undefined }
    : parseFindingLocation(location);
  if (parsed === undefined) {
    // No location to validate (e.g. an architectural finding with no single
    // site). Absence of a location is not itself a fabrication signal.
    return NO_LOCATION_RESULT;
  }

  const resolution = resolveRealPathWithinProject(cwd, parsed.path);
  if (!resolution.ok) {
    return { ok: false, outcome: resolution.outcome, reason: resolution.reason };
  }

  if (parsed.line !== undefined) {
    if (resolution.stat.size > MAX_EVIDENCE_SOURCE_FILE_BYTES) {
      return {
        ok: false,
        outcome: 'unverifiable',
        reason: evidenceFileLimitReason(parsed.path, resolution.stat.size),
      };
    }
    let content: string;
    try {
      content = readRegularFileNoFollow(resolution.realPath, resolution.stat).toString('utf-8');
    } catch (error) {
      return {
        ok: false,
        outcome: 'unverifiable',
        reason: `location path "${parsed.path}" could not be read: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const lineCount = countLines(content);
    if (parsed.line < 1 || parsed.line > lineCount) {
      return {
        ok: false,
        outcome: 'invalid',
        reason: `location line ${parsed.line} is out of range for "${parsed.path}" (file has ${lineCount} lines)`,
      };
    }
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// verbatimExcerpt 機械照合（review-integrity protocol: typed evidence protocol）
// ---------------------------------------------------------------------------

/**
 * 単一の verbatimExcerpt に許す最大行数。「極端に広い引用は不採用」とする
 * 機械的な上限 — 引用は「この claim を裏づける最小限の証拠」であるべきで、
 * ファイル丸ごとの貼り付けは証拠として機能しない。
 */
export const MAX_SOURCE_QUOTE_LINES = 200;

export type SourceQuoteVerificationOutcome =
  | { outcome: 'match'; fileHash: string }
  | { outcome: 'quote-mismatch'; reason: string }
  | { outcome: 'stale-snapshot'; reason: string }
  | { outcome: 'unverifiable'; reason: string; error?: unknown };

/**
 * verbatimExcerpt の決定的機械照合（review-integrity protocol の中核）。三分類:
 *   - match: path が project 内実在ファイルで、startLine/endLine が正順かつ
 *     実在範囲内で、verbatimExcerpt がその行範囲の全文と完全一致し、かつ
 *     snapshotId が検証時点の review scope と一致する。
 *   - quote-mismatch: 上記のいずれかが不成立（path 不在・symlink 脱出・範囲外・
 *     文字列不一致・空引用・広すぎる引用）。証拠が成立しないだけで、欠陥の
 *     真偽そのものは証明しない — 呼び出し元は reviewer anomaly（review-integrity
 *     側）へ隔離し、product gate は塞がない。
 *   - stale-snapshot: snapshotId が現在の review scope と食い違う。レビュー後に
 *     対象が変化した可能性があり、幻覚か正当な再観測かを判定できない —
 *     呼び出し元は再取得対象として隔離する（match/quote-mismatch のどちらとも
 *     確定しない）。
 * snapshot 検証を最初に行う理由: 対象が変化していれば、その後の内容比較結果
 * （一致・不一致のどちらであっても）は「今のコード」に対する判定であって
 * 「reviewer が見た時点」の真偽を証明しない — 誤って match/quote-mismatch と
 * 確定させないため、内容比較より先に判定して return する。
 */
export function verifySourceQuoteEvidence(
  cwd: string,
  evidence: SourceQuoteEvidence,
  expectedSnapshotId: string,
): SourceQuoteVerificationOutcome {
  if (evidence.snapshotId !== expectedSnapshotId) {
    return {
      outcome: 'stale-snapshot',
      reason: `evidence snapshotId "${evidence.snapshotId}" does not match the current review scope snapshot "${expectedSnapshotId}"`,
    };
  }

  if (evidence.verbatimExcerpt.trim().length === 0) {
    return { outcome: 'quote-mismatch', reason: 'verbatimExcerpt is empty' };
  }
  if (evidence.endLine < evidence.startLine) {
    return {
      outcome: 'quote-mismatch',
      reason: `startLine ${evidence.startLine} is after endLine ${evidence.endLine}`,
    };
  }
  const quotedLineSpan = evidence.endLine - evidence.startLine + 1;
  if (quotedLineSpan > MAX_SOURCE_QUOTE_LINES) {
    return {
      outcome: 'quote-mismatch',
      reason: `quoted range spans ${quotedLineSpan} lines, exceeding the ${MAX_SOURCE_QUOTE_LINES}-line limit for a single verbatim excerpt`,
    };
  }

  const resolution = resolveRealPathWithinProject(cwd, evidence.path);
  if (!resolution.ok) {
    return resolution.outcome === 'unverifiable'
      ? {
        outcome: 'unverifiable',
        reason: resolution.reason,
        ...('error' in resolution ? { error: resolution.error } : {}),
      }
      : { outcome: 'quote-mismatch', reason: resolution.reason };
  }

  if (resolution.stat.size > MAX_EVIDENCE_SOURCE_FILE_BYTES) {
    return {
      outcome: 'unverifiable',
      reason: evidenceFileLimitReason(evidence.path, resolution.stat.size),
    };
  }

  let content: string;
  try {
    content = readRegularFileNoFollow(resolution.realPath, resolution.stat).toString('utf-8');
  } catch (error) {
    return {
      outcome: 'unverifiable',
      reason: `source quote path "${evidence.path}" could not be read: ${error instanceof Error ? error.message : String(error)}`,
      ...(!isMissingPathError(error) ? { error } : {}),
    };
  }
  const lineCount = countLines(content);
  if (evidence.startLine < 1 || evidence.endLine > lineCount) {
    return {
      outcome: 'quote-mismatch',
      reason: `line range ${evidence.startLine}-${evidence.endLine} is out of range for "${evidence.path}" (file has ${lineCount} lines)`,
    };
  }

  // 完全一致のみ採用（部分行・空白緩和なし）。行全体を要求するため
  // 「部分行だけの恣意的引用」は構造的に排除される。
  const actualExcerpt = content.split('\n').slice(evidence.startLine - 1, evidence.endLine).join('\n');
  if (actualExcerpt !== evidence.verbatimExcerpt) {
    return {
      outcome: 'quote-mismatch',
      reason: `verbatimExcerpt does not exactly match "${evidence.path}" lines ${evidence.startLine}-${evidence.endLine}`,
    };
  }

  return { outcome: 'match', fileHash: createHash('sha256').update(content).digest('hex') };
}

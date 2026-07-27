/**
 * reports/ 直下の予約ファイル名。
 *
 * resume の継承 manifest（resume-artifacts.json）は reports スナップショットの
 * 内側に置かれる内部ファイルであり、workflow の成果物名前空間と衝突し得る。
 * 予約名を全境界（出力契約の Zod 検証・report-writer・{report:X} リゾルバ・
 * doctor）で拒否し、「同名レポートを持つ run を resume するとスナップショットの
 * 無条件除外で成果物が黙って消える」「内部形式へ意図せず依存する」事故を防ぐ。
 */

import { findUnicode17UnassignedCodePoint } from '../../shared/utils/unicode-17-assigned-repertoire.js';
import { unicodeDefaultCaseFoldNfc } from '../../shared/utils/unicode-default-case-fold.js';

export const RESUME_ARTIFACTS_FILE_NAME = 'resume-artifacts.json';
export const REPORT_INTERNAL_NAMESPACE = '.takt-report-internal';

export type ReportRelativePathClassification =
  | {
    readonly kind: 'public';
    readonly normalizedPath: string;
    readonly portableIdentity: string;
  }
  | {
    readonly kind: 'reserved-manifest';
    readonly normalizedPath: string;
    readonly portableIdentity: string;
  }
  | {
    readonly kind: 'internal-namespace';
    readonly normalizedPath: string;
    readonly portableIdentity: string;
  }
  | { readonly kind: 'invalid'; readonly normalizedPath: string; readonly reason: string };

/**
 * 通常reportの全境界で使うportable path分類。
 * 入力を trim/normalize して別の名前へ書き換えず、非canonical表現は拒否する。
 */
export function classifyReportRelativePath(path: string): ReportRelativePathClassification {
  if (!path.isWellFormed()) {
    return { kind: 'invalid', normalizedPath: path, reason: 'must be well-formed UTF-16' };
  }
  const unassignedCodePoint = findUnicode17UnassignedCodePoint(path);
  if (unassignedCodePoint !== undefined) {
    return {
      kind: 'invalid',
      normalizedPath: path,
      reason: `U+${unassignedCodePoint.toString(16).toUpperCase()} is outside the Unicode 17 assigned repertoire`,
    };
  }
  if (path.length === 0 || path.includes('\0')) {
    return { kind: 'invalid', normalizedPath: path, reason: 'empty or NUL-containing path' };
  }
  if (path !== path.trim()) {
    return { kind: 'invalid', normalizedPath: path, reason: 'leading or trailing whitespace' };
  }
  if (path.includes('\\')) {
    return { kind: 'invalid', normalizedPath: path, reason: 'non-canonical path separator' };
  }
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) {
    return { kind: 'invalid', normalizedPath: path, reason: 'absolute path' };
  }
  const segments = path.split('/');
  if (segments.some((segment) => segment.length === 0)) {
    return { kind: 'invalid', normalizedPath: path, reason: 'empty path segment' };
  }
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    return { kind: 'invalid', normalizedPath: path, reason: 'dot path segment' };
  }
  const portableIdentity = unicodeDefaultCaseFoldNfc(path);
  const identitySegments = portableIdentity.split('/');
  const firstSegment = identitySegments[0]!;
  const baseName = identitySegments[identitySegments.length - 1]!;
  if (firstSegment === REPORT_INTERNAL_NAMESPACE) {
    return { kind: 'internal-namespace', normalizedPath: path, portableIdentity };
  }
  if (baseName === RESUME_ARTIFACTS_FILE_NAME) {
    return { kind: 'reserved-manifest', normalizedPath: path, portableIdentity };
  }
  return { kind: 'public', normalizedPath: path, portableIdentity };
}

/** 予約名拒否の共通エラーメッセージ（境界ごとの主語を付けて使う）。 */
function reservedReportFileNameMessage(name: string): string {
  return `"${name}" is a reserved internal file name reserved for the internal resume snapshot manifest (${RESUME_ARTIFACTS_FILE_NAME}); choose a different report name`;
}

export function reportPathRejectionMessage(name: string): string {
  const classification = classifyReportRelativePath(name);
  switch (classification.kind) {
    case 'public':
      throw new Error(`Report path "${name}" is public and has no rejection message`);
    case 'reserved-manifest':
      return reservedReportFileNameMessage(name);
    case 'internal-namespace':
      return `"${name}" uses the internal report namespace "${REPORT_INTERNAL_NAMESPACE}"`;
    case 'invalid':
      return `"${name}" is not a valid report-relative path: ${classification.reason}`;
  }
}

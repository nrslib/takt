import { readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { parseFindingLocation } from './location.js';

/**
 * Deterministic, cwd-based verification that a "path:line" location string
 * points at a real file within the project and (when a line is present) a line
 * number within that file's range. This is the "raw admission validation" from
 * the Finding Contract convergence design: hallucinated locations (a reviewer
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
export interface LocationAdmissionResult {
  ok: boolean;
  reason?: string;
}

const NO_LOCATION_RESULT: LocationAdmissionResult = { ok: true };

function isInsideBase(base: string, path: string): boolean {
  const basePrefix = base.endsWith(sep) ? base : base + sep;
  return path === base || path.startsWith(basePrefix);
}

/**
 * ファイルの行数。末尾改行は「最後の行の終端」であって空行ではない
 * （"a\nb\n" は2行。split('\n') の 3 要素目は行ではない）。素朴な
 * split('\n').length は 134 行のファイルで ":135" を範囲内と誤判定していた
 * （codex 再現ブロッカー B1）。
 */
function countLines(content: string): number {
  if (content.length === 0) {
    return 0;
  }
  const segments = content.split('\n');
  return content.endsWith('\n') ? segments.length - 1 : segments.length;
}

export function validateLocationAdmission(cwd: string, location: string | undefined): LocationAdmissionResult {
  const parsed = parseFindingLocation(location);
  if (parsed === undefined) {
    // No location to validate (e.g. an architectural finding with no single
    // site). Absence of a location is not itself a fabrication signal.
    return NO_LOCATION_RESULT;
  }

  const resolvedBase = resolve(cwd);
  const resolvedPath = resolve(resolvedBase, parsed.path);
  if (!isInsideBase(resolvedBase, resolvedPath)) {
    // Raw finding text is untrusted reviewer evidence (see manager-runner.ts).
    // A path that escapes the project is treated as inadmissible rather than
    // as a thrown error, matching the rest of this validation (evidence that
    // fails a deterministic check is dropped, not a hard failure of the run).
    return { ok: false, reason: `location path "${parsed.path}" resolves outside the project` };
  }

  // 字句的な resolve() だけでは symlink 経由の脱出を検出できない（statSync が
  // リンクを追跡するため node_modules/... のようなプロジェクト外実体が受理
  // されていた — codex 再現ブロッカー B1）。実体パス（realpath）同士で包含を
  // 検証する。realpathSync は存在しないパスで throw するので存在確認も兼ねる。
  let realBase: string;
  let realPath: string;
  try {
    realBase = realpathSync(resolvedBase);
  } catch {
    return { ok: false, reason: `project root "${cwd}" cannot be resolved` };
  }
  try {
    realPath = realpathSync(resolvedPath);
  } catch {
    return { ok: false, reason: `location path "${parsed.path}" does not exist` };
  }
  if (!isInsideBase(realBase, realPath)) {
    return { ok: false, reason: `location path "${parsed.path}" resolves outside the project (via symlink)` };
  }

  let stat;
  try {
    stat = statSync(realPath);
  } catch {
    return { ok: false, reason: `location path "${parsed.path}" does not exist` };
  }
  if (!stat.isFile()) {
    return { ok: false, reason: `location path "${parsed.path}" is not a file` };
  }

  if (parsed.line !== undefined) {
    const lineCount = countLines(readFileSync(realPath, 'utf-8'));
    if (parsed.line < 1 || parsed.line > lineCount) {
      return {
        ok: false,
        reason: `location line ${parsed.line} is out of range for "${parsed.path}" (file has ${lineCount} lines)`,
      };
    }
  }

  return { ok: true };
}

/**
 * {report:X} 参照の構文解釈と実行時解決。
 *
 * 従来は reportDir との単純な文字列連結（存在チェックなし）だったため、
 * resume 境界（producer 実行後に resume を挟むと旧 run の reports/ が
 * 引き継がれない）で consumer の参照が黙って壊れ、エージェントが実在しない
 * パスを探して詰んでいた（v3-r4）。ここでは path containment / 存在 /
 * 通常ファイル（symlink 拒否）を検証し、欠落時はエージェント起動前に明確な
 * エラーを投げる。
 *
 * doctor の静的解析（{report:X} 抽出）もこの parser を共用し、静的解析と
 * 実行時の構文解釈を揃える。
 */

import { lstatSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { isReservedReportFileName, RESUME_ARTIFACTS_FILE_NAME } from '../../models/reserved-report-names.js';
import { readResumeReportSnapshotManifest } from '../run/resume-report-snapshot.js';

export const REPORT_REFERENCE_PATTERN = /\{report:([^}]+)\}/g;

/** テキストから {report:X} の参照名を抽出する（doctor と実行時で共用）。 */
export function extractReportReferences(text: string | undefined): string[] {
  if (!text) {
    return [];
  }
  return [...text.matchAll(REPORT_REFERENCE_PATTERN)]
    .map((match) => (match[1] ?? '').trim())
    .filter((name) => name.length > 0);
}

export interface ResolveReportReferenceContext {
  /** 参照しているステップ名（エラーメッセージ用） */
  readonly stepName: string;
  /**
   * run の reports ルート（engine から明示的に渡す — パス文字列からの推測は
   * しない）。workflow_call の子（`reports/subworkflows/<segment>/` の
   * 名前空間付き reportDir）に限り、親成果物への read-only フォールバック
   * 解決に使う。
   */
  readonly reportsRootDir?: string;
  /**
   * 存在検証を無効化する（`takt prompt` のプレビューなど、実 run が存在しない
   * 文脈のみ）。containment 検証は常に行う。
   */
  readonly validateExistence?: boolean;
}

/**
 * 解決結果のスコープ。`parent-run-readonly` は workflow_call の子が親 run の
 * 成果物を参照した場合で、**読み取り専用参照**である — レポートの書き込み
 * （phase 2 / writeReportFile）はこのリゾルバを通らず、常に自分の名前空間付き
 * reportDir へ書くため、親レポートが書き込み対象になることはない。
 */
export type ResolvedReportReferenceScope = 'step' | 'parent-run-readonly';

export interface ResolvedReportReference {
  readonly path: string;
  readonly scope: ResolvedReportReferenceScope;
}

/** サブワークフロー名前空間のディレクトリ名（run-paths.ts の構造と対）。 */
const SUBWORKFLOWS_NAMESPACE_DIR = 'subworkflows';

/** reportDir の絶対パスから run slug を導出する（エラーメッセージ用のみ）。 */
function deriveRunInfoFromReportDir(reportDir: string): { cwd: string; runSlug: string } | undefined {
  const marker = `${sep}.takt${sep}runs${sep}`;
  const markerIndex = reportDir.lastIndexOf(marker);
  if (markerIndex < 0) {
    return undefined;
  }
  const cwd = reportDir.slice(0, markerIndex);
  const remainder = reportDir.slice(markerIndex + marker.length);
  const runSlug = remainder.split(sep)[0];
  if (!runSlug) {
    return undefined;
  }
  return { cwd, runSlug };
}

function buildMissingReportError(
  reference: string,
  reportDir: string,
  context: ResolveReportReferenceContext,
): Error {
  const runInfo = deriveRunInfoFromReportDir(reportDir);
  const runLabel = runInfo ? `run "${runInfo.runSlug}"` : `report directory "${reportDir}"`;
  let resumeNote = '';
  if (runInfo) {
    const manifest = readResumeReportSnapshotManifest(runInfo.cwd, runInfo.runSlug);
    if (manifest) {
      resumeNote = ` Resumed from "${manifest.sourceRunSlug}", but the source report snapshot does not contain it.`;
    }
  }
  return new Error(
    `Report reference "${reference}" is unavailable for step "${context.stepName}" in ${runLabel}.${resumeNote}`
    + ' The referenced report has not been produced in this run;'
    + ' check that a step producing it runs before this step (takt workflow doctor can diagnose this).',
  );
}

/**
 * 実在する通常ファイルかどうか。symlink は lstat で **リンク自体を拒否**する
 * （statSync はリンク先を追うため、reportDir 外を指す symlink の参照を
 * 受理してしまう — codex 指摘）。
 */
function checkRegularFile(pathAbs: string, reference: string, stepName: string): boolean {
  let stat;
  try {
    stat = lstatSync(pathAbs);
  } catch {
    return false;
  }
  if (stat.isSymbolicLink()) {
    throw new Error(
      `Report reference "${reference}" for step "${stepName}" resolves to a symlink; refusing to follow it`,
    );
  }
  return stat.isFile();
}

function assertContained(reportDir: string, reference: string, stepName: string): string {
  const baseAbs = resolve(reportDir);
  const targetAbs = resolve(reportDir, reference);
  const basePrefix = baseAbs.endsWith(sep) ? baseAbs : baseAbs + sep;
  if (!targetAbs.startsWith(basePrefix)) {
    throw new Error(
      `Report reference "${reference}" escapes the report directory for step "${stepName}"`,
    );
  }
  return targetAbs;
}

/**
 * reportDir が reportsRootDir の `subworkflows/` 名前空間配下かどうか。
 * workflow_call の子だけが親成果物フォールバックの対象（任意のネスト
 * reportDir へ適用しない — codex 指摘）。
 */
function isSubworkflowNamespaceDir(reportDir: string, reportsRootDir: string): boolean {
  const rootAbs = resolve(reportsRootDir);
  const dirAbs = resolve(reportDir);
  const namespacePrefix = `${rootAbs}${sep}${SUBWORKFLOWS_NAMESPACE_DIR}${sep}`;
  return dirAbs.startsWith(namespacePrefix);
}

/**
 * {report:X} を実パスへ解決する。containment / 存在 / 通常ファイル
 * （symlink 拒否）を検証し、問題があればエージェント起動前に throw する。
 * `path` は従来と同じ `${dir}/${reference}` 形式（プロンプト本文の互換性維持）。
 *
 * workflow_call の子（subworkflows 名前空間）で見つからない場合のみ、
 * `context.reportsRootDir`（engine から明示的に渡された run の reports ルート）
 * へフォールバックする。その場合 `scope` は `parent-run-readonly` — 親成果物の
 * 読み取り専用参照であり、書き込みは常に自分の reportDir に対して行われる。
 */
export function resolveReportReferenceDetailed(
  reportDir: string,
  reference: string,
  context: ResolveReportReferenceContext,
): ResolvedReportReference {
  // 内部予約名（resume スナップショット manifest）を通常レポートとして
  // 解決させない — 内部形式への意図しない依存を明示エラーで拒否する。
  if (isReservedReportFileName(reference)) {
    throw new Error(
      `Report reference "${reference}" for step "${context.stepName}" refers to a reserved internal file `
      + `(${RESUME_ARTIFACTS_FILE_NAME} holds the resume snapshot manifest) and cannot be used as a report`,
    );
  }
  const targetAbs = assertContained(reportDir, reference, context.stepName);
  if (context.validateExistence === false) {
    return { path: `${reportDir}/${reference}`, scope: 'step' };
  }
  if (checkRegularFile(targetAbs, reference, context.stepName)) {
    return { path: `${reportDir}/${reference}`, scope: 'step' };
  }
  const reportsRoot = context.reportsRootDir;
  if (reportsRoot !== undefined && isSubworkflowNamespaceDir(reportDir, reportsRoot)) {
    const rootTargetAbs = assertContained(reportsRoot, reference, context.stepName);
    if (checkRegularFile(rootTargetAbs, reference, context.stepName)) {
      return { path: `${reportsRoot}/${reference}`, scope: 'parent-run-readonly' };
    }
  }
  throw buildMissingReportError(reference, reportDir, context);
}

export function resolveReportReference(
  reportDir: string,
  reference: string,
  context: ResolveReportReferenceContext,
): string {
  return resolveReportReferenceDetailed(reportDir, reference, context).path;
}

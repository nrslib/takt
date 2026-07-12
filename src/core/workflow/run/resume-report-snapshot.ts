/**
 * Resume 時の run artifact（reports/）継承 — manifest 付きスナップショット。
 *
 * resume は新しい run slug/dir を作るが、{report:X} は現 run の reportDir への
 * 単純パス置換のため、abort 前に旧 run が生成したレポートを引き継がないと
 * producer 実行後の resume で consumer の参照が必ず壊れる（v3-r4 の resume
 * 境界バグ）。ここでは旧 run の reports/ 全体（バージョン付き履歴を含む）を
 * 新 run の reports/ として原子的に継承する。
 *
 * codex 裁定のポイント:
 * - 選択コピーはしない。静的解析では workflow_call / loop judge / 動的 facet の
 *   参照を把握しきれないため、常に全体をコピーする。
 * - 祖先探索・fallback はしない。常に source_run_slug の直接の親のみ。
 * - symlink・run 外 path・非通常ファイルは拒否。target reports/ が既に非空なら
 *   fail-fast。失敗時は一時成果物を除去し、半端な reports/ を公開しない。
 * - ファイル一覧と hash の SSOT は manifest（resume-artifacts.json）。meta.json
 *   からは参照のみ。
 * - **公開は単一 rename に集約する（codex 2巡目裁定）**: manifest は staged
 *   reports の内側（reports/resume-artifacts.json、予約名）に置き、一時領域で
 *   全部完成させてから reports の rename 1回だけで公開する。ロールバックという
 *   概念が存在しないため、並行 resume の勝者破壊もロールバック失敗による
 *   中途半端な状態も原理的に起きない。予約名は次回 resume のコピーから除外する
 *   （継承 manifest は新 manifest に置き換わる）。
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { isValidReportDirName } from '../../../shared/utils/index.js';
import { buildRunPaths } from './run-paths.js';

// reports/ 直下の予約名（単一情報源は core/models/reserved-report-names.ts）。
// 継承 manifest はスナップショットの一部として reports 内に置かれ、次回 resume
// のスナップショットコピーからは除外される。予約名は出力契約 / report-writer /
// {report:X} リゾルバ / doctor の全境界で拒否されるため、正当な同名レポートは
// 存在し得ない（除外の無条件性と整合する）。
export { RESUME_ARTIFACTS_FILE_NAME } from '../../models/reserved-report-names.js';
import { RESUME_ARTIFACTS_FILE_NAME } from '../../models/reserved-report-names.js';

export interface ResumeReportSnapshotFileEntry {
  /** reports/ からの相対パス（POSIX 区切り） */
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

export interface ResumeReportSnapshotManifest {
  readonly version: 1;
  readonly sourceRunSlug: string;
  readonly targetRunSlug: string;
  readonly createdAt: string;
  readonly files: readonly ResumeReportSnapshotFileEntry[];
}

export interface InheritResumeReportSnapshotOptions {
  /** .takt/runs が存在するディレクトリ（実行 cwd） */
  readonly cwd: string;
  readonly sourceRunSlug: string;
  readonly targetRunSlug: string;
}

function toPosixRelative(relativePath: string): string {
  return relativePath.split(sep).join('/');
}

function assertInside(baseAbs: string, candidateAbs: string, label: string): void {
  const prefix = baseAbs.endsWith(sep) ? baseAbs : baseAbs + sep;
  if (candidateAbs !== baseAbs && !candidateAbs.startsWith(prefix)) {
    throw new Error(`Resume report snapshot: ${label} escapes its run directory: ${candidateAbs}`);
  }
}

interface CopyResult {
  readonly files: ResumeReportSnapshotFileEntry[];
}

/**
 * source reports/ を stagingDir へ再帰コピーしつつ manifest エントリを作る。
 * symlink・非通常ファイル（fifo 等）は拒否して即座に throw する。
 */
function copyReportsTree(
  sourceRootAbs: string,
  stagingRootAbs: string,
  relativeDir: string,
): CopyResult {
  const files: ResumeReportSnapshotFileEntry[] = [];
  const sourceDirAbs = relativeDir === '' ? sourceRootAbs : join(sourceRootAbs, relativeDir);
  for (const entryName of readdirSync(sourceDirAbs)) {
    // 予約名（前回 resume の継承 manifest）はコピーしない — この継承で
    // 生成する新しい manifest が同名で staged reports に入る。
    if (relativeDir === '' && entryName === RESUME_ARTIFACTS_FILE_NAME) {
      continue;
    }
    const entryRel = relativeDir === '' ? entryName : join(relativeDir, entryName);
    const entryAbs = resolve(sourceRootAbs, entryRel);
    assertInside(sourceRootAbs, entryAbs, `source entry "${toPosixRelative(entryRel)}"`);
    const stat = lstatSync(entryAbs);
    if (stat.isSymbolicLink()) {
      throw new Error(
        `Resume report snapshot: refusing to copy symlink "${toPosixRelative(entryRel)}" from source run reports`,
      );
    }
    if (stat.isDirectory()) {
      mkdirSync(join(stagingRootAbs, entryRel), { recursive: true });
      files.push(...copyReportsTree(sourceRootAbs, stagingRootAbs, entryRel).files);
      continue;
    }
    if (!stat.isFile()) {
      throw new Error(
        `Resume report snapshot: refusing to copy non-regular file "${toPosixRelative(entryRel)}" from source run reports`,
      );
    }
    const content = readFileSync(entryAbs);
    const stagingAbs = resolve(stagingRootAbs, entryRel);
    assertInside(stagingRootAbs, stagingAbs, `staged entry "${toPosixRelative(entryRel)}"`);
    mkdirSync(dirname(stagingAbs), { recursive: true });
    writeFileSync(stagingAbs, content);
    files.push({
      path: toPosixRelative(entryRel),
      size: content.length,
      sha256: createHash('sha256').update(content).digest('hex'),
    });
  }
  return { files };
}

function isEmptyDir(dirAbs: string): boolean {
  return readdirSync(dirAbs).length === 0;
}

export function resumeArtifactsPath(cwd: string, runSlug: string): string {
  return join(buildRunPaths(cwd, runSlug).reportsRootAbs, RESUME_ARTIFACTS_FILE_NAME);
}

export function readResumeReportSnapshotManifest(
  cwd: string,
  runSlug: string,
): ResumeReportSnapshotManifest | undefined {
  if (!isValidReportDirName(runSlug)) {
    return undefined;
  }
  const manifestAbs = resumeArtifactsPath(cwd, runSlug);
  if (!existsSync(manifestAbs)) {
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(manifestAbs, 'utf-8')) as ResumeReportSnapshotManifest;
  } catch {
    return undefined;
  }
}

/**
 * source run の reports/ を target run の reports/ として継承する。
 *
 * 手順: 検証 → 一時ディレクトリへ再帰コピー + manifest を一時領域の**内側**に
 * 生成（reports/resume-artifacts.json、予約名）→ reports の rename **1回だけ**で
 * 公開。公開操作が単一 rename に集約されているため、ロールバックという概念が
 * 存在しない: rename 失敗（並行敗者の宛先既存を含む）時は staging を掃除する
 * だけで、公開済み状態に触る操作が一切ない。掃除自体が失敗しても公開物は
 * 不変のまま。
 */
export function inheritResumeReportSnapshot(
  options: InheritResumeReportSnapshotOptions,
): ResumeReportSnapshotManifest {
  const { cwd, sourceRunSlug, targetRunSlug } = options;
  if (!isValidReportDirName(sourceRunSlug)) {
    throw new Error(`Resume report snapshot: invalid source run slug: ${sourceRunSlug}`);
  }
  if (!isValidReportDirName(targetRunSlug)) {
    throw new Error(`Resume report snapshot: invalid target run slug: ${targetRunSlug}`);
  }
  if (sourceRunSlug === targetRunSlug) {
    throw new Error(`Resume report snapshot: source and target run slugs are identical: ${sourceRunSlug}`);
  }

  const sourcePaths = buildRunPaths(cwd, sourceRunSlug);
  const targetPaths = buildRunPaths(cwd, targetRunSlug);
  if (!existsSync(sourcePaths.runRootAbs)) {
    throw new Error(
      `Resume report snapshot: source run "${sourceRunSlug}" does not exist at ${sourcePaths.runRootAbs}`,
    );
  }
  if (existsSync(targetPaths.reportsAbs) && !isEmptyDir(targetPaths.reportsAbs)) {
    throw new Error(
      `Resume report snapshot: target run "${targetRunSlug}" already has a non-empty reports directory; `
      + 'refusing to overwrite it with the inherited snapshot',
    );
  }

  // source の reports/ パス自体が symlink の場合、外部ディレクトリを丸ごと
  // コピーしてしまう（codex 指摘）。中身の走査前にパス自体を lstat で拒否する。
  const sourceReportsStat = lstatOrUndefined(sourcePaths.reportsAbs);
  if (sourceReportsStat?.isSymbolicLink()) {
    throw new Error(
      `Resume report snapshot: source run "${sourceRunSlug}" reports path is a symlink; refusing to copy it`,
    );
  }
  if (sourceReportsStat !== undefined && !sourceReportsStat.isDirectory()) {
    throw new Error(
      `Resume report snapshot: source run "${sourceRunSlug}" reports path is not a directory`,
    );
  }

  mkdirSync(targetPaths.runRootAbs, { recursive: true });
  const uniqueSuffix = `${process.pid}-${Date.now().toString(36)}`;
  const stagingRootAbs = join(targetPaths.runRootAbs, `.reports-inherit-tmp-${uniqueSuffix}`);
  // 公開は単一 rename に集約する（codex 2巡目裁定）。一時領域で reports コピーと
  // manifest（staged reports の内側の予約名）の両方を完成させてから rename する。
  // 失敗経路は staging の掃除のみで、公開済み状態に触る操作は存在しない —
  // 並行 resume の勝者破壊も、ロールバック失敗による中途半端な状態も
  // 原理的に起きない。
  let completed = false;
  try {
    mkdirSync(stagingRootAbs, { recursive: true });
    const { files } = sourceReportsStat !== undefined
      ? copyReportsTree(sourcePaths.reportsAbs, stagingRootAbs, '')
      : { files: [] as ResumeReportSnapshotFileEntry[] };

    const manifest: ResumeReportSnapshotManifest = {
      version: 1,
      sourceRunSlug,
      targetRunSlug,
      createdAt: new Date().toISOString(),
      files: [...files].sort((a, b) => a.path.localeCompare(b.path)),
    };
    // manifest は staged reports の内側（予約名）— 空 source でも staged
    // reports は manifest 1ファイルを含むため、「空ディレクトリの公開」という
    // 窓自体が消える。
    writeFileSync(join(stagingRootAbs, RESUME_ARTIFACTS_FILE_NAME), JSON.stringify(manifest, null, 2));

    // 空の reports/ が既にあれば除去してから rename する。並行 resume が先に
    // 除去していた場合（ENOENT）は続行してよい — 公開は直後の rename が原子的に
    // 決着し、敗者は rename の失敗（宛先既存）で落ちて staging を掃除するだけ。
    if (existsSync(targetPaths.reportsAbs)) {
      try {
        rmdirSync(targetPaths.reportsAbs);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
    }
    renameSync(stagingRootAbs, targetPaths.reportsAbs);
    completed = true;
    return manifest;
  } finally {
    if (!completed) {
      rmSync(stagingRootAbs, { recursive: true, force: true });
    }
  }
}

function lstatOrUndefined(pathAbs: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(pathAbs);
  } catch {
    return undefined;
  }
}

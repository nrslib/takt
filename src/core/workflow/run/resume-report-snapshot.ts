/**
 * Resume 時の run artifact（reports/）継承 — manifest 付きスナップショット。
 *
 * resume は新しい run slug/dir を作るが、{report:X} は現 run の reportDir への
 * 単純パス置換のため、abort 前に旧 run が生成したレポートを引き継がないと
 * producer 実行後の resume で consumer の参照が必ず壊れる（v3-r4 の resume
 * 境界バグ）。ここでは旧 run の reports/ 全体（バージョン付き履歴を含む）を
 * 新 run の reports/ として原子的に継承する。
 *
 * Finding Contractのポイント:
 * - 選択コピーはしない。静的解析では workflow_call / loop judge / 動的 facet の
 *   参照を把握しきれないため、常に全体をコピーする。
 * - 祖先探索・fallback はしない。常に source_run_slug の直接の親のみ。
 * - symlink・run 外 path・非通常ファイルは拒否。target reports/ が既に非空なら
 *   fail-fast。失敗時は一時成果物を除去し、半端な reports/ を公開しない。
 * - ファイル一覧と hash の SSOT は manifest（resume-artifacts.json）。meta.json
 *   からは参照のみ。
 * - **公開は単一 rename に集約する（atomic publication requirement）**: manifest は staged
 *   reports の内側（reports/resume-artifacts.json、予約名）に置き、一時領域で
 *   全部完成させてから reports の rename 1回だけで公開する。ロールバックという
 *   概念が存在しないため、並行 resume の勝者破壊もロールバック失敗による
 *   中途半端な状態も原理的に起きない。予約名は次回 resume のコピーから除外する
 *   （継承 manifest は新 manifest に置き換わる）。
 */

import { createHash } from 'node:crypto';
import {
  lstatSync,
  readdirSync,
  type Stats,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { getErrorMessage, isValidReportDirName } from '../../../shared/utils/index.js';
import {
  assertPrivateDirectoryReadSnapshot,
  capturePrivateDirectoryReadSnapshot,
  readRegularFileNoFollow,
  ensurePrivateDirectory,
  publishPrivateDirectory,
  removePrivateDirectory,
  writePrivateFileWithMode,
  type PrivateDirectoryReadSnapshot,
} from '../../../shared/utils/private-file.js';
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

export class ResumeReportSnapshotSourceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ResumeReportSnapshotSourceError';
  }
}

const MANIFEST_KEYS = new Set(['version', 'sourceRunSlug', 'targetRunSlug', 'createdAt', 'files']);
const MANIFEST_FILE_KEYS = new Set(['path', 'size', 'sha256']);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function assertManifestMetadata(
  sourceRunSlug: string,
  targetRunSlug: string,
  createdAt: string,
): void {
  if (sourceRunSlug === targetRunSlug) {
    throw new Error('Resume report snapshot: manifest sourceRunSlug and targetRunSlug must differ');
  }
  const timestamp = new Date(createdAt);
  if (Number.isNaN(timestamp.getTime()) || timestamp.toISOString() !== createdAt) {
    throw new Error('Resume report snapshot: manifest createdAt must be a canonical ISO timestamp');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isValidManifestPath(value: string): boolean {
  if (value.length === 0 || value.includes('\\') || value.startsWith('/')) {
    return false;
  }
  const segments = value.split('/');
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

function parseResumeReportSnapshotManifest(value: unknown, targetRunSlug: string): ResumeReportSnapshotManifest {
  if (!isRecord(value) || !hasOnlyKeys(value, MANIFEST_KEYS)) {
    throw new Error('Resume report snapshot: manifest must be an object with only the documented fields');
  }
  if (value.version !== 1) {
    throw new Error('Resume report snapshot: manifest version must be 1');
  }
  if (typeof value.sourceRunSlug !== 'string' || !isValidReportDirName(value.sourceRunSlug)) {
    throw new Error('Resume report snapshot: manifest sourceRunSlug is invalid');
  }
  if (value.targetRunSlug !== targetRunSlug) {
    throw new Error(`Resume report snapshot: manifest targetRunSlug must match "${targetRunSlug}"`);
  }
  if (typeof value.createdAt !== 'string') {
    throw new Error('Resume report snapshot: manifest createdAt must be a canonical ISO timestamp');
  }
  assertManifestMetadata(value.sourceRunSlug, targetRunSlug, value.createdAt);
  if (!Array.isArray(value.files)) {
    throw new Error('Resume report snapshot: manifest files must be an array');
  }
  const seenPaths = new Set<string>();
  const files = value.files.map((entry, index): ResumeReportSnapshotFileEntry => {
    if (!isRecord(entry) || !hasOnlyKeys(entry, MANIFEST_FILE_KEYS)) {
      throw new Error(`Resume report snapshot: manifest files[${index}] has an invalid shape`);
    }
    if (typeof entry.path !== 'string' || !isValidManifestPath(entry.path)) {
      throw new Error(`Resume report snapshot: manifest files[${index}].path is invalid`);
    }
    if (entry.path === RESUME_ARTIFACTS_FILE_NAME || seenPaths.has(entry.path)) {
      throw new Error(`Resume report snapshot: manifest contains a reserved or duplicate path "${entry.path}"`);
    }
    if (typeof entry.size !== 'number' || !Number.isSafeInteger(entry.size) || entry.size < 0) {
      throw new Error(`Resume report snapshot: manifest files[${index}].size is invalid`);
    }
    if (typeof entry.sha256 !== 'string' || !SHA256_PATTERN.test(entry.sha256)) {
      throw new Error(`Resume report snapshot: manifest files[${index}].sha256 is invalid`);
    }
    seenPaths.add(entry.path);
    return { path: entry.path, size: entry.size, sha256: entry.sha256 };
  });
  return {
    version: 1,
    sourceRunSlug: value.sourceRunSlug,
    targetRunSlug,
    createdAt: value.createdAt,
    files,
  };
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

function assertDirectoryChain(trustedRootAbs: string, targetDirAbs: string, label: string): void {
  const trustedRoot = resolve(trustedRootAbs);
  const targetDir = resolve(targetDirAbs);
  assertInside(trustedRoot, targetDir, label);
  let current = trustedRoot;
  for (const component of relative(trustedRoot, targetDir).split(sep).filter(Boolean)) {
    current = join(current, component);
    const stat = lstatOrUndefined(current);
    if (stat === undefined) {
      return;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`Resume report snapshot: ${label} contains a symlink: ${current}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`Resume report snapshot: ${label} contains a non-directory path: ${current}`);
    }
  }
}

function createDirectoryChain(trustedRootAbs: string, targetDirAbs: string, label: string): void {
  const trustedRoot = resolve(trustedRootAbs);
  const targetDir = resolve(targetDirAbs);
  assertInside(trustedRoot, targetDir, label);
  let current = trustedRoot;
  for (const component of relative(trustedRoot, targetDir).split(sep).filter(Boolean)) {
    current = join(current, component);
    if (lstatOrUndefined(current) === undefined) {
      ensurePrivateDirectory(current);
    }
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new Error(`Resume report snapshot: ${label} contains a symlink: ${current}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`Resume report snapshot: ${label} contains a non-directory path: ${current}`);
    }
  }
}

interface CopyResult {
  readonly files: ResumeReportSnapshotFileEntry[];
}

const PRIVATE_FILE_MODE = 0o600;

function inspectSnapshotSource<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof ResumeReportSnapshotSourceError) {
      throw error;
    }
    throw new ResumeReportSnapshotSourceError(
      `Resume report snapshot: source unavailable: ${getErrorMessage(error)}`,
      { cause: error },
    );
  }
}

/**
 * source reports/ を stagingDir へ再帰コピーしつつ manifest エントリを作る。
 * symlink・非通常ファイル（fifo 等）は拒否して即座に throw する。
 */
function copyReportsTree(
  sourceRootSnapshot: PrivateDirectoryReadSnapshot,
  stagingRootAbs: string,
  relativeDir: string,
): CopyResult {
  const files: ResumeReportSnapshotFileEntry[] = [];
  const sourceRootAbs = sourceRootSnapshot.path;
  const sourceDirAbs = relativeDir === '' ? sourceRootAbs : join(sourceRootAbs, relativeDir);
  const directorySnapshot = relativeDir === ''
    ? sourceRootSnapshot
    : inspectSnapshotSource(() => capturePrivateDirectoryReadSnapshot(sourceDirAbs));
  inspectSnapshotSource(() => assertPrivateDirectoryReadSnapshot(directorySnapshot));
  const entryNames = inspectSnapshotSource(() => readdirSync(sourceDirAbs));
  inspectSnapshotSource(() => assertPrivateDirectoryReadSnapshot(directorySnapshot));
  for (const entryName of entryNames) {
    // 予約名（前回 resume の継承 manifest）はコピーしない — この継承で
    // 生成する新しい manifest が同名で staged reports に入る。
    if (relativeDir === '' && entryName === RESUME_ARTIFACTS_FILE_NAME) {
      continue;
    }
    const entryRel = relativeDir === '' ? entryName : join(relativeDir, entryName);
    const entryAbs = resolve(sourceRootAbs, entryRel);
    assertInside(sourceRootAbs, entryAbs, `source entry "${toPosixRelative(entryRel)}"`);
    const stat = inspectSnapshotSource(() => lstatSync(entryAbs));
    if (stat.isSymbolicLink()) {
      throw new ResumeReportSnapshotSourceError(
        `Resume report snapshot: refusing to copy symlink "${toPosixRelative(entryRel)}" from source run reports`,
      );
    }
    if (stat.isDirectory()) {
      const stagingDirectory = join(stagingRootAbs, entryRel);
      ensurePrivateDirectory(stagingDirectory);
      files.push(...copyReportsTree(sourceRootSnapshot, stagingRootAbs, entryRel).files);
      continue;
    }
    if (!stat.isFile()) {
      throw new ResumeReportSnapshotSourceError(
        `Resume report snapshot: refusing to copy non-regular file "${toPosixRelative(entryRel)}" from source run reports`,
      );
    }
    const content = inspectSnapshotSource(() => readRegularFileNoFollow(entryAbs, stat));
    const stagingAbs = resolve(stagingRootAbs, entryRel);
    assertInside(stagingRootAbs, stagingAbs, `staged entry "${toPosixRelative(entryRel)}"`);
    const stagingDirectory = dirname(stagingAbs);
    ensurePrivateDirectory(stagingDirectory);
    const inheritedMode = stat.mode & PRIVATE_FILE_MODE;
    writePrivateFileWithMode(stagingAbs, content, inheritedMode);
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
  const manifestStat = lstatOrUndefined(manifestAbs);
  if (manifestStat === undefined) {
    return undefined;
  }
  if (!manifestStat.isFile()) {
    throw new Error(`Resume report snapshot: manifest is not a regular file: ${manifestAbs}`);
  }
  const parsed: unknown = JSON.parse(readRegularFileNoFollow(manifestAbs, manifestStat).toString('utf-8'));
  return parseResumeReportSnapshotManifest(parsed, runSlug);
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
  if (!isValidReportDirName(targetRunSlug)) {
    throw new Error(`Resume report snapshot: invalid target run slug: ${targetRunSlug}`);
  }

  const targetPaths = buildRunPaths(cwd, targetRunSlug);
  assertDirectoryChain(cwd, targetPaths.runRootAbs, 'target run path');
  const targetReportsStat = lstatOrUndefined(targetPaths.reportsAbs);
  if (targetReportsStat !== undefined && !targetReportsStat.isDirectory()) {
    throw new Error(`Resume report snapshot: target run "${targetRunSlug}" reports path is not a directory`);
  }
  if (targetReportsStat !== undefined && !isEmptyDir(targetPaths.reportsAbs)) {
    throw new Error(
      `Resume report snapshot: target run "${targetRunSlug}" already has a non-empty reports directory; `
      + 'refusing to overwrite it with the inherited snapshot',
    );
  }
  if (!isValidReportDirName(sourceRunSlug)) {
    throw new ResumeReportSnapshotSourceError(`Resume report snapshot: invalid source run slug: ${sourceRunSlug}`);
  }
  if (sourceRunSlug === targetRunSlug) {
    throw new Error(`Resume report snapshot: source and target run slugs are identical: ${sourceRunSlug}`);
  }

  const sourcePaths = buildRunPaths(cwd, sourceRunSlug);
  const sourceRunStat = inspectSnapshotSource(() => lstatOrUndefined(sourcePaths.runRootAbs));
  if (sourceRunStat === undefined) {
    throw new ResumeReportSnapshotSourceError(
      `Resume report snapshot: source run "${sourceRunSlug}" does not exist at ${sourcePaths.runRootAbs}`,
    );
  }
  if (!sourceRunStat.isDirectory()) {
    throw new ResumeReportSnapshotSourceError(
      `Resume report snapshot: source run "${sourceRunSlug}" is not a directory`,
    );
  }
  // source の reports/ パス自体が symlink の場合、外部ディレクトリを丸ごと
  // コピーしてしまう（boundary requirement）。中身の走査前にパス自体を lstat で拒否する。
  const sourceReportsStat = inspectSnapshotSource(() => lstatOrUndefined(sourcePaths.reportsAbs));
  if (sourceReportsStat?.isSymbolicLink()) {
    throw new ResumeReportSnapshotSourceError(
      `Resume report snapshot: source run "${sourceRunSlug}" reports path is a symlink; refusing to copy it`,
    );
  }
  if (sourceReportsStat !== undefined && !sourceReportsStat.isDirectory()) {
    throw new ResumeReportSnapshotSourceError(
      `Resume report snapshot: source run "${sourceRunSlug}" reports path is not a directory`,
    );
  }
  const sourceReportsSnapshot = sourceReportsStat === undefined
    ? undefined
    : inspectSnapshotSource(() => capturePrivateDirectoryReadSnapshot(sourcePaths.reportsAbs));

  createDirectoryChain(cwd, targetPaths.runRootAbs, 'target run path');
  assertDirectoryChain(cwd, targetPaths.runRootAbs, 'target run path');
  const uniqueSuffix = `${process.pid}-${Date.now().toString(36)}`;
  const stagingRootAbs = join(targetPaths.runRootAbs, `.reports-inherit-tmp-${uniqueSuffix}`);
  const targetRunStat = lstatSync(targetPaths.runRootAbs) as Stats;
  // 公開は単一 rename に集約する（atomic publication requirement）。一時領域で reports コピーと
  // manifest（staged reports の内側の予約名）の両方を完成させてから rename する。
  // 失敗経路は staging の掃除のみで、公開済み状態に触る操作は存在しない —
  // 並行 resume の勝者破壊も、ロールバック失敗による中途半端な状態も
  // 原理的に起きない。
  let completed = false;
  try {
    ensurePrivateDirectory(stagingRootAbs);
    const { files } = sourceReportsSnapshot !== undefined
      ? copyReportsTree(sourceReportsSnapshot, stagingRootAbs, '')
      : { files: [] as ResumeReportSnapshotFileEntry[] };

    const createdAt = new Date().toISOString();
    assertManifestMetadata(sourceRunSlug, targetRunSlug, createdAt);
    const manifest: ResumeReportSnapshotManifest = {
      version: 1,
      sourceRunSlug,
      targetRunSlug,
      createdAt,
      files: [...files].sort((a, b) => a.path.localeCompare(b.path)),
    };
    // manifest は staged reports の内側（予約名）— 空 source でも staged
    // reports は manifest 1ファイルを含むため、「空ディレクトリの公開」という
    // 窓自体が消える。
    const manifestPath = join(stagingRootAbs, RESUME_ARTIFACTS_FILE_NAME);
    writePrivateFileWithMode(manifestPath, JSON.stringify(manifest, null, 2), PRIVATE_FILE_MODE);

    const stagingStat = lstatSync(stagingRootAbs) as Stats;
    publishPrivateDirectory(
      targetPaths.runRootAbs,
      stagingRootAbs,
      targetPaths.reportsAbs,
      targetRunStat,
      stagingStat,
      targetReportsStat,
    );
    completed = true;
    return manifest;
  } finally {
    if (!completed) {
      const stagingStat = lstatOrUndefined(stagingRootAbs);
      if (stagingStat !== undefined) {
        removePrivateDirectory(targetPaths.runRootAbs, stagingRootAbs, targetRunStat, stagingStat);
      }
    }
  }
}

function lstatOrUndefined(pathAbs: string): Stats | undefined {
  try {
    return lstatSync(pathAbs) as Stats;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

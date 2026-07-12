import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import type { FindingLedger, RawFinding } from './types.js';
import { parseFindingLedger, parseRawFindings } from './schemas.js';
import { assertLedgerIdAllocationInvariant } from './ledger-validation.js';
import { writeReportFile } from '../report-writer.js';

interface FindingLedgerStoreOptions {
  projectCwd: string;
  reportDir: string;
  workflowName: string;
  ledgerPath: string;
  rawFindingsPath: string;
}

const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const READ_ONLY_PRIVATE_FILE_MODE = 0o400;

export interface FindingLedgerStore {
  /**
   * この store が束縛する台帳の正準ワークフロー名。workflow_call の子が親から
   * store を継承した場合も親の名前のまま変わらない。ledger.json の
   * workflowName スタンプ（reconcile 時）はこの値と一致させる必要がある。
   * 一致しないと assertLedgerWorkflowName が次回の save/load で例外を投げる。
   */
  workflowName: string;
  loadLedger: () => FindingLedger;
  saveLedger: (ledger: FindingLedger) => void;
  /**
   * 「読み込み → 更新関数 → 保存」を排他区間で行う。workflow_call の並列子
   * エンジンが同じ store インスタンス（親から継承した台帳）を共有する場合、
   * 各子が「最初に読んだ台帳」を基準に非同期処理後に保存すると後勝ちで
   * 一方の更新が消える（lost update）。呼び出し元は非同期処理（LLM 呼び出し等）
   * を済ませたあとにこの API を呼び、mutator には同期処理だけを渡すこと
   * （mutator の中で await すると、直列化の意味がなくなる）。
   * 同一プロセス内の Promise チェーンによる直列化であり、複数プロセスからの
   * 同時更新はこの直列化の対象外（現状の設計外）。
   */
  updateLedger: (mutator: (current: FindingLedger) => FindingLedger) => Promise<FindingLedger>;
  createRunCopy: () => string;
  saveRawFindings: (runId: string, stepName: string, rawFindings: RawFinding[]) => string;
  saveManagerValidationReport: (report: FindingManagerValidationReport) => string;
  /** Audit trail for the finding-conflict-adjudication synthetic step: discarded decisions (evidence changed between prompt and apply) and other non-applied outcomes. */
  saveConflictAdjudicationReport: (report: FindingConflictAdjudicationAuditReport) => string;
  /** Audit trail for a NEEDS_ADJUDICATION stop (対策バッチ B1): the open provisional findings that reached a cross-round fixpoint and their origin. */
  saveNeedsAdjudicationReport: (report: NeedsAdjudicationReport) => string;
}

/**
 * Written when the workflow stops at NEEDS_ADJUDICATION (対策バッチ B1: a
 * cross-round provisional fixpoint). Durable, machine-readable record of
 * "why it stopped" alongside the human-readable abort reason string — see
 * WorkflowEngine's recordNeedsAdjudication.
 */
export interface NeedsAdjudicationReport {
  version: 1;
  runId: string;
  /** Step whose rule transition matched NEEDS_ADJUDICATION (e.g. "reviewers", "final-gate"). */
  stepName: string;
  reachedAt: string;
  provisionalFindings: Array<{
    findingId: string;
    kind: string;
    stableKey: string;
    reason: string;
    reviewers: string[];
    sourceRawFindingIds: string[];
  }>;
}

/**
 * Written when an adjudication decision could NOT be applied (codex B2: the
 * evidence hash at apply time differed from the hash the LLM was prompted
 * with, or the conflict stopped being active mid-flight). The started attempt
 * stays recorded on the conflict; this report preserves WHY nothing was
 * applied and what the discarded decision was.
 */
export interface FindingConflictAdjudicationAuditReport {
  version: 1;
  runId: string;
  conflictId: string;
  discarded: true;
  reason: string;
  promptEvidenceHash: string;
  freshEvidenceHash?: string;
  output: unknown;
}

export interface FindingManagerValidationAttemptReport {
  attempt: number;
  managerOutput: unknown;
  validationErrors: string[];
}

/** Raw finding rejected before ever reaching mechanical classification / the manager: its location failed a deterministic admission check (path does not exist / line out of range). Audit trail for hallucinated-location raws (see admission-validation.ts). */
export interface RawAdmissionRejectionReport {
  rawFindingId: string;
  location: string;
  reason: string;
}

/** Raw finding decided 'unsupported': it explicitly referenced an existing finding but the reference did not hold up. No finding is created or changed; kept for audit only (see decision-assembly.ts's UnsupportedRawDecision). */
export interface UnsupportedRawFindingReport {
  rawFindingId: string;
  targetFindingId: string;
  evidence: string;
}

/** reviewer 出力がハード上限（件数 / byte / フィールド長）を超え、全量が単一 overflow provisional に置き換えられた記録（v2 梯子設計 §10）。 */
export interface ReviewerOutputOverflowReport {
  reviewer: string;
  reason: string;
}

/**
 * canonicalization が raw の主張を正規化した監査レコード（codex 2巡目ブロッカー
 * 対応）。wire / ledger の identity 構成フィールド（path/title/description）には
 * 一切載せず、この専用メタデータだけが「正規化前の元の主張」を保持する。
 * 変換が起きた raw のみ記録する（無変換 raw のノイズは増やさない）。
 */
export interface RawNormalizationAuditRecord {
  /** 正規化後（namespace 付与後）の raw finding id。wire / provisional の sourceRawFindingIds と突合できる。 */
  rawFindingId: string;
  reviewer: string;
  /** レビュアが主張した元の relation（欠損していた場合は undefined）。 */
  claimedRelation?: string;
  /** レビュアが主張した元の targetFindingId。 */
  claimedTargetFindingId?: string;
  /** レビュアが送ってきた legacy kind（送られていた場合）。 */
  claimedKind?: string;
  /** canonical に採用された整合 relation。 */
  normalizedRelation: string;
  /** wire（台帳の rawFindings）に残した targetFindingId。undefined = 除外された。 */
  wireTargetFindingId?: string;
  /** 検出された ambiguity codes（RawAmbiguityCode）。 */
  ambiguityCodes: string[];
  /** 適用された正規化の種別。 */
  normalizations: Array<
    | 'relation-normalized'
    | 'target-dropped-from-wire'
    | 'required-fields-missing'
    /** A-2: location を行範囲（path:start-end）として解釈した。 */
    | 'location-line-range-interpreted'
    /** A-2: location "N/A" を locationless として扱った。 */
    | 'location-not-applicable'
  >;
}

/** raw / 決定が provisional finding として着地した記録（v2 梯子設計 §7）。 */
export interface ProvisionalLandingReport {
  kind: string;
  stableKey: string;
  reason: string;
  sourceRawFindingIds: string[];
}

/** ambiguous raw 解釈（manager interpretation）の観測メトリクス（v2 梯子設計 実装単位10）。 */
export interface InterpretationStatsReport {
  ambiguousRawCount: number;
  managerCalls: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  reusedCompletedDecisions: number;
  interruptedInterpretations: number;
  budgetExhaustedLineages: number;
}

export interface FindingManagerValidationReport {
  version: 1;
  runId: string;
  stepName: string;
  retryCount: number;
  ledgerUpdated: boolean;
  finalErrors: string[];
  attempts: FindingManagerValidationAttemptReport[];
  rawAdmissionRejections?: RawAdmissionRejectionReport[];
  unsupportedRawFindings?: UnsupportedRawFindingReport[];
  reviewerOutputOverflows?: ReviewerOutputOverflowReport[];
  provisionalLandings?: ProvisionalLandingReport[];
  /** 正規化前の元の主張の監査記録（変換が起きた raw のみ）。 */
  rawNormalizations?: RawNormalizationAuditRecord[];
  interpretationStats?: InterpretationStatsReport;
  /** correction（レビュア1回突き返し）の実施記録（成功率メトリクスの材料）。 */
  relationClarifications?: Array<{ reviewer: string; flaggedRawFindingIds: string[] }>;
}

function resolveInside(baseDir: string, path: string): string {
  const resolvedBase = resolve(baseDir);
  const resolvedPath = resolve(resolvedBase, path);
  assertPathInside(resolvedBase, resolvedPath, path);
  return resolvedPath;
}

function assertPathInside(resolvedBase: string, resolvedPath: string, path: string): void {
  const basePrefix = resolvedBase.endsWith(sep) ? resolvedBase : resolvedBase + sep;
  if (resolvedPath !== resolvedBase && !resolvedPath.startsWith(basePrefix)) {
    throw new Error(`Finding ledger path escapes base directory: ${path}`);
  }
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

function assertNotSymlink(path: string): void {
  if (pathExists(path) && lstatSync(path).isSymbolicLink()) {
    throw new Error(`Finding ledger path must not be a symbolic link: ${path}`);
  }
}

function findExistingAncestor(path: string): string {
  let current = path;
  while (!pathExists(current)) {
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(`Finding ledger parent directory does not exist: ${path}`);
    }
    current = parent;
  }
  return current;
}

function assertRealPathInside(baseDir: string, path: string): void {
  const resolvedBase = realpathSync(baseDir);
  const resolvedPath = realpathSync(path);
  assertPathInside(resolvedBase, resolvedPath, path);
}

function prepareWritableFilePath(baseDir: string, filePath: string): void {
  const parentDir = dirname(filePath);
  assertRealPathInside(baseDir, findExistingAncestor(parentDir));
  mkdirSync(parentDir, { recursive: true, mode: PRIVATE_DIR_MODE });
  chmodSync(parentDir, PRIVATE_DIR_MODE);
  assertRealPathInside(baseDir, parentDir);
  assertNotSymlink(filePath);
  if (pathExists(filePath)) {
    chmodSync(filePath, PRIVATE_FILE_MODE);
  }
}

function prepareWritableCopyPath(baseDir: string, filePath: string): void {
  prepareWritableFilePath(baseDir, filePath);
}

function prepareWritableDirectory(baseDir: string, dirPath: string): void {
  assertRealPathInside(baseDir, findExistingAncestor(dirPath));
  mkdirSync(dirPath, { recursive: true, mode: PRIVATE_DIR_MODE });
  chmodSync(dirPath, PRIVATE_DIR_MODE);
  assertRealPathInside(baseDir, dirPath);
}

function createEmptyLedger(workflowName: string): FindingLedger {
  return {
    version: 1,
    workflowName,
    nextId: 1,
    findings: [],
    rawFindings: [],
    conflicts: [],
    updatedAt: new Date().toISOString(),
  };
}

function readLedgerFile(path: string): FindingLedger {
  const ledger = parseFindingLedger(JSON.parse(readFileSync(path, 'utf-8')));
  assertLedgerIdAllocationInvariant(ledger);
  return ledger;
}

function readProjectLedgerFile(baseDir: string, path: string): FindingLedger {
  assertNotSymlink(path);
  assertRealPathInside(baseDir, path);
  return readLedgerFile(path);
}

function readProjectLedgerOrEmpty(baseDir: string, path: string, workflowName: string): FindingLedger {
  assertRealPathInside(baseDir, findExistingAncestor(dirname(path)));
  assertNotSymlink(path);
  if (!pathExists(path)) {
    return createEmptyLedger(workflowName);
  }
  const ledger = readProjectLedgerFile(baseDir, path);
  assertLedgerWorkflowName(ledger, workflowName, path);
  return ledger;
}

function assertLedgerWorkflowName(ledger: FindingLedger, workflowName: string, source: string): void {
  if (ledger.workflowName !== workflowName) {
    throw new Error(`Finding ledger workflowName mismatch in ${source}: expected "${workflowName}", got "${ledger.workflowName}"`);
  }
}

function sanitizeFileSegment(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (sanitized.length === 0) {
    throw new Error(`Invalid finding file segment: ${value}`);
  }
  return sanitized;
}

export function createFindingLedgerStore(options: FindingLedgerStoreOptions): FindingLedgerStore {
  const ledgerRoot = resolveFindingLedgerRoot(options.projectCwd);
  assertNotSymlink(ledgerRoot);
  const ledgerPath = resolveInside(ledgerRoot, options.ledgerPath);
  const copyPath = resolveInside(options.reportDir, 'findings-ledger.json');
  const rawFindingsDir = resolveInside(ledgerRoot, options.rawFindingsPath);

  const loadLedgerImpl = (): FindingLedger => {
    return readProjectLedgerOrEmpty(ledgerRoot, ledgerPath, options.workflowName);
  };
  const saveLedgerImpl = (ledger: FindingLedger): void => {
    assertLedgerWorkflowName(ledger, options.workflowName, ledgerPath);
    assertLedgerIdAllocationInvariant(ledger);
    prepareWritableFilePath(ledgerRoot, ledgerPath);
    writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2), { encoding: 'utf-8', mode: PRIVATE_FILE_MODE });
    chmodSync(ledgerPath, PRIVATE_FILE_MODE);
  };

  // 同一プロセス内の呼び出しを直列化するための Promise チェーン。
  // updateLedger は「このチェーンの末尾に自分の臨界区間を継ぎ足し、前の
  // 呼び出しが終わるまで自分の読み込みを始めない」ことで排他を実現する。
  let updateQueue: Promise<unknown> = Promise.resolve();

  return {
    workflowName: options.workflowName,
    loadLedger: loadLedgerImpl,
    saveLedger: saveLedgerImpl,
    updateLedger: (mutator) => {
      const critical = updateQueue.then(() => {
        const current = loadLedgerImpl();
        const next = mutator(current);
        saveLedgerImpl(next);
        return next;
      });
      // キューの継続は失敗で止めない（この呼び出しの失敗は呼び出し元へ
      // critical 経由でそのまま伝播する）。失敗を握りつぶさずに繋ぐと、
      // 1回の失敗で以降の全ての updateLedger 呼び出しが解決しなくなる。
      updateQueue = critical.catch(() => undefined);
      return critical;
    },
    createRunCopy: () => {
      const ledger = readProjectLedgerOrEmpty(ledgerRoot, ledgerPath, options.workflowName);
      prepareWritableCopyPath(options.reportDir, copyPath);
      writeFileSync(copyPath, JSON.stringify(ledger, null, 2), { encoding: 'utf-8', mode: PRIVATE_FILE_MODE });
      chmodSync(copyPath, READ_ONLY_PRIVATE_FILE_MODE);
      return copyPath;
    },
    saveRawFindings: (runId, stepName, rawFindings) => {
      const parsedRawFindings = parseRawFindings(rawFindings);
      prepareWritableDirectory(ledgerRoot, rawFindingsDir);
      const baseName = `${sanitizeFileSegment(runId)}.${sanitizeFileSegment(stepName)}`;
      let rawFindingsFile = `${baseName}.json`;
      let generation = 2;
      while (pathExists(resolveInside(rawFindingsDir, rawFindingsFile))) {
        rawFindingsFile = `${baseName}.${generation}.json`;
        generation += 1;
      }
      const rawFindingsFilePath = resolveInside(rawFindingsDir, rawFindingsFile);
      assertNotSymlink(rawFindingsFilePath);
      writeFileSync(rawFindingsFilePath, JSON.stringify(parsedRawFindings, null, 2), {
        encoding: 'utf-8',
        mode: PRIVATE_FILE_MODE,
      });
      chmodSync(rawFindingsFilePath, PRIVATE_FILE_MODE);
      return rawFindingsFilePath;
    },
    saveManagerValidationReport: (report) => {
      const fileName = `findings-manager-validation.${sanitizeFileSegment(report.stepName)}.json`;
      return writeReportFile(options.reportDir, fileName, JSON.stringify(report, null, 2));
    },
    saveConflictAdjudicationReport: (report) => {
      const fileName = `findings-adjudication.${sanitizeFileSegment(report.conflictId)}.json`;
      return writeReportFile(options.reportDir, fileName, JSON.stringify(report, null, 2));
    },
    saveNeedsAdjudicationReport: (report) => {
      // NEEDS_ADJUDICATION is terminal — a run reaches it at most once, so a
      // fixed name (already scoped by the run's own report directory) is
      // enough; no per-conflict/per-step disambiguation is needed.
      return writeReportFile(options.reportDir, 'needs-adjudication.json', JSON.stringify(report, null, 2));
    },
  };
}

export function resolveFindingLedgerRoot(projectCwd: string): string {
  return resolve(projectCwd);
}

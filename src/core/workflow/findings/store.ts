import { lstatSync, realpathSync, type Stats } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import {
  readRegularFileNoFollow,
  ensurePrivateDirectory,
  PrivateArtifactPublicationConflictError,
  writePrivateFileWithMode,
  writePrivateFileWithModeGuarded,
} from '../../../shared/utils/private-file.js';
import type { FindingLedger, RawFinding } from './types.js';
import { normalizeProvisionalInterpretationEpochs } from './interpretation-wal.js';
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

const PRIVATE_FILE_MODE = 0o600;
const READ_ONLY_PRIVATE_FILE_MODE = 0o400;

export interface LedgerRepository {
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
   * revalidateBeforeSave は atomic publication の直前にも呼ばれる。publish=false
   * の場合、候補の一時ファイルを公開せず、返された安全な mutation を保存する。
   */
  updateLedger: <Result>(
    mutator: (current: FindingLedger) => FindingLedgerMutation<Result>,
    revalidateBeforeSave?: (
      current: FindingLedger,
      mutation: FindingLedgerMutation<Result>,
    ) => FindingLedgerPublicationDecision<Result>,
  ) => Promise<FindingLedgerMutation<Result>>;
}

export interface AdjudicationReservationRegistry {
  claimAdjudicationReservation: (reservationToken: string) => boolean;
  releaseAdjudicationReservation: (reservationToken: string) => void;
}

export interface FindingArtifactWriter {
  createRunCopy: () => string;
  saveRawFindings: (runId: string, stepName: string, rawFindings: RawFinding[]) => string;
  saveManagerValidationReport: (report: FindingManagerValidationReport) => string;
  /** Audit trail for the finding-conflict-adjudication synthetic step: discarded decisions (evidence changed between prompt and apply) and other non-applied outcomes. */
  saveConflictAdjudicationReport: (report: FindingConflictAdjudicationAuditReport) => string;
  /** Audit trail for a NEEDS_ADJUDICATION stop: the open provisional findings that reached a cross-round fixpoint and their origin. */
  saveNeedsAdjudicationReport: (report: NeedsAdjudicationReport) => string;
}

export interface FindingLedgerStore
  extends LedgerRepository, FindingArtifactWriter, AdjudicationReservationRegistry {}

export type FindingManagerStore = LedgerRepository & AdjudicationReservationRegistry & Pick<
  FindingArtifactWriter,
  'createRunCopy' | 'saveRawFindings' | 'saveManagerValidationReport'
>;

export type FindingAdjudicationStore = LedgerRepository
  & AdjudicationReservationRegistry
  & Pick<FindingArtifactWriter, 'saveConflictAdjudicationReport'>;

export interface FindingLedgerMutation<Result> {
  ledger: FindingLedger;
  result: Result;
}

export interface FindingLedgerPublicationDecision<Result> {
  mutation: FindingLedgerMutation<Result>;
  publish: boolean;
}

/**
 * Which condition forced the NEEDS_ADJUDICATION transition. 'fixpoint' is the
 * provisional fixpoint mechanism (the provisional set stopped changing
 * across rounds); 'budget-exhausted' is the bounded stop
 * budget extension (the cumulative round count, or elapsed time, exceeded its
 * configured limit even though the provisional set kept churning). This is
 * classified from the actual matched rule condition (see NeedsAdjudicationReport.matchedCondition),
 * NOT inferred from ledger state — so a workflow that places the budget rule
 * before the fixpoint rule correctly records 'budget-exhausted' when the budget
 * rule matched first. 'unclassified' covers a custom route to NEEDS_ADJUDICATION
 * whose condition references neither signal.
 */
export type NeedsAdjudicationStopReason = 'fixpoint' | 'budget-exhausted' | 'review-integrity-exhausted' | 'unclassified';

/**
 * Written when the workflow stops at NEEDS_ADJUDICATION (a
 * cross-round provisional fixpoint, or its bounded-stop-budget extension).
 * Durable, machine-readable record of "why it stopped" alongside the
 * human-readable abort reason string — see WorkflowEngine's
 * recordNeedsAdjudication.
 */
export interface NeedsAdjudicationReport {
  version: 1;
  runId: string;
  /** Step whose rule transition matched NEEDS_ADJUDICATION (e.g. "reviewers", "final-gate"). */
  stepName: string;
  reachedAt: string;
  /** Classified from `matchedCondition` (fact), not ledger-state inference. */
  stopReason: NeedsAdjudicationStopReason;
  /** The exact condition of the rule that routed to NEEDS_ADJUDICATION — the ground-truth fact `stopReason` is derived from. Absent only when the transition came from a loop-monitor judge override (which surfaces no condition string). */
  matchedCondition?: string;
  /** Present whenever the ledger carries stop-budget state, regardless of stopReason — audit context for how many rounds it took to reach either terminal condition. */
  stopBudget?: {
    roundsCompleted: number;
    firstRoundAt: string;
  };
  provisionalFindings: Array<{
    findingId: string;
    kind: string;
    stableKey: string;
    reason: string;
    reviewers: string[];
    sourceRawFindingIds: string[];
  }>;
  /**
   * 二系統台帳（review-integrity protocol）の review-integrity 側の未昇格 anomaly。
   * NEEDS_ADJUDICATION 自体は（従来どおり）provisional のみが引き起こすが、
   * 到達したときにこの監査情報も同梱することで、人手裁定が「product gate を
   * 塞いでいる provisional」と「引用不成立で監査だけされている anomaly」の
   * 両方を1箇所で見られるようにする。anomaly 単体で NEEDS_ADJUDICATION を
   * 引き起こすことはない（product gate を塞がないという安全不変条件どおり）。
   */
  reviewerAnomalies?: Array<{
    id: string;
    kind: string;
    stableKey: string;
    reason: string;
    reviewers: string[];
    sourceRawFindingIds: string[];
    occurrences: number;
  }>;
}

/**
 * Written when an adjudication decision could NOT be applied (evidence CAS requirement: the
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

/** unsupported は target を変えず confirmed finding も作らないため、gate-blocking provisional と併せて裁定根拠を監査する。 */
export interface UnsupportedRawFindingReport {
  rawFindingId: string;
  targetFindingId: string;
  evidence: string;
}

/** reviewer 出力がハード上限（件数 / byte / フィールド長）を超え、全量が単一 overflow provisional に置き換えられた記録。 */
export interface ReviewerOutputOverflowReport {
  reviewer: string;
  reason: string;
}

/** canonical identity を変えずに、raw finding の正規化前後を監査する。 */
export interface RawNormalizationAuditRecord {
  /** 正規化後（namespace 付与後）の raw finding id。wire / provisional の sourceRawFindingIds と突合できる。 */
  rawFindingId: string;
  reviewer: string;
  /** レビュアが主張した元の relation（欠損していた場合は undefined）。 */
  claimedRelation?: string;
  /** レビュアが主張した元の targetFindingId。 */
  claimedTargetFindingId?: string;
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
    /** location を行範囲（path:start-end）として解釈した。 */
    | 'location-line-range-interpreted'
    /** location "N/A" を locationless として扱った。 */
    | 'location-not-applicable'
  >;
}

/** raw / 決定が provisional finding として着地した記録。 */
export interface ProvisionalLandingReport {
  kind: string;
  stableKey: string;
  reason: string;
  sourceRawFindingIds: string[];
}

/** raw が reviewer anomaly（review-integrity 側の二系統台帳）として着地した記録（review-integrity protocol）。ProvisionalLandingReport と同じ形だが、product gate を一切塞がない着地先であることを型で区別する。 */
export interface ReviewerAnomalyLandingReport {
  kind: string;
  stableKey: string;
  reason: string;
  sourceRawFindingIds: string[];
}

/** ambiguous raw 解釈（manager interpretation）の観測メトリクス。 */
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
  /** reviewer anomaly として着地した記録（review-integrity protocol。product gate は塞がない）。 */
  reviewerAnomalyLandings?: ReviewerAnomalyLandingReport[];
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
  ensurePrivateDirectory(parentDir);
  assertRealPathInside(baseDir, parentDir);
  assertNotSymlink(filePath);
}

function prepareWritableCopyPath(baseDir: string, filePath: string): void {
  prepareWritableFilePath(baseDir, filePath);
}

function prepareWritableDirectory(baseDir: string, dirPath: string): void {
  assertRealPathInside(baseDir, findExistingAncestor(dirPath));
  ensurePrivateDirectory(dirPath);
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

function readLedgerFile(path: string, expectedStat: Stats): FindingLedger {
  const ledger = parseFindingLedger(JSON.parse(readRegularFileNoFollow(path, expectedStat).toString('utf-8')));
  assertLedgerIdAllocationInvariant(ledger);
  return ledger;
}

function hasEquivalentLedgerState(content: string, expected: FindingLedger): boolean {
  try {
    const published = parseFindingLedger(JSON.parse(content));
    const publishedState = { ...published, updatedAt: '' };
    const expectedState = { ...expected, updatedAt: '' };
    return JSON.stringify(publishedState) === JSON.stringify(expectedState);
  } catch {
    return false;
  }
}

function describeLedgerState(content: string): string {
  try {
    const ledger = parseFindingLedger(JSON.parse(content));
    return JSON.stringify({
      workflowName: ledger.workflowName,
      nextId: ledger.nextId,
      findings: ledger.findings.length,
      rawFindings: ledger.rawFindings.length,
      conflicts: ledger.conflicts.length,
      updatedAt: ledger.updatedAt,
    });
  } catch {
    return 'invalid-ledger';
  }
}

function readProjectLedgerFile(baseDir: string, path: string): FindingLedger {
  assertNotSymlink(path);
  assertRealPathInside(baseDir, path);
  const expectedStat = lstatSync(path);
  if (!expectedStat.isFile()) {
    throw new Error(`Finding ledger path is not a regular file: ${path}`);
  }
  return readLedgerFile(path, expectedStat);
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
    return normalizeProvisionalInterpretationEpochs(
      readProjectLedgerOrEmpty(ledgerRoot, ledgerPath, options.workflowName),
    );
  };
  const normalizeLedger = (ledger: FindingLedger): FindingLedger => {
    const parsedLedger = parseFindingLedger(normalizeProvisionalInterpretationEpochs(ledger));
    assertLedgerWorkflowName(parsedLedger, options.workflowName, ledgerPath);
    assertLedgerIdAllocationInvariant(parsedLedger);
    return parsedLedger;
  };
  const normalizeMutation = <Result>(mutation: FindingLedgerMutation<Result>): FindingLedgerMutation<Result> => ({
    ...mutation,
    ledger: normalizeLedger(mutation.ledger),
  });
  const normalizePublicationDecision = <Result>(
    decision: FindingLedgerPublicationDecision<Result>,
  ): FindingLedgerPublicationDecision<Result> => ({
    ...decision,
    mutation: normalizeMutation(decision.mutation),
  });
  const prepareLedgerSave = (ledger: FindingLedger): string => {
    const parsedLedger = normalizeLedger(ledger);
    prepareWritableFilePath(ledgerRoot, ledgerPath);
    return JSON.stringify(parsedLedger, null, 2);
  };
  const saveLedgerImpl = (ledger: FindingLedger): void => {
    writePrivateFileWithMode(ledgerPath, prepareLedgerSave(ledger), PRIVATE_FILE_MODE);
  };
  const saveLedgerGuardedImpl = (
    ledger: FindingLedger,
    publicationGuard: () => FindingLedgerPublicationDecision<unknown>,
  ): boolean => {
    return writePrivateFileWithModeGuarded(
      ledgerPath,
      prepareLedgerSave(ledger),
      PRIVATE_FILE_MODE,
      () => {
        const decision = publicationGuard();
        if (!decision.publish) {
          return false;
        }
        return {
          publish: true,
          content: prepareLedgerSave(decision.mutation.ledger),
        };
      },
    );
  };

  // 同一プロセス内の呼び出しを直列化するための Promise チェーン。
  // updateLedger は「このチェーンの末尾に自分の臨界区間を継ぎ足し、前の
  // 呼び出しが終わるまで自分の読み込みを始めない」ことで排他を実現する。
  let updateQueue: Promise<unknown> = Promise.resolve();
  const adjudicationReservations = new Set<string>();

  return {
    workflowName: options.workflowName,
    loadLedger: loadLedgerImpl,
    saveLedger: saveLedgerImpl,
    updateLedger: (mutator, revalidateBeforeSave) => {
      const critical = updateQueue.then(() => {
        const current = loadLedgerImpl();
        const mutation = mutator(current);
        const preparedMutation = normalizeMutation(mutation);
        if (revalidateBeforeSave === undefined) {
          saveLedgerImpl(preparedMutation.ledger);
          return preparedMutation;
        }
        const initialDecision = normalizePublicationDecision(revalidateBeforeSave(current, preparedMutation));
        if (!initialDecision.publish) {
          saveLedgerImpl(initialDecision.mutation.ledger);
          return initialDecision.mutation;
        }
        let publicationDecision = initialDecision;
        const published = saveLedgerGuardedImpl(initialDecision.mutation.ledger, () => {
          publicationDecision = normalizePublicationDecision(revalidateBeforeSave(current, initialDecision.mutation));
          return publicationDecision;
        });
        if (!published) {
          saveLedgerImpl(publicationDecision.mutation.ledger);
        }
        return publicationDecision.mutation;
      });
      // キューの継続は失敗で止めない（この呼び出しの失敗は呼び出し元へ
      // critical 経由でそのまま伝播する）。失敗を握りつぶさずに繋ぐと、
      // 1回の失敗で以降の全ての updateLedger 呼び出しが解決しなくなる。
      updateQueue = critical.catch(() => undefined);
      return critical;
    },
    claimAdjudicationReservation: (reservationToken) => {
      if (adjudicationReservations.has(reservationToken)) {
        return false;
      }
      adjudicationReservations.add(reservationToken);
      return true;
    },
    releaseAdjudicationReservation: (reservationToken) => {
      adjudicationReservations.delete(reservationToken);
    },
    createRunCopy: () => {
      const ledger = loadLedgerImpl();
      const content = JSON.stringify(ledger, null, 2);
      prepareWritableCopyPath(options.reportDir, copyPath);
      try {
        writePrivateFileWithMode(copyPath, content, READ_ONLY_PRIVATE_FILE_MODE);
      } catch (error) {
        if (!(error instanceof PrivateArtifactPublicationConflictError)) {
          throw error;
        }
        const publishedStat = lstatSync(copyPath) as Stats;
        if (!publishedStat.isFile()) {
          throw error;
        }
        const publishedContent = readRegularFileNoFollow(copyPath, publishedStat).toString('utf-8');
        if (publishedContent !== content && !hasEquivalentLedgerState(publishedContent, ledger)) {
          throw new Error(
            `${error.message}; concurrent run copy differs: ${describeLedgerState(publishedContent)}`,
            { cause: error },
          );
        }
      }
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
      writePrivateFileWithMode(rawFindingsFilePath, JSON.stringify(parsedRawFindings, null, 2), PRIVATE_FILE_MODE);
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

import { createHash } from 'node:crypto';
import { lstatSync, readlinkSync, realpathSync, type Stats } from 'node:fs';
import {
  dirname,
  relative,
  resolve,
  sep,
} from 'node:path';
import {
  readRegularFileNoFollow,
  readPrivateFileState,
  ensurePrivateDirectory,
  PrivateArtifactPublicationConflictError,
  type PrivateFileState,
  writePrivateFileWithMode,
  writePrivateFileWithModeExpected,
  writePrivateFileWithModeExpectedGuarded,
} from '../../../shared/utils/private-file.js';
import type {
  FindingLedger,
  FindingManagerReportPublication,
  FindingManagerValidationReport,
  RawFinding,
} from './types.js';
import { parseFindingLedger, parseRawFindings } from './schemas.js';
import { assertFindingLedgerProjectionInvariant } from '../../models/finding-ledger-invariants.js';
import {
  finalizeReportPublication,
  publishReportFile,
  writeReportFile,
} from '../report-writer.js';
import type { ReportPublicationReceipt } from '../report-publication.js';
import { runLedgerUpdateExclusive } from './ledger-identity-queue.js';
import {
  assertFindingManagerLedgerCommit,
  cloneFindingLedgerMutation,
  normalizeFindingLedger,
  normalizeFindingLedgerMutation,
  normalizePendingManagerCommitFinalization,
  normalizePendingManagerCommitRebind,
  normalizePendingManagerCommitStage,
} from './ledger-mutation.js';
import {
  computeFindingManagerReportPublicationId,
  findingManagerValidationReportFileName,
  serializeFindingManagerValidationReport,
} from './manager-report-content.js';
import { isValidReportDirName } from '../../../shared/utils/taskPaths.js';
import { runPrivateFileExclusive } from '../../../shared/utils/private-file-lock.js';

interface FindingLedgerStoreOptions {
  projectCwd: string;
  runId: string;
  reportDir: string;
  workflowName: string;
  ledgerPath: string;
  rawFindingsPath: string;
  trustedResumeSourceRunId?: string;
}

const PRIVATE_FILE_MODE = 0o600;
const READ_ONLY_PRIVATE_FILE_MODE = 0o400;

export interface LedgerRepository {
  /** この store が束縛する、外部公開用の論理 run identity。 */
  readonly runId: string;
  /** 同じ永続台帳を指す store 間で共有する、永続化方式に依存しない識別子。 */
  readonly ledgerIdentity: string;
  /**
   * この store が束縛する台帳の正準ワークフロー名。workflow_call の子が親から
   * store を継承した場合も親の名前のまま変わらない。ledger.json の
   * workflowName スタンプ（reconcile 時）はこの値と一致させる必要がある。
   * 一致しないと assertLedgerWorkflowName が次回の save/load で例外を投げる。
   */
  workflowName: string;
  loadLedger: () => FindingLedger;
  /**
   * 「読み込み → 更新関数 → 保存」を、同じ ledgerIdentity を持つ store 間で
   * 排他実行する。各呼び出しが「最初に読んだ台帳」を基準に非同期処理後に
   * 保存すると後勝ちで一方の更新が消える（lost update）。呼び出し元は
   * 非同期処理（LLM 呼び出し等）を済ませたあとにこの API を呼び、
   * mutator には同期処理だけを渡すこと（mutator の中で await すると、
   * 直列化の意味がなくなる）。
   * 同一プロセス内の Promise チェーンによる直列化であり、複数プロセスからの
   * 同時更新はこの直列化の対象外（現状の設計外）。
   * revalidateBeforeSave は atomic publication の直前にも呼ばれる。publish=false
   * の場合、候補の一時ファイルを公開せず、返された安全な mutation を保存する。
   * 各 callback には永続状態と共有しない clone を渡す。callback は引数を直接
   * 変更できるが、変更は戻り値に含めた場合だけ候補として検証される。
   */
  updateLedger: <Result>(
    mutator: (current: FindingLedger) => FindingLedgerMutation<Result>,
    revalidateBeforeSave?: (
      current: FindingLedger,
      mutation: FindingLedgerMutation<Result>,
    ) => FindingLedgerPublicationDecision<Result>,
  ) => Promise<FindingLedgerMutation<Result>>;
}

export interface FindingManagerLedgerCommit<Result> {
  readonly ledger: FindingLedger;
  readonly result: Result;
  readonly publication?: {
    readonly roundMarker: string;
    readonly report: FindingManagerValidationReport;
  };
}

export interface FindingManagerCommitStager {
  commitManagerLedger: <Result>(
    mutator: (current: FindingLedger) => FindingManagerLedgerCommit<Result>,
  ) => Promise<FindingLedgerMutation<Result>>;
}

export interface AdjudicationReservationRegistry {
  claimAdjudicationReservation: (reservationToken: string) => boolean;
  releaseAdjudicationReservation: (reservationToken: string) => void;
}

export interface FindingArtifactWriter {
  saveLedgerSnapshot: () => void;
  saveRawFindings: (runId: string, stepName: string, rawFindings: RawFinding[]) => void;
  saveManagerValidationReport: (report: FindingManagerValidationReport) => void;
  planManagerValidationPublication: (
    roundMarker: string,
    report: FindingManagerValidationReport,
  ) => FindingManagerReportPublication;
  bindManagerValidationPublication: (
    roundMarker: string,
    publication: FindingManagerReportPublication,
  ) => FindingManagerReportPublication;
  publishManagerValidationPublication: (
    publication: FindingManagerReportPublication,
  ) => ReportPublicationReceipt;
  /** Audit trail for the finding-conflict-adjudication synthetic step: discarded decisions (evidence changed between prompt and apply) and other non-applied outcomes. */
  saveConflictAdjudicationReport: (report: FindingConflictAdjudicationAuditReport) => void;
}

export interface FindingManagerCommitRebinder {
  rebindPendingManagerValidationPublication: (
    publication: FindingManagerReportPublication,
  ) => Promise<FindingLedger>;
}

export interface FindingManagerCommitFinalizer {
  finalizeManagerValidationPublication: (
    publication: FindingManagerReportPublication,
    receipt: ReportPublicationReceipt,
  ) => Promise<FindingManagerCommitFinalization>;
}

export interface FindingLedgerStore
  extends
    LedgerRepository,
    FindingManagerCommitStager,
    FindingArtifactWriter,
    FindingManagerCommitRebinder,
    FindingManagerCommitFinalizer,
    AdjudicationReservationRegistry {}

export type FindingManagerStore = LedgerRepository
  & FindingManagerCommitStager
  & AdjudicationReservationRegistry
  & FindingManagerCommitRebinder
  & FindingManagerCommitFinalizer
  & Pick<
    FindingArtifactWriter,
    | 'saveLedgerSnapshot'
    | 'saveRawFindings'
    | 'saveManagerValidationReport'
    | 'planManagerValidationPublication'
    | 'bindManagerValidationPublication'
    | 'publishManagerValidationPublication'
  >;

export type FindingAdjudicationStore = LedgerRepository
  & AdjudicationReservationRegistry
  & Pick<FindingArtifactWriter, 'saveConflictAdjudicationReport'>;

export interface FindingLedgerMutation<Result> {
  ledger: FindingLedger;
  result: Result;
}

export interface FindingManagerCommitFinalization {
  ledger: FindingLedger;
  completedRoundMarker: string;
}

export interface FindingLedgerPublicationDecision<Result> {
  mutation: FindingLedgerMutation<Result>;
  publish: boolean;
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

export type {
  FindingManagerValidationAttemptReport,
  FindingManagerValidationReport,
  InterpretationStatsReport,
  ProvisionalLandingReport,
  RawAdmissionRejectionReport,
  RawNormalizationAuditRecord,
  ReviewerAnomalyLandingReport,
  ReviewerOutputOverflowReport,
  UnsupportedRawFindingReport,
} from './types.js';

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

function canonicalPathIdentity(path: string): string {
  const ancestor = findExistingAncestor(path);
  if (lstatSync(ancestor).isSymbolicLink()) {
    try {
      return resolve(realpathSync(ancestor), relative(ancestor, path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        const linkTarget = resolve(dirname(ancestor), readlinkSync(ancestor));
        return resolve(canonicalPathIdentity(linkTarget), relative(ancestor, path));
      }
      throw error;
    }
  }
  return resolve(
    realpathSync(ancestor),
    relative(ancestor, path),
  );
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
    workflowName,
    nextId: 1,
    findings: [],
    evidenceRecords: [],
    rawFindings: [],
    conflicts: [],
    interpretations: [],
    updatedAt: new Date().toISOString(),
  };
}

function parseLedgerContent(content: Buffer): FindingLedger {
  const ledger = parseFindingLedger(JSON.parse(content.toString('utf-8')));
  assertFindingLedgerProjectionInvariant(ledger);
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
  return parseLedgerContent(readRegularFileNoFollow(path, expectedStat));
}

interface LedgerReadSnapshot {
  ledger: FindingLedger;
  state: PrivateFileState;
}

function readProjectLedgerSnapshot(
  baseDir: string,
  path: string,
  workflowName: string,
): LedgerReadSnapshot {
  assertRealPathInside(baseDir, findExistingAncestor(dirname(path)));
  assertNotSymlink(path);
  if (!pathExists(path)) {
    return {
      ledger: createEmptyLedger(workflowName),
      state: { path: resolve(path), exists: false },
    };
  }
  assertRealPathInside(baseDir, path);
  const snapshot = readPrivateFileState(path);
  if (!snapshot.state.exists) {
    throw new PrivateArtifactPublicationConflictError(
      `Finding ledger identity changed while reading: ${path}`,
    );
  }
  if (!('content' in snapshot)) {
    throw new Error(`Finding ledger content is missing from its read snapshot: ${path}`);
  }
  const ledger = parseLedgerContent(snapshot.content);
  assertLedgerWorkflowName(ledger, workflowName, path);
  return { ledger, state: snapshot.state };
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

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function managerReportContent(report: FindingManagerValidationReport): string {
  return serializeFindingManagerValidationReport(report);
}

function sameManagerPublication(
  left: FindingManagerReportPublication,
  right: FindingManagerReportPublication,
): boolean {
  return left.publicationId === right.publicationId
    && left.domainId === right.domainId
    && left.originRunId === right.originRunId
    && left.destinationRunId === right.destinationRunId
    && left.fileName === right.fileName
    && left.contentSha256 === right.contentSha256
    && managerReportContent(left.report) === managerReportContent(right.report);
}

export function createFindingLedgerStore(options: FindingLedgerStoreOptions): FindingLedgerStore {
  const ledgerRoot = resolveFindingLedgerRoot(options.projectCwd);
  assertNotSymlink(ledgerRoot);
  const ledgerPath = resolveInside(ledgerRoot, options.ledgerPath);
  const ledgerIdentity = canonicalPathIdentity(ledgerPath);
  const publicationDomainId = sha256([
    canonicalPathIdentity(ledgerRoot),
    ledgerIdentity,
  ].join('\0'));
  const copyPath = resolveInside(options.reportDir, 'findings-ledger.json');
  const rawFindingsDir = resolveInside(ledgerRoot, options.rawFindingsPath);
  if (!isValidReportDirName(options.runId)) {
    throw new Error(`Invalid finding store run id: ${options.runId}`);
  }
  const boundRunId = options.runId;
  if (options.trustedResumeSourceRunId !== undefined
    && !isValidReportDirName(options.trustedResumeSourceRunId)) {
    throw new Error(`Invalid trusted resume source run id: ${options.trustedResumeSourceRunId}`);
  }

  const normalizeLedger = (ledger: FindingLedger): FindingLedger => {
    const parsedLedger = normalizeFindingLedger(ledger, options.workflowName);
    assertLedgerWorkflowName(parsedLedger, options.workflowName, ledgerPath);
    return parsedLedger;
  };
  const loadLedgerImpl = (): FindingLedger => {
    return normalizeLedger(
      readProjectLedgerOrEmpty(ledgerRoot, ledgerPath, options.workflowName),
    );
  };
  const normalizeMutation = <Result>(
    current: FindingLedger,
    mutation: FindingLedgerMutation<Result>,
  ): FindingLedgerMutation<Result> => {
    return normalizeFindingLedgerMutation(current, mutation, options.workflowName);
  };
  const normalizePublicationDecision = <Result>(
    current: FindingLedger,
    decision: FindingLedgerPublicationDecision<Result>,
  ): FindingLedgerPublicationDecision<Result> => ({
    ...decision,
    mutation: normalizeMutation(current, decision.mutation),
  });
  const prepareLedgerSave = (ledger: FindingLedger): string => {
    const parsedLedger = normalizeLedger(ledger);
    prepareWritableFilePath(ledgerRoot, ledgerPath);
    return JSON.stringify(parsedLedger, null, 2);
  };
  const saveLedgerImpl = (ledger: FindingLedger, expectedState: PrivateFileState): void => {
    const content = prepareLedgerSave(ledger);
    writePrivateFileWithModeExpected(
      ledgerPath,
      content,
      PRIVATE_FILE_MODE,
      expectedState,
    );
  };
  const saveLedgerGuardedImpl = (
    ledger: FindingLedger,
    expectedState: PrivateFileState,
    publicationGuard: () => FindingLedgerPublicationDecision<unknown>,
  ): boolean => {
    return writePrivateFileWithModeExpectedGuarded(
      ledgerPath,
      prepareLedgerSave(ledger),
      PRIVATE_FILE_MODE,
      expectedState,
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
  const adjudicationReservations = new Set<string>();
  const bindManagerValidationPublication = (
    roundMarker: string,
    publication: FindingManagerReportPublication,
  ): FindingManagerReportPublication => {
    const expectedFileName = findingManagerValidationReportFileName(publication.report);
    const expectedContentSha256 = sha256(managerReportContent(publication.report));
    const expectedPublicationId = computeFindingManagerReportPublicationId({
      roundMarker,
      originRunId: publication.originRunId,
      fileName: publication.fileName,
      contentSha256: publication.contentSha256,
    });
    if (publication.domainId !== publicationDomainId
      || publication.report.runId !== publication.originRunId
      || publication.fileName !== expectedFileName
      || publication.contentSha256 !== expectedContentSha256
      || publication.publicationId !== expectedPublicationId) {
      throw new Error(`Finding manager publication "${publication.publicationId}" failed integrity validation`);
    }
    const currentRunId = boundRunId;
    if (currentRunId === publication.destinationRunId) {
      return publication;
    }
    if (options.trustedResumeSourceRunId !== publication.destinationRunId) {
      throw new Error(
        `Finding manager publication destination "${currentRunId}" is not authorized to inherit `
        + `"${publication.destinationRunId}"`,
      );
    }
    return {
      ...publication,
      destinationRunId: currentRunId,
    };
  };
  const planManagerValidationPublication = (
    roundMarker: string,
    report: FindingManagerValidationReport,
  ): FindingManagerReportPublication => {
    const originRunId = boundRunId;
    if (report.runId !== originRunId) {
      throw new Error(
        `Finding manager report run id "${report.runId}" does not match publication destination "${originRunId}"`,
      );
    }
    const fileName = findingManagerValidationReportFileName(report);
    const contentSha256 = sha256(managerReportContent(report));
    return {
      publicationId: computeFindingManagerReportPublicationId({
        roundMarker,
        originRunId,
        fileName,
        contentSha256,
      }),
      domainId: publicationDomainId,
      originRunId,
      destinationRunId: originRunId,
      fileName,
      contentSha256,
      report,
    };
  };
  const normalizeManagerCommit = <Result>(
    current: FindingLedger,
    commit: FindingManagerLedgerCommit<Result>,
  ): FindingLedgerMutation<Result> => {
    assertFindingManagerLedgerCommit(commit);
    const stagedCandidate = commit.ledger.pendingManagerCommit;
    const requestedStage = commit.publication ?? (
      stagedCandidate === undefined
        ? undefined
        : {
            roundMarker: stagedCandidate.roundMarker,
            report: stagedCandidate.publication.report,
          }
    );
    const completedLedger = stagedCandidate === undefined
      ? commit.ledger
      : {
          workflowName: current.workflowName,
          ...stagedCandidate.completed,
        };
    const completed = normalizeFindingLedgerMutation(
      current,
      { ledger: completedLedger, result: commit.result },
      options.workflowName,
    );
    if (requestedStage === undefined) {
      return completed;
    }
    const publication = bindManagerValidationPublication(
      requestedStage.roundMarker,
      planManagerValidationPublication(
        requestedStage.roundMarker,
        requestedStage.report,
      ),
    );
    const stagedLedger = normalizePendingManagerCommitStage(
      current,
      completed.ledger,
      requestedStage.roundMarker,
      publication,
      options.workflowName,
    );
    if (
      stagedCandidate !== undefined
      && (
        !sameManagerPublication(stagedCandidate.publication, publication)
        || JSON.stringify(normalizeLedger(commit.ledger))
          !== JSON.stringify(stagedLedger)
      )
    ) {
      throw new Error('Finding manager commit contains a forged publication stage');
    }
    return {
      ledger: stagedLedger,
      result: completed.result,
    };
  };

  return {
    runId: boundRunId,
    ledgerIdentity,
    workflowName: options.workflowName,
    loadLedger: loadLedgerImpl,
    updateLedger: (mutator, revalidateBeforeSave) => {
      return runLedgerUpdateExclusive(ledgerIdentity, () => {
        return runPrivateFileExclusive(`${ledgerIdentity}.lock`, () => {
          const snapshot = readProjectLedgerSnapshot(
            ledgerRoot,
            ledgerPath,
            options.workflowName,
          );
          const current = normalizeLedger(snapshot.ledger);
          const mutation = mutator(structuredClone(current));
          const preparedMutation = normalizeMutation(current, mutation);
          if (revalidateBeforeSave === undefined) {
            saveLedgerImpl(preparedMutation.ledger, snapshot.state);
            return preparedMutation;
          }
          const initialDecision = normalizePublicationDecision(
            current,
            revalidateBeforeSave(
              structuredClone(current),
              cloneFindingLedgerMutation(preparedMutation),
            ),
          );
          if (!initialDecision.publish) {
            saveLedgerImpl(initialDecision.mutation.ledger, snapshot.state);
            return initialDecision.mutation;
          }
          let publicationDecision = initialDecision;
          const published = saveLedgerGuardedImpl(initialDecision.mutation.ledger, snapshot.state, () => {
            publicationDecision = normalizePublicationDecision(
              current,
              revalidateBeforeSave(
                structuredClone(current),
                cloneFindingLedgerMutation(initialDecision.mutation),
              ),
            );
            return publicationDecision;
          });
          if (!published) {
            saveLedgerImpl(publicationDecision.mutation.ledger, snapshot.state);
          }
          return publicationDecision.mutation;
        });
      });
    },
    commitManagerLedger: (mutator) => {
      return runLedgerUpdateExclusive(ledgerIdentity, () => {
        return runPrivateFileExclusive(`${ledgerIdentity}.lock`, () => {
          const snapshot = readProjectLedgerSnapshot(
            ledgerRoot,
            ledgerPath,
            options.workflowName,
          );
          const current = normalizeLedger(snapshot.ledger);
          const mutation = normalizeManagerCommit(
            current,
            mutator(structuredClone(current)),
          );
          saveLedgerImpl(mutation.ledger, snapshot.state);
          return mutation;
        });
      });
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
    saveLedgerSnapshot: () => {
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
    },
    saveRawFindings: (runId, stepName, rawFindings) => {
      if (runId !== boundRunId) {
        throw new Error(
          `Raw Finding run "${runId}" does not match the store-bound run identity`,
        );
      }
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
    },
    saveManagerValidationReport: (report) => {
      const fileName = findingManagerValidationReportFileName(report);
      const content = managerReportContent(report);
      const contentSha256 = sha256(content);
      publishReportFile({
        reportDir: options.reportDir,
        fileName,
        content,
        publicationId: sha256(['manager-validation', fileName, contentSha256].join('\0')),
        contentSha256,
      });
    },
    planManagerValidationPublication,
    bindManagerValidationPublication,
    rebindPendingManagerValidationPublication: (publication) => {
      return runLedgerUpdateExclusive(ledgerIdentity, () => {
        return runPrivateFileExclusive(`${ledgerIdentity}.lock`, () => {
          const snapshot = readProjectLedgerSnapshot(
            ledgerRoot,
            ledgerPath,
            options.workflowName,
          );
          const current = normalizeLedger(snapshot.ledger);
          const pending = current.pendingManagerCommit;
          if (pending === undefined) {
            throw new Error(
              `Pending manager commit CAS failed for publication "${publication.publicationId}"`,
            );
          }
          const authorized = bindManagerValidationPublication(
            pending.roundMarker,
            pending.publication,
          );
          if (!sameManagerPublication(authorized, publication)) {
            throw new Error(
              `Finding manager publication "${publication.publicationId}" is not authorized for pending rebind`,
            );
          }
          const rebound = normalizePendingManagerCommitRebind(
            current,
            publication,
            options.workflowName,
          );
          saveLedgerImpl(rebound, snapshot.state);
          return rebound;
        });
      });
    },
    publishManagerValidationPublication: (publication) => {
      const currentRunId = boundRunId;
      if (publication.domainId !== publicationDomainId
        || publication.destinationRunId !== currentRunId) {
        throw new Error(
          `Finding manager publication "${publication.publicationId}" is not bound to this report directory`,
        );
      }
      return publishReportFile({
        reportDir: options.reportDir,
        fileName: publication.fileName,
        content: managerReportContent(publication.report),
        publicationId: publication.publicationId,
        contentSha256: publication.contentSha256,
      });
    },
    finalizeManagerValidationPublication: (publication, receipt) => {
      const currentRunId = boundRunId;
      if (publication.domainId !== publicationDomainId
        || publication.destinationRunId !== currentRunId) {
        throw new Error(
          `Finding manager publication "${publication.publicationId}" is not bound to this report directory`,
        );
      }
      const targetPath = resolveInside(options.reportDir, publication.fileName);
      return runLedgerUpdateExclusive(ledgerIdentity, () => {
        return runPrivateFileExclusive(`${ledgerIdentity}.lock`, () => {
          return finalizeReportPublication(receipt, {
            reportDir: options.reportDir,
            targetPath,
            publicationId: publication.publicationId,
            contentSha256: publication.contentSha256,
          }, () => {
            const snapshot = readProjectLedgerSnapshot(
              ledgerRoot,
              ledgerPath,
              options.workflowName,
            );
            const current = normalizeLedger(snapshot.ledger);
            const pending = current.pendingManagerCommit;
            if (pending === undefined) {
              throw new Error(
                `Pending manager commit CAS failed for publication "${publication.publicationId}"`,
              );
            }
            const expectedPublicationId = computeFindingManagerReportPublicationId({
              roundMarker: pending.roundMarker,
              originRunId: publication.originRunId,
              fileName: publication.fileName,
              contentSha256: publication.contentSha256,
            });
            if (!sameManagerPublication(pending.publication, publication)
              || publication.publicationId !== expectedPublicationId
              || publication.report.runId !== publication.originRunId
              || publication.fileName
                !== findingManagerValidationReportFileName(publication.report)
              || publication.contentSha256 !== sha256(managerReportContent(publication.report))) {
              throw new Error(
                `Finding manager publication "${publication.publicationId}" failed integrity validation`,
              );
            }
            const finalizedLedger = normalizePendingManagerCommitFinalization(
              current,
              publication.publicationId,
              options.workflowName,
            );
            saveLedgerImpl(finalizedLedger, snapshot.state);
            return {
              ledger: finalizedLedger,
              completedRoundMarker: pending.roundMarker,
            };
          });
        });
      });
    },
    saveConflictAdjudicationReport: (report) => {
      const fileName = `findings-adjudication.${sanitizeFileSegment(report.conflictId)}.json`;
      writeReportFile(options.reportDir, fileName, JSON.stringify(report, null, 2));
    },
  };
}

export function resolveFindingLedgerRoot(projectCwd: string): string {
  return resolve(projectCwd);
}

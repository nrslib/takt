import type { FindingLedger } from '../../core/workflow/findings/types.js';
import { canonicalJson, sha256 } from './canonical-json.js';
import type { RunReadContext } from './context.js';
import { readFindingLedgerProjection } from './finding-ledger.js';

export interface TrustedFindingResumeSource {
  readonly sourceRunId: string;
  readonly sourceScopeId: string;
  readonly sourceRevision: number;
  readonly importedRevision: number;
  readonly projectionDigest: string;
  readonly snapshotDigest: string;
}

interface ResumeSourceRow {
  readonly sourceRunId: string;
  readonly sourceSnapshotDigest: string;
  readonly sourceFindingScopeId: string | null;
  readonly sourceFindingRevision: number | null;
  readonly importedFindingRevision: number | null;
  readonly sourceFindingProjectionDigest: string | null;
  readonly depth: number;
}

export function readTrustedFindingResumeSource(
  context: RunReadContext,
  runId: string,
): TrustedFindingResumeSource | undefined {
  const row = context.get<ResumeSourceRow>(`
    SELECT
      sources.source_run_id AS sourceRunId,
      sources.source_snapshot_digest AS sourceSnapshotDigest,
      sources.source_finding_scope_id AS sourceFindingScopeId,
      sources.source_finding_revision AS sourceFindingRevision,
      sources.imported_finding_revision AS importedFindingRevision,
      sources.source_finding_projection_digest AS sourceFindingProjectionDigest,
      ancestry.depth
    FROM run_resume_sources AS sources
    JOIN run_ancestry AS ancestry
      ON ancestry.run_id = sources.run_id
      AND ancestry.ancestor_run_id = sources.source_run_id
      AND ancestry.snapshot_digest = sources.source_snapshot_digest
    WHERE sources.run_id = ?
  `, runId);
  if (row === undefined || row.sourceFindingScopeId === null) {
    return undefined;
  }
  if (
    row.depth !== 1
    || row.sourceFindingRevision === null
    || row.importedFindingRevision === null
    || row.sourceFindingProjectionDigest === null
  ) {
    throw new Error(`Run "${runId}" has invalid direct Finding resume provenance`);
  }
  const imported = readFindingLedgerProjection(context, {
    runId,
    scopeId: 'root',
    revision: row.importedFindingRevision,
  });
  if (
    imported.workflowName.length === 0
    || sha256(canonicalJson(imported.ledger)) !== row.sourceFindingProjectionDigest
  ) {
    throw new Error(`Run "${runId}" imported Finding authority does not match its resume source`);
  }
  return Object.freeze({
    sourceRunId: row.sourceRunId,
    sourceScopeId: row.sourceFindingScopeId,
    sourceRevision: row.sourceFindingRevision,
    importedRevision: row.importedFindingRevision,
    projectionDigest: row.sourceFindingProjectionDigest,
    snapshotDigest: row.sourceSnapshotDigest,
  });
}

export function readImportedFindingLedger(
  context: RunReadContext,
  runId: string,
  source: TrustedFindingResumeSource,
): FindingLedger {
  const stored = readTrustedFindingResumeSource(context, runId);
  if (!sameTrustedFindingResumeSource(stored, source)) {
    throw new Error(`Run "${runId}" Finding resume source is forged or stale`);
  }
  return readFindingLedgerProjection(context, {
    runId,
    scopeId: 'root',
    revision: source.importedRevision,
  }).ledger;
}

export function sameTrustedFindingResumeSource(
  left: TrustedFindingResumeSource | undefined,
  right: TrustedFindingResumeSource | undefined,
): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  return left.sourceRunId === right.sourceRunId
    && left.sourceScopeId === right.sourceScopeId
    && left.sourceRevision === right.sourceRevision
    && left.importedRevision === right.importedRevision
    && left.projectionDigest === right.projectionDigest
    && left.snapshotDigest === right.snapshotDigest;
}

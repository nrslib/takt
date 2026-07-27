import type { DatabaseSync } from 'node:sqlite';
import { canonicalJson, sha256 } from './canonical-json.js';
import { importFindingAuthority } from './finding-ledger.js';
import type { CompleteResumeSnapshot } from './resume-snapshot-types.js';
import {
  assertResumePublicationProvenance,
} from './finding-manager-adapter-contract.js';

export interface TrustedRunStorageResumeSnapshot {
  readonly snapshot: CompleteResumeSnapshot;
  readonly digest: string;
}

export function captureTrustedRunStorageResumeSnapshot(
  snapshot: CompleteResumeSnapshot,
): TrustedRunStorageResumeSnapshot {
  return Object.freeze({
    snapshot,
    digest: sha256(canonicalJson(snapshot)),
  });
}

export function seedRunResumeImport(
  database: DatabaseSync,
  input: {
    readonly childRunId: string;
    readonly childWorkflowName: string;
    readonly findingContractEnabled: boolean;
    readonly source: TrustedRunStorageResumeSnapshot;
  },
): void {
  const source = input.source.snapshot;
  if (sha256(canonicalJson(source)) !== input.source.digest) {
    throw new Error('Run resume source snapshot changed before import');
  }
  const sourceRunId = requiredString(source.run.runId, 'source run id');
  seedAncestry(database, input.childRunId, sourceRunId, input.source);
  const finding = source.findingLedger;
  if ((finding !== null) !== input.findingContractEnabled) {
    throw new Error('Run resume source Finding Contract does not match the child run');
  }
  if (finding === null) {
    insertResumeSource(database, {
      childRunId: input.childRunId,
      sourceRunId,
      sourceSnapshotDigest: input.source.digest,
      finding: null,
    });
    return;
  }
  if (finding.ledger.workflowName !== input.childWorkflowName) {
    throw new Error('Run resume source Finding workflow does not match the child run');
  }
  const pending = finding.ledger.pendingManagerCommit;
  if (
    pending !== undefined
    && pending.publication.destinationRunId !== sourceRunId
  ) {
    throw new Error(
      'Run resume source pending Finding publication is not bound to its direct source run',
    );
  }
  if (pending !== undefined) {
    assertResumePublicationProvenance(
      pending.publication,
      pending.roundMarker,
      {
        directSourceRunId: sourceRunId,
        originRunIds: new Set([
          sourceRunId,
          ...source.ancestry.map((ancestor) => requiredString(
            ancestor.ancestorRunId,
            'ancestor run id',
          )),
        ]),
        originScopeId: 'root',
        workflowName: input.childWorkflowName,
      },
    );
  }
  const projectionDigest = importFindingAuthority({
    run: (sql, ...parameters) => database.prepare(sql).run(...parameters),
  }, {
    runId: input.childRunId,
    scopeId: 'root',
    workflowName: input.childWorkflowName,
    ledger: finding.ledger,
    sourceUpdatedAt: finding.updatedAt,
  });
  insertResumeSource(database, {
    childRunId: input.childRunId,
    sourceRunId,
    sourceSnapshotDigest: input.source.digest,
    finding: {
      sourceRevision: finding.revision,
      projectionDigest,
    },
  });
}

function seedAncestry(
  database: DatabaseSync,
  childRunId: string,
  sourceRunId: string,
  source: TrustedRunStorageResumeSnapshot,
): void {
  database.prepare(`
    INSERT INTO run_ancestry (
      run_id, ancestor_run_id, depth, snapshot_digest
    ) VALUES (?, ?, 1, ?)
  `).run(childRunId, sourceRunId, source.digest);
  source.snapshot.ancestry.forEach((ancestor, index) => {
    const ancestorRunId = requiredString(
      ancestor.ancestorRunId,
      'ancestor run id',
    );
    const depth = requiredPositiveInteger(ancestor.depth, 'ancestor depth');
    const snapshotDigest = requiredDigest(
      ancestor.snapshotDigest,
      'ancestor snapshot digest',
    );
    if (
      depth !== index + 1
      || ancestorRunId === childRunId
      || ancestorRunId === sourceRunId
    ) {
      throw new Error('Run resume source ancestry is not a direct linear chain');
    }
    database.prepare(`
      INSERT INTO run_ancestry (
        run_id, ancestor_run_id, depth, snapshot_digest
      ) VALUES (?, ?, ?, ?)
    `).run(childRunId, ancestorRunId, depth + 1, snapshotDigest);
  });
}

function insertResumeSource(
  database: DatabaseSync,
  input: {
    readonly childRunId: string;
    readonly sourceRunId: string;
    readonly sourceSnapshotDigest: string;
    readonly finding: {
      readonly sourceRevision: number;
      readonly projectionDigest: string;
    } | null;
  },
): void {
  const finding = input.finding === null
    ? {
        scopeId: null,
        sourceRevision: null,
        importedRevision: null,
        projectionDigest: null,
      }
    : {
        scopeId: 'root',
        sourceRevision: input.finding.sourceRevision,
        importedRevision: 1,
        projectionDigest: input.finding.projectionDigest,
      };
  database.prepare(`
    INSERT INTO run_resume_sources (
      run_id,
      source_run_id,
      source_snapshot_digest,
      source_finding_scope_id,
      source_finding_revision,
      imported_finding_revision,
      source_finding_projection_digest
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.childRunId,
    input.sourceRunId,
    input.sourceSnapshotDigest,
    finding.scopeId,
    finding.sourceRevision,
    finding.importedRevision,
    finding.projectionDigest,
  );
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Run resume source ${label} is invalid`);
  }
  return value;
}

function requiredPositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error(`Run resume source ${label} is invalid`);
  }
  return Number(value);
}

function requiredDigest(value: unknown, label: string): string {
  const digest = requiredString(value, label);
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    throw new Error(`Run resume source ${label} is invalid`);
  }
  return digest;
}

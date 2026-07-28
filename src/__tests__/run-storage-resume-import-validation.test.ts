import { afterEach, describe, expect, it } from 'vitest';
import { validateResumeImportSnapshot } from '../infra/run-storage/resume-import-validation.js';
import type { CompleteResumeSnapshot } from '../infra/run-storage/resume-snapshot-types.js';
import { canonicalJson, sha256 } from '../infra/run-storage/canonical-json.js';
import { createEngineProofRecord } from '../core/models/finding-evidence-record.js';
import {
  cleanupRealRunStorages,
  createRealRunStorage,
} from './helpers/run-storage.js';

afterEach(cleanupRealRunStorages);

function snapshot(findingContractEnabled: boolean): CompleteResumeSnapshot {
  const storage = createRealRunStorage({ findingContractEnabled });
  const value = storage.root.readResumeSnapshot();
  storage.root.close();
  return structuredClone(value);
}

describe('run storage resume import validation', () => {
  it('duplicate scope identityをimport前に拒否する', () => {
    const source = snapshot(true);
    const duplicate = {
      ...source,
      scopes: [...source.scopes, source.scopes[0]!],
    };

    expect(() => validateResumeImportSnapshot(duplicate, {
      childWorkflowName: 'default',
      findingContractEnabled: true,
    })).toThrow(/duplicate scope "root"/i);
  });

  it('Finding revisionの期待集合に対する余剰を拒否する', () => {
    const source = snapshot(true);
    const extraRevision = {
      ...source.findingRevisions[0]!,
      revision: 2,
    };
    const invalid = {
      ...source,
      findingRevisions: [...source.findingRevisions, extraRevision],
    };

    expect(() => validateResumeImportSnapshot(invalid, {
      childWorkflowName: 'default',
      findingContractEnabled: true,
    })).toThrow(/Finding revisions mismatch.*extra=\[root\/2\]/i);
  });

  it('root current projectionとFinding ledgerの不一致を拒否する', () => {
    const source = snapshot(true);
    if (source.findingLedger === null) {
      throw new Error('Expected Finding projection');
    }
    const invalid = {
      ...source,
      findingLedger: {
        ...source.findingLedger,
        ledger: {
          ...source.findingLedger.ledger,
          nextId: source.findingLedger.ledger.nextId + 1,
        },
      },
    };

    expect(() => validateResumeImportSnapshot(invalid, {
      childWorkflowName: 'default',
      findingContractEnabled: true,
    })).toThrow(/root Finding projection does not match/i);
  });

  it('currentがvalidでもforged historical revisionを拒否する', async () => {
    const storage = createRealRunStorage({ findingContractEnabled: true });
    const lease = storage.root.claimLease({
      ownerKey: 'historical-revision-validation',
      leaseDurationMs: 9_000,
    });
    const runtime = storage.root.runtime({ lease });
    const execution = runtime.execution.startStep({
      stepKey: 'findings-manager',
      expectedScopeRevision: 0,
    });
    const store = runtime.findingManager({
      workflowName: 'default',
      producer: execution.handle,
    });
    await store.updateLedger((ledger) => ({
      ledger: {
        ...ledger,
        stopBudget: {
          roundMarkers: ['revision-2'],
          firstRoundAt: ledger.updatedAt,
          exhausted: false,
        },
      },
      result: undefined,
    }));
    const source = structuredClone(storage.root.readResumeSnapshot());
    storage.root.close();
    const revision1 = source.findingRevisions.find(
      (row) => row.scope_id === 'root' && row.revision === 1,
    )!;
    const forgedEvidence = {
      evidenceId: sha256('forged-evidence-id'),
      kind: 'file_quote',
      path: 'src/a.ts',
      startLine: 1,
      endLine: 1,
      verbatimExcerpt: 'one',
      snapshotId: sha256('snapshot'),
      claimIdentityHash: sha256('claim'),
      fileHash: sha256('file'),
    };
    const record = canonicalJson(forgedEvidence);
    const historicalProjection = {
      workflowName: 'default',
      nextId: 1,
      updatedAt: new Date(Number(revision1.updated_at)).toISOString(),
      findings: [],
      evidenceRecords: [forgedEvidence],
      rawFindings: [],
      conflicts: [],
      interpretations: [],
    };
    const projectionDigest = sha256(canonicalJson(historicalProjection));
    const invalid = {
      ...source,
      findingEntries: [...source.findingEntries, {
        scopeId: 'root',
        revision: 1,
        ordinal: 0,
        entryKind: 'evidence',
        authorityId: forgedEvidence.evidenceId,
        record,
        digest: sha256(record),
      }],
      findingRevisions: source.findingRevisions.map((row) => (
        row === revision1
          ? {
              ...row,
              evidence_record_count: 1,
              projection_digest: projectionDigest,
            }
          : row
      )),
      findingPublications: source.findingPublications.map((row) => (
        row.scopeId === 'root' && row.revision === 1
          ? { ...row, projectionDigest }
          : row
      )),
    };

    expect(() => validateResumeImportSnapshot(invalid, {
      childWorkflowName: 'default',
      findingContractEnabled: true,
    })).toThrow(/canonical content address/i);
  });

  it('revision履歴でraw findingの削除・差替えを拒否する', async () => {
    const storage = createRealRunStorage({ findingContractEnabled: true });
    const lease = storage.root.claimLease({
      ownerKey: 'append-only-history-validation',
      leaseDurationMs: 9_000,
    });
    const runtime = storage.root.runtime({ lease });
    const execution = runtime.execution.startStep({
      stepKey: 'findings-manager',
      expectedScopeRevision: 0,
    });
    const store = runtime.findingManager({
      workflowName: 'default',
      producer: execution.handle,
    });
    const originalRaw = {
      rawFindingId: 'raw-history-1',
      stepName: 'review',
      reviewer: 'reviewer',
      familyTag: 'bug',
      severity: 'high' as const,
      title: 'Historical issue',
      description: 'Original immutable observation.',
      suggestion: null,
      relation: 'new' as const,
      targetFindingId: null,
      evidence: [],
    };
    await store.updateLedger((ledger) => ({
      ledger: {
        ...ledger,
        rawFindings: [originalRaw],
      },
      result: undefined,
    }));
    await store.updateLedger((ledger) => ({
      ledger: {
        ...ledger,
        stopBudget: {
          roundMarkers: ['history-revision'],
          firstRoundAt: ledger.updatedAt,
          exhausted: false,
        },
      },
      result: undefined,
    }));
    const source = structuredClone(storage.root.readResumeSnapshot());
    storage.root.close();
    if (source.findingLedger === null) {
      throw new Error('Expected Finding projection');
    }
    const currentRevision = source.findingHeads.find(
      (row) => row.scope_id === 'root',
    )!.current_revision as number;

    for (const variant of ['removed', 'replaced'] as const) {
      const replacementRaw = {
        ...originalRaw,
        description: 'Forged replacement observation.',
      };
      const rawFindings = variant === 'removed' ? [] : [replacementRaw];
      const forgedLedger = {
        ...source.findingLedger.ledger,
        rawFindings,
      };
      const projectionDigest = sha256(canonicalJson(forgedLedger));
      const invalid: CompleteResumeSnapshot = {
        ...source,
        findingLedger: {
          ...source.findingLedger,
          ledger: forgedLedger,
        },
        findingEntries: source.findingEntries.flatMap((row) => {
          if (
            row.scopeId !== 'root'
            || row.revision !== currentRevision
            || row.entryKind !== 'raw'
          ) {
            return [row];
          }
          if (variant === 'removed') {
            return [];
          }
          const record = canonicalJson(replacementRaw);
          return [{
            ...row,
            record,
            digest: sha256(record),
          }];
        }),
        findingRevisions: source.findingRevisions.map((row) => (
          row.scope_id === 'root' && row.revision === currentRevision
            ? {
                ...row,
                raw_finding_count: rawFindings.length,
                projection_digest: projectionDigest,
              }
            : row
        )),
        findingPublications: source.findingPublications.map((row) => (
          row.scopeId === 'root' && row.revision === currentRevision
            ? { ...row, projectionDigest }
            : row
        )),
      };

      expect(() => validateResumeImportSnapshot(invalid, {
        childWorkflowName: 'default',
        findingContractEnabled: true,
      })).toThrow(
        variant === 'removed'
          ? /cannot be removed from the append-only ledger/
          : /cannot be replaced with different content/,
      );
    }
  });

  it('final revisionがpending completedのstaged raw/evidenceを昇格しなければ再封印後も拒否する', async () => {
    const storage = createRealRunStorage({ findingContractEnabled: true });
    const lease = storage.root.claimLease({
      ownerKey: 'pending-finalization-history-validation',
      leaseDurationMs: 9_000,
    });
    const runtime = storage.root.runtime({ lease });
    const execution = runtime.execution.startStep({
      stepKey: 'findings-manager',
      expectedScopeRevision: 0,
    });
    const store = runtime.findingManager({
      workflowName: 'default',
      producer: execution.handle,
    });
    const claimIdentityHash = sha256('pending-finalization-claim');
    const evidenceRecord = createEngineProofRecord({
      kind: 'engine_proof',
      verifierId: 'takt.pending-transition-test',
      verifierVersion: '1',
      workflowName: 'default',
      runId: store.runId,
      scopeIdentity: store.ledgerIdentity,
      snapshotId: sha256('pending-finalization-snapshot'),
      claimIdentityHash,
      targetFindingId: null,
      subject: {
        kind: 'named_structural_check',
        checkId: 'pending-finalization',
        parameters: {},
      },
      dependencyDigests: [],
      resultDigest: sha256('pending-finalization-result'),
      issuedAt: '2026-07-28T00:00:00.000Z',
    });
    const rawFinding = {
      rawFindingId: 'raw-pending-finalization',
      stepName: 'review',
      reviewer: 'reviewer',
      familyTag: 'integrity',
      severity: 'high' as const,
      title: 'Pending finalization observation',
      description: 'This staged observation must be promoted atomically.',
      suggestion: null,
      relation: 'new' as const,
      targetFindingId: null,
      evidence: [{ kind: 'engine_proof' as const, proofId: evidenceRecord.proofId }],
    };
    const roundMarker = 'pending-finalization-round';
    const staged = await store.commitManagerLedger((current) => ({
      ledger: {
        ...current,
        evidenceRecords: [evidenceRecord],
        rawFindings: [rawFinding],
        stopBudget: {
          roundMarkers: [roundMarker],
          firstRoundAt: current.updatedAt,
          exhausted: false,
        },
      },
      publication: {
        roundMarker,
        report: {
          version: 1,
          runId: store.runId,
          stepName: 'review',
          retryCount: 0,
          ledgerUpdated: true,
          finalErrors: [],
          attempts: [],
        },
      },
      result: undefined,
    }));
    const publication = staged.ledger.pendingManagerCommit!.publication;
    const receipt = store.publishManagerValidationPublication(publication);
    await store.finalizeManagerValidationPublication(publication, receipt);
    const source = structuredClone(storage.root.readResumeSnapshot());
    storage.root.close();
    if (source.findingLedger === null) {
      throw new Error('Expected Finding projection');
    }
    const finalRevision = source.findingLedger.revision;
    const forgedLedger = {
      ...source.findingLedger.ledger,
      evidenceRecords: [],
      rawFindings: [],
    };
    const projectionDigest = sha256(canonicalJson(forgedLedger));
    const invalid: CompleteResumeSnapshot = {
      ...source,
      findingLedger: {
        ...source.findingLedger,
        ledger: forgedLedger,
      },
      findingEntries: source.findingEntries.filter((row) => (
        row.scopeId !== 'root'
        || row.revision !== finalRevision
        || (row.entryKind !== 'raw' && row.entryKind !== 'evidence')
      )),
      findingRevisions: source.findingRevisions.map((row) => (
        row.scope_id === 'root' && row.revision === finalRevision
          ? {
              ...row,
              raw_finding_count: 0,
              evidence_record_count: 0,
              projection_digest: projectionDigest,
            }
          : row
      )),
      findingPublications: source.findingPublications.map((row) => (
        row.scopeId === 'root' && row.revision === finalRevision
          ? { ...row, projectionDigest }
          : row
      )),
    };

    expect(() => validateResumeImportSnapshot(invalid, {
      childWorkflowName: 'default',
      findingContractEnabled: true,
    })).toThrow(/finalization does not match its completed projection/i);
  });

  it('pending revision間でcompleted projectionを差し替えた履歴を拒否する', async () => {
    const storage = createRealRunStorage({ findingContractEnabled: true });
    const lease = storage.root.claimLease({
      ownerKey: 'pending-replacement-history-validation',
      leaseDurationMs: 9_000,
    });
    const runtime = storage.root.runtime({ lease });
    const execution = runtime.execution.startStep({
      stepKey: 'findings-manager',
      expectedScopeRevision: 0,
    });
    const store = runtime.findingManager({
      workflowName: 'default',
      producer: execution.handle,
    });
    const roundMarker = 'pending-replacement-round';
    await store.commitManagerLedger((current) => ({
      ledger: {
        ...current,
        stopBudget: {
          roundMarkers: [roundMarker],
          firstRoundAt: current.updatedAt,
          exhausted: false,
        },
      },
      publication: {
        roundMarker,
        report: {
          version: 1,
          runId: store.runId,
          stepName: 'review',
          retryCount: 0,
          ledgerUpdated: false,
          finalErrors: [],
          attempts: [],
        },
      },
      result: undefined,
    }));
    const source = structuredClone(storage.root.readResumeSnapshot());
    storage.root.close();
    if (source.findingLedger === null) {
      throw new Error('Expected Finding projection');
    }
    const pendingRevision = source.findingLedger.revision;
    const forgedRevision = pendingRevision + 1;
    const pendingControl = source.findingControls.find((row) => (
      row.scopeId === 'root'
      && row.revision === pendingRevision
      && row.controlKind === 'pending_manager_commit'
    ))!;
    const forgedPending = JSON.parse(String(pendingControl.record)) as {
      completed: { nextId: number };
    };
    forgedPending.completed.nextId += 1;
    const forgedLedger = {
      ...source.findingLedger.ledger,
      pendingManagerCommit: forgedPending,
    };
    const projectionDigest = sha256(canonicalJson(forgedLedger));
    const revisionRow = source.findingRevisions.find((row) => (
      row.scope_id === 'root' && row.revision === pendingRevision
    ))!;
    const publicationRow = source.findingPublications.find((row) => (
      row.scopeId === 'root' && row.revision === pendingRevision
    ))!;
    const invalid: CompleteResumeSnapshot = {
      ...source,
      findingLedger: {
        ...source.findingLedger,
        revision: forgedRevision,
        ledger: forgedLedger,
      },
      findingHeads: source.findingHeads.map((row) => (
        row.scope_id === 'root'
          ? { ...row, current_revision: forgedRevision }
          : row
      )),
      findingRevisions: [
        ...source.findingRevisions,
        {
          ...revisionRow,
          revision: forgedRevision,
          projection_digest: projectionDigest,
        },
      ],
      findingPublications: [
        ...source.findingPublications,
        {
          ...publicationRow,
          revision: forgedRevision,
          projectionDigest,
        },
      ],
      findingEntries: [
        ...source.findingEntries,
        ...source.findingEntries
          .filter((row) => row.scopeId === 'root' && row.revision === pendingRevision)
          .map((row) => ({ ...row, revision: forgedRevision })),
      ],
      findingControls: [
        ...source.findingControls,
        ...source.findingControls
          .filter((row) => row.scopeId === 'root' && row.revision === pendingRevision)
          .map((row) => {
            if (row.controlKind !== 'pending_manager_commit') {
              return { ...row, revision: forgedRevision };
            }
            const record = canonicalJson(forgedPending);
            return {
              ...row,
              revision: forgedRevision,
              record,
              digest: sha256(record),
            };
          }),
      ],
    };

    expect(() => validateResumeImportSnapshot(invalid, {
      childWorkflowName: 'default',
      findingContractEnabled: true,
    })).toThrow(/pending commit was replaced or mutated/i);
  });

  it('Finding Contract無効時はすべてのFinding配列を空に要求する', () => {
    const source = snapshot(false);
    const invalid = {
      ...source,
      findingPublications: [{
        scopeId: 'root',
        revision: 1,
      }],
    };

    expect(() => validateResumeImportSnapshot(invalid, {
      childWorkflowName: 'default',
      findingContractEnabled: false,
    })).toThrow(/Finding authority while disabled/i);
  });

  it('child own-contract current revisionのpending publication provenanceを検証する', async () => {
    const storage = createRealRunStorage({ findingContractEnabled: true });
    const lease = storage.root.claimLease({
      ownerKey: 'child-pending-validation',
      leaseDurationMs: 9_000,
    });
    const runtime = storage.root.runtime({ lease });
    const childScope = runtime.scopes.resolveWorkflowCallChild({
      scopeKey: 'child-own-contract',
      findingContractEnabled: true,
      workflowDefinition: {
        name: 'child',
        codecName: 'json-v1',
        definition: '{"name":"child"}',
      },
    });
    const childRuntime = storage.root.runtime({ lease, scope: childScope });
    const execution = childRuntime.execution.startStep({
      stepKey: 'child-manager',
      expectedScopeRevision: 0,
    });
    const store = childRuntime.findingManager({
      workflowName: 'child',
      producer: execution.handle,
    });
    await store.commitManagerLedger((current) => ({
      ledger: {
        ...current,
        stopBudget: {
          roundMarkers: ['child-pending'],
          firstRoundAt: current.updatedAt,
          exhausted: false,
        },
      },
      publication: {
        roundMarker: 'child-pending',
        report: {
          version: 1,
          runId: store.runId,
          stepName: 'child-review',
          retryCount: 0,
          ledgerUpdated: false,
          finalErrors: [],
          attempts: [],
        },
      },
      result: undefined,
    }));
    const currentLedger = store.loadLedger();
    const source = structuredClone(storage.root.readResumeSnapshot());
    storage.root.close();
    const childHead = source.findingHeads.find(
      (head) => head.scope_id !== 'root',
    )!;
    const scopeId = String(childHead.scope_id);
    const revision = Number(childHead.current_revision);
    const control = source.findingControls.find(
      (row) => row.scopeId === scopeId
        && row.revision === revision
        && row.controlKind === 'pending_manager_commit',
    )!;
    const pending = JSON.parse(String(control.record)) as {
      publication: { destinationRunId: string };
    };
    pending.publication.destinationRunId = 'forged-source';
    const record = JSON.stringify(pending);
    const ledger = {
      ...currentLedger,
      pendingManagerCommit: pending,
    };
    const projectionDigest = sha256(canonicalJson(ledger));
    const invalid = {
      ...source,
      findingControls: source.findingControls.map((row) => (
        row === control
          ? { ...row, record, digest: sha256(record) }
          : row
      )),
      findingRevisions: source.findingRevisions.map((row) => (
        row.scope_id === scopeId && row.revision === revision
          ? { ...row, projection_digest: projectionDigest }
          : row
      )),
      findingPublications: source.findingPublications.map((row) => (
        row.scopeId === scopeId && row.revision === revision
          ? { ...row, projectionDigest }
          : row
      )),
    };

    expect(() => validateResumeImportSnapshot(invalid, {
      childWorkflowName: 'default',
      findingContractEnabled: true,
    })).toThrow(/resume provenance validation/i);
  });
});

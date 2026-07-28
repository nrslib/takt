import { afterEach, describe, expect, it } from 'vitest';
import { validateResumeImportSnapshot } from '../infra/run-storage/resume-import-validation.js';
import type { CompleteResumeSnapshot } from '../infra/run-storage/resume-snapshot-types.js';
import { canonicalJson, sha256 } from '../infra/run-storage/canonical-json.js';
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

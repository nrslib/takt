import { afterEach, describe, expect, it } from 'vitest';
import { validateResumeImportSnapshot } from '../infra/run-storage/resume-import-validation.js';
import type { CompleteResumeSnapshot } from '../infra/run-storage/resume-snapshot-types.js';
import {
  cleanupRealRunStorages,
  createRealRunStorage,
} from './helpers/run-storage.js';

afterEach(cleanupRealRunStorages);

function snapshot(findingContractEnabled: boolean): CompleteResumeSnapshot {
  const storage = createRealRunStorage({ findingContractEnabled });
  const value = structuredClone(storage.root.readResumeSnapshot());
  storage.root.close();
  return value;
}

async function snapshotWithFindingRevision(): Promise<CompleteResumeSnapshot> {
  const storage = createRealRunStorage({ findingContractEnabled: true });
  const lease = storage.root.claimLease({
    ownerKey: 'resume-validation',
    leaseDurationMs: 9_000,
  });
  const runtime = storage.root.runtime({ lease });
  const execution = runtime.execution.startStep({
    stepKey: 'finding-manager',
    expectedScopeRevision: 0,
  });
  const manager = runtime.findingManager({
    workflowName: 'default',
    producer: execution.handle,
  });
  await manager.updateLedger((ledger) => ({
    ledger: {
      ...ledger,
      stopBudget: {
        roundMarkers: ['round-1'],
        firstRoundAt: ledger.updatedAt,
        exhausted: false,
      },
    },
    result: undefined,
  }));
  const value = structuredClone(storage.root.readResumeSnapshot());
  storage.root.close();
  return value;
}

describe('run storage resume import validation', () => {
  it('accepts the current projection without workflow or engine audit state', async () => {
    const source = await snapshotWithFindingRevision();

    const validated = validateResumeImportSnapshot(source);

    expect(validated.scopes.has('root')).toBe(true);
    expect(validated.findings.has('root')).toBe(true);
  });

  it('rejects duplicate scope identity before import', () => {
    const source = snapshot(true);
    const duplicate = {
      ...source,
      scopes: [...source.scopes, source.scopes[0]!],
    };

    expect(() => validateResumeImportSnapshot(duplicate))
      .toThrow(/scope "root" is duplicated/i);
  });

  it('rejects a source whose run aggregate differs from its scopes', () => {
    const source = snapshot(false);
    const invalid = {
      ...source,
      run: { ...source.run, findingContractEnabled: 1 },
    };

    expect(() => validateResumeImportSnapshot(invalid))
      .toThrow(/aggregate is invalid/i);
  });

  it('rejects a scope graph that is not rooted at root', () => {
    const source = snapshot(true);
    const invalid = {
      ...source,
      scopes: source.scopes.map((scope) => (
        scope.scopeId === 'root'
          ? { ...scope, parentScopeId: 'missing' }
          : scope
      )),
    };

    expect(() => validateResumeImportSnapshot(invalid))
      .toThrow(/root scope identity is invalid/i);
  });

  it('rejects a head without its current revision', async () => {
    const source = await snapshotWithFindingRevision();
    const invalid = {
      ...source,
      findingRevisions: [],
    };

    expect(() => validateResumeImportSnapshot(invalid))
      .toThrow(/has no current revision/i);
  });

  it('rejects current rows whose revision differs from the head', async () => {
    const source = await snapshotWithFindingRevision();
    const invalid = {
      ...source,
      findingControls: source.findingControls.map((row, index) => (
        index === 0 ? { ...row, revision: 999 } : row
      )),
    };

    expect(() => validateResumeImportSnapshot(invalid))
      .toThrow(/is not from its current revision/i);
  });

  it('rejects sealed counts that differ from the current projection', async () => {
    const source = await snapshotWithFindingRevision();
    const invalid = {
      ...source,
      findingRevisions: source.findingRevisions.map((revision) => ({
        ...revision,
        control_count: Number(revision.control_count) + 1,
      })),
    };

    expect(() => validateResumeImportSnapshot(invalid))
      .toThrow(/control count/i);
  });
});

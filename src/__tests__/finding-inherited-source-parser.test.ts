import { describe, expect, it } from 'vitest';
import { createEmptyFindingContractRegistries } from '../core/models/finding-contract-seed.js';
import {
  classifyInheritedSourceShape,
  LegacyPendingManagerCommitError,
  parseInheritedSourceAuthority,
} from '../infra/finding-storage/inherited-source-parser.js';

const TIMESTAMP = '2026-08-03T00:00:00.000Z';

function currentLedger() {
  return {
    workflowName: 'review',
    nextId: 1,
    updatedAt: TIMESTAMP,
    findings: [],
    evidenceRecords: [],
    evidenceBindings: [],
    lifecycleReservations: [],
    lifecycleEvents: [],
    rawFindings: [],
    conflicts: [],
    ...createEmptyFindingContractRegistries(),
  };
}

function source(ledger: object) {
  return {
    authorityKey: 'root',
    workflowName: 'review',
    revision: 3,
    ledgerJson: JSON.stringify(ledger),
  };
}

describe('inherited finding source parser', () => {
  it('classifies both normalization registries as current without legacy fallback', () => {
    expect(classifyInheritedSourceShape(currentLedger()).kind).toBe('current');
    expect(parseInheritedSourceAuthority(source(currentLedger())).kind).toBe('current');

    const broken = { ...currentLedger(), findings: 'broken' };
    expect(() => parseInheritedSourceAuthority(source(broken))).toThrow();
  });

  it('rejects a partial normalization registry before schema selection', () => {
    const { provisionalConflictNormalizations: _records, ...partial } = currentLedger();
    expect(() => classifyInheritedSourceShape(partial)).toThrow(
      /partial provisional conflict normalization registry/,
    );
  });

  it('fails closed on a legacy pending manager commit before frozen schema parsing', () => {
    const {
      provisionalConflictNormalizationSnapshots: _snapshots,
      provisionalConflictNormalizations: _records,
      ...legacy
    } = currentLedger();
    const pending = {
      ...legacy,
      pendingManagerCommit: {
        roundMarker: 'round-3',
        publication: { publicationId: 'publication-3' },
      },
    };
    try {
      parseInheritedSourceAuthority(source(pending));
      throw new Error('Expected legacy pending preflight to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(LegacyPendingManagerCommitError);
      expect((error as LegacyPendingManagerCommitError).failure).toMatchObject({
        code: 'legacy_pending_manager_commit',
        roundMarker: 'round-3',
        publicationId: 'publication-3',
        retryCondition: 'source ledger_json has no top-level pendingManagerCommit property',
      });
    }
  });
});

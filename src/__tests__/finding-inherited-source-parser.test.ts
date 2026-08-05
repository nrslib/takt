import { describe, expect, it } from 'vitest';
import { createEmptyFindingContractRegistries } from '../core/models/finding-contract-seed.js';
import { parseInheritedSourceAuthority } from '../infra/finding-storage/inherited-source-parser.js';

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
  it('should parse the inherited authority when the ledger matches the current contract', () => {
    const ledger = parseInheritedSourceAuthority(source(currentLedger()));
    expect(ledger.workflowName).toBe('review');
    expect(ledger.findings).toEqual([]);
  });

  it('should reject an inherited authority when the ledger does not match the current contract', () => {
    // FC 台帳に後方互換は持たない: 現行 schema と異なる形（旧形式・壊れた形）は
    // 変換や救済をせず、そのまま parse 失敗として弾く。
    const broken = { ...currentLedger(), findings: 'broken' };
    expect(() => parseInheritedSourceAuthority(source(broken))).toThrow();

    const legacyShape: Record<string, unknown> = { ...currentLedger() };
    delete legacyShape.reviewerAnomalies;
    delete legacyShape.reviewIntegrity;
    legacyShape.unknownLegacyKey = [];
    expect(() => parseInheritedSourceAuthority(source(legacyShape))).toThrow();
  });

  it('should reject invalid source metadata before reading the ledger', () => {
    expect(() => parseInheritedSourceAuthority({
      authorityKey: '',
      workflowName: 'review',
      revision: 1,
      ledgerJson: JSON.stringify(currentLedger()),
    })).toThrow(/invalid metadata/);
  });
});

import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEmptyFindingContractRegistries } from '../core/models/finding-contract-seed.js';
import { parseInheritedSourceAuthority } from '../infra/finding-storage/inherited-source-parser.js';
import { FindingDatabase } from '../infra/finding-storage/database.js';
import { readSourceAuthorityRaw } from '../infra/finding-storage/repository.js';
import { ROOT_FINDING_AUTHORITY_KEY } from '../infra/finding-storage/resolver.js';
import { buildRunPaths } from '../core/workflow/run/run-paths.js';
import {
  cleanupTestFindingStorage,
  createTestFindingLedgerStore,
} from './helpers/finding-storage.js';

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

  it('should round-trip a ledger written by the current store through the inherited parser', async () => {
    // 現行エンジンの store 書き込み(sqlite ledger_json)を、そのまま
    // parseInheritedSourceAuthority で読めることを固定する — e2e helper /
    // requeue 継承が使う唯一の読み経路。
    const projectCwd = mkdtempSync(join(tmpdir(), 'takt-inherited-roundtrip-'));
    const runId = 'roundtrip-run';
    try {
      const store = createTestFindingLedgerStore({
        projectCwd,
        runId,
        reportDir: projectCwd,
        workflowName: 'review',
      });
      await store.updateLedger((current) => ({
        ledger: { ...current, updatedAt: TIMESTAMP },
        result: undefined,
      }));
      const written = store.loadLedger();
      const source = FindingDatabase.readSource({
        databasePath: buildRunPaths(projectCwd, runId).findingContractDatabaseAbs,
        runId,
        read: (database) => readSourceAuthorityRaw(database, ROOT_FINDING_AUTHORITY_KEY),
      });
      expect(source).toBeDefined();
      const parsed = parseInheritedSourceAuthority(source!);
      expect(parsed).toEqual(written);
    } finally {
      cleanupTestFindingStorage();
      rmSync(projectCwd, { recursive: true, force: true });
    }
  });
});

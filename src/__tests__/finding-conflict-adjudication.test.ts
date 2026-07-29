/**
 * Phase B of the Finding Contract convergence design: conflict adjudication.
 * Covers the pure logic (evidenceHash, engine-derived transitions,
 * ledger application, FindingsRuleContext.conflicts.unadjudicated)
 * without spinning up a full WorkflowEngine — the engine-level detour
 * (routing back to the originating step / ABORT, the 1-attempt gate observed
 * through actual rule evaluation) is covered separately in
 * finding-conflict-adjudication-engine.test.ts.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const reviewScopeSnapshot = vi.hoisted(() => ({
  id: 'd'.repeat(64),
}));

vi.mock('../core/workflow/findings/snapshot.js', async () => {
  const actual = await vi.importActual<typeof import('../core/workflow/findings/snapshot.js')>(
    '../core/workflow/findings/snapshot.js',
  );
  return {
    ...actual,
    computeReviewScopeSnapshotId: () => reviewScopeSnapshot.id,
  };
});
import {
  FINDING_CONFLICT_ADJUDICATION_OUTCOME_TRANSITION,
  applyFindingConflictAdjudication,
  resolveAdjudicationDisposition,
  selectConflictForAdjudication,
} from '../core/workflow/findings/adjudication-apply.js';
import { computeConflictEvidenceHash as computeConflictEvidenceHashWithScope, isConflictUnadjudicated } from '../core/workflow/findings/adjudication-evidence.js';
import { buildFindingsRuleContext as buildFindingsRuleContextWithScope } from '../core/workflow/findings/context.js';
import { computeReviewScopeSnapshotId } from '../core/workflow/findings/snapshot.js';
import { computeFileQuoteEvidenceRecordId } from '../core/models/finding-evidence-record.js';
import type {
  FindingConflictAdjudicationOutput,
  FindingLedger,
  FindingLedgerConflict,
  FindingLedgerEntry,
  RawFinding,
  VerifiedFileQuoteEvidenceRecord,
} from '../core/workflow/findings/types.js';
import { canonicalRawFindingFixture } from './helpers/finding-lifecycle-fixture.js';

function makeEvidenceRecord(
  path = 'src/a.ts',
  startLine = 10,
): VerifiedFileQuoteEvidenceRecord {
  const payload = {
    kind: 'file_quote' as const,
    path,
    startLine,
    endLine: startLine,
    verbatimExcerpt: `// line ${startLine}`,
    snapshotId: 'a'.repeat(64),
    claimIdentityHash: 'b'.repeat(64),
    fileHash: 'c'.repeat(64),
  };
  return {
    evidenceId: computeFileQuoteEvidenceRecordId(payload),
    ...payload,
  };
}

function computeConflictEvidenceHash(
  conflict: FindingLedgerConflict,
  ledger: FindingLedger,
): string {
  return computeConflictEvidenceHashWithScope(conflict, ledger, computeReviewScopeSnapshotId(process.cwd()));
}

function buildFindingsRuleContext(ledger: FindingLedger) {
  return buildFindingsRuleContextWithScope(ledger, process.cwd());
}

function makeRaw(overrides: Partial<RawFinding> = {}): RawFinding {
  const base = canonicalRawFindingFixture({
    rawFindingId: 'raw-1',
    stepName: 'reviewers',
    reviewer: 'coding-review',
    familyTag: 'bug',
    severity: 'high',
    title: 'Disputed issue',
    description: 'The bug is present.',
    suggestion: null,
    relation: 'new',
    targetFindingId: null,
    target: { kind: 'code', paths: ['src/a.ts'] },
    evidence: [{
      kind: 'file_quote',
      path: 'src/a.ts',
      startLine: 10,
      endLine: 10,
      verbatimExcerpt: '// line 10',
      snapshotId: 'a'.repeat(64),
    }],
  });
  const {
    targetIdentityHash: _targetIdentityHash,
    claimIdentityHash: _claimIdentityHash,
    semanticClaimIdentityHash: _semanticClaimIdentityHash,
    candidateIdentityHash: _candidateIdentityHash,
    target,
    sourceBinding,
    ...raw
  } = { ...base, ...overrides };
  return canonicalRawFindingFixture({
    ...raw,
    target,
    sourceBinding,
  });
}

function makeFinding(
  overrides: Pick<FindingLedgerEntry, 'revision'> & Partial<Omit<FindingLedgerEntry, 'revision'>>,
): FindingLedgerEntry {
  const evidenceRecord = makeEvidenceRecord();
  const raw = makeRaw();
  return {
    id: 'F-0001',
    status: 'open',
    lifecycle: 'new',
    target: raw.target,
    targetIdentityHash: raw.targetIdentityHash,
    claimIdentityHash: raw.claimIdentityHash,
    semanticClaimIdentityHash: raw.semanticClaimIdentityHash,
    severity: 'high',
    title: 'Disputed issue',
    evidenceIds: [evidenceRecord.evidenceId],
    reviewers: ['coding-review'],
    rawFindingIds: ['raw-1'],
    firstSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
    lastSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
    ...overrides,
  };
}

function makeConflict(overrides: Partial<FindingLedgerConflict> = {}): FindingLedgerConflict {
  return {
    id: 'C-FA2947446963',
    status: 'active',
    findingIds: ['F-0001'],
    rawFindingIds: [],
    description: 'Reviewers disagree about F-0001.',
    firstSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
    lastSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
    ...overrides,
  };
}

function makeLedger(overrides: Partial<FindingLedger> = {}): FindingLedger {
  const evidenceRecord = makeEvidenceRecord();
  return {
    workflowName: 'test-workflow',
    nextId: 2,
    updatedAt: '2026-06-13T00:00:00.000Z',
    findings: [makeFinding({ revision: 1 })],
    evidenceRecords: [evidenceRecord],
    rawFindings: [makeRaw()],
    conflicts: [makeConflict()],
    interpretations: [],
    ...overrides,
  };
}

function makeOutput(overrides: Partial<FindingConflictAdjudicationOutput> = {}): FindingConflictAdjudicationOutput {
  return {
    conflictId: 'C-FA2947446963',
    outcome: 'undetermined',
    ...overrides,
  };
}

describe('computeConflictEvidenceHash / isConflictUnadjudicated', () => {
  it('is deterministic for the same ledger state', () => {
    const ledger = makeLedger({ rawFindings: [makeRaw()] });
    const first = computeConflictEvidenceHash(ledger.conflicts[0]!, ledger);
    const second = computeConflictEvidenceHash(ledger.conflicts[0]!, ledger);
    expect(first).toBe(second);
  });

  it('a conflict with no adjudication history is unadjudicated', () => {
    const conflict = makeConflict();
    expect(isConflictUnadjudicated(conflict, 'any-hash')).toBe(true);
  });

  it('a conflict adjudicated against the current hash is not unadjudicated (1回制限)', () => {
    const ledger = makeLedger({ rawFindings: [makeRaw()] });
    const hash = computeConflictEvidenceHash(ledger.conflicts[0]!, ledger);
    const adjudicated: FindingLedgerConflict = {
      ...ledger.conflicts[0]!,
      adjudications: [{
        evidenceHash: hash,
        outcome: 'undetermined',
        rationale: 'No conclusion.',
        decidedAt: { runId: 'run-1', stepName: 'finding-conflict-adjudication', timestamp: '2026-06-13T00:00:00.000Z' },
      }],
    };
    expect(isConflictUnadjudicated(adjudicated, hash)).toBe(false);
  });

  it('既出 hash への再裁定拒否: 過去の（最新でない）裁定記録の hash に戻っても再裁定できない (codex B3)', () => {
    const ledger = makeLedger({ rawFindings: [makeRaw()] });
    const revertedHash = computeConflictEvidenceHash(ledger.conflicts[0]!, ledger);
    const conflictWithHistory: FindingLedgerConflict = {
      ...ledger.conflicts[0]!,
      adjudications: [
        {
          evidenceHash: revertedHash,
          outcome: 'undetermined',
          rationale: 'First decision.',
          decidedAt: { runId: 'run-1', stepName: 'finding-conflict-adjudication', timestamp: '2026-06-13T00:00:00.000Z' },
        },
        {
          evidenceHash: 'newer-different-hash',
          outcome: 'undetermined',
          rationale: 'Second decision.',
          decidedAt: { runId: 'run-2', stepName: 'finding-conflict-adjudication', timestamp: '2026-06-13T01:00:00.000Z' },
        },
      ],
    };
    // 現在の evidence が run-1 時点の状態へ「戻った」ケース: 最新記録だけを
    // 見ると未裁定に見えるが、全履歴照合により再裁定は拒否される。
    expect(isConflictUnadjudicated(conflictWithHistory, revertedHash)).toBe(false);
  });

  it('raw finding の内容変化で hash が変わる（内容ベース, codex B2）', () => {
    const before = makeLedger({ rawFindings: [makeRaw()] });
    const hashBefore = computeConflictEvidenceHash(before.conflicts[0]!, before);
    const after = makeLedger({ rawFindings: [makeRaw({ description: 'The bug now manifests differently.' })] });
    const hashAfter = computeConflictEvidenceHash(after.conflicts[0]!, after);
    expect(hashAfter).not.toBe(hashBefore);
  });

  it('raw finding の ID が変わると完全な台帳証跡の hash も変わる', () => {
    const before = makeLedger({ rawFindings: [makeRaw()] });
    const hashBefore = computeConflictEvidenceHash(before.conflicts[0]!, before);
    const after = makeLedger({
      findings: [makeFinding({ revision: 1, rawFindingIds: ['raw-renamed'] })],
      rawFindings: [makeRaw({ rawFindingId: 'raw-renamed' })],
    });
    const hashAfter = computeConflictEvidenceHash(after.conflicts[0]!, after);
    expect(hashAfter).not.toBe(hashBefore);
  });

  it('review scope snapshot の変化で hash が変わる', () => {
    const ledger = makeLedger({ rawFindings: [makeRaw()] });
    const before = computeConflictEvidenceHashWithScope(ledger.conflicts[0]!, ledger, 'scope-before');
    const after = computeConflictEvidenceHashWithScope(ledger.conflicts[0]!, ledger, 'scope-after');
    expect(after).not.toBe(before);
  });

  it('新しい内容の raw finding の追加で hash が変わる', () => {
    const before = makeLedger({ rawFindings: [makeRaw()] });
    const hashBefore = computeConflictEvidenceHash(before.conflicts[0]!, before);
    const after = makeLedger({
      findings: [makeFinding({ revision: 1, rawFindingIds: ['raw-1', 'raw-2'] })],
      rawFindings: [makeRaw(), makeRaw({ rawFindingId: 'raw-2', description: 'A second, different observation.' })],
    });
    const hashAfter = computeConflictEvidenceHash(after.conflicts[0]!, after);
    expect(hashAfter).not.toBe(hashBefore);
  });

  it('新しい dispute の記録で hash が変わる', () => {
    const before = makeLedger({ rawFindings: [makeRaw()] });
    const hashBefore = computeConflictEvidenceHash(before.conflicts[0]!, before);
    const after = makeLedger({
      rawFindings: [makeRaw()],
      findings: [makeFinding({ revision: 1,
        disputes: [{ reason: 'stale', evidence: 'src/a.ts no longer has this code', recordedAt: { runId: 'run-2', stepName: 'fix', timestamp: '2026-06-13T01:00:00.000Z' } }],
      })],
    });
    const hashAfter = computeConflictEvidenceHash(after.conflicts[0]!, after);
    expect(hashAfter).not.toBe(hashBefore);
  });

  it('非権威の rejected observation 監査追加だけでは hash が変わらない', () => {
    const before = makeLedger({ rawFindings: [makeRaw()] });
    const hashBefore = computeConflictEvidenceHash(before.conflicts[0]!, before);
    const after = makeLedger({
      rawFindings: [makeRaw()],
      findings: [makeFinding({
        revision: 1,
        rejectedObservations: [{
          rawFindingId: 'raw-rejected-audit',
          reason: 'The observation failed evidence admission.',
          observedAt: {
            runId: 'run-2',
            stepName: 'reviewers',
            timestamp: '2026-06-13T01:00:00.000Z',
          },
        }],
      })],
    });
    const hashAfter = computeConflictEvidenceHash(after.conflicts[0]!, after);

    expect(hashAfter).toBe(hashBefore);
  });

  it('conflict の description の変化で hash が変わる', () => {
    const ledger = makeLedger({ rawFindings: [makeRaw()] });
    const hashBefore = computeConflictEvidenceHash(ledger.conflicts[0]!, ledger);
    const hashAfter = computeConflictEvidenceHash(
      { ...ledger.conflicts[0]!, description: 'A different disagreement entirely.' },
      ledger,
    );
    expect(hashAfter).not.toBe(hashBefore);
  });
});

describe('applyFindingConflictAdjudication', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'takt-adjudication-'));
    mkdirSync(join(cwd, 'src'), { recursive: true });
    writeFileSync(join(cwd, 'src', 'a.ts'), Array.from({ length: 20 }, (_, i) => `// line ${i + 1}`).join('\n') + '\n');
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  const context = { workflowName: 'test-workflow', stepName: 'finding-conflict-adjudication', runId: 'run-1', timestamp: '2026-06-13T02:00:00.000Z' };

  it('finding_stale -> resolved: derives the transition from the closed outcome', () => {
    const ledger = makeLedger();
    const output = makeOutput({
      outcome: 'finding_stale',
      rationale: 'The bound adjudication inputs show the finding is stale.',
    });
    const result = applyFindingConflictAdjudication({
      ledger, output, evidenceHash: 'hash-1', cwd, context,
    });

    expect(result.transition).toBe('resolved');
    const finding = result.ledger.findings.find((f) => f.id === 'F-0001')!;
    expect(finding.status).toBe('resolved');
    expect(finding.lifecycle).toBe('resolved');
    const conflict = result.ledger.conflicts.find((c) => c.id === 'C-FA2947446963')!;
    expect(conflict.status).toBe('resolved');
    expect(conflict.adjudications).toHaveLength(1);
    expect(conflict.adjudications![0]!.evidenceHash).toBe('hash-1');
  });

  it('finding_stale -> resolved: accepts a verifiable file:line citation embedded in explanatory evidence', () => {
    const ledger = makeLedger();
    const evidence = 'The current implementation at src/a.ts:5 shows that the stale path is gone.';
    const output = makeOutput({
      outcome: 'finding_stale',
      rationale: evidence,
    });

    const result = applyFindingConflictAdjudication({
      ledger, output, evidenceHash: 'hash-embedded-line', cwd, context,
    });

    expect(result.transition).toBe('resolved');
    expect(result.ledger.findings[0]?.resolvedEvidence)
      .toBe('Conflict adjudication C-FA2947446963@hash-embedded-line: finding_stale');
  });

  it('finding_stale -> resolved: accepts a verifiable file:start-end citation embedded in explanatory evidence', () => {
    const ledger = makeLedger();
    const evidence = 'src/a.ts:4-6 shows the current implementation that resolves the finding.';
    const output = makeOutput({
      outcome: 'finding_stale',
      rationale: evidence,
    });

    const result = applyFindingConflictAdjudication({
      ledger, output, evidenceHash: 'hash-embedded-range', cwd, context,
    });

    expect(result.transition).toBe('resolved');
    expect(result.ledger.findings[0]?.resolvedEvidence)
      .toBe('Conflict adjudication C-FA2947446963@hash-embedded-range: finding_stale');
  });

  it.each([
    ['smart quotes', 'The evidence is “src/a.ts:5”.', 'src/a.ts:5'],
    ['Japanese corner brackets', '証拠は「src/a.ts:4-6」です。', 'src/a.ts:4-6'],
    ['fullwidth parentheses', '証拠は（src/a.ts:5）です。', 'src/a.ts:5'],
  ])('finding_stale -> resolved: accepts a citation delimited by %s', (_delimiter, evidence, citation) => {
    const ledger = makeLedger();
    const output = makeOutput({
      outcome: 'finding_stale',
      rationale: evidence,
    });

    const result = applyFindingConflictAdjudication({
      ledger, output, evidenceHash: 'hash-unicode-delimiter', cwd, context,
    });

    expect(result.transition).toBe('resolved');
    expect(result.ledger.findings[0]?.resolvedEvidence)
      .toBe('Conflict adjudication C-FA2947446963@hash-unicode-delimiter: finding_stale');
  });

  it('finding_stale -> resolved is rejected when no evidence entry is a verifiable file:line citation', () => {
    const ledger = makeLedger();
    const output = makeOutput({
      outcome: 'finding_stale',
      rationale: 'It is fixed, trust me.',
    });
    expect(() => applyFindingConflictAdjudication({
      ledger, output, evidenceHash: 'hash-1', cwd, context,
    })).not.toThrow();
  });

  it('finding_stale -> resolved does not accept a citation embedded inside a larger token', () => {
    const ledger = makeLedger();
    const output = makeOutput({
      outcome: 'finding_stale',
      rationale: 'prefixsrc/a.ts:5suffix',
    });

    expect(() => applyFindingConflictAdjudication({
      ledger, output, evidenceHash: 'hash-non-boundary', cwd, context,
    })).not.toThrow();
  });

  it('finding_stale -> resolved is rejected when the end of an embedded line range is outside the cited file', () => {
    const ledger = makeLedger();
    const output = makeOutput({
      outcome: 'finding_stale',
      rationale: 'src/a.ts:19-21 supposedly proves the finding is stale.',
    });

    expect(() => applyFindingConflictAdjudication({
      ledger, output, evidenceHash: 'hash-out-of-range', cwd, context,
    })).not.toThrow();
  });

  it('finding_stale -> resolved is rejected when an embedded line range is reversed', () => {
    const ledger = makeLedger();
    const output = makeOutput({
      outcome: 'finding_stale',
      rationale: 'src/a.ts:6-4 supposedly proves the finding is stale.',
    });

    expect(() => applyFindingConflictAdjudication({
      ledger, output, evidenceHash: 'hash-reversed-range', cwd, context,
    })).not.toThrow();
  });

  it('finding_stale -> resolved does not accept an embedded citation outside the reviewed project', () => {
    const ledger = makeLedger();
    const output = makeOutput({
      outcome: 'finding_stale',
      rationale: '/etc/hosts:1 supposedly proves the finding is stale.',
    });

    expect(() => applyFindingConflictAdjudication({
      ledger, output, evidenceHash: 'hash-outside-project', cwd, context,
    })).not.toThrow();
  });

  it('evidence_invalid -> invalidated: machine-verifies when the finding location does not exist', () => {
    const evidenceRecord = makeEvidenceRecord('src/does-not-exist.ts', 1);
    const ledger = makeLedger({
      findings: [makeFinding({ revision: 1, evidenceIds: [evidenceRecord.evidenceId] })],
      evidenceRecords: [evidenceRecord],
    });
    const output = makeOutput({
      outcome: 'evidence_invalid',
      rationale: 'The premise was never true.',
    });
    const result = applyFindingConflictAdjudication({
      ledger, output, evidenceHash: 'hash-2', cwd, context,
    });
    const finding = result.ledger.findings.find((f) => f.id === 'F-0001')!;
    expect(finding.status).toBe('invalidated');
    expect(finding.invalidatedEvidence)
      .toBe('Conflict adjudication C-FA2947446963@hash-2: evidence_invalid');
  });

  it('evidence_invalid -> invalidated: falls back to adjudicator evidence when the location resolves fine', () => {
    const evidenceRecord = makeEvidenceRecord('src/a.ts', 5);
    const ledger = makeLedger({
      findings: [makeFinding({ revision: 1, evidenceIds: [evidenceRecord.evidenceId] })],
      evidenceRecords: [evidenceRecord],
    });
    const output = makeOutput({
      outcome: 'evidence_invalid',
      rationale: 'The claim itself never held: no such API exists.',
    });
    const result = applyFindingConflictAdjudication({
      ledger, output, evidenceHash: 'hash-3', cwd, context,
    });
    const finding = result.ledger.findings.find((f) => f.id === 'F-0001')!;
    expect(finding.status).toBe('invalidated');
    expect(finding.invalidatedEvidence)
      .toBe('Conflict adjudication C-FA2947446963@hash-3: evidence_invalid');
  });

  it('finding_valid + actionableFix 空 -> unresolved: undetermined と同じ扱い（conflict は active のまま、記録のみ）', () => {
    const ledger = makeLedger();
    const output = makeOutput({
      outcome: 'finding_valid',
      rationale: 'This is a real, legitimate disagreement.',
    });
    const result = applyFindingConflictAdjudication({
      ledger, output, evidenceHash: 'hash-4', cwd, context,
    });
    expect(result.transition).toBe('keep_open');
    expect(result.disposition).toBe('unresolved');
    const finding = result.ledger.findings.find((f) => f.id === 'F-0001')!;
    expect(finding.status).toBe('open');
    const conflict = result.ledger.conflicts.find((c) => c.id === 'C-FA2947446963')!;
    expect(conflict.status).toBe('active');
    expect(conflict.adjudications).toHaveLength(1);
    expect(conflict.adjudications![0]!.outcome).toBe('finding_valid');
  });

  it('finding_valid + actionableFix -> actionable_fix: conflict はレビュア側支持で resolved、finding は open のまま suggestion に fix が載る', () => {
    const ledger = makeLedger({ findings: [makeFinding({ revision: 1, suggestion: 'Original suggestion.' })] });
    const output = makeOutput({
      outcome: 'finding_valid',
      rationale: 'The reviewer is right: the bug is still present.',
      actionableFix: 'Guard the null case in src/a.ts before dereferencing.',
    });
    const result = applyFindingConflictAdjudication({
      ledger, output, evidenceHash: 'hash-4a', cwd, context,
    });
    expect(result.transition).toBe('keep_open');
    expect(result.disposition).toBe('actionable_fix');
    const finding = result.ledger.findings.find((f) => f.id === 'F-0001')!;
    expect(finding.status).toBe('open');
    expect(finding.suggestion).toContain('Original suggestion.');
    expect(finding.suggestion).toContain('[adjudicated fix] Guard the null case');
    const conflict = result.ledger.conflicts.find((c) => c.id === 'C-FA2947446963')!;
    expect(conflict.status).toBe('resolved');
    expect(conflict.resolvedEvidence)
      .toBe('Conflict adjudication C-FA2947446963@hash-4a: finding_valid');
    expect(conflict.adjudications).toHaveLength(1);
    expect(conflict.adjudications![0]!.actionableFix).toContain('Guard the null case');
  });

  it('undetermined -> keep_open: never opens the gate', () => {
    const ledger = makeLedger();
    const output = makeOutput({ outcome: 'undetermined' });
    const result = applyFindingConflictAdjudication({
      ledger, output, evidenceHash: 'hash-5', cwd, context,
    });
    expect(result.transition).toBe('keep_open');
    expect(result.disposition).toBe('unresolved');
    expect(result.ledger.conflicts[0]!.status).toBe('active');
  });

  it('resolveAdjudicationDisposition: outcome と actionableFix から disposition を導出する', () => {
    expect(resolveAdjudicationDisposition({ outcome: 'finding_stale', actionableFix: '' })).toBe('finding_closed');
    expect(resolveAdjudicationDisposition({ outcome: 'evidence_invalid', actionableFix: '' })).toBe('finding_closed');
    expect(resolveAdjudicationDisposition({ outcome: 'finding_valid', actionableFix: 'Fix it like this.' })).toBe('actionable_fix');
    expect(resolveAdjudicationDisposition({ outcome: 'finding_valid', actionableFix: '   ' })).toBe('unresolved');
    expect(resolveAdjudicationDisposition({ outcome: 'undetermined', actionableFix: '' })).toBe('unresolved');
  });

  it('derives the finding transition without accepting an LLM transition field', () => {
    const ledger = makeLedger();
    const output = makeOutput({ outcome: 'finding_valid' });
    expect(applyFindingConflictAdjudication({
      ledger, output, evidenceHash: 'hash-6', cwd, context,
    }).transition).toBe('keep_open');
  });

  it('rejects adjudication against a conflict that is not active', () => {
    const ledger = makeLedger({ conflicts: [makeConflict({ status: 'resolved' })] });
    const output = makeOutput();
    expect(() => applyFindingConflictAdjudication({
      ledger, output, evidenceHash: 'hash-7', cwd, context,
    })).toThrow(/not active/);
  });

  it('rejects adjudication against an unknown conflict id', () => {
    const ledger = makeLedger();
    const output = makeOutput({ conflictId: 'C-9999' });
    expect(() => applyFindingConflictAdjudication({
      ledger, output, evidenceHash: 'hash-8', cwd, context,
    })).toThrow(/Unknown conflict/);
  });

  it('every declared outcome maps to exactly the engine-owned transition', () => {
    expect(FINDING_CONFLICT_ADJUDICATION_OUTCOME_TRANSITION).toEqual({
      finding_valid: 'keep_open',
      finding_stale: 'resolved',
      evidence_invalid: 'invalidated',
      undetermined: 'keep_open',
    });
  });
});

describe('selectConflictForAdjudication', () => {
  it('picks the first active conflict that is unadjudicated, skipping resolved and already-adjudicated ones', () => {
    const ledger = makeLedger({
      nextId: 5,
      findings: [
        makeFinding({ revision: 1, id: 'F-0002', rawFindingIds: [] }),
        makeFinding({ revision: 1, id: 'F-0003', rawFindingIds: [] }),
        makeFinding({ revision: 1, id: 'F-0004', rawFindingIds: [] }),
      ],
      conflicts: [
        makeConflict({ id: 'C-2BF240CC0BEC', findingIds: ['F-0002'], status: 'resolved' }),
        makeConflict({ id: 'C-85DE8622C4AC', findingIds: ['F-0003'], adjudications: [{ evidenceHash: 'stays-same', outcome: 'undetermined', rationale: 'No conclusion.', decidedAt: { runId: 'run-1', stepName: 'finding-conflict-adjudication', timestamp: '2026-06-13T00:00:00.000Z' } }] }),
        makeConflict({ id: 'C-0868C7FDC93C', findingIds: ['F-0004'] }),
      ],
    });
    const target = selectConflictForAdjudication(ledger, (conflict) => (
      conflict.id === 'C-0868C7FDC93C' || (conflict.adjudications?.at(-1)?.evidenceHash !== 'stays-same')
    ));
    expect(target?.id).toBe('C-0868C7FDC93C');
  });

  it('returns undefined when nothing is eligible', () => {
    const ledger = makeLedger({ conflicts: [] });
    expect(selectConflictForAdjudication(ledger, () => true)).toBeUndefined();
  });
});

describe('buildFindingsRuleContext: conflicts.unadjudicated', () => {
  it('counts a freshly active conflict as unadjudicated', () => {
    const ledger = makeLedger();
    const context = buildFindingsRuleContext(ledger);
    expect(context.conflicts.count).toBe(1);
    expect(context.conflicts.unadjudicated.count).toBe(1);
  });

  it('excludes a conflict already adjudicated against its current evidence', () => {
    const ledger = makeLedger();
    const hash = computeConflictEvidenceHash(ledger.conflicts[0]!, ledger);
    const adjudicatedLedger: FindingLedger = {
      ...ledger,
      conflicts: [{
        ...ledger.conflicts[0]!,
        adjudications: [{
          evidenceHash: hash,
          outcome: 'undetermined',
          rationale: 'No conclusion.',
          decidedAt: { runId: 'run-1', stepName: 'finding-conflict-adjudication', timestamp: '2026-06-13T00:00:00.000Z' },
        }],
      }],
    };
    const context = buildFindingsRuleContext(adjudicatedLedger);
    expect(context.conflicts.count).toBe(1);
    expect(context.conflicts.unadjudicated.count).toBe(0);
  });

  it('re-counts as unadjudicated once a new dispute changes the evidence hash', () => {
    const ledger = makeLedger();
    const staleHash = computeConflictEvidenceHash(ledger.conflicts[0]!, ledger);
    const findingWithNewDispute = makeFinding({ revision: 1,
      disputes: [{ reason: 'stale', evidence: 'no longer true', recordedAt: { runId: 'run-2', stepName: 'fix', timestamp: '2026-06-13T01:00:00.000Z' } }],
    });
    const changedLedger: FindingLedger = {
      ...ledger,
      findings: [findingWithNewDispute],
      conflicts: [{
        ...ledger.conflicts[0]!,
        adjudications: [{
          evidenceHash: staleHash,
          outcome: 'undetermined',
          rationale: 'No conclusion.',
          decidedAt: { runId: 'run-1', stepName: 'finding-conflict-adjudication', timestamp: '2026-06-13T00:00:00.000Z' },
        }],
      }],
    };
    const context = buildFindingsRuleContext(changedLedger);
    expect(context.conflicts.unadjudicated.count).toBe(1);
  });
});

/**
 * Phase B of the Finding Contract convergence design: conflict adjudication.
 * Covers the pure logic (evidenceHash, the outcome/findingTransition
 * invariant, ledger application, FindingsRuleContext.conflicts.unadjudicated)
 * without spinning up a full WorkflowEngine — the engine-level detour
 * (routing back to the originating step / ABORT, the 1-attempt gate observed
 * through actual rule evaluation) is covered separately in
 * finding-conflict-adjudication-engine.test.ts.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FINDING_CONFLICT_ADJUDICATION_OUTCOME_TRANSITION,
  applyFindingConflictAdjudication,
  resolveAdjudicationDisposition,
  selectConflictForAdjudication,
} from '../core/workflow/findings/adjudication-apply.js';
import { computeConflictEvidenceHash as computeConflictEvidenceHashWithScope, isConflictUnadjudicated } from '../core/workflow/findings/adjudication-evidence.js';
import { buildFindingsRuleContext as buildFindingsRuleContextWithScope } from '../core/workflow/findings/context.js';
import { computeReviewScopeSnapshotId } from '../core/workflow/findings/snapshot.js';
import type {
  FindingConflictAdjudicationOutput,
  FindingLedger,
  FindingLedgerConflict,
  FindingLedgerEntry,
} from '../core/workflow/findings/types.js';

function computeConflictEvidenceHash(
  conflict: FindingLedgerConflict,
  ledger: FindingLedger,
): string {
  return computeConflictEvidenceHashWithScope(conflict, ledger, computeReviewScopeSnapshotId(process.cwd()));
}

function buildFindingsRuleContext(ledger: FindingLedger) {
  return buildFindingsRuleContextWithScope(ledger, process.cwd());
}

function makeFinding(overrides: Partial<FindingLedgerEntry> = {}): FindingLedgerEntry {
  return {
    id: 'F-0001',
    status: 'open',
    lifecycle: 'new',
    severity: 'high',
    title: 'Disputed issue',
    location: 'src/a.ts:10',
    reviewers: ['coding-review'],
    rawFindingIds: ['raw-1'],
    firstSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
    lastSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
    ...overrides,
  };
}

function makeConflict(overrides: Partial<FindingLedgerConflict> = {}): FindingLedgerConflict {
  return {
    id: 'C-0001',
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
  return {
    version: 1,
    workflowName: 'test-workflow',
    nextId: 2,
    updatedAt: '2026-06-13T00:00:00.000Z',
    findings: [makeFinding()],
    rawFindings: [],
    conflicts: [makeConflict()],
    ...overrides,
  };
}

function makeOutput(overrides: Partial<FindingConflictAdjudicationOutput> = {}): FindingConflictAdjudicationOutput {
  return {
    conflictId: 'C-0001',
    outcome: 'undetermined',
    findingTransition: 'keep_open',
    evidence: ['No conclusive evidence either way.'],
    actionableFix: '',
    ...overrides,
  };
}

describe('computeConflictEvidenceHash / isConflictUnadjudicated', () => {
  const makeRaw = (overrides: Partial<import('../core/workflow/findings/types.js').RawFinding> = {}) => ({
    rawFindingId: 'raw-1',
    stepName: 'reviewers',
    reviewer: 'coding-review',
    familyTag: 'bug',
    severity: 'high' as const,
    title: 'Disputed issue',
    location: 'src/a.ts:10',
    description: 'The bug is present.',
    ...overrides,
  });

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
        findingTransition: 'keep_open',
        evidence: ['x'],
        actionableFix: '',
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
          findingTransition: 'keep_open',
          evidence: ['first attempt'],
          actionableFix: '',
          decidedAt: { runId: 'run-1', stepName: 'finding-conflict-adjudication', timestamp: '2026-06-13T00:00:00.000Z' },
        },
        {
          evidenceHash: 'newer-different-hash',
          outcome: 'undetermined',
          findingTransition: 'keep_open',
          evidence: ['second attempt with changed evidence'],
          actionableFix: '',
          decidedAt: { runId: 'run-2', stepName: 'finding-conflict-adjudication', timestamp: '2026-06-13T01:00:00.000Z' },
        },
      ],
    };
    // 現在の evidence が run-1 時点の状態へ「戻った」ケース: 最新記録だけを
    // 見ると未裁定に見えるが、全履歴照合により再裁定は拒否される。
    expect(isConflictUnadjudicated(conflictWithHistory, revertedHash)).toBe(false);
  });

  it('開始済み attempt の hash も再裁定を塞ぐ（resume 相互作用の土台）', () => {
    const conflict: FindingLedgerConflict = {
      ...makeConflict(),
      adjudicationAttempts: [{
        evidenceHash: 'attempted-hash',
        reservationToken: 'reservation-run-1',
        startedAt: { runId: 'run-1', stepName: 'finding-conflict-adjudication', timestamp: '2026-06-13T00:00:00.000Z' },
      }],
    };
    expect(isConflictUnadjudicated(conflict, 'attempted-hash')).toBe(false);
    expect(isConflictUnadjudicated(conflict, 'fresh-hash')).toBe(true);
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
      findings: [makeFinding({ rawFindingIds: ['raw-renamed'] })],
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
      findings: [makeFinding({ rawFindingIds: ['raw-1', 'raw-2'] })],
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
      findings: [makeFinding({
        disputes: [{ reason: 'stale', evidence: 'src/a.ts no longer has this code', recordedAt: { runId: 'run-2', stepName: 'fix', timestamp: '2026-06-13T01:00:00.000Z' } }],
      })],
    });
    const hashAfter = computeConflictEvidenceHash(after.conflicts[0]!, after);
    expect(hashAfter).not.toBe(hashBefore);
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

  it('finding_stale -> resolved: moves the finding to resolved and the conflict to resolved, given verifiable evidence', () => {
    const ledger = makeLedger();
    const output = makeOutput({
      outcome: 'finding_stale',
      findingTransition: 'resolved',
      evidence: ['Verified fixed against current code.', 'src/a.ts:5'],
    });
    const result = applyFindingConflictAdjudication({
      ledger, output, evidenceHash: 'hash-1', cwd, context,
    });

    expect(result.transition).toBe('resolved');
    const finding = result.ledger.findings.find((f) => f.id === 'F-0001')!;
    expect(finding.status).toBe('resolved');
    expect(finding.lifecycle).toBe('resolved');
    const conflict = result.ledger.conflicts.find((c) => c.id === 'C-0001')!;
    expect(conflict.status).toBe('resolved');
    expect(conflict.adjudications).toHaveLength(1);
    expect(conflict.adjudications![0]!.evidenceHash).toBe('hash-1');
  });

  it('finding_stale -> resolved is rejected when no evidence entry is a verifiable file:line citation', () => {
    const ledger = makeLedger();
    const output = makeOutput({
      outcome: 'finding_stale',
      findingTransition: 'resolved',
      evidence: ['It is fixed, trust me.'],
    });
    expect(() => applyFindingConflictAdjudication({
      ledger, output, evidenceHash: 'hash-1', cwd, context,
    })).toThrow(/verifiable/);
  });

  it('evidence_invalid -> invalidated: machine-verifies when the finding location does not exist', () => {
    const ledger = makeLedger({ findings: [makeFinding({ location: 'src/does-not-exist.ts:1' })] });
    const output = makeOutput({
      outcome: 'evidence_invalid',
      findingTransition: 'invalidated',
      evidence: ['The premise was never true.'],
    });
    const result = applyFindingConflictAdjudication({
      ledger, output, evidenceHash: 'hash-2', cwd, context,
    });
    const finding = result.ledger.findings.find((f) => f.id === 'F-0001')!;
    expect(finding.status).toBe('invalidated');
    expect(finding.invalidatedEvidence).toMatch(/does not exist/);
  });

  it('evidence_invalid -> invalidated: falls back to adjudicator evidence when the location resolves fine', () => {
    const ledger = makeLedger({ findings: [makeFinding({ location: 'src/a.ts:5' })] });
    const output = makeOutput({
      outcome: 'evidence_invalid',
      findingTransition: 'invalidated',
      evidence: ['The claim itself never held: no such API exists.'],
    });
    const result = applyFindingConflictAdjudication({
      ledger, output, evidenceHash: 'hash-3', cwd, context,
    });
    const finding = result.ledger.findings.find((f) => f.id === 'F-0001')!;
    expect(finding.status).toBe('invalidated');
    expect(finding.invalidatedEvidence).toContain('The claim itself never held');
  });

  it('finding_valid + actionableFix 空 -> unresolved: undetermined と同じ扱い（conflict は active のまま、記録のみ）', () => {
    const ledger = makeLedger();
    const output = makeOutput({
      outcome: 'finding_valid',
      findingTransition: 'keep_open',
      evidence: ['This is a real, legitimate disagreement.'],
      actionableFix: '',
    });
    const result = applyFindingConflictAdjudication({
      ledger, output, evidenceHash: 'hash-4', cwd, context,
    });
    expect(result.transition).toBe('keep_open');
    expect(result.disposition).toBe('unresolved');
    const finding = result.ledger.findings.find((f) => f.id === 'F-0001')!;
    expect(finding.status).toBe('open');
    const conflict = result.ledger.conflicts.find((c) => c.id === 'C-0001')!;
    expect(conflict.status).toBe('active');
    expect(conflict.adjudications).toHaveLength(1);
    expect(conflict.adjudications![0]!.outcome).toBe('finding_valid');
  });

  it('finding_valid + actionableFix -> actionable_fix: conflict はレビュア側支持で resolved、finding は open のまま suggestion に fix が載る', () => {
    const ledger = makeLedger({ findings: [makeFinding({ suggestion: 'Original suggestion.' })] });
    const output = makeOutput({
      outcome: 'finding_valid',
      findingTransition: 'keep_open',
      evidence: ['The reviewer is right: the bug is still present.'],
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
    const conflict = result.ledger.conflicts.find((c) => c.id === 'C-0001')!;
    expect(conflict.status).toBe('resolved');
    expect(conflict.resolvedEvidence).toContain('in favor of the reviewer');
    expect(conflict.resolvedEvidence).toContain('Guard the null case');
    expect(conflict.adjudications).toHaveLength(1);
    expect(conflict.adjudications![0]!.actionableFix).toContain('Guard the null case');
  });

  it('undetermined -> keep_open: never opens the gate', () => {
    const ledger = makeLedger();
    const output = makeOutput({ outcome: 'undetermined', findingTransition: 'keep_open' });
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

  it('rejects output whose findingTransition does not match its outcome', () => {
    const ledger = makeLedger();
    const output = makeOutput({ outcome: 'finding_valid', findingTransition: 'resolved' });
    expect(() => applyFindingConflictAdjudication({
      ledger, output, evidenceHash: 'hash-6', cwd, context,
    })).toThrow(/inconsistent/);
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

  it('every declared outcome maps to exactly the documented findingTransition', () => {
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
      conflicts: [
        makeConflict({ id: 'C-resolved', status: 'resolved' }),
        makeConflict({ id: 'C-adjudicated', adjudications: [{ evidenceHash: 'stays-same', outcome: 'undetermined', findingTransition: 'keep_open', evidence: ['x'], actionableFix: '', decidedAt: { runId: 'run-1', stepName: 'finding-conflict-adjudication', timestamp: '2026-06-13T00:00:00.000Z' } }] }),
        makeConflict({ id: 'C-target' }),
      ],
    });
    const target = selectConflictForAdjudication(ledger, (conflict) => (
      conflict.id === 'C-target' || (conflict.adjudications?.at(-1)?.evidenceHash !== 'stays-same')
    ));
    expect(target?.id).toBe('C-target');
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
          findingTransition: 'keep_open',
          evidence: ['x'],
          actionableFix: '',
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
    const findingWithNewDispute = makeFinding({
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
          findingTransition: 'keep_open',
          evidence: ['x'],
          actionableFix: '',
          decidedAt: { runId: 'run-1', stepName: 'finding-conflict-adjudication', timestamp: '2026-06-13T00:00:00.000Z' },
        }],
      }],
    };
    const context = buildFindingsRuleContext(changedLedger);
    expect(context.conflicts.unadjudicated.count).toBe(1);
  });
});

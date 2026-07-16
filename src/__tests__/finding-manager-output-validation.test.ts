import { describe, expect, it } from 'vitest';
import { validateFindingManagerOutput } from '../core/workflow/findings/manager-output-validation.js';
import { parseRawFindings, parseReviewerRawFindings } from '../core/models/finding-schemas.js';
import type {
  FindingLedger,
  FindingManagerOutput,
  RawFinding,
} from '../core/workflow/findings/types.js';

function makeLedger(overrides: Partial<FindingLedger> = {}): FindingLedger {
  return {
    version: 1,
    workflowName: 'peer-review',
    nextId: 2,
    updatedAt: '2026-06-13T00:00:00.000Z',
    rawFindings: [makeRawFinding({ rawFindingId: 'raw-existing' })],
    conflicts: [],
    findings: [
      {
        id: 'F-0001',
        status: 'open',
        lifecycle: 'new',
        severity: 'high',
        title: 'Existing issue',
        reviewers: ['architecture-review'],
        rawFindingIds: ['raw-existing'],
        firstSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
        lastSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
      },
    ],
    ...overrides,
  };
}

function makeRawFinding(overrides: Partial<RawFinding> = {}): RawFinding {
  return {
    rawFindingId: 'raw-current',
    stepName: 'architecture-review',
    reviewer: 'architecture-review',
    familyTag: 'bug',
    severity: 'high',
    title: 'Current issue',
    description: 'The issue is present in the current review.',
    ...overrides,
  };
}

function makeManagerOutput(overrides: Partial<FindingManagerOutput> = {}): FindingManagerOutput {
  return {
    matches: [],
    newFindings: [],
    resolvedFindings: [],
    reopenedFindings: [],
    conflicts: [],
    resolvedConflicts: [],
    waivedFindings: [],
    disputeNotes: [],
    ...overrides,
  };
}

const CLAIM = '## Disputed Findings\n- findingId: F-0001\n  reason: frozen contract\n  evidence: src/types.ts:94';

describe('validateFindingManagerOutput', () => {
  it('should accept a waiver backed by a dispute claim in the prior response', () => {
    const result = validateFindingManagerOutput({
      previousLedger: makeLedger(),
      rawFindings: [],
      managerOutput: makeManagerOutput({
        waivedFindings: [{ findingId: 'F-0001', reason: 'Frozen public contract mandates Record', evidence: 'src/types.ts:94' }],
      }),
      priorStepResponseText: CLAIM,
    });

    expect(result.ok).toBe(true);
  });

  it('should accept a waiver claimed with a column-zero bare findingId field', () => {
    const result = validateFindingManagerOutput({
      previousLedger: makeLedger(),
      rawFindings: [],
      managerOutput: makeManagerOutput({
        waivedFindings: [{ findingId: 'F-0001', reason: 'Frozen public contract mandates Record', evidence: 'src/types.ts:94' }],
      }),
      priorStepResponseText: [
        '## Disputed Findings',
        'findingId: F-0001',
        'reason: frozen contract',
        'evidence: src/types.ts:94',
      ].join('\n'),
    });

    expect(result.ok).toBe(true);
  });

  // finding_contract_instruction.md (ja) の異議申告ガイドは、見出しとフィールド名
  // （## Disputed Findings / findingId / reason / evidence）を英語のまま書かせ、
  // reason だけを日本語散文にする。coder がガイドどおりに書いた応答を
  // hasDisputeClaimsHeading() / hasDisputeClaimFor() が認識できることを、
  // 公開APIである validateFindingManagerOutput 経由で確認する（#1012）。
  it('should accept a waiver backed by a ja-prose dispute claim that keeps protocol tokens in English', () => {
    const jaClaim = [
      '## Disputed Findings',
      '- findingId: F-0001',
      '  reason: 凍結された公開契約により、この型を変更できない',
      '  evidence: src/types.ts:94',
    ].join('\n');

    const result = validateFindingManagerOutput({
      previousLedger: makeLedger(),
      rawFindings: [],
      managerOutput: makeManagerOutput({
        waivedFindings: [{ findingId: 'F-0001', reason: '凍結された公開契約により、この型を変更できない', evidence: 'src/types.ts:94' }],
      }),
      priorStepResponseText: jaClaim,
    });

    expect(result.ok).toBe(true);
  });

  it('should reject duplicate dispute notes for the same finding', () => {
    const result = validateFindingManagerOutput({
      previousLedger: makeLedger(),
      rawFindings: [],
      managerOutput: makeManagerOutput({
        disputeNotes: [
          { findingId: 'F-0001', reason: 'first note', evidence: 'src/a.ts:1' },
          { findingId: 'F-0001', reason: 'second note', evidence: 'src/a.ts:2' },
        ],
      }),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(' ')).toContain('Duplicate dispute note');
    }
  });

  it('should reject a waiver when the prior response contains no claim for the finding', () => {
    const result = validateFindingManagerOutput({
      previousLedger: makeLedger(),
      rawFindings: [],
      managerOutput: makeManagerOutput({
        waivedFindings: [{ findingId: 'F-0001', reason: 'reason', evidence: 'src/types.ts:94' }],
      }),
      priorStepResponseText: 'All findings fixed.',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(' ')).toContain('no dispute claim');
    }
  });

  it('should reject a waiver when the id appears outside a Disputed Findings block', () => {
    const result = validateFindingManagerOutput({
      previousLedger: makeLedger(),
      rawFindings: [],
      managerOutput: makeManagerOutput({
        waivedFindings: [{ findingId: 'F-0001', reason: 'reason', evidence: 'src/types.ts:94' }],
      }),
      priorStepResponseText: 'F-0001 was fixed in src/types.ts:94. No disputes.',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(' ')).toContain('no dispute claim');
    }
  });

  it('should reject a waiver when the id only appears inside another finding entry', () => {
    const result = validateFindingManagerOutput({
      previousLedger: makeLedger(),
      rawFindings: [],
      managerOutput: makeManagerOutput({
        waivedFindings: [{ findingId: 'F-0001', reason: 'reason', evidence: 'src/types.ts:94' }],
      }),
      priorStepResponseText: [
        '## Disputed Findings',
        '- findingId: F-0002',
        '  reason: external constraint',
        '  evidence: src/b.ts:20',
        '  note: F-0001 was fixed, not disputed.',
      ].join('\n'),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(' ')).toContain('no dispute claim');
    }
  });

  it('should reject a waiver when findingId only appears inside another entry note line', () => {
    const result = validateFindingManagerOutput({
      previousLedger: makeLedger(),
      rawFindings: [],
      managerOutput: makeManagerOutput({
        waivedFindings: [{ findingId: 'F-0001', reason: 'reason', evidence: 'src/types.ts:94' }],
      }),
      priorStepResponseText: [
        '## Disputed Findings',
        '- findingId: F-0002',
        '  reason: external constraint',
        '  evidence: src/b.ts:20',
        '  note: findingId: F-0001 was fixed in src/a.ts:1',
      ].join('\n'),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(' ')).toContain('no dispute claim');
    }
  });

  it('should reject a waiver when a bare findingId appears indented inside a multi-line note', () => {
    const result = validateFindingManagerOutput({
      previousLedger: makeLedger(),
      rawFindings: [],
      managerOutput: makeManagerOutput({
        waivedFindings: [{ findingId: 'F-0001', reason: 'reason', evidence: 'src/types.ts:94' }],
      }),
      priorStepResponseText: [
        '## Disputed Findings',
        '- findingId: F-0002',
        '  reason: external constraint',
        '  evidence: src/b.ts:20',
        '  note:',
        '    findingId: F-0001 was fixed in src/a.ts:1',
      ].join('\n'),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(' ')).toContain('no dispute claim');
    }
  });

  it('should reject a waiver without file:line evidence', () => {
    const result = validateFindingManagerOutput({
      previousLedger: makeLedger(),
      rawFindings: [],
      managerOutput: makeManagerOutput({
        waivedFindings: [{ findingId: 'F-0001', reason: 'reason', evidence: 'because I said so' }],
      }),
      priorStepResponseText: CLAIM,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(' ')).toContain('file:line evidence');
    }
  });

  it('should reject a dispute note recorded alongside a state transition', () => {
    const result = validateFindingManagerOutput({
      previousLedger: makeLedger(),
      rawFindings: [],
      managerOutput: makeManagerOutput({
        waivedFindings: [{ findingId: 'F-0001', reason: 'reason', evidence: 'src/types.ts:94' }],
        disputeNotes: [{ findingId: 'F-0001', reason: 'also disputed', evidence: 'src/a.ts:1' }],
      }),
      priorStepResponseText: CLAIM,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(' ')).toContain('state transition');
    }
  });

  it('should reject waiving a critical finding', () => {
    const ledger = makeLedger();
    ledger.findings[0]!.severity = 'critical';
    const result = validateFindingManagerOutput({
      previousLedger: ledger,
      rawFindings: [],
      managerOutput: makeManagerOutput({
        waivedFindings: [{ findingId: 'F-0001', reason: 'reason', evidence: 'src/a.ts:1' }],
      }),
      priorStepResponseText: CLAIM,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(' ')).toContain('critical findings must stay open');
    }
  });

  it('should reject waiving a finding that is not open', () => {
    const ledger = makeLedger();
    ledger.findings[0]!.status = 'resolved';
    const result = validateFindingManagerOutput({
      previousLedger: ledger,
      rawFindings: [],
      managerOutput: makeManagerOutput({
        waivedFindings: [{ findingId: 'F-0001', reason: 'reason', evidence: 'src/a.ts:1' }],
      }),
      priorStepResponseText: CLAIM,
    });

    expect(result.ok).toBe(false);
  });

  it('should reject a waive combined with another decision for the same finding', () => {
    const result = validateFindingManagerOutput({
      previousLedger: makeLedger(),
      rawFindings: [makeRawFinding()],
      managerOutput: makeManagerOutput({
        matches: [{ findingId: 'F-0001', rawFindingIds: ['raw-current'] }],
        waivedFindings: [{ findingId: 'F-0001', reason: 'reason', evidence: 'src/a.ts:1' }],
      }),
      priorStepResponseText: CLAIM,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(' ')).toContain('multiple manager decisions');
    }
  });

  it('should accept reopening a waived finding', () => {
    const ledger = makeLedger();
    ledger.findings[0]!.status = 'waived';
    const result = validateFindingManagerOutput({
      previousLedger: ledger,
      rawFindings: [makeRawFinding()],
      managerOutput: makeManagerOutput({
        reopenedFindings: [{ findingId: 'F-0001', rawFindingIds: ['raw-current'], evidence: 'premise no longer holds' }],
      }),
    });

    expect(result.ok).toBe(true);
  });

  it('should record dispute notes only against open findings', () => {
    const ledger = makeLedger();
    ledger.findings[0]!.status = 'resolved';
    const result = validateFindingManagerOutput({
      previousLedger: ledger,
      rawFindings: [],
      managerOutput: makeManagerOutput({
        disputeNotes: [{ findingId: 'F-0001', reason: 'reason', evidence: 'src/a.ts:1' }],
      }),
    });

    expect(result.ok).toBe(false);
  });

  it('should accept a valid manager output before reconciliation', () => {
    const result = validateFindingManagerOutput({
      previousLedger: makeLedger(),
      rawFindings: [makeRawFinding()],
      managerOutput: makeManagerOutput({
        matches: [{ findingId: 'F-0001', rawFindingIds: ['raw-current'] }],
      }),
    });

    expect(result).toEqual({ ok: true });
  });

  it('should reject a rawFindingId referenced by multiple decision categories', () => {
    const result = validateFindingManagerOutput({
      previousLedger: makeLedger(),
      rawFindings: [makeRawFinding()],
      managerOutput: makeManagerOutput({
        newFindings: [{ rawFindingIds: ['raw-current'], title: 'Current issue', severity: 'high' }],
        conflicts: [{ findingIds: [], rawFindingIds: ['raw-current'], description: 'Duplicate raw decision.' }],
      }),
    });

    expect(result).toEqual({
      ok: false,
      errors: [
        'Raw finding id "raw-current" appears in multiple manager decisions: newFindings[0] and conflicts[0]',
      ],
    });
  });

  it('should reject a rawFindingId shared by resolvedFindings and another decision category', () => {
    const result = validateFindingManagerOutput({
      previousLedger: makeLedger(),
      rawFindings: [makeRawFinding({ rawFindingId: 'raw-existing' })],
      managerOutput: makeManagerOutput({
        newFindings: [{ rawFindingIds: ['raw-existing'], title: 'Current issue', severity: 'high' }],
        resolvedFindings: [{ findingId: 'F-0001', rawFindingIds: ['raw-existing'], evidence: 'Fixed.' }],
      }),
    });

    expect(result).toEqual({
      ok: false,
      errors: [
        'Raw finding id "raw-existing" appears in multiple manager decisions: newFindings[0] and resolvedFindings[0]',
        'Resolved finding "F-0001" references current raw finding "raw-existing" that is not a resolution_confirmation',
        'Resolved finding "F-0001" requires at least one current resolution_confirmation raw finding targeting it',
      ],
    });
  });

  it('should reject a rawFindingId shared by multiple resolvedFindings decisions', () => {
    const result = validateFindingManagerOutput({
      previousLedger: makeLedger({
        findings: [
          {
            id: 'F-0001',
            status: 'open',
            lifecycle: 'new',
            severity: 'high',
            title: 'Existing issue',
            reviewers: ['architecture-review'],
            rawFindingIds: ['raw-existing'],
            firstSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
            lastSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
          },
          {
            id: 'F-0002',
            status: 'open',
            lifecycle: 'new',
            severity: 'medium',
            title: 'Second issue',
            reviewers: ['architecture-review'],
            rawFindingIds: ['raw-existing'],
            firstSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
            lastSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
          },
        ],
      }),
      rawFindings: [],
      managerOutput: makeManagerOutput({
        resolvedFindings: [
          { findingId: 'F-0001', rawFindingIds: ['raw-existing'], evidence: 'Fixed.' },
          { findingId: 'F-0002', rawFindingIds: ['raw-existing'], evidence: 'Also fixed.' },
        ],
      }),
    });

    expect(result).toEqual({
      ok: false,
      errors: [
        'Raw finding id "raw-existing" appears in multiple manager decisions: resolvedFindings[0] and resolvedFindings[1]',
        'Resolved finding "F-0001" requires at least one current resolution_confirmation raw finding targeting it',
        'Resolved finding "F-0002" requires at least one current resolution_confirmation raw finding targeting it',
      ],
    });
  });

  it('should reject a findingId referenced by multiple decision categories', () => {
    const result = validateFindingManagerOutput({
      previousLedger: makeLedger(),
      rawFindings: [makeRawFinding()],
      managerOutput: makeManagerOutput({
        matches: [{ findingId: 'F-0001', rawFindingIds: ['raw-current'] }],
        conflicts: [{ findingIds: ['F-0001'], rawFindingIds: [], description: 'Conflicting decision.' }],
      }),
    });

    expect(result).toEqual({
      ok: false,
      errors: [
        'Finding id "F-0001" appears in multiple manager decisions: matches[0] and conflicts[0]',
      ],
    });
  });

  it('should reject unknown rawFindingId references in current raw-finding decisions', () => {
    const result = validateFindingManagerOutput({
      previousLedger: makeLedger(),
      rawFindings: [makeRawFinding({ rawFindingId: 'raw-current' })],
      managerOutput: makeManagerOutput({
        newFindings: [{ rawFindingIds: ['raw-missing'], title: 'Missing raw finding', severity: 'high' }],
      }),
    });

    expect(result).toEqual({
      ok: false,
      errors: ['Unknown raw finding id "raw-missing" in newFindings[0]'],
    });
  });

  it('should reject current raw-finding decisions with empty rawFindingIds before reconciliation', () => {
    const result = validateFindingManagerOutput({
      previousLedger: makeLedger(),
      rawFindings: [makeRawFinding()],
      managerOutput: makeManagerOutput({
        newFindings: [{ rawFindingIds: [], title: 'Missing raw evidence', severity: 'high' }],
      }),
    });

    expect(result).toEqual({
      ok: false,
      errors: ['newFindings[0] must reference at least one current raw finding id'],
    });
  });

  it('should reject conflicts without existing finding ids or current raw finding ids', () => {
    const result = validateFindingManagerOutput({
      previousLedger: makeLedger(),
      rawFindings: [makeRawFinding()],
      managerOutput: makeManagerOutput({
        conflicts: [{ findingIds: [], rawFindingIds: [], description: 'No conflict evidence.' }],
      }),
    });

    expect(result).toEqual({
      ok: false,
      errors: ['conflicts[0] must reference at least one finding id or current raw finding id'],
    });
  });

  it('should reject unknown findingId references', () => {
    const result = validateFindingManagerOutput({
      previousLedger: makeLedger(),
      rawFindings: [makeRawFinding()],
      managerOutput: makeManagerOutput({
        matches: [{ findingId: 'F-9999', rawFindingIds: ['raw-current'] }],
      }),
    });

    expect(result).toEqual({
      ok: false,
      errors: ['Unknown finding id "F-9999" in matches[0]'],
    });
  });

  it('should validate resolvedFinding rawFindingIds against the previous ledger evidence', () => {
    const result = validateFindingManagerOutput({
      previousLedger: makeLedger({
        rawFindings: [makeRawFinding({ rawFindingId: 'raw-other' })],
      }),
      rawFindings: [],
      managerOutput: makeManagerOutput({
        resolvedFindings: [{ findingId: 'F-0001', rawFindingIds: ['raw-other'], evidence: 'Fixed.' }],
      }),
    });

    expect(result).toEqual({
      ok: false,
      errors: [
        'Resolved finding "F-0001" references raw finding id "raw-other" that does not belong to the finding',
        'Resolved finding "F-0001" requires at least one current resolution_confirmation raw finding targeting it',
      ],
    });
  });

  it('should accept a resolution backed by a current resolution_confirmation raw finding', () => {
    const result = validateFindingManagerOutput({
      previousLedger: makeLedger(),
      rawFindings: [
        makeRawFinding({
          rawFindingId: 'raw-confirm',
          kind: 'resolution_confirmation',
          targetFindingId: 'F-0001',
          title: 'Confirmed fixed',
          description: 'Verified at src/index.ts:42 that the issue is resolved.',
        }),
      ],
      managerOutput: makeManagerOutput({
        resolvedFindings: [{ findingId: 'F-0001', rawFindingIds: ['raw-confirm'], evidence: 'Verified at src/index.ts:42.' }],
      }),
    });

    expect(result).toEqual({ ok: true });
  });

  it('should reject a resolution citing a confirmation that targets a different finding', () => {
    const result = validateFindingManagerOutput({
      previousLedger: makeLedger(),
      rawFindings: [
        makeRawFinding({
          rawFindingId: 'raw-confirm',
          kind: 'resolution_confirmation',
          targetFindingId: 'F-0099',
          title: 'Confirmed fixed',
          description: 'Verified elsewhere.',
        }),
      ],
      managerOutput: makeManagerOutput({
        resolvedFindings: [{ findingId: 'F-0001', rawFindingIds: ['raw-confirm'], evidence: 'Verified.' }],
      }),
    });

    expect(result).toEqual({
      ok: false,
      errors: [
        'Resolution confirmation "raw-confirm" targets "F-0099" but was cited for "F-0001"',
        'Resolved finding "F-0001" requires at least one current resolution_confirmation raw finding targeting it',
      ],
    });
  });

  it('should reject a resolution confirmation cited as issue evidence', () => {
    const result = validateFindingManagerOutput({
      previousLedger: makeLedger(),
      rawFindings: [
        makeRawFinding({
          rawFindingId: 'raw-confirm',
          kind: 'resolution_confirmation',
          targetFindingId: 'F-0001',
          title: 'Confirmed fixed',
          description: 'Verified at src/index.ts:42.',
        }),
      ],
      managerOutput: makeManagerOutput({
        newFindings: [{ rawFindingIds: ['raw-confirm'], title: 'Fake issue', severity: 'high' }],
      }),
    });

    expect(result).toEqual({
      ok: false,
      errors: [
        'Resolution confirmation "raw-confirm" cannot be cited as issue evidence in newFindings[0]',
      ],
    });
  });

  it('should reject a silence-based resolution citing only previous ledger raw findings', () => {
    const result = validateFindingManagerOutput({
      previousLedger: makeLedger(),
      rawFindings: [],
      managerOutput: makeManagerOutput({
        resolvedFindings: [{ findingId: 'F-0001', rawFindingIds: ['raw-existing'], evidence: 'No longer reported.' }],
      }),
    });

    expect(result).toEqual({
      ok: false,
      errors: [
        'Resolved finding "F-0001" requires at least one current resolution_confirmation raw finding targeting it',
      ],
    });
  });

  it('should reject invalid state transitions before ledger mutation', () => {
    const result = validateFindingManagerOutput({
      previousLedger: makeLedger({
        findings: [
          {
            id: 'F-0001',
            status: 'resolved',
            lifecycle: 'resolved',
            severity: 'high',
            title: 'Resolved issue',
            reviewers: ['architecture-review'],
            rawFindingIds: ['raw-existing'],
            firstSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
            lastSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
            resolvedAt: '2026-06-13T00:30:00.000Z',
          },
        ],
      }),
      rawFindings: [makeRawFinding()],
      managerOutput: makeManagerOutput({
        matches: [{ findingId: 'F-0001', rawFindingIds: ['raw-current'] }],
      }),
    });

    expect(result).toEqual({
      ok: false,
      errors: ['Cannot match finding "F-0001" because it is not open'],
    });
  });

  it('should reject raw findings with different familyTag values before reconciliation', () => {
    const result = validateFindingManagerOutput({
      previousLedger: makeLedger(),
      rawFindings: [
        makeRawFinding({ rawFindingId: 'raw-current-a', familyTag: 'bug' }),
        makeRawFinding({ rawFindingId: 'raw-current-b', familyTag: 'security' }),
      ],
      managerOutput: makeManagerOutput({
        newFindings: [{
          rawFindingIds: ['raw-current-a', 'raw-current-b'],
          title: 'Mixed finding families',
          severity: 'high',
        }],
      }),
    });

    expect(result).toEqual({
      ok: false,
      errors: [
        'Cannot create a new finding from raw findings with different familyTag values: "bug" and "security" (newFindings[0])',
      ],
    });
  });
});

describe('finding-schemas backward compatibility', () => {
  it('should parse pre-existing raw findings without kind or targetFindingId', () => {
    const parsed = parseRawFindings([
      {
        rawFindingId: 'raw-old',
        stepName: 'arch-review',
        reviewer: 'arch-review',
        familyTag: 'bug',
        severity: 'high',
        title: 'Old entry',
        description: 'Stored before the kind field existed.',
      },
    ]);

    expect(parsed[0]?.kind).toBeUndefined();
    expect(parsed[0]?.targetFindingId).toBeUndefined();
  });

  it('should treat empty location and suggestion from structured output as unset', () => {
    const parsed = parseReviewerRawFindings([
      {
        rawFindingId: 'raw-confirm',
        familyTag: 'bug',
        severity: 'low',
        title: 'Confirmed fixed',
        description: 'Verified at src/index.ts:42.',
        kind: 'resolution_confirmation',
        targetFindingId: 'F-0001',
        location: '',
        suggestion: '',
      },
    ]);

    expect(parsed[0]?.location).toBeUndefined();
    expect(parsed[0]?.suggestion).toBeUndefined();
  });

  it('should treat an empty targetFindingId from structured output as unset', () => {
    const parsed = parseReviewerRawFindings([
      {
        rawFindingId: 'raw-1',
        familyTag: 'bug',
        severity: 'low',
        title: 'Issue entry',
        description: 'Strict structured output fills every field.',
        kind: 'issue',
        targetFindingId: '',
      },
    ]);

    expect(parsed[0]?.kind).toBe('issue');
    expect(parsed[0]?.targetFindingId).toBeUndefined();
  });
});

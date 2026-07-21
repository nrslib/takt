import { describe, expect, it, vi } from 'vitest';
import type { AgentResponse, WorkflowStep } from '../core/models/types.js';
import type { FindingLedger, FindingLedgerEntry, FindingLedgerStore } from '../core/workflow/findings/types.js';
import { assembleManagerOutput } from '../core/workflow/findings/decision-assembly.js';
import { computeDismissCandidates } from '../core/workflow/findings/manager-utils.js';
import { reconcileFindingLedger } from '../core/workflow/findings/reconciler.js';
import { computeFixpointSnapshot } from '../core/workflow/findings/fixpoint.js';
import { createEmptyManagerOutput } from '../core/workflow/findings/manager-output.js';
import { runFindingManagerForStep } from '../core/workflow/findings/manager-runner.js';
import type { FindingManagerDecisions } from '../core/models/finding-types.js';

vi.mock('../agents/agent-usecases.js', () => ({
  executeAgent: vi.fn(),
}));

const { executeAgent } = await import('../agents/agent-usecases.js');
const executeAgentMock = vi.mocked(executeAgent);

function provisionalEntry(overrides: Partial<FindingLedgerEntry> = {}): FindingLedgerEntry {
  return {
    id: 'F-0001',
    status: 'open',
    lifecycle: 'new',
    severity: 'medium',
    title: '必須品質ゲートの実行証跡がない',
    reviewers: ['coding-review'],
    rawFindingIds: ['raw-1'],
    firstSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-07-01T00:00:00.000Z' },
    lastSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-07-01T00:00:00.000Z' },
    provisional: {
      kind: 'unverified-locationless',
      stableKey: 'stable-1',
      lineageKey: 'lineage-1',
      sourceRawFindingIds: ['raw-1'],
      reason: 'a new locationless claim has no mechanically verifiable source_quote evidence',
      firstObservedAt: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-07-01T00:00:00.000Z' },
      lastObservedAt: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-07-01T00:00:00.000Z' },
      interpretationEpochs: 0,
      gateEffect: 'block',
      firstObservedRound: 1,
    },
    ...overrides,
  };
}

function makeLedger(findings: FindingLedgerEntry[], overrides: Partial<FindingLedger> = {}): FindingLedger {
  return {
    version: 1,
    workflowName: 'peer-review',
    nextId: findings.length + 1,
    updatedAt: '2026-07-01T00:00:00.000Z',
    rawFindings: [],
    conflicts: [],
    findings,
    ...overrides,
  };
}

function makeDecisions(overrides: Partial<FindingManagerDecisions> = {}): FindingManagerDecisions {
  return {
    rawDecisions: [],
    disputeDecisions: [],
    conflictDecisions: [],
    invalidateDecisions: [],
    duplicateDecisions: [],
    dismissDecisions: [],
    ...overrides,
  };
}

describe('computeDismissCandidates', () => {
  it('open な provisional のうち裁定可能な kind だけを候補にする', () => {
    const findings = [
      provisionalEntry({ id: 'F-0001' }),
      // 解釈 epoch を使い切った ambiguous — 解釈ラダーの所有権が切れたので候補
      provisionalEntry({
        id: 'F-0002',
        provisional: { ...provisionalEntry().provisional!, kind: 'raw-meaning-ambiguous', stableKey: 'stable-2', interpretationEpochs: 2 },
      }),
      // 解釈 epoch が残る ambiguous — 解釈ラダーが所有権を持つ間は候補にしない
      provisionalEntry({
        id: 'F-0007',
        provisional: { ...provisionalEntry().provisional!, kind: 'raw-meaning-ambiguous', stableKey: 'stable-7', interpretationEpochs: 1 },
      }),
      // 処理失敗の証跡 — 候補にしない
      provisionalEntry({
        id: 'F-0003',
        provisional: { ...provisionalEntry().provisional!, kind: 'reviewer-output-overflow', stableKey: 'stable-3' },
      }),
      provisionalEntry({
        id: 'F-0010',
        provisional: {
          ...provisionalEntry().provisional!,
          kind: 'reviewer-output-overflow',
          stableKey: 'stable-10',
          firstObservedRound: undefined,
        },
      }),
      provisionalEntry({
        id: 'F-0004',
        provisional: { ...provisionalEntry().provisional!, kind: 'manager-budget-exhausted', stableKey: 'stable-4' },
      }),
      provisionalEntry({
        id: 'F-0008',
        provisional: { ...provisionalEntry().provisional!, kind: 'invalid-location-evidence', stableKey: 'stable-8' },
      }),
      provisionalEntry({
        id: 'F-0009',
        provisional: {
          ...provisionalEntry().provisional!,
          kind: 'raw-adjudication-unresolved',
          stableKey: 'stable-9',
          adjudicationAttempts: [1, 2].map((attempt) => ({
            attempt,
            replayRawFindingId: `replay-${attempt}`,
            reason: 'no substantive outcome',
            at: provisionalEntry().lastSeen,
          })),
        },
      }),
      // provisional でない open finding — 候補にしない
      provisionalEntry({ id: 'F-0005', provisional: undefined }),
      // open でない provisional — 候補にしない
      provisionalEntry({ id: 'F-0006', status: 'resolved' }),
    ];

    const candidates = computeDismissCandidates({
      version: 1,
      workflowName: 'test',
      nextId: 11,
      updatedAt: '2026-01-01T00:00:00.000Z',
      findings,
      rawFindings: [],
      conflicts: [],
    });

    expect([...candidates.keys()].sort()).toEqual(['F-0001', 'F-0002', 'F-0009']);
    expect(candidates.get('F-0001')).toContain('unverified-locationless');
  });
});

describe('assembleManagerOutput dismissDecisions', () => {
  const dismissal = { findingId: 'F-0001', basis: 'out_of_scope' as const, reason: '検証結果の評価は final gate の職掌' };

  it('候補集合にある open provisional への dismiss を採用する', () => {
    const ledger = makeLedger([provisionalEntry()]);
    const assembly = assembleManagerOutput({
      previousLedger: ledger,
      residualRawFindings: [],
      decisions: makeDecisions({ dismissDecisions: [dismissal] }),
      dismissCandidateFindingIds: new Set(['F-0001']),
    });

    expect(assembly.output.dismissedFindings).toEqual([dismissal]);
    expect(assembly.rejectedDismissDecisions).toEqual([]);
  });

  it('エンジンが候補として提示していない finding への dismiss は不採用にする', () => {
    const ledger = makeLedger([provisionalEntry()]);
    const assembly = assembleManagerOutput({
      previousLedger: ledger,
      residualRawFindings: [],
      decisions: makeDecisions({ dismissDecisions: [dismissal] }),
      // 候補集合を渡さない = LLM の reason だけでは権限が生まれない
    });

    expect(assembly.output.dismissedFindings).toEqual([]);
    expect(assembly.rejectedDismissDecisions[0]?.reason).toContain('did not offer it as a dismissal candidate');
  });

  it('同ラウンドの clean 証拠による settlement を dismiss より優先する', () => {
    const resolvedTarget = provisionalEntry({ id: 'F-0001' });
    const ledger = makeLedger([resolvedTarget], {
      rawFindings: [{
        rawFindingId: 'confirm-1',
        stepName: 'reviewers',
        reviewer: 'coding-review',
        familyTag: 'gate',
        severity: 'medium',
        title: '解消確認',
        description: 'fixed',
      }],
    });
    const mechanicalOutput = {
      ...createEmptyManagerOutput(),
      resolvedFindings: [{ findingId: 'F-0001', rawFindingIds: ['confirm-1'], evidence: 'clean confirmation' }],
    };
    const assembly = assembleManagerOutput({
      previousLedger: ledger,
      residualRawFindings: [],
      decisions: makeDecisions({ dismissDecisions: [dismissal] }),
      mechanicalOutput,
      dismissCandidateFindingIds: new Set(['F-0001']),
    });

    expect(assembly.output.dismissedFindings).toEqual([]);
    expect(assembly.rejectedDismissDecisions[0]?.reason).toContain('clean evidence settles it');
    expect(assembly.output.resolvedFindings.map((resolved) => resolved.findingId)).toEqual(['F-0001']);
  });

  it('active conflict が参照する finding への dismiss は拒否する（裁定経路を迂回させない）', () => {
    const ledger = makeLedger([provisionalEntry()], {
      conflicts: [{
        id: 'C-1',
        status: 'active',
        findingIds: ['F-0001'],
        rawFindingIds: [],
        description: 'contradiction',
        firstSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-07-01T00:00:00.000Z' },
        lastSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-07-01T00:00:00.000Z' },
      }],
    });
    const assembly = assembleManagerOutput({
      previousLedger: ledger,
      residualRawFindings: [],
      decisions: makeDecisions({ dismissDecisions: [dismissal] }),
      dismissCandidateFindingIds: new Set(['F-0001']),
    });

    expect(assembly.output.dismissedFindings).toEqual([]);
    expect(assembly.rejectedDismissDecisions[0]?.reason).toContain('active conflict');
  });
});

describe('reconcileFindingLedger dismissedFindings', () => {
  it('dismiss を status/lifecycle=dismissed + 監査記録 + revision 加算で適用する', () => {
    const ledger = makeLedger([provisionalEntry({ revision: 3 })]);
    const next = reconcileFindingLedger({
      previousLedger: ledger,
      rawFindings: [],
      managerOutput: {
        ...createEmptyManagerOutput(),
        dismissedFindings: [{ findingId: 'F-0001', basis: 'out_of_scope', reason: 'final gate の職掌' }],
      },
      context: { workflowName: 'peer-review', stepName: 'reviewers', runId: 'run-2', timestamp: '2026-07-02T00:00:00.000Z' },
    });

    const dismissed = next.findings.find((finding) => finding.id === 'F-0001')!;
    expect(dismissed.status).toBe('dismissed');
    expect(dismissed.lifecycle).toBe('dismissed');
    expect(dismissed.revision).toBe(4);
    expect(dismissed.dismissal).toMatchObject({
      basis: 'out_of_scope',
      reason: 'final gate の職掌',
      decidedAt: { runId: 'run-2', stepName: 'reviewers' },
    });
  });

  it('provisional でない finding への dismiss 適用は例外にする（防衛線）', () => {
    const ledger = makeLedger([provisionalEntry({ provisional: undefined })]);
    expect(() => reconcileFindingLedger({
      previousLedger: ledger,
      rawFindings: [],
      managerOutput: {
        ...createEmptyManagerOutput(),
        dismissedFindings: [{ findingId: 'F-0001', basis: 'unverifiable_claim', reason: 'x' }],
      },
      context: { workflowName: 'peer-review', stepName: 'reviewers', runId: 'run-2', timestamp: '2026-07-02T00:00:00.000Z' },
    })).toThrow(/not provisional/);
  });
});

describe('fixpoint snapshot with dismissed provisionals', () => {
  it('dismissed になった provisional は provisionalKeys から消え、id:status として substantiveEntries に現れる', () => {
    const cwd = process.cwd();
    const before = computeFixpointSnapshot(makeLedger([provisionalEntry()]), cwd);
    expect(before.provisionalKeys).toEqual(['stable-1']);
    expect(before.substantiveEntries).toEqual([]);

    const after = computeFixpointSnapshot(
      makeLedger([provisionalEntry({
        status: 'dismissed',
        lifecycle: 'dismissed',
        dismissal: {
          basis: 'out_of_scope',
          reason: 'final gate の職掌',
          decidedAt: { runId: 'run-2', stepName: 'reviewers', timestamp: '2026-07-02T00:00:00.000Z' },
        },
      })]),
      cwd,
    );
    expect(after.provisionalKeys).toEqual([]);
    expect(after.substantiveEntries).toEqual(['F-0001:dismissed']);
  });
});

describe('runFindingManagerForStep dismiss round trip', () => {
  it('残余 raw ゼロでも dismiss 候補があれば manager を起動し、裁定で完了ゲートが開く', async () => {
    let ledger = makeLedger([provisionalEntry()]);
    const savedValidationReports: unknown[] = [];
    const reservations = new Set<string>();
    const ledgerStore: FindingLedgerStore = {
      workflowName: 'peer-review',
      loadLedger: () => ledger,
      saveLedger: (next) => { ledger = next; },
      updateLedger: (mutator) => {
        const mutation = mutator(ledger);
        ledger = mutation.ledger;
        return Promise.resolve(mutation);
      },
      claimAdjudicationReservation: (token) => {
        if (reservations.has(token)) return false;
        reservations.add(token);
        return true;
      },
      releaseAdjudicationReservation: (token) => { reservations.delete(token); },
      createRunCopy: () => '/tmp/ledger-copy.json',
      saveRawFindings: () => '/tmp/raw-findings.json',
      saveManagerValidationReport: (report) => { savedValidationReports.push(report); return '/tmp/report.json'; },
    };
    executeAgentMock.mockResolvedValue({
      status: 'done',
      content: '',
      structuredOutput: {
        rawDecisions: [],
        disputeDecisions: [],
        conflictDecisions: [],
        invalidateDecisions: [],
        duplicateDecisions: [],
        dismissDecisions: [{
          findingId: 'F-0001',
          basis: 'out_of_scope',
          reason: '品質ゲート証跡の評価は final gate の職掌',
        }],
      },
    } as unknown as AgentResponse);

    const result = await runFindingManagerForStep({
      contract: {
        ledgerPath: '.takt/findings/ledger.json',
        rawFindingsPath: '.takt/findings/raw',
        manager: { persona: 'findings-manager', instruction: 'Reconcile findings.', outputContract: 'Return JSON.' },
      } as never,
      ledgerStore,
      optionsBuilder: {
        buildAgentOptions: () => ({}),
        resolveStepProviderModel: () => ({ provider: 'codex', model: 'gpt-test' }),
      } as never,
      stepExecutor: {
        buildPhase1Instruction: (instruction: string) => instruction,
        recordSynthesizedAgentUsage: () => {},
        normalizeStructuredOutput: (_step: WorkflowStep, response: AgentResponse) => response,
      } as never,
      cwd: process.cwd(),
      parentStep: { kind: 'agent', name: 'reviewers', persona: 'reviewer', edit: false } as WorkflowStep,
      stepIteration: 2,
      subResults: [],
      workflowName: 'peer-review',
      runId: 'run-2',
      callNamespace: '',
      timestamp: '2026-07-02T00:00:00.000Z',
    });

    expect(executeAgentMock).toHaveBeenCalledTimes(1);

    const dismissed = result.ledger.findings.find((finding) => finding.id === 'F-0001')!;
    expect(dismissed.status).toBe('dismissed');
    expect(dismissed.dismissal?.basis).toBe('out_of_scope');
    expect(result.ledger.findings.filter((finding) => finding.status === 'open')).toEqual([]);
  });
});

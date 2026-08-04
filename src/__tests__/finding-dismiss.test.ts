import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentResponse, WorkflowStep } from '../core/models/types.js';
import type {
  FindingLedger,
  FindingLedgerEntry,
  FindingLedgerStore,
  RawFinding,
} from '../core/workflow/findings/types.js';
import { assembleManagerOutput } from '../core/workflow/findings/decision-assembly.js';
import { computeDismissCandidates } from '../core/workflow/findings/manager-utils.js';
import { reconcileFindingLedger as reconcileFindingLedgerStrict } from '../core/workflow/findings/reconciler.js';
import { computeFixpointSnapshot } from '../core/workflow/findings/fixpoint.js';
import { createEmptyManagerOutput } from '../core/workflow/findings/manager-output.js';
import { runFindingManagerForStep } from '../core/workflow/findings/manager-runner.js';
import type { FindingManagerDecisions } from '../core/models/finding-types.js';
import { reconcileCommitPlan } from '../core/workflow/findings/manager-commit-finalization.js';
import { computeLineageKey, computeReviewerStableKey } from '../core/workflow/findings/raw-canonicalization.js';
import { storedRawReconcileProvenance } from './helpers/finding-integrity.js';
import {
  authorizeFindingLedgerFixture,
  canonicalRawFindingFixture,
} from './helpers/finding-lifecycle-fixture.js';
import { computeClaimIdentityHash } from '../core/workflow/findings/evidence-domain.js';
import { hasLifecycleProductTransitionCapability } from '../core/workflow/findings/raw-relation-capabilities.js';
import { renderFindingLedgerInstructionSummary } from '../core/workflow/findings/context.js';
import {
  createFindingManagerPublicationDouble,
  RevisionedFindingLedgerTestRepository,
} from './helpers/finding-manager-publication.js';
import { findingManagerTaskResponse } from './helpers/finding-manager-task-response.js';
import { processInterpretationLiveClaims } from '../core/workflow/findings/interpretation-live-claims.js';

vi.mock('../agents/agent-usecases.js', () => ({
  executeAgent: vi.fn(),
}));

const { executeAgent } = await import('../agents/agent-usecases.js');
const executeAgentMock = vi.mocked(executeAgent);

function provisionalEntry(
  overrides: Pick<FindingLedgerEntry, 'revision'> & Partial<Omit<FindingLedgerEntry, 'revision'>>,
): FindingLedgerEntry {
  return {
    id: 'F-0001',
    status: 'open',
    lifecycle: 'new',
    severity: 'medium',
    title: '必須品質ゲートの実行証跡がない',
    evidenceIds: [],
    reviewers: ['coding-review'],
    rawFindingIds: ['raw-1'],
    firstSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-07-01T00:00:00.000Z' },
    lastSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-07-01T00:00:00.000Z' },
    provisional: {
      kind: 'raw-meaning-ambiguous',
      stableKey: 'stable-1',
      lineageKey: 'lineage-1',
      sourceRawFindingIds: ['raw-1'],
      reason: 'the raw finding meaning requires adjudication',
      firstObservedAt: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-07-01T00:00:00.000Z' },
      lastObservedAt: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-07-01T00:00:00.000Z' },
      gateEffect: 'block',
      firstObservedRound: 1,
    },
    ...overrides,
  };
}

function makeLedger(findings: FindingLedgerEntry[], overrides: Partial<FindingLedger> = {}): FindingLedger {
  return authorizeFindingLedgerFixture({
    workflowName: 'peer-review',
    nextId: findings.length + 1,
    updatedAt: '2026-07-01T00:00:00.000Z',
    evidenceRecords: [],
    rawFindings: [],
    conflicts: [],
    findings,
    ...overrides,
  });
}

type TestReconcileInput = Omit<
  Parameters<typeof reconcileFindingLedgerStrict>[0],
  'provisionalFindings' | 'entityProvisionalMutations'
  | 'terminalEntityAttachmentFindingIds'
  | 'rawProvenanceByRawFindingId' | 'verifiedEvidenceRecordsByRawFindingId'
>;

function reconcileFindingLedger(input: TestReconcileInput): FindingLedger {
  return reconcileFindingLedgerStrict({
    ...input,
    entityProvisionalMutations: [],
    terminalEntityAttachmentFindingIds: new Set(),
    provisionalFindings: [],
    verifiedEvidenceRecordsByRawFindingId: new Map(),
    rawProvenanceByRawFindingId: new Map(input.rawFindings.map((rawFinding) => [
      rawFinding.rawFindingId,
      storedRawReconcileProvenance(
        rawFinding,
        computeReviewerStableKey({
          workflowName: input.context.workflowName,
          callNamespace: '',
          parentStepName: input.context.stepName,
          reviewerPersonaKey: rawFinding.reviewer,
        }),
        computeLineageKey({
          claimIdentityHash: computeClaimIdentityHash(rawFinding),
          ...(rawFinding.targetFindingId !== null
            ? { targetFindingId: rawFinding.targetFindingId }
            : {}),
        }),
      ),
    ])),
  });
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
  it('manager には provisional dismissal 候補を公開しない', () => {
    const findings = [
      provisionalEntry({ revision: 1, id: 'F-0001' }),
      // 解釈 epoch を使い切った ambiguous — 解釈ラダーの所有権が切れたので候補
      provisionalEntry({ revision: 1,
        id: 'F-0002',
        provisional: { ...provisionalEntry({ revision: 1 }).provisional!, kind: 'raw-meaning-ambiguous', stableKey: 'stable-2' },
      }),
      // 解釈 epoch が残る ambiguous — 解釈ラダーが所有権を持つ間は候補にしない
      provisionalEntry({ revision: 1,
        id: 'F-0007',
        provisional: { ...provisionalEntry({ revision: 1 }).provisional!, kind: 'raw-meaning-ambiguous', stableKey: 'stable-7' },
      }),
      // 処理失敗の証跡 — 候補にしない
      provisionalEntry({ revision: 1,
        id: 'F-0003',
        provisional: { ...provisionalEntry({ revision: 1 }).provisional!, kind: 'reviewer-output-overflow', stableKey: 'stable-3' },
      }),
      provisionalEntry({ revision: 1,
        id: 'F-0004',
        provisional: { ...provisionalEntry({ revision: 1 }).provisional!, kind: 'manager-budget-exhausted', stableKey: 'stable-4' },
      }),
      provisionalEntry({ revision: 1,
        id: 'F-0008',
        provisional: { ...provisionalEntry({ revision: 1 }).provisional!, kind: 'stale-precondition', stableKey: 'stable-8' },
      }),
      // provisional でない open finding — 候補にしない
      provisionalEntry({ revision: 1, id: 'F-0005', provisional: undefined }),
      // open でない provisional — 候補にしない
      provisionalEntry({ revision: 1, id: 'F-0006', status: 'resolved' }),
    ];

    const candidates = computeDismissCandidates(makeLedger(findings));

    expect(candidates).toEqual(new Map());
  });
});

describe('assembleManagerOutput dismissDecisions', () => {
  const dismissal = {
    findingId: 'F-0001',
    basis: 'outside_contract_jurisdiction' as const,
    reason: '検証結果の評価は final gate の職掌',
    evidence: '主張はコードではなく品質ゲートの実行記録だけを対象にしている',
  };

  it('候補集合を注入しても standard manager dismissal を拒否する', () => {
    const ledger = makeLedger([provisionalEntry({ revision: 1 })]);
    const assembly = assembleManagerOutput({
      previousLedger: ledger,
      residualRawFindings: [],
      decisions: makeDecisions({ dismissDecisions: [dismissal] }),
      dismissCandidateFindingIds: new Set(['F-0001']),
      managerAuthority: 'standard',
    });

    expect(assembly.output.dismissedFindings).toEqual([]);
    expect(assembly.rejectedDismissDecisions[0]?.reason)
      .toContain('outside verified terminal adjudication');
  });

  it('standard authority では semantic dismissal を拒否する', () => {
    const ledger = makeLedger([provisionalEntry({ revision: 1 })]);
    const semanticDismissal = {
      findingId: 'F-0001',
      basis: 'false_positive' as const,
      reason: '現行コードには指摘された分岐が存在しない',
      evidence: 'src/example.ts の実装は入力を検証してから分岐する',
    };
    const assembly = assembleManagerOutput({
      previousLedger: ledger,
      residualRawFindings: [],
      decisions: makeDecisions({ dismissDecisions: [semanticDismissal] }),
      dismissCandidateFindingIds: new Set(['F-0001']),
      managerAuthority: 'standard',
    });

    expect(assembly.output.dismissedFindings).toEqual([]);
    expect(assembly.rejectedDismissDecisions[0]?.reason)
      .toContain('outside verified terminal adjudication');
  });

  it('manager assembly は terminal_adjudication ラベルを自己申告されても dismissal を拒否する', () => {
    const ledger = makeLedger([provisionalEntry({ revision: 1 })]);
    const semanticDismissal = {
      findingId: 'F-0001',
      basis: 'no_issue_after_verification' as const,
      reason: '現行コードを検証した結果、指摘された問題は成立しない',
      evidence: 'src/example.ts の実装は入力を検証してから分岐する',
    };
    const assembly = assembleManagerOutput({
      previousLedger: ledger,
      residualRawFindings: [],
      decisions: makeDecisions({ dismissDecisions: [semanticDismissal] }),
      dismissCandidateFindingIds: new Set(['F-0001']),
      managerAuthority: 'terminal_adjudication',
    });

    expect(assembly.output.dismissedFindings).toEqual([]);
    expect(assembly.output.newFindings).toEqual([]);
    expect(assembly.rejectedDismissDecisions[0]?.reason)
      .toContain('outside verified terminal adjudication');
  });

  it('terminal adjudicator でも同一ラウンドで再観測された finding は dismiss しない', () => {
    const ledger = makeLedger([provisionalEntry({ revision: 1 })]);
    const assembly = assembleManagerOutput({
      previousLedger: ledger,
      residualRawFindings: [],
      decisions: makeDecisions({
        dismissDecisions: [{
          findingId: 'F-0001',
          basis: 'false_positive',
          reason: '現行コードには指摘された問題がない',
          evidence: 'src/example.ts を確認した',
        }],
      }),
      mechanicalOutput: {
        ...createEmptyManagerOutput(),
        matches: [{
          findingId: 'F-0001',
          rawFindingIds: ['persist-1'],
          evidence: '同じ問題を現行コードで再観測した',
        }],
      },
      dismissCandidateFindingIds: new Set(['F-0001']),
      managerAuthority: 'terminal_adjudication',
    });

    expect(assembly.output.dismissedFindings).toEqual([]);
    expect(assembly.output.matches.map((match) => match.findingId)).toEqual(['F-0001']);
    expect(assembly.rejectedDismissDecisions[0]?.reason)
      .toContain('outside verified terminal adjudication');
  });

  it('outside_task_scope も manager assembly では採用しない', () => {
    const ledger = makeLedger([provisionalEntry({ revision: 1 })]);
    const assembly = assembleManagerOutput({
      previousLedger: ledger,
      residualRawFindings: [],
      decisions: makeDecisions({
        dismissDecisions: [{
          findingId: 'F-0001',
          basis: 'outside_task_scope',
          reason: 'GitLab は GitHub 限定 task の範囲外',
          taskQuote: 'GitHub issue attachments',
          workflowTaskDigest: '1'.repeat(64),
          adjudicationTaskId: '2'.repeat(64),
        }],
      }),
      mechanicalOutput: {
        ...createEmptyManagerOutput(),
        matches: [{
          findingId: 'F-0001',
          rawFindingIds: ['persist-1'],
          evidence: 'GitLab 添付の未対応を再観測した',
        }],
      },
      dismissCandidateFindingIds: new Set(['F-0001']),
      managerAuthority: 'terminal_adjudication',
    });

    expect(assembly.output.dismissedFindings).toEqual([]);
    expect(assembly.output.matches.map((match) => match.findingId)).toEqual(['F-0001']);
    expect(assembly.rejectedDismissDecisions[0]?.reason)
      .toContain('outside verified terminal adjudication');
  });

  it('エンジンが候補として提示していない finding への dismiss は不採用にする', () => {
    const ledger = makeLedger([provisionalEntry({ revision: 1 })]);
    const assembly = assembleManagerOutput({
      previousLedger: ledger,
      residualRawFindings: [],
      decisions: makeDecisions({ dismissDecisions: [dismissal] }),
      managerAuthority: 'standard',
      // 候補集合を渡さない = LLM の reason だけでは権限が生まれない
    });

    expect(assembly.output.dismissedFindings).toEqual([]);
    expect(assembly.rejectedDismissDecisions[0]?.reason)
      .toContain('outside verified terminal adjudication');
  });

  it('同ラウンドの clean 証拠による settlement を dismiss より優先する', () => {
    const resolvedTarget = provisionalEntry({ revision: 1, id: 'F-0001' });
    const ledger = makeLedger([resolvedTarget], {
      rawFindings: [{
        rawFindingId: 'confirm-1',
        stepName: 'reviewers',
        reviewer: 'coding-review',
        familyTag: 'gate',
        severity: 'medium',
        title: '解消確認',
        description: 'fixed',
        suggestion: null,
        relation: 'resolution_confirmation',
        targetFindingId: 'F-0001',
        targetPrecondition: {
          targetFindingId: 'F-0001',
          targetRevision: 1,
          targetStatus: 'open',
          targetEvidenceHash: '0'.repeat(64),
        },
        evidence: [],
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
      managerAuthority: 'standard',
    });

    expect(assembly.output.dismissedFindings).toEqual([]);
    expect(assembly.rejectedDismissDecisions[0]?.reason)
      .toContain('outside verified terminal adjudication');
    expect(assembly.output.resolvedFindings.map((resolved) => resolved.findingId)).toEqual(['F-0001']);
  });

  it('active conflict が参照する finding への dismiss は拒否する（裁定経路を迂回させない）', () => {
    const ledger = makeLedger([provisionalEntry({ revision: 1 })], {
      conflicts: [{
    id: 'C-FA2947446963',
    status: 'active',
    revision: 1,
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
      managerAuthority: 'standard',
    });

    expect(assembly.output.dismissedFindings).toEqual([]);
    expect(assembly.rejectedDismissDecisions[0]?.reason)
      .toContain('outside verified terminal adjudication');
  });
});

describe('reconcileFindingLedger dismissedFindings', () => {
  it('standard manager dismissal を reconciliation 境界で拒否する', () => {
    const ledger = makeLedger([provisionalEntry({ revision: 3 })]);
    expect(() => reconcileFindingLedger({
      previousLedger: ledger,
      rawFindings: [],
      managerOutput: {
        ...createEmptyManagerOutput(),
        dismissedFindings: [{
          findingId: 'F-0001',
          basis: 'outside_contract_jurisdiction',
          reason: 'final gate の職掌',
          evidence: '品質ゲートの実行記録だけを対象にしている',
          authority: 'standard',
        }],
      },
      context: { workflowName: 'peer-review', stepName: 'reviewers', runId: 'run-2', timestamp: '2026-07-02T00:00:00.000Z' },
    })).toThrow(/outside verified terminal adjudication/);
  });

  it('terminal_adjudication ラベル付きでも manager commit 経由の dismissal を拒否する', () => {
    const current = provisionalEntry({ revision: 3 });
    const currentLedger = makeLedger([current]);
    const rawFinding: RawFinding = canonicalRawFindingFixture({
      rawFindingId: 'raw-same-claim',
      stepName: 'reviewers',
      reviewer: 'coding-review',
      familyTag: 'quality-gate',
      severity: 'medium',
      title: current.title,
      description: current.description ?? 'same claim',
      suggestion: null,
      relation: 'persists',
      targetFindingId: current.id,
      targetPrecondition: {
        targetFindingId: current.id,
        targetRevision: current.revision,
        targetStatus: 'open',
        targetEvidenceHash: '0'.repeat(64),
      },
      evidence: [],
    });

    const result = reconcileCommitPlan({
      runInput: {
        cwd: process.cwd(),
        workflowName: currentLedger.workflowName,
        parentStep: { kind: 'agent', name: 'reviewers', persona: 'reviewer', edit: false },
        runId: 'run-2',
        timestamp: '2026-07-02T00:00:00.000Z',
      } as never,
      freshLedger: currentLedger,
      rawFindings: [rawFinding],
      managerOutput: {
        ...createEmptyManagerOutput(),
        matches: [{
          findingId: current.id,
          rawFindingIds: [rawFinding.rawFindingId],
          evidence: 'GitLab concern still exists',
        }],
        dismissedFindings: [{
          findingId: current.id,
          basis: 'outside_task_scope',
          reason: 'GitLab は GitHub 限定 task の範囲外',
          taskQuote: 'GitHub issue attachments',
          workflowTaskDigest: '1'.repeat(64),
          adjudicationTaskId: '2'.repeat(64),
          authority: 'terminal_adjudication',
        }],
      },
      provisionalSpecs: [],
      entityProvisionalMutations: [],
      anomalySpecs: [],
      pendingRejectedObservations: [],
      verifiedEvidenceRecordsByRawFindingId: new Map(),
      rawProvenanceByRawFindingId: new Map([[
        rawFinding.rawFindingId,
        storedRawReconcileProvenance(
          rawFinding,
          computeReviewerStableKey({
            workflowName: currentLedger.workflowName,
            callNamespace: '',
            parentStepName: 'reviewers',
            reviewerPersonaKey: rawFinding.reviewer,
          }),
          current.provisional!.lineageKey,
        ),
      ]]),
      cleanWire: [rawFinding],
      explicitResolvedByMapping: new Map(),
      explicitPromotedFindingIds: new Set(),
      recoveryProvisionalRawFindingIds: new Set(),
      staleRawFindingIds: new Set(),
      deferredRawFindingIds: new Set(),
      resolutionRenotifications: [],
      unsupportedRawFindingReports: [],
      healthyReviewerStableKeys: new Set(),
    });
    expect(result.managerOutput.dismissedFindings).toEqual([]);
    expect(result.normalizationRejections).toContainEqual(
      expect.stringContaining('manager dismissal requires verified terminal adjudication'),
    );
    expect(result.ledger.findings.find((finding) => finding.id === current.id)?.status).toBe('open');
  });

  it('provisional でない finding への dismiss 適用は例外にする（防衛線）', () => {
    const ledger = makeLedger([provisionalEntry({ revision: 1, provisional: undefined })]);
    expect(() => reconcileFindingLedger({
      previousLedger: ledger,
      rawFindings: [],
      managerOutput: {
        ...createEmptyManagerOutput(),
        dismissedFindings: [{
          findingId: 'F-0001',
          basis: 'outside_contract_jurisdiction',
          reason: 'x',
          evidence: 'claim has no verifiable subject',
          authority: 'standard',
        }],
      },
      context: { workflowName: 'peer-review', stepName: 'reviewers', runId: 'run-2', timestamp: '2026-07-02T00:00:00.000Z' },
    })).toThrow(/not provisional/);
  });
});

describe('fixpoint snapshot with dismissed provisionals', () => {
  it('dismissed になった provisional は provisionalKeys から消え、id:status として substantiveEntries に現れる', () => {
    const cwd = process.cwd();
    const before = computeFixpointSnapshot(makeLedger([provisionalEntry({ revision: 1 })]), cwd);
    expect(before.provisionalKeys).toEqual(['stable-1']);
    expect(before.substantiveEntries).toEqual([]);

    const after = computeFixpointSnapshot(
      makeLedger([provisionalEntry({ revision: 1,
        status: 'dismissed',
        lifecycle: 'dismissed',
        dismissal: {
          basis: 'outside_contract_jurisdiction',
          reason: 'final gate の職掌',
          evidence: '品質ゲートの実行記録だけを対象にしている',
          authority: 'standard',
          decidedAt: { runId: 'run-2', stepName: 'reviewers', timestamp: '2026-07-02T00:00:00.000Z' },
        },
      })]),
      cwd,
    );
    expect(after.provisionalKeys).toEqual([]);
    expect(after.substantiveEntries).toEqual(['F-0001:dismissed']);
  });
});

describe('outside_task_scope reopen capability', () => {
  const taskDigest = 'a'.repeat(64);
  const dismissed = provisionalEntry({
    revision: 2,
    status: 'dismissed',
    lifecycle: 'dismissed',
    dismissal: {
      basis: 'outside_task_scope',
      reason: 'GitLab は GitHub 限定 task の範囲外',
      taskQuote: 'GitHub issue attachments',
      workflowTaskDigest: taskDigest,
      adjudicationTaskId: 'b'.repeat(64),
      authority: 'terminal_adjudication',
      decidedAt: {
        runId: 'run-2',
        stepName: 'reviewers',
        timestamp: '2026-07-02T00:00:00.000Z',
      },
    },
  });

  it('同じ workflow task digest の reopened raw は audit-only にする', () => {
    expect(hasLifecycleProductTransitionCapability({
      relation: 'reopened',
      target: dismissed,
      workflowTaskDigest: taskDigest,
    })).toBe(false);
  });

  it('別 workflow task digest では新しい scope として reopen を評価できる', () => {
    expect(hasLifecycleProductTransitionCapability({
      relation: 'reopened',
      target: dismissed,
      workflowTaskDigest: 'c'.repeat(64),
    })).toBe(true);
  });

  it('dismissal の task binding を台帳コンテキストへ表示する', () => {
    const summary = JSON.parse(renderFindingLedgerInstructionSummary(
      makeLedger([dismissed]),
    )) as {
      dismissed: Array<{
        taskQuote: string;
        workflowTaskDigest: string;
        adjudicationTaskId: string;
      }>;
    };

    expect(summary.dismissed[0]).toMatchObject({
      taskQuote: 'GitHub issue attachments',
      workflowTaskDigest: taskDigest,
      adjudicationTaskId: 'b'.repeat(64),
    });
  });
});

describe('runFindingManagerForStep dismiss round trip', () => {
  it('残余 raw ゼロでは manager dismissal 候補を生成せず provisional を open のまま保つ', async () => {
    const repository = new RevisionedFindingLedgerTestRepository(
      makeLedger([provisionalEntry({ revision: 1 })]),
    );
    const reportDir = mkdtempSync(join(tmpdir(), 'takt-finding-dismiss-'));
    const savedValidationReports: unknown[] = [];
    const publicationDouble = createFindingManagerPublicationDouble(
      (report) => join(
        reportDir,
        `findings-manager-validation.${report.stepName}.json`,
      ),
      repository,
    );
    const ledgerStore: FindingLedgerStore = {
      ledgerIdentity: '/test/finding-dismiss/ledger.json',
      workflowName: 'peer-review',
      loadLedger: () => repository.loadLedger(),
      updateLedger: (mutator, revalidateBeforeSave) => (
        repository.updateLedger(mutator, revalidateBeforeSave)
      ),
      interpretationLiveClaims: processInterpretationLiveClaims,
      saveLedgerSnapshot: () => {},
      saveRawFindings: () => {},
      saveManagerValidationReport: (report) => { savedValidationReports.push(report); },
      ...publicationDouble,
    };
    executeAgentMock.mockImplementation(async (_persona, instruction) => (
      findingManagerTaskResponse(instruction as string, {
        rawDecisions: [],
        disputeDecisions: [],
        conflictDecisions: [],
        invalidateDecisions: [],
        duplicateDecisions: [],
        dismissDecisions: [{
          findingId: 'F-0001',
          basis: 'outside_contract_jurisdiction',
          reason: '品質ゲート証跡の評価は final gate の職掌',
          evidence: '主張は品質ゲートの実行記録だけを対象にしている',
        }],
      })
    ));

    try {
      const result = await runFindingManagerForStep({
      contract: {
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
      managerAuthority: 'standard',
      workflowTask: 'Review the requested implementation.',
      });

      expect(executeAgentMock).not.toHaveBeenCalled();

      const dismissed = result.ledger.findings.find((finding) => finding.id === 'F-0001')!;
      expect(dismissed.status).toBe('open');
      expect(dismissed.dismissal).toBeUndefined();
      expect(result.ledger.findings.filter((finding) => finding.status === 'open'))
        .toEqual([dismissed]);
    } finally {
      rmSync(reportDir, { recursive: true, force: true });
    }
  });
});

import { describe, it, expect } from 'vitest';
import { InstructionBuilder } from '../core/workflow/instruction/InstructionBuilder.js';
import { ledgerHasOpenFindings, ledgerHasWaivedFindings } from '../core/workflow/findings/context.js';
import type { FindingLedger } from '../core/models/finding-types.js';
import type { InstructionContext } from '../core/workflow/instruction/instruction-context.js';
import type { WorkflowStep } from '../core/models/types.js';

function makeStep(): WorkflowStep {
  return {
    kind: 'agent',
    name: 'fix',
    persona: 'bench-coder',
    instruction: 'Fix the findings.',
    edit: true,
  } as WorkflowStep;
}

function makeContext(options: {
  hasOpenFindings: boolean;
  hasWaivedFindings?: boolean;
  hasDismissedFindings?: boolean;
  /** レビュアー契約（markdown レポート + 正規化係）として組むかどうか。 */
  reviewer?: boolean;
  language?: 'en' | 'ja';
}): InstructionContext {
  return {
    task: 'task',
    iteration: 1,
    maxSteps: 10,
    stepIteration: 1,
    cwd: '/tmp',
    projectCwd: '/tmp',
    userInputs: [],
    language: options.language ?? 'en',
    findingContract: {
      ledgerSummary: '{}',
      reportLedgerSummary: '{}',
      hasOpenFindings: options.hasOpenFindings,
      hasWaivedFindings: options.hasWaivedFindings ?? false,
      hasDismissedFindings: options.hasDismissedFindings ?? false,
      // codex 対策#4: reviewer context は常に reviewScopeSnapshotId とセットで
      // 生成される（WorkflowEngineSetup.buildFindingContractInstructionContext 参照）。
      // 欠けた fixture は finding-contract-instruction.ts の fail-loud ガードに
      // 引っかかるため、実際の生成規則に合わせる。
      ...(options.reviewer === true
        ? { reviewer: { reviewScopeSnapshotId: 'test-snapshot-id' } }
        : {}),
    },
  } as unknown as InstructionContext;
}

/** Finding Contract セクション（appendFindingContractInstruction の出力範囲）を切り出す */
function extractFindingContractSection(instruction: string): string {
  const start = instruction.indexOf('## Finding Contract');
  expect(start).toBeGreaterThanOrEqual(0);
  return instruction.slice(start);
}

describe('dispute guidance injection', () => {
  it('should omit the dispute guidance when the ledger has no open findings', () => {
    const instruction = new InstructionBuilder(makeStep(), makeContext({ hasOpenFindings: false })).build();

    const section = extractFindingContractSection(instruction);
    expect(section).not.toContain('Consolidated ledger copy');
    expect(section).not.toContain('Disputed Findings');
    expect(section).not.toContain('dispute claim');
  });

  it('should inject the dispute guidance when open findings exist', () => {
    const instruction = new InstructionBuilder(makeStep(), makeContext({ hasOpenFindings: true })).build();

    const section = extractFindingContractSection(instruction);
    expect(section).toContain('"## Disputed Findings" heading');
    expect(section).toContain('no longer matches reality');
    expect(section).toContain('findingId: the ledger finding id');
    expect(section).toContain('evidence: file:line references from the current code backing the reason');
  });

  it('should not inject dispute guidance for a reviewer context (reviewer branch wins)', () => {
    const instruction = new InstructionBuilder(
      makeStep(),
      makeContext({ hasOpenFindings: true, reviewer: true }),
    ).build();

    const section = extractFindingContractSection(instruction);
    expect(section).toContain('Write an ordinary Markdown review report');
    expect(section).not.toContain('Disputed Findings');
    expect(section).not.toContain('dispute claim');
  });

  // language の配線漏れは buildFindingContractInstruction の単体テストだけでは
  // 検出できない（InstructionBuilder が context.language を渡し忘れても単体テストは
  // 気づかない）。InstructionBuilder 経由で実際に ja が伝播することを確認する（#1012）。
  it('should inject ja prose with English protocol tokens when language is ja', () => {
    const instruction = new InstructionBuilder(
      makeStep(),
      makeContext({ hasOpenFindings: true, language: 'ja' }),
    ).build();

    const section = extractFindingContractSection(instruction);
    expect(section).toContain('## Disputed Findings');
    expect(section).toContain('findingId:');
    expect(section).toContain('reason:');
    expect(section).toContain('evidence:');
    expect(section).toContain('見出しとフィールド名は英語のまま書いてください');
  });
});

describe('reviewer duty gating', () => {
  // 義務ブロックの有無は、その義務にしか現れない特定のフレーズで判定する。
  // `waived` のような一般語の不在で否定契約を検証すると、無関係な説明文が増える
  // だけで偽陰性・偽陽性になる。
  const CONFIRMATION_DUTY = "When explicitly reporting an open finding's lifecycle";
  const WAIVED_DUTY = 'listed as waived in the ledger summary';

  it('should omit confirmation and waived duties for reviewers when the ledger is empty', () => {
    const instruction = new InstructionBuilder(
      makeStep(),
      makeContext({ hasOpenFindings: false, reviewer: true }),
    ).build();

    const section = extractFindingContractSection(instruction);
    expect(section).toContain('Write an ordinary Markdown review report');
    expect(section).not.toContain(CONFIRMATION_DUTY);
    expect(section).not.toContain(WAIVED_DUTY);
  });

  it('should inject the waived duty independently of open findings', () => {
    const section = extractFindingContractSection(new InstructionBuilder(
      makeStep(),
      makeContext({ hasOpenFindings: false, hasWaivedFindings: true, reviewer: true }),
    ).build());

    expect(section).toContain(WAIVED_DUTY);
    expect(section).not.toContain(CONFIRMATION_DUTY);
  });

  it('should inject confirmation duties when open findings exist and waived duty only with waived findings', () => {
    const withOpen = extractFindingContractSection(new InstructionBuilder(
      makeStep(),
      makeContext({ hasOpenFindings: true, reviewer: true }),
    ).build());
    expect(withOpen).toContain(CONFIRMATION_DUTY);
    expect(withOpen).not.toContain(WAIVED_DUTY);

    const withWaived = extractFindingContractSection(new InstructionBuilder(
      makeStep(),
      makeContext({ hasOpenFindings: true, hasWaivedFindings: true, reviewer: true }),
    ).build());
    expect(withWaived).toContain(WAIVED_DUTY);
  });
});

describe('ledgerHasOpenFindings', () => {
  function makeLedger(statuses: Array<'open' | 'resolved' | 'waived'>): FindingLedger {
    return {
      workflowName: 'w',
      nextId: statuses.length + 1,
      updatedAt: '2026-07-05T00:00:00.000Z',
      rawFindings: [],
      conflicts: [],
      findings: statuses.map((status, index) => ({
        id: `F-000${index + 1}`,
        status,
        lifecycle: status === 'open' ? 'new' : status,
        revision: 1,
        severity: 'high',
        title: `Finding ${index + 1}`,
        reviewers: ['reviewer'],
        rawFindingIds: [],
        firstSeen: { runId: 'r', stepName: 's', timestamp: '2026-07-05T00:00:00.000Z' },
        lastSeen: { runId: 'r', stepName: 's', timestamp: '2026-07-05T00:00:00.000Z' },
      })),
    };
  }

  it('should be false for an empty ledger', () => {
    expect(ledgerHasOpenFindings(makeLedger([]))).toBe(false);
  });

  it('should be false when all findings are resolved or waived', () => {
    expect(ledgerHasOpenFindings(makeLedger(['resolved', 'waived']))).toBe(false);
  });

  it('should be true when any finding is open', () => {
    expect(ledgerHasOpenFindings(makeLedger(['resolved', 'open', 'waived']))).toBe(true);
  });

  it('should detect waived findings independently', () => {
    expect(ledgerHasWaivedFindings(makeLedger(['resolved', 'open']))).toBe(false);
    expect(ledgerHasWaivedFindings(makeLedger(['waived']))).toBe(true);
  });
});

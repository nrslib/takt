/**
 * codex 対策#4 の配線バグ回帰テスト（manager 検証側）。
 *
 * finding-review-scope-snapshot-wiring.test.ts は ParallelRunner が正しい
 * reviewScopeSnapshotId を reviewer instruction へ配ることを固定する。
 * ここではその値が実際に admission の結果を左右することを確認する —
 * 正しい snapshotId を echo した file_quote finding は product finding へ
 * 昇格し、配線バグ時に reviewer が実際に受け取っていた値（空文字 / 古い値）を
 * echo した同じ引用は reviewer anomaly に隔離される。quote 自体（path/行範囲/
 * verbatimExcerpt）は常に正しい実在の引用のまま固定し、snapshotId だけを
 * 変えることで、この1変数だけが admission を分けることを示す。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fsControl = vi.hoisted(() => ({
  beforeOpenPath: undefined as string | undefined,
  beforeOpen: undefined as (() => void) | undefined,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    openSync: ((path: Parameters<typeof actual.openSync>[0], ...args: unknown[]) => {
      if (fsControl.beforeOpenPath === String(path)) {
        fsControl.beforeOpenPath = undefined;
        const beforeOpen = fsControl.beforeOpen;
        fsControl.beforeOpen = undefined;
        beforeOpen?.();
      }
      return Reflect.apply(actual.openSync, actual, [path, ...args]) as number;
    }) as typeof actual.openSync,
  };
});

import { linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentResponse, FindingContractConfig, WorkflowStep } from '../core/models/types.js';
import { verifyFileQuoteEvidence } from '../core/workflow/findings/admission-validation.js';
import { computeReviewScopeSnapshotId } from '../core/workflow/findings/snapshot.js';
import { runFindingManagerForStep } from '../core/workflow/findings/manager-runner.js';
import { createFindingManagerPublicationDouble, RevisionedFindingLedgerTestRepository } from './helpers/finding-manager-publication.js';
import { emptyFindingAuthorityProjection } from './helpers/finding-lifecycle-fixture.js';
import type { FindingLedgerStore } from '../core/workflow/findings/store.js';
import type { FindingLedger } from '../core/workflow/findings/types.js';
import { verifiedSourceQuoteFields } from './helpers/finding-evidence.js';
import { initializeGitFixture } from './helpers/git-fixture.js';

const FINDING_CONTRACT: FindingContractConfig = {
  ledgerPath: '.takt/findings/peer-review.json',
  rawFindingsPath: '.takt/findings/raw',
  manager: {
    persona: 'findings-manager',
    instruction: 'Reconcile findings.',
    outputContract: 'Return JSON.',
  },
};

describe('reviewScopeSnapshotId correctness determines admission outcome (manager-runner.ts)', () => {
  let cwd: string;
  let reportDir: string;

  beforeEach(() => {
    fsControl.beforeOpenPath = undefined;
    fsControl.beforeOpen = undefined;
    cwd = mkdtempSync(join(tmpdir(), 'takt-review-scope-snapshot-admission-'));
    reportDir = mkdtempSync(join(tmpdir(), 'takt-review-scope-snapshot-reports-'));
    mkdirSync(join(cwd, 'src'), { recursive: true });
    writeFileSync(
      join(cwd, 'src', 'example.ts'),
      Array.from({ length: 10 }, (_, i) => `// line ${i + 1}`).join('\n') + '\n',
    );
    initializeGitFixture(cwd, ['src/example.ts']);
  });

  afterEach(() => {
    fsControl.beforeOpenPath = undefined;
    fsControl.beforeOpen = undefined;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(reportDir, { recursive: true, force: true });
  });

  function makeLedgerStore(): { store: FindingLedgerStore; current: () => FindingLedger } {
    const ledgerRepository = new RevisionedFindingLedgerTestRepository({
      workflowName: 'peer-review',
      nextId: 1,
      updatedAt: '2026-07-13T00:00:00.000Z',
      findings: [],
      evidenceRecords: [],
      rawFindings: [],
      conflicts: [],
      interpretations: [],
      ...emptyFindingAuthorityProjection(),
    });
    const reservations = new Set<string>();
    const store: FindingLedgerStore = {
      ledgerIdentity: '/test/finding-review-scope-snapshot-admission/ledger.json',
      workflowName: 'peer-review',
      loadLedger: () => ledgerRepository.loadLedger(),
      updateLedger: (mutator) => ledgerRepository.updateLedger(mutator),
      claimAdjudicationReservation: (token) => {
        if (reservations.has(token)) return false;
        reservations.add(token);
        return true;
      },
      releaseAdjudicationReservation: (token) => { reservations.delete(token); },
      saveLedgerSnapshot: () => {},
      saveRawFindings: () => {},
      saveManagerValidationReport: () => {},
      ...createFindingManagerPublicationDouble(
        (report) => join(reportDir, `findings-manager-validation.${report.stepName}.json`),
        ledgerRepository,
      ),
      saveConflictAdjudicationReport: () => {},
    };
    return { store, current: () => ledgerRepository.loadLedger() };
  }

  /**
   * quote 自体（path/行範囲/verbatimExcerpt）は常に正しい実在の引用にする。
   * 変えるのは snapshotId だけ — これは「ParallelRunner が reviewer instruction
   * へ何を渡したか」に対応する変数であり、この関数の1変数だけが admission の
   * 結果を分けることを示す。
   */
  async function runManagerWithSnapshotId(store: FindingLedgerStore, snapshotId: string) {
    const quote = verifiedSourceQuoteFields(cwd, 'src/example.ts', 3);
    const optionsBuilder = {
      buildAgentOptions: () => ({}),
      resolveStepProviderModel: () => ({ provider: 'claude', model: 'claude-sonnet' }),
    };
    const stepExecutor = {
      buildPhase1Instruction: (instruction: string) => instruction,
      recordSynthesizedAgentUsage: () => {},
      normalizeStructuredOutput: (_step: WorkflowStep, response: AgentResponse) => response,
    };
    const parentStep: WorkflowStep = { kind: 'agent', name: 'reviewers', persona: 'reviewer', edit: false } as WorkflowStep;
    return runFindingManagerForStep({
      contract: FINDING_CONTRACT as never,
      ledgerStore: store,
      optionsBuilder: optionsBuilder as never,
      stepExecutor: stepExecutor as never,
      cwd,
      parentStep,
      stepIteration: 1,
      subResults: [{
        subStep: { kind: 'agent', name: 'ai-antipattern-review', persona: 'ai-antipattern-reviewer', edit: false } as WorkflowStep,
        response: {
          status: 'done',
          content: '',
          structuredOutput: {
            rawFindings: [{
              rawFindingId: 'finding-1',
              familyTag: 'bug',
              severity: 'high',
              title: 'Suspicious pattern in example.ts',
              description: 'A real observation quoting an existing line verbatim.',
              suggestion: 'Fix it.',
              relation: 'new',
              targetFindingId: null,
              evidence: [{ ...quote, snapshotId }],
            }],
          },
        } as unknown as AgentResponse,
      }],
      workflowName: 'peer-review',
      runId: 'test-run',
      callNamespace: '',
      timestamp: '2026-07-13T00:00:00.000Z',
    });
  }

  it('admits a file_quote finding as a real product finding when the reviewer echoes the correct reviewScopeSnapshotId', async () => {
    const { store, current } = makeLedgerStore();
    const correctSnapshotId = computeReviewScopeSnapshotId(cwd);

    const result = await runManagerWithSnapshotId(store, correctSnapshotId);

    expect(result.status).toBe('updated');
    const ledger = current();
    expect(ledger.findings).toHaveLength(1);
    expect(ledger.findings[0]?.title).toBe('Suspicious pattern in example.ts');
    expect(ledger.reviewerAnomalies ?? []).toHaveLength(0);
  });

  it('rejects the identical quote into a reviewer anomaly when reviewScopeSnapshotId is empty — the exact wire shape the pre-fix ParallelRunner bug produced', async () => {
    const { store, current } = makeLedgerStore();

    // pre-fix ParallelRunner built the finding-contract instruction context
    // inline without reviewScopeSnapshotId. finding-contract-instruction.ts's
    // `contract.reviewScopeSnapshotId ?? ''` then rendered an empty token into
    // the reviewer-facing instruction, so a compliant reviewer echoed back ''.
    const result = await runManagerWithSnapshotId(store, '');

    expect(result.status).toBe('updated');
    const ledger = current();
    // 引用そのものは完全に正確でも、snapshotId が不正なら product finding へ昇格しない。
    expect(ledger.findings).toHaveLength(0);
    const anomalies = ledger.reviewerAnomalies ?? [];
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]?.kind).toBe('protocol-anomaly');
  });

  it('isolates the identical quote as a stale-snapshot reviewer anomaly when reviewScopeSnapshotId is non-empty but stale', async () => {
    const { store, current } = makeLedgerStore();

    const result = await runManagerWithSnapshotId(store, '2'.repeat(64));

    expect(result.status).toBe('updated');
    const ledger = current();
    expect(ledger.findings).toHaveLength(0);
    const anomalies = ledger.reviewerAnomalies ?? [];
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]?.kind).toBe('stale-snapshot');
  });

  it('rejects admission when the source file is replaced after inspection and leaves the substitute unchanged', () => {
    const sourcePath = join(cwd, 'src', 'example.ts');
    const originalPath = join(cwd, 'src', 'original-example.ts');
    const outsidePath = join(cwd, 'outside-example.ts');
    const outsideContent = '// substituted outside content\n';
    const quote = verifiedSourceQuoteFields(cwd, 'src/example.ts', 3);
    writeFileSync(outsidePath, outsideContent);
    fsControl.beforeOpenPath = sourcePath;
    fsControl.beforeOpen = () => {
      renameSync(sourcePath, originalPath);
      linkSync(outsidePath, sourcePath);
    };

    const verification = verifyFileQuoteEvidence(cwd, {
      kind: 'file_quote',
      path: 'src/example.ts',
      startLine: 3,
      endLine: 3,
      verbatimExcerpt: quote.verbatimExcerpt,
      snapshotId: quote.snapshotId,
    }, quote.snapshotId);

    expect(verification).toMatchObject({
      outcome: 'unverifiable',
      reason: expect.stringMatching(/identity changed/),
    });
    expect(readFileSync(outsidePath, 'utf-8')).toBe(outsideContent);
    expect(readFileSync(sourcePath, 'utf-8')).toBe(outsideContent);
    expect(readFileSync(originalPath, 'utf-8')).toContain('// line 3');
  });
});

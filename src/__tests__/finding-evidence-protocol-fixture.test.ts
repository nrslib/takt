/**
 * codex 対策#4（typed evidence protocol + verbatimExcerpt 機械照合 +
 * 二系統台帳 + gate 分離）の決定的 red/green fixture。
 *
 * 実 ledger の架空指摘7件（takt-bench run
 * 20260712-073441-pr-task-attachments-takt-add-p の
 * reviewers:2:ai-antipattern-review が返した finding-1〜finding-7）を、
 * 実際に生成された指摘内容を、新しい typed evidence contract の fixture として
 * 固定する。
 *
 * gemma4:31b は ai-antipattern.md ポリシーの章見出し7つ（幻覚API/過剰実装/
 * デッドコード/フォールバック濫用/スコープクリープ/パターン不一致/後方互換）を
 * family_tag として丸暗記し、存在しないファイルへ1件ずつ割り当てた架空指摘を
 * 生成した（コードを読まずポリシー一覧を吐いた）。7件中6件（finding-1〜6）は
 * 存在しないファイルを指し、1件（finding-7、src/shared/constants.ts:20）は
 * 実在するパスを指すが引用内容は無関係（真の欠陥ではない）— 経路の実在性だけを
 * 見る旧チェックはこの1件を素通りさせていた。
 *
 * #4 前（red）: 6件は invalid-location-evidence provisional として product gate
 * を無条件に塞ぎ、1件（finding-7）は決定的検証なしで通常の open finding に昇格する。
 * #4 後（green）: 7件全てが reviewer anomaly（review-integrity 側の二系統台帳）へ
 * 隔離され、product finding は1件も作られず、product gate（findings.open.count /
 * findings.provisional.count）は塞がれない。
 *
 * このテストは #4 実装前後の両方でこのファイルのまま実行できる（RED は
 * 実装直前に stash して確認済み — 実装後は必ず GREEN であることを固定する）。
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AgentResponse, WorkflowStep } from '../core/models/types.js';
import type { FindingLedger } from '../core/workflow/findings/types.js';
import { runFindingManagerForStep, type FindingManagerSubStepResult } from '../core/workflow/findings/manager-runner.js';
import type { FindingLedgerStore } from '../core/workflow/findings/store.js';
import { processInterpretationLiveClaims } from '../core/workflow/findings/interpretation-live-claims.js';
import { buildFindingsRuleContext as buildFindingsRuleContextWithCwd } from '../core/workflow/findings/context.js';
import { computeReviewScopeSnapshotId } from '../core/workflow/findings/snapshot.js';
import { computeFileQuoteEvidenceRecordId } from '../core/models/finding-evidence-record.js';
import { createFindingManagerPublicationDouble, RevisionedFindingLedgerTestRepository } from './helpers/finding-manager-publication.js';
import {
  authorizeFindingLedgerFixture,
  canonicalRawFindingFixture,
  emptyFindingAuthorityProjection,
  reviewerRawExtractionFixture,
} from './helpers/finding-lifecycle-fixture.js';
import { findingReviewPublicationFixture } from './helpers/finding-review-publication.js';
import { initializeGitFixture } from './helpers/git-fixture.js';

vi.mock('../agents/agent-usecases.js', () => ({
  executeAgent: vi.fn(),
}));

const { executeAgent } = await import('../agents/agent-usecases.js');
const executeAgentMock = vi.mocked(executeAgent);

function buildFindingsRuleContext(ledger: FindingLedger) {
  return buildFindingsRuleContextWithCwd(ledger, process.cwd(), new Map());
}

beforeEach(() => {
  executeAgentMock.mockReset();
});

// ---------------------------------------------------------------------------
// fixture cwd: 実測 run と同じ実在/不在パターンを再現する（hermetic —
// 実 takt リポジトリの現在の内容や行数の変化に依存しない）。
// ---------------------------------------------------------------------------
const FIXTURE_CWD = mkdtempSync(join(tmpdir(), 'takt-evidence-protocol-fixture-'));
const REPORT_DIR = mkdtempSync(join(tmpdir(), 'takt-evidence-protocol-reports-'));
function writeFixtureFile(relativePath: string, lineCount: number): void {
  const fullPath = join(FIXTURE_CWD, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, `${Array.from({ length: lineCount }, (_, index) => `// unrelated line ${index + 1}`).join('\n')}\n`);
}
// finding-7 の claim（src/shared/constants.ts:20, "legacy mapping" 云々）と
// 無関係な内容の実在ファイル — 実測どおり「path は実在するが引用内容は
// 架空」を再現する。20行を超える内容にして line 20 を範囲内にする。
writeFixtureFile('src/shared/constants.ts', 29);
initializeGitFixture(FIXTURE_CWD, ['src/shared/constants.ts']);
// finding-1〜6 が指すパスは意図的に作らない（実際に存在しない）。
const FIXTURE_SNAPSHOT_ID = computeReviewScopeSnapshotId(FIXTURE_CWD);

function unverifiedFileQuote(path: string, line: number, verbatimExcerpt: string) {
  return {
    kind: 'file_quote' as const,
    path,
    startLine: line,
    endLine: line,
    verbatimExcerpt,
    snapshotId: FIXTURE_SNAPSHOT_ID,
  };
}

function seedEvidenceRecord() {
  const quote = unverifiedFileQuote(
    'src/shared/constants.ts',
    5,
    '// unrelated line 5',
  );
  const payload = {
    ...quote,
    claimIdentityHash: 'a'.repeat(64),
    fileHash: 'b'.repeat(64),
  };
  return {
    evidenceId: computeFileQuoteEvidenceRecordId(payload),
    ...payload,
  };
}

afterAll(() => {
  rmSync(FIXTURE_CWD, { recursive: true, force: true });
  rmSync(REPORT_DIR, { recursive: true, force: true });
});

/**
 * 実測 run（20260712-073441-pr-task-attachments-takt-add-p、
 * reviewers ステップの2回目実行、ai-antipattern-review）の指摘内容を
 * typed evidence contract で埋め込む。rawFindingId はエンジンの namespacedRawFindingId が
 * 付与する前の、reviewer が実際に返したローカル id（"finding-N"）。
 * このデータは takt-bench リポジトリ（読み取りのみ、書き込みなし）から
 * 1回だけ採取した凍結フィクスチャであり、以後 takt-bench には一切アクセスしない。
 */
const V3R4_AI_ANTIPATTERN_REVIEW_2ND_RAW_FINDINGS: Array<Record<string, unknown>> = [
  {
    rawFindingId: 'finding-1',
    familyTag: 'ai-hallucination',
    severity: 'high',
    title: 'Potential use of non-existent API method',
    description: "The generated code calls `provider.executeWithRetryAsync()`, but the provider interface only defines `executeWithRetry()`. This appears to be an AI hallucination of a common naming pattern.",
    suggestion: 'Change `executeWithRetryAsync()` to `executeWithRetry()`.',
    relation: 'new',
    targetFindingId: null,
    evidence: [unverifiedFileQuote('src/core/workflowExecutor.ts', 45, 'provider.executeWithRetryAsync()')],
  },
  {
    rawFindingId: 'finding-2',
    familyTag: 'over-engineering',
    severity: 'low',
    title: 'Excessive abstraction for simple logic',
    description: 'The AI introduced a complex Strategy pattern for a string transformation that is only used in one place, increasing cognitive load without providing actual extensibility.',
    suggestion: 'Inline the logic into a simple utility function.',
    relation: 'new',
    targetFindingId: null,
    evidence: [unverifiedFileQuote('src/shared/utils/stringHelper.ts', 12, 'class StringTransformStrategy')],
  },
  {
    rawFindingId: 'finding-3',
    familyTag: 'dead-code',
    severity: 'medium',
    title: 'Unused helper method generated by AI',
    description: 'The method `validateLegacyConfigFormat` was generated but is never called within the codebase, likely a leftover from a previous prompt iteration.',
    suggestion: 'Remove the unused method.',
    relation: 'new',
    targetFindingId: null,
    evidence: [unverifiedFileQuote('src/features/config/configLoader.ts', 88, 'validateLegacyConfigFormat()')],
  },
  {
    rawFindingId: 'finding-4',
    familyTag: 'fallback-abuse',
    severity: 'medium',
    title: 'Over-reliance on default arguments masking missing data',
    description: 'The AI added default empty strings to almost all parameters in the setup command, which hides configuration errors that should be explicitly reported to the user.',
    suggestion: 'Remove defaults for required configuration fields and implement proper validation errors.',
    relation: 'new',
    targetFindingId: null,
    evidence: [unverifiedFileQuote('src/app/cli/commands/setup.ts', 30, "function setup(name = '')")],
  },
  {
    rawFindingId: 'finding-5',
    familyTag: 'scope-creep',
    severity: 'low',
    title: 'Implementation of unrequested feature',
    description: 'The AI implemented a remote syslog exporter that was not requested in the requirements, adding unnecessary dependencies.',
    suggestion: 'Remove the syslog exporter logic.',
    relation: 'new',
    targetFindingId: null,
    evidence: [unverifiedFileQuote('src/core/logging/logger.ts', 110, 'createSyslogExporter()')],
  },
  {
    rawFindingId: 'finding-6',
    familyTag: 'pattern-mismatch',
    severity: 'medium',
    title: 'Inconsistent error handling pattern',
    description: 'The AI used a try-catch block that swallows errors and returns null, whereas the rest of the project uses a Result type for explicit error handling.',
    suggestion: 'Refactor the method to return a `Result<T, E>` type.',
    relation: 'new',
    targetFindingId: null,
    evidence: [unverifiedFileQuote('src/features/api/client.ts', 55, 'catch { return null; }')],
  },
  {
    rawFindingId: 'finding-7',
    familyTag: 'legacy-bloat',
    severity: 'low',
    title: 'Unnecessary backward compatibility logic',
    description: 'The AI added a mapping for a version of the config file that was deprecated three versions ago and is no longer supported by the system.',
    suggestion: 'Remove the legacy mapping logic.',
    relation: 'new',
    targetFindingId: null,
    evidence: [unverifiedFileQuote('src/shared/constants.ts', 200, 'const LEGACY_CONFIG_MAP = {}')],
  },
];

function reviewerExtraction(raw: Record<string, unknown>): Record<string, unknown> {
  const finding = raw as Partial<import('../core/workflow/findings/types.js').RawFinding>;
  const localId = typeof finding.rawFindingId === 'string' ? finding.rawFindingId : null;
  const description = typeof finding.description === 'string' ? finding.description : null;
  return reviewerRawExtractionFixture({
    rawFindingId: localId,
    familyTag: typeof finding.familyTag === 'string' ? finding.familyTag : null,
    severity: finding.severity ?? null,
    title: typeof finding.title === 'string' ? finding.title : null,
    description,
    suggestion: typeof finding.suggestion === 'string' ? finding.suggestion : null,
    relation: finding.relation ?? null,
    targetFindingId: finding.targetFindingId ?? null,
    evidence: finding.evidence,
    rawExcerpt: `[${localId ?? 'anonymous'}] ${description ?? finding.title ?? 'Observation'}`,
  });
}

function makeHarness(initialLedger: FindingLedger): {
  currentLedger: () => FindingLedger;
  run: () => ReturnType<typeof runFindingManagerForStep>;
} {
  const ledgerRepository = new RevisionedFindingLedgerTestRepository(initialLedger);
  const ledgerStore: FindingLedgerStore = {
    ledgerIdentity: '/test/finding-evidence-protocol-fixture/ledger.json',
    workflowName: 'peer-review',
    loadLedger: () => ledgerRepository.loadLedger(),
    updateLedger: (mutator) => ledgerRepository.updateLedger(mutator),
    interpretationLiveClaims: processInterpretationLiveClaims,
    saveLedgerSnapshot: () => {},
    saveRawFindings: () => {},
    saveManagerValidationReport: () => {},
    ...createFindingManagerPublicationDouble(
      (report) => join(REPORT_DIR, `findings-manager-validation.${report.stepName}.json`),
      ledgerRepository,
    ),
  };
  const optionsBuilder = {
    buildAgentOptions: () => ({}),
    resolveStepProviderModel: () => ({ provider: 'opencode', model: 'gemma4:31b' }),
  };
  const stepExecutor = {
    buildPhase1Instruction: (instruction: string) => instruction,
    recordSynthesizedAgentUsage: () => {},
    normalizeStructuredOutput: (_step: WorkflowStep, response: AgentResponse) => response,
  };
  const parentStep: WorkflowStep = { kind: 'agent', name: 'reviewers', persona: 'reviewer', edit: false } as WorkflowStep;
  const contract = {
    manager: {
      persona: 'findings-manager',
      instruction: 'Reconcile findings.',
      outputContract: 'Return JSON.',
    },
  };
  return {
    currentLedger: () => ledgerRepository.loadLedger(),
    run: () => {
      const extractions = V3R4_AI_ANTIPATTERN_REVIEW_2ND_RAW_FINDINGS
        .map(reviewerExtraction);
      const subResults: FindingManagerSubStepResult[] = [{
        subStep: { kind: 'agent', name: 'ai-antipattern-review', persona: 'ai-antipattern-reviewer', edit: false } as WorkflowStep,
        publication: findingReviewPublicationFixture({
          scopeIdentity: ledgerStore.ledgerIdentity,
          parentStepName: parentStep.name,
          stepIteration: 2,
          reviewerStepName: 'ai-antipattern-review',
          rawFindings: extractions,
        }),
      }];
      return runFindingManagerForStep({
        contract: contract as never,
        ledgerStore,
        optionsBuilder: optionsBuilder as never,
        stepExecutor: stepExecutor as never,
        cwd: FIXTURE_CWD,
        parentStep,
        stepIteration: 2,
        subResults,
        workflowName: 'peer-review',
        workflowTask: 'Review the implementation.',
        runId: '20260712-073441-pr-task-attachments-takt-add-p',
        callNamespace: '',
        timestamp: '2026-07-12T09:05:19.675Z',
        managerAuthority: 'standard',
      });
    },
  };
}

describe('codex 対策#4 red/green fixture: 実測の gemma 架空指摘7件（ai-antipattern-review 2巡目）', () => {
  it('GREEN: engine coverage gap 6件は provisional、invalid locator 1件は reviewer anomaly へ隔離される', async () => {
    const harness = makeHarness({
      workflowName: 'peer-review', nextId: 1, updatedAt: '2026-07-12T00:00:00.000Z',
      findings: [], evidenceRecords: [], rawFindings: [], conflicts: [],
      ...emptyFindingAuthorityProjection(),
    });

    const result = await harness.run();

    // 決定的検証だけで着地する — manager（LLM）は一切呼ばれない。
    expect(executeAgentMock).not.toHaveBeenCalled();
    expect(result.status).toBe('updated');

    const ledger = harness.currentLedger();
    expect(ledger.findings).toHaveLength(6);

    const context = buildFindingsRuleContext(ledger);
    expect(context.open.count).toBe(6);
    expect(context.provisional.count).toBe(6);
    expect(context.reviewerAnomalies.count).toBe(1);

    const anomalies = ledger.reviewerAnomalies ?? [];
    expect(anomalies).toEqual([expect.objectContaining({
      kind: 'quote-mismatch',
      title: 'Unnecessary backward compatibility logic',
      occurrences: 1,
    })]);
    const provisionalTitles = ledger.findings.map((finding) => finding.title).sort();
    expect(provisionalTitles).toEqual([
      'Excessive abstraction for simple logic',
      'Implementation of unrequested feature',
      'Inconsistent error handling pattern',
      'Over-reliance on default arguments masking missing data',
      'Potential use of non-existent API method',
      'Unused helper method generated by AI',
    ].sort());

    const finding7Anomaly = anomalies.find((anomaly) => anomaly.title === 'Unnecessary backward compatibility logic');
    expect(finding7Anomaly?.claimedLocation).toBeUndefined();
    expect(finding7Anomaly?.mismatchReason).toContain('line range');
  });

  it('reviewer anomaly は critical-path の安全不変条件を満たす: invalidated/resolved/waived な状態を持たず、findings 配列を一切変更しない', async () => {
    const evidenceRecord = seedEvidenceRecord();
    const seedFinding = {
      id: 'F-0001',
      status: 'open' as const,
      lifecycle: 'new' as const,
      severity: 'medium' as const,
      title: 'A genuine, unrelated pre-existing finding',
      evidenceIds: [evidenceRecord.evidenceId],
      description: 'Pre-existing finding untouched by this round.',
      reviewers: ['arch-review'],
      rawFindingIds: ['raw-seed'],
      firstSeen: { runId: 'run-0', stepName: 'reviewers', timestamp: '2026-07-01T00:00:00.000Z' },
      lastSeen: { runId: 'run-0', stepName: 'reviewers', timestamp: '2026-07-01T00:00:00.000Z' },
      revision: 1,
    };
    const initialLedger = authorizeFindingLedgerFixture({
      workflowName: 'peer-review', nextId: 2, updatedAt: '2026-07-12T00:00:00.000Z',
      findings: [seedFinding],
      evidenceRecords: [evidenceRecord],
      rawFindings: [canonicalRawFindingFixture({
        rawFindingId: 'raw-seed',
        stepName: 'reviewers',
        reviewer: 'arch-review',
        familyTag: 'bug',
        severity: 'medium',
        title: 'A genuine, unrelated pre-existing finding',
        description: 'Pre-existing finding untouched by this round.',
        suggestion: null,
        relation: 'new',
        targetFindingId: null,
        target: { kind: 'code', paths: ['src/shared/constants.ts'] },
        evidence: [unverifiedFileQuote('src/shared/constants.ts', 5, '// unrelated line 5')],
      })],
      conflicts: [],
    });
    const harness = makeHarness(initialLedger);

    await harness.run();

    const ledger = harness.currentLedger();
    // 既存 finding は状態・revision とも一切変更されない（別配列なので触りようがない）。
    const preserved = ledger.findings.find((finding) => finding.id === 'F-0001');
    expect(preserved).toEqual(initialLedger.findings[0]);

    // ReviewerAnomalyEntry には status/lifecycle/waivers フィールドが型として
    // 存在しない（invalidated/resolved/waived として扱えない）。
    for (const anomaly of ledger.reviewerAnomalies ?? []) {
      expect(anomaly).not.toHaveProperty('status');
      expect(anomaly).not.toHaveProperty('lifecycle');
      expect(anomaly).not.toHaveProperty('waivers');
    }
  });
});

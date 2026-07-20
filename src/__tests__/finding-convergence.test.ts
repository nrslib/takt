/**
 * Focused tests for the Finding Contract convergence design (Phase A):
 * raw admission validation (item 1), duplicateDecisions/superseded (item 6),
 * invalidate/invalidated (item 1/4), and relation schema invariants (item 3/7).
 * Items 1/2/4/5 mechanical-classification and grouping-key
 * behavior are covered in finding-mechanical-classification.test.ts and
 * finding-decision-assembly.test.ts; this file covers the remaining pipeline
 * seams (admission -> assembly -> reconcile) and schema invariants.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, readFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assembleManagerOutput } from '../core/workflow/findings/decision-assembly.js';
import { classifyRawFindingsMechanically } from '../core/workflow/findings/mechanical-classification.js';
import { reconcileFindingLedger } from '../core/workflow/findings/reconciler.js';
import { validateLocationAdmission } from '../core/workflow/findings/admission-validation.js';
import { runFindingManagerForStep } from '../core/workflow/findings/manager-runner.js';
import { parseFindingLedger, parseRawFindings } from '../core/models/finding-schemas.js';
import { buildFindingsRuleContext as buildFindingsRuleContextWithCwd } from '../core/workflow/findings/context.js';
import type { AgentResponse, WorkflowStep } from '../core/models/types.js';
import type { FindingLedger, FindingLedgerEntry, FindingLedgerStore, FindingManagerDecisions, RawFinding } from '../core/workflow/findings/types.js';
import { createFindingAdjudicationReservation } from './helpers/finding-adjudication-reservation.js';
import { verifiedSourceQuoteFields } from './helpers/finding-evidence.js';
import { initializeGitFixture } from './helpers/git-fixture.js';

function buildFindingsRuleContext(ledger: FindingLedger) {
  return buildFindingsRuleContextWithCwd(ledger, process.cwd());
}

vi.mock('../agents/agent-usecases.js', () => ({
  executeAgent: vi.fn(),
}));

const { executeAgent } = await import('../agents/agent-usecases.js');
const executeAgentMock = vi.mocked(executeAgent);

function makeRawFinding(overrides: Partial<RawFinding> = {}): RawFinding {
  return {
    rawFindingId: 'raw-current',
    stepName: 'architecture-review',
    reviewer: 'architecture-review',
    familyTag: 'bug',
    severity: 'high',
    title: 'Current issue',
    description: 'The issue is present in the current review.',
    relation: 'new',
    ...overrides,
  };
}

function makeFinding(overrides: Partial<FindingLedgerEntry> = {}): FindingLedgerEntry {
  return {
    id: 'F-0001',
    status: 'open',
    lifecycle: 'new',
    severity: 'high',
    title: 'Existing issue',
    location: 'src/a.ts:10',
    reviewers: ['architecture-review'],
    rawFindingIds: ['raw-existing'],
    firstSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
    lastSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
    ...overrides,
  };
}

function makeLedger(overrides: Partial<FindingLedger> = {}): FindingLedger {
  return {
    version: 1,
    workflowName: 'peer-review',
    nextId: 2,
    updatedAt: '2026-06-13T00:00:00.000Z',
    rawFindings: [makeRawFinding({ rawFindingId: 'raw-existing' })],
    conflicts: [],
    findings: [makeFinding()],
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

describe('item 3/6: duplicateDecisions merges duplicates into a canonical finding', () => {
  it('Given F-0011/F-0017/F-0018-style duplicates When the manager issues duplicateDecisions Then the canonical absorbs raw/reviewer evidence and duplicates become superseded, reducing the open count', () => {
    const canonical = makeFinding({
      id: 'F-0011',
      title: 'Distributed lock cleanup gap',
      location: 'src/lock/manager.ts:80',
      reviewers: ['robustness-review'],
      rawFindingIds: ['raw-f11'],
    });
    const dupA = makeFinding({
      id: 'F-0017',
      title: 'Lock handle not released under contention',
      location: 'src/lock/manager.ts:140',
      reviewers: ['concurrency-review'],
      rawFindingIds: ['raw-f17'],
    });
    const dupB = makeFinding({
      id: 'F-0018',
      title: 'Distributed lock leak on cleanup failure',
      location: 'src/lock/cleanup.ts:12',
      reviewers: ['reliability-review'],
      rawFindingIds: ['raw-f18'],
    });
    const otherOpen = makeFinding({ id: 'F-0002', title: 'Unrelated issue', location: 'src/other.ts:1', rawFindingIds: [] });
    const ledger = makeLedger({
      nextId: 19,
      rawFindings: [
        makeRawFinding({ rawFindingId: 'raw-f11', familyTag: 'concurrency' }),
        makeRawFinding({ rawFindingId: 'raw-f17', familyTag: 'race-condition' }),
        makeRawFinding({ rawFindingId: 'raw-f18', familyTag: 'resource-leak' }),
      ],
      findings: [canonical, dupA, dupB, otherOpen],
    });

    const before = buildFindingsRuleContext(ledger);
    expect(before.open.count).toBe(4);

    const assembly = assembleManagerOutput({
      previousLedger: ledger,
      residualRawFindings: [],
      decisions: makeDecisions({
        duplicateDecisions: [{
          canonicalFindingId: 'F-0011',
          duplicateFindingIds: ['F-0017', 'F-0018'],
          evidence: 'All three describe the same distributed lock cleanup gap; reviewers used different familyTag values and lines.',
        }],
      }),
    });
    expect(assembly.rejectedDuplicateDecisions).toEqual([]);
    expect(assembly.output.duplicateFindings).toEqual([{
      canonicalFindingId: 'F-0011',
      duplicateFindingIds: ['F-0017', 'F-0018'],
      evidence: 'All three describe the same distributed lock cleanup gap; reviewers used different familyTag values and lines.',
    }]);

    const next = reconcileFindingLedger({
      previousLedger: ledger,
      rawFindings: [],
      managerOutput: assembly.output,
      context: { workflowName: 'peer-review', stepName: 'reviewers', runId: 'run-2', timestamp: '2026-07-10T00:00:00.000Z' },
    });

    const nextCanonical = next.findings.find((f) => f.id === 'F-0011');
    const nextDupA = next.findings.find((f) => f.id === 'F-0017');
    const nextDupB = next.findings.find((f) => f.id === 'F-0018');
    expect(nextCanonical?.status).toBe('open');
    expect(nextCanonical?.rawFindingIds.sort()).toEqual(['raw-f11', 'raw-f17', 'raw-f18']);
    expect(nextCanonical?.reviewers.sort()).toEqual(['concurrency-review', 'reliability-review', 'robustness-review']);
    expect(nextDupA?.status).toBe('superseded');
    expect(nextDupA?.lifecycle).toBe('superseded');
    expect(nextDupA?.supersededByFindingId).toBe('F-0011');
    expect(nextDupB?.status).toBe('superseded');
    expect(nextDupB?.supersededByFindingId).toBe('F-0011');

    const after = buildFindingsRuleContext(next);
    expect(after.open.count).toBe(2); // F-0011 (merged) + F-0002; F-0017/F-0018 dropped out of open.
  });

  it('Given a duplicateDecisions entry with an unknown duplicate finding id When assembled Then it is rejected and nothing is applied', () => {
    const ledger = makeLedger({ findings: [makeFinding({ id: 'F-0011' })] });
    const result = assembleManagerOutput({
      previousLedger: ledger,
      residualRawFindings: [],
      decisions: makeDecisions({
        duplicateDecisions: [{ canonicalFindingId: 'F-0011', duplicateFindingIds: ['F-9999'], evidence: 'x' }],
      }),
    });
    expect(result.output.duplicateFindings).toEqual([]);
    expect(result.rejectedDuplicateDecisions).toHaveLength(1);
  });

  // duplicate 統合の受け皿（canonical）を同じ出力で waive すると、統合された
  // 指摘ごとゲートから消える。canonical も waive/note 併存禁止集合
  // （transitionedFindingIds）に載せて不採用にする。
  it('Given a duplicateDecisions canonical that is also waived in the same output When assembled Then the waive is rejected', () => {
    const ledger = makeLedger({
      findings: [makeFinding({ id: 'F-0001' }), makeFinding({ id: 'F-0002', location: 'src/b.ts:1' })],
    });
    const claim = '## Disputed Findings\n- findingId: F-0001\n  reason: frozen contract\n  evidence: src/a.ts:10';
    const result = assembleManagerOutput({
      previousLedger: ledger,
      residualRawFindings: [],
      decisions: makeDecisions({
        duplicateDecisions: [{ canonicalFindingId: 'F-0001', duplicateFindingIds: ['F-0002'], evidence: 'same issue' }],
        disputeDecisions: [{ findingId: 'F-0001', decision: 'waive', reason: 'frozen contract', evidence: 'src/a.ts:10' }],
      }),
      priorStepResponseText: claim,
    });

    expect(result.output.duplicateFindings).toHaveLength(1);
    expect(result.output.waivedFindings).toEqual([]);
    expect(result.rejectedDisputeDecisions).toHaveLength(1);
    expect(result.rejectedDisputeDecisions[0]?.reason).toContain('state transition');
    expect(result.rejectedRawDecisions).toEqual([expect.objectContaining({
      findingId: 'F-0001',
      decision: 'waive',
    })]);
  });

  it('Given a duplicateDecisions entry where the canonical is also a duplicate of another entry When assembled Then the cyclic entry is rejected', () => {
    const ledger = makeLedger({
      findings: [makeFinding({ id: 'F-0001' }), makeFinding({ id: 'F-0002', location: 'src/b.ts:1' }), makeFinding({ id: 'F-0003', location: 'src/c.ts:1' })],
    });
    const result = assembleManagerOutput({
      previousLedger: ledger,
      residualRawFindings: [],
      decisions: makeDecisions({
        duplicateDecisions: [
          { canonicalFindingId: 'F-0001', duplicateFindingIds: ['F-0002'], evidence: 'a' },
          { canonicalFindingId: 'F-0002', duplicateFindingIds: ['F-0003'], evidence: 'b' },
        ],
      }),
    });
    expect(result.output.duplicateFindings).toHaveLength(1);
    expect(result.output.duplicateFindings[0]?.canonicalFindingId).toBe('F-0001');
    expect(result.rejectedDuplicateDecisions).toHaveLength(1);
    expect(result.rejectedDuplicateDecisions[0]?.reason).toContain('cycle');
  });
});

describe('item 1/4: raw admission validation and invalidate', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'takt-findings-admission-'));
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src/real.ts'), `${Array.from({ length: 5 }, (_, i) => `// line ${i + 1}`).join('\n')}\n`);
    initializeGitFixture(projectDir, ['src/real.ts']);
    executeAgentMock.mockReset();
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('Given a location whose path does not exist When validated Then it is inadmissible', () => {
    const result = validateLocationAdmission(projectDir, 'src/does-not-exist.ts:1');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('does not exist');
  });

  it('Given a location whose line is out of range When validated Then it is inadmissible', () => {
    const result = validateLocationAdmission(projectDir, 'src/real.ts:9999');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('out of range');
  });

  it('Given a location that exists and is in range When validated Then it is admissible', () => {
    expect(validateLocationAdmission(projectDir, 'src/real.ts:3')).toEqual({ ok: true });
  });

  // B1: 末尾改行は「最終行の終端」であって空行ではない。5行 + 末尾改行の
  // ファイルで、ちょうど最終行（:5）は範囲内、最終行+1（:6）は範囲外。
  // 素朴な split('\n').length は :6 を範囲内と誤判定していた（codex 再現）。
  it('Given a file with a trailing newline When the exact last line is cited Then it is admissible, and last line + 1 is not', () => {
    // src/real.ts は5行 + 末尾改行（beforeEach 参照）。
    expect(validateLocationAdmission(projectDir, 'src/real.ts:5')).toEqual({ ok: true });
    const overByOne = validateLocationAdmission(projectDir, 'src/real.ts:6');
    expect(overByOne.ok).toBe(false);
    expect(overByOne.reason).toContain('file has 5 lines');
  });

  it('Given a file without a trailing newline When the exact last line is cited Then it is admissible, and last line + 1 is not', () => {
    writeFileSync(join(projectDir, 'src/no-trailing.ts'), 'line 1\nline 2\nline 3');
    expect(validateLocationAdmission(projectDir, 'src/no-trailing.ts:3')).toEqual({ ok: true });
    const overByOne = validateLocationAdmission(projectDir, 'src/no-trailing.ts:4');
    expect(overByOne.ok).toBe(false);
    expect(overByOne.reason).toContain('file has 3 lines');
  });

  it('Given an empty file When line 1 is cited Then it is inadmissible', () => {
    writeFileSync(join(projectDir, 'src/empty.ts'), '');
    const result = validateLocationAdmission(projectDir, 'src/empty.ts:1');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('file has 0 lines');
  });

  // B1: 字句的な resolve() はプロジェクト内に見えるパスの symlink 脱出を検出
  // できない（codex 再現: node_modules/... の symlink 実体が受理された）。
  // realpath で解決した実体パスがプロジェクト root 配下にあることを検証する。
  it('Given a symlink inside the project pointing outside it When validated Then it is inadmissible', () => {
    const outsideDir = mkdtempSync(join(tmpdir(), 'takt-findings-outside-'));
    try {
      writeFileSync(join(outsideDir, 'outside.ts'), 'line 1\nline 2\n');
      symlinkSync(join(outsideDir, 'outside.ts'), join(projectDir, 'src/escape.ts'));
      const result = validateLocationAdmission(projectDir, 'src/escape.ts:1');
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('outside the project');
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('Given a symlinked directory inside the project pointing outside it When a file under it is cited Then it is inadmissible', () => {
    const outsideDir = mkdtempSync(join(tmpdir(), 'takt-findings-outside-dir-'));
    try {
      writeFileSync(join(outsideDir, 'module.ts'), 'line 1\n');
      symlinkSync(outsideDir, join(projectDir, 'vendored'));
      const result = validateLocationAdmission(projectDir, 'vendored/module.ts:1');
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('outside the project');
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('Given a symlink inside the project pointing at another file inside the project When validated Then it is admissible', () => {
    symlinkSync(join(projectDir, 'src/real.ts'), join(projectDir, 'src/alias.ts'));
    expect(validateLocationAdmission(projectDir, 'src/alias.ts:1')).toEqual({ ok: true });
  });

  it('Given no location When validated Then it is admissible (nothing to check)', () => {
    expect(validateLocationAdmission(projectDir, undefined)).toEqual({ ok: true });
  });

  it('keeps an inaccessible existing location unverifiable instead of classifying it as invalid', () => {
    const restrictedDir = join(projectDir, 'restricted');
    mkdirSync(restrictedDir);
    writeFileSync(join(restrictedDir, 'real.ts'), 'line 1\n');
    chmodSync(restrictedDir, 0o000);
    try {
      const result = validateLocationAdmission(projectDir, 'restricted/real.ts:1');
      expect(result).toMatchObject({ ok: false, outcome: 'unverifiable' });
    } finally {
      chmodSync(restrictedDir, 0o700);
    }
  });

  function makeHarness(initialLedger: FindingLedger): {
    savedLedgers: FindingLedger[];
    savedValidationReports: unknown[];
    run: (input: { reviewerRawFindings: Array<Record<string, unknown>>; priorStepResponseText?: string }) => ReturnType<typeof runFindingManagerForStep>;
  } {
    let ledger = initialLedger;
    const savedLedgers: FindingLedger[] = [];
    const savedValidationReports: unknown[] = [];
    const ledgerStore: FindingLedgerStore = {
      workflowName: 'peer-review',
      loadLedger: () => ledger,
      saveLedger: (next) => { savedLedgers.push(next); },
      // v2 では WAL（beginInterpretations 等）が保存を複数回行うため、double も
      // 状態を持つ（mutator の結果を次回の読み込みへ引き継ぐ）。
      updateLedger: (mutator) => {
        const mutation = mutator(ledger);
        ledger = mutation.ledger;
        savedLedgers.push(ledger);
        return Promise.resolve(mutation);
      },
      ...createFindingAdjudicationReservation(),
      createRunCopy: () => join(projectDir, 'ledger-copy.json'),
      saveRawFindings: () => join(projectDir, 'raw-findings.json'),
      saveManagerValidationReport: (report) => {
        savedValidationReports.push(report);
        return join(projectDir, 'manager-report.json');
      },
    };
    const optionsBuilder = {
      buildAgentOptions: () => ({}),
      resolveStepProviderModel: () => ({ provider: 'codex', model: 'gpt-test' }),
    };
    const stepExecutor = {
      buildPhase1Instruction: (instruction: string) => instruction,
      recordSynthesizedAgentUsage: () => {},
      normalizeStructuredOutput: (_step: WorkflowStep, response: AgentResponse) => response,
    };
    const parentStep: WorkflowStep = { kind: 'agent', name: 'reviewers', persona: 'reviewer', edit: false } as WorkflowStep;
    const contract = {
      ledgerPath: '.takt/findings/ledger.json',
      rawFindingsPath: '.takt/findings/raw',
      manager: { persona: 'findings-manager', instruction: 'Reconcile findings.', outputContract: 'Return JSON.' },
    };
    return {
      savedLedgers,
      savedValidationReports,
      run: (input) => runFindingManagerForStep({
        contract: contract as never,
        ledgerStore,
        optionsBuilder: optionsBuilder as never,
        stepExecutor: stepExecutor as never,
        cwd: projectDir,
        parentStep,
        stepIteration: 1,
        subResults: [{
          subStep: { kind: 'agent', name: 'architecture-review', persona: 'arch', edit: false } as WorkflowStep,
          response: { status: 'done', content: '', structuredOutput: { rawFindings: input.reviewerRawFindings } } as unknown as AgentResponse,
        }],
        workflowName: 'peer-review',
        runId: 'run-1',
        callNamespace: '',
        timestamp: '2026-07-10T00:00:00.000Z',
        priorStepResponseText: input.priorStepResponseText,
      }),
    };
  }

  it('Given a critical raw finding whose location does not exist When run Then it is never promoted to a confirmed finding and lands as a non-blocking reviewer anomaly, not a gate-blocking provisional (codex 対策#4, supersedes B3)', async () => {
    const harness = makeHarness(makeLedger({ findings: [], rawFindings: [] }));
    const result = await harness.run({
      reviewerRawFindings: [{
        rawFindingId: 'raw-hallucinated',
        familyTag: 'security',
        severity: 'critical',
        title: 'Hallucinated critical finding',
        location: 'src/does-not-exist.ts:99',
        description: 'This location does not correspond to any file in the reviewed code.',
        suggestion: '',
        relation: 'new',
        targetFindingId: '',
      }],
    });

    expect(result.status).toBe('updated');
    expect(executeAgentMock).not.toHaveBeenCalled();
    const savedLedger = harness.savedLedgers.at(-1);
    // 確定 finding には昇格しない（幻覚 location を confirmed に載せない）。
    // codex 対策#4 以前は「location 証拠の不成立」を product gate 側の
    // provisional として保持していたが、typed evidence protocol 導入後は
    // review-integrity 側の reviewer anomaly（quote-mismatch）へ隔離する —
    // 引用不成立は欠陥の虚偽そのものを証明しないため、観測は監査に残しつつ
    // product gate は塞がない（三分類・§C）。
    expect(savedLedger?.findings.some((f) => f.title === 'Hallucinated critical finding')).toBe(false);
    const anomaly = savedLedger?.reviewerAnomalies?.find((a) => a.sourceRawFindingIds.some((id) => id.endsWith(':raw-hallucinated')));
    expect(anomaly?.kind).toBe('quote-mismatch');
    expect(anomaly?.promotedFindingId).toBeUndefined();
    expect(harness.savedValidationReports).toHaveLength(1);
    const report = harness.savedValidationReports[0] as { rawAdmissionRejections?: Array<{ rawFindingId: string; reason: string }> };
    expect(report.rawAdmissionRejections).toHaveLength(1);
    expect(report.rawAdmissionRejections?.[0]?.rawFindingId).toContain('raw-hallucinated');
    // codex 検証ブロッカー#2 以降、admission は location の実在ではなく検証可能な
    // 証跡（source_quote の verbatimExcerpt 一致）の有無で判定する — 実在しても
    // 引用が無ければ不採用。理由文言もそれを述べる。
    expect(report.rawAdmissionRejections?.[0]?.reason).toContain('no verifiable source_quote evidence');
  });

  it('Given an existing critical open finding whose stored location does not exist When the manager invalidates it from the engine-offered candidate list Then it becomes invalidated and drops out of the blocking open set', async () => {
    const criticalFinding = makeFinding({
      id: 'F-0012',
      severity: 'critical',
      title: 'Hallucinated critical finding',
      location: 'src/does-not-exist.ts:5',
      rawFindingIds: ['raw-existing'],
    });
    const ledger = makeLedger({ nextId: 13, findings: [criticalFinding] });
    const harness = makeHarness(ledger);

    executeAgentMock.mockImplementation(async (_persona: string, instruction: string) => {
      // 候補リストに F-0012 が挙げられていることを確認してから invalidate する。
      if (!instruction.includes('F-0012')) {
        throw new Error('Test setup error: F-0012 not offered as an invalidate candidate');
      }
      return {
        status: 'done',
        content: '',
        structuredOutput: {
          rawDecisions: [],
          disputeDecisions: [],
          conflictDecisions: [],
          invalidateDecisions: [{ findingId: 'F-0012', evidence: 'Confirmed the cited file does not exist in the reviewed code.' }],
          duplicateDecisions: [],
          dismissDecisions: [],
        },
      } as unknown as AgentResponse;
    });

    const result = await harness.run({ reviewerRawFindings: [] });

    expect(result.status).toBe('updated');
    expect(executeAgentMock).toHaveBeenCalledTimes(1);
    const savedLedger = harness.savedLedgers.at(-1);
    const finding = savedLedger?.findings.find((f) => f.id === 'F-0012');
    expect(finding?.status).toBe('invalidated');
    expect(finding?.lifecycle).toBe('invalidated');
    expect(finding?.invalidatedEvidence).toContain('does not exist');

    const ruleContext = buildFindingsRuleContext(savedLedger!);
    expect(ruleContext.open.count).toBe(0);
  });

  // 保存直前の再照合（freshAssembly）は invalidate 候補を fresh 台帳・現 cwd で
  // 再計算する。初回判断の時点では不在だったファイルが保存時には存在する
  // （並列子の生成物や fix ステップの成果物）とき、stale な invalidate を
  // そのまま適用せず不採用として検証レポートに残す。
  it('Given the invalidated location becomes valid between the manager judgment and the save When run Then the stale invalidate is rejected and the finding stays open', async () => {
    const candidateFinding = makeFinding({
      id: 'F-0012',
      title: 'Location appears later',
      location: 'src/appears-later.ts:2',
      rawFindingIds: ['raw-existing'],
    });
    const ledger = makeLedger({ nextId: 13, findings: [candidateFinding] });
    const harness = makeHarness(ledger);

    executeAgentMock.mockImplementation(async (_persona: string, instruction: string) => {
      if (!instruction.includes('F-0012')) {
        throw new Error('Test setup error: F-0012 not offered as an invalidate candidate');
      }
      // LLM 呼び出し中にファイルが生まれる（初回候補計算の後・保存の前）。
      writeFileSync(join(projectDir, 'src/appears-later.ts'), 'line 1\nline 2\nline 3\n');
      return {
        status: 'done',
        content: '',
        structuredOutput: {
          rawDecisions: [],
          disputeDecisions: [],
          conflictDecisions: [],
          invalidateDecisions: [{ findingId: 'F-0012', evidence: 'The cited file does not exist in the reviewed code.' }],
          duplicateDecisions: [],
          dismissDecisions: [],
        },
      } as unknown as AgentResponse;
    });

    const result = await harness.run({ reviewerRawFindings: [] });

    expect(result.status).toBe('updated');
    const savedLedger = harness.savedLedgers.at(-1);
    const finding = savedLedger?.findings.find((f) => f.id === 'F-0012');
    expect(finding?.status).toBe('open');
    expect(finding?.invalidatedEvidence).toBeUndefined();

    // stale な invalidate は staleRejections として検証レポートに残る。
    expect(harness.savedValidationReports).toHaveLength(1);
    const report = harness.savedValidationReports[0] as {
      ledgerUpdated: boolean;
      attempts: Array<{ validationErrors: string[] }>;
    };
    expect(report.ledgerUpdated).toBe(true);
    const errors = report.attempts.flatMap((attempt) => attempt.validationErrors).join(' ');
    expect(errors).toContain('F-0012');
    expect(errors).toContain('did not confirm');
  });

  it('Given the manager tries to invalidate a finding NOT in the engine-offered candidate list When assembled Then it is rejected (LLM claim alone is not enough)', () => {
    // 対象 finding の location は実在する（=候補集合に含まれない）ため、
    // manager が invalidate を主張しても採用されない。
    const validFinding = makeFinding({ id: 'F-0001', location: 'src/a.ts:10' });
    const ledger = makeLedger({ findings: [validFinding] });
    const result = assembleManagerOutput({
      previousLedger: ledger,
      residualRawFindings: [],
      decisions: makeDecisions({
        invalidateDecisions: [{ findingId: 'F-0001', evidence: 'I think this is fake.' }],
      }),
      // eligibleFindingIds は空 — エンジンはこの finding を候補として提示していない。
      invalidLocationCandidateFindingIds: new Set(),
    });
    expect(result.output.invalidatedFindings).toEqual([]);
    expect(result.rejectedInvalidateDecisions).toHaveLength(1);
    expect(result.rejectedInvalidateDecisions[0]?.reason).toContain('did not confirm');
  });

  it('Given a critical finding invalidate decision within the candidate set When assembled and reconciled Then critical severity does not block invalidation (unlike waive)', () => {
    const criticalFinding = makeFinding({ id: 'F-0012', severity: 'critical' });
    const ledger = makeLedger({ nextId: 13, findings: [criticalFinding] });
    const assembly = assembleManagerOutput({
      previousLedger: ledger,
      residualRawFindings: [],
      decisions: makeDecisions({
        invalidateDecisions: [{ findingId: 'F-0012', evidence: 'src/a.ts:10 does not exist' }],
      }),
      invalidLocationCandidateFindingIds: new Set(['F-0012']),
    });
    expect(assembly.rejectedInvalidateDecisions).toEqual([]);
    expect(assembly.output.invalidatedFindings).toEqual([{ findingId: 'F-0012', evidence: 'src/a.ts:10 does not exist' }]);

    const next = reconcileFindingLedger({
      previousLedger: ledger,
      rawFindings: [],
      managerOutput: assembly.output,
      context: { workflowName: 'peer-review', stepName: 'reviewers', runId: 'run-2', timestamp: '2026-07-10T00:00:00.000Z' },
    });
    expect(next.findings.find((f) => f.id === 'F-0012')?.status).toBe('invalidated');
  });

  // B2: 明示参照付き raw（relation persists/reopened）は、manager の判断が再問い
  // 合わせ後もなお不採用のとき、エンジンの「強制 new 化」フォールバックの対象に
  // ならない。強制すると根拠不成立の再報告が新規 finding として台帳に混入する。
  it('Given a relation "persists" raw targeting a non-open finding When run Then it goes through the ambiguous ladder and lands as a gate-blocking provisional (never forced to new)', async () => {
    // 対象 F-0001 を resolved にして、persists の機械分類（open target 前提）に
    // 掛からず manager 送りになるようにする。
    const ledger = makeLedger({
      findings: [makeFinding({ status: 'resolved', lifecycle: 'resolved', location: 'src/real.ts:2' })],
    });
    const harness = makeHarness(ledger);

    // manager は2回とも 'new' を返す（B2 で reject される判断）。
    executeAgentMock.mockImplementation(async (_persona: string, instruction: string) => {
      const match = /"rawFindingId":\s*"([^"]+)"/.exec(instruction);
      const rawFindingId = match?.[1];
      if (rawFindingId === undefined) {
        throw new Error('Test setup error: rawFindingId not found in manager instruction');
      }
      return {
        status: 'done',
        content: '',
        structuredOutput: {
          rawDecisions: [{ rawFindingId, decision: 'new', findingId: '', evidence: 'Treating it as fresh.' }],
          disputeDecisions: [],
          conflictDecisions: [],
          invalidateDecisions: [],
          duplicateDecisions: [],
          dismissDecisions: [],
        },
      } as unknown as AgentResponse;
    });

    const result = await harness.run({
      reviewerRawFindings: [{
        rawFindingId: 'p-1',
        familyTag: 'bug',
        severity: 'high',
        title: 'Existing issue still present',
        description: 'Claims the already-resolved F-0001 still persists.',
        suggestion: '',
        relation: 'persists',
        targetFindingId: 'F-0001',
        // 機械照合済み evidence（typed evidence protocol、codex 対策#4）で
        // admission を通し、この試験の主眼（ambiguous ladder が manager の
        // 壊れた応答をどう扱うか）を admission gate と独立に検証できるようにする。
        ...verifiedSourceQuoteFields(projectDir, 'src/real.ts', 2),
      }],
    });

    expect(result.status).toBe('updated');
    // v2: 対象が open でない persists は ambiguous（persists-target-not-open）と
    // して解釈フェーズへ進む。decisions manager は呼ばれない（clean residual 0）。
    // この mock は decisions 形しか返さないため解釈 parse に失敗し、raw は
    // provisional として着地する（強制 new 化も drop もされない）。
    expect(executeAgentMock).toHaveBeenCalledTimes(1);
    const savedLedger = harness.savedLedgers.at(-1);
    expect(savedLedger?.findings.find((f) => f.id === 'F-0001')?.status).toBe('resolved');
    const landed = savedLedger?.findings.find((f) => f.title === 'Existing issue still present');
    expect(landed?.status).toBe('open');
    expect(landed?.provisional).toMatchObject({ kind: 'raw-meaning-ambiguous', gateEffect: 'block' });
    // 監査記録: 先行保存（write-ahead の正規化監査）+ 最終保存の2件。最終保存に
    // provisionalLandings が残る。
    expect(harness.savedValidationReports).toHaveLength(2);
    const report = harness.savedValidationReports.at(-1) as {
      provisionalLandings?: Array<{ kind: string; reason: string; sourceRawFindingIds: string[] }>;
    };
    expect(report.provisionalLandings?.some((landing) => (
      landing.sourceRawFindingIds.some((id) => id.includes('p-1'))
    ))).toBe(true);
  });
});

describe('item 7: relation schema invariants', () => {
  it('Given relation "new" with a non-empty targetFindingId When parsed Then it is rejected', () => {
    expect(() => parseRawFindings([{
      rawFindingId: 'raw-1',
      stepName: 's',
      reviewer: 'r',
      familyTag: 'bug',
      severity: 'high',
      title: 't',
      description: 'd',
      relation: 'new',
      targetFindingId: 'F-0001',
    }])).toThrow();
  });

  it('Given relation "persists" with no targetFindingId When parsed Then it is rejected', () => {
    expect(() => parseRawFindings([{
      rawFindingId: 'raw-1',
      stepName: 's',
      reviewer: 'r',
      familyTag: 'bug',
      severity: 'high',
      title: 't',
      description: 'd',
      relation: 'persists',
    }])).toThrow();
  });

  it('Given an unknown field instead of relation When parsed Then normal strict validation rejects it', () => {
    expect(() => parseRawFindings([{
      rawFindingId: 'raw-1',
      stepName: 's',
      reviewer: 'r',
      familyTag: 'bug',
      severity: 'high',
      title: 't',
      description: 'd',
      kind: 'issue',
    }])).toThrow(/Unrecognized key/);
  });
});

// B5: invalidated / superseded の監査可視化。ブロッキング集合（open/conflicts）の
// 意味は変えず、サマリとルールコンテキストから「こう裁定された」ことを追える。
describe('B5: invalidated / superseded audit visibility', () => {
  function makeAuditLedger(): FindingLedger {
    return makeLedger({
      nextId: 4,
      findings: [
        makeFinding({ id: 'F-0001' }),
        makeFinding({
          id: 'F-0002',
          status: 'invalidated',
          lifecycle: 'invalidated',
          title: 'Hallucinated finding',
          location: 'src/ghost.ts:1',
          rawFindingIds: [],
          invalidatedAt: '2026-07-11T00:00:00.000Z',
          invalidatedEvidence: 'src/ghost.ts does not exist in the reviewed code',
        }),
        makeFinding({
          id: 'F-0003',
          status: 'superseded',
          lifecycle: 'superseded',
          title: 'Duplicate of F-0001',
          location: 'src/a.ts:20',
          rawFindingIds: [],
          supersededByFindingId: 'F-0001',
        }),
      ],
    });
  }

  it('Given a ledger with invalidated and superseded findings When rule context is built Then their counts are exposed without changing the open set', () => {
    const context = buildFindingsRuleContext(makeAuditLedger());
    expect(context.open.count).toBe(1);
    expect(context.invalidated.count).toBe(1);
    expect(context.superseded.count).toBe(1);
  });

  it('Given a ledger with invalidated and superseded findings When summaries are rendered Then both appear with minimal item info and existing keys keep their shape', async () => {
    const { renderFindingLedgerInstructionSummary, renderFindingLedgerReportSummary } = await import('../core/workflow/findings/context.js');
    const ledger = makeAuditLedger();

    const instructionSummary = JSON.parse(renderFindingLedgerInstructionSummary(ledger)) as Record<string, unknown>;
    // 既存キーの形式維持（追加のみ）。
    expect(Object.keys(instructionSummary)).toEqual(
      expect.arrayContaining(['version', 'workflowName', 'open', 'resolved', 'waived', 'invalidated', 'superseded', 'conflicts']),
    );
    expect(instructionSummary.invalidated).toEqual([
      { id: 'F-0002', severity: 'high', title: 'Hallucinated finding', evidence: 'src/ghost.ts does not exist in the reviewed code' },
    ]);
    expect(instructionSummary.superseded).toEqual([
      { id: 'F-0003', title: 'Duplicate of F-0001', supersededBy: 'F-0001' },
    ]);

    const reportSummary = JSON.parse(renderFindingLedgerReportSummary(ledger)) as Record<string, unknown>;
    expect(reportSummary.openFindingIds).toEqual(['F-0001']);
    expect(reportSummary.invalidatedFindingIds).toEqual(['F-0002']);
    expect(reportSummary.supersededFindingIds).toEqual(['F-0003']);
    expect(reportSummary.conflictIds).toEqual([]);
  });
});

// B4: v3-r2 実台帳の F-0016 raw 群（AI-PERSIST-F-0011-ROUTING /
// AI-PERSIST-F-0006-ROUTING / AI-PERSIST-F-0017-ROUTING）の replay。旧エンジンの
// familyTag + exact location 機械マージは、この3件（同じ familyTag=resource-leak、
// 同じ routing.ts:302、意味は F-0006 系のリーク主張と F-0011/F-0017 系の分散
// cleanup 懸念の2系統）を壊れた混成 finding F-0016 に畳んだ。新エンジンでは
// 機械分類 → assembly → reconcile を通しても1つの finding に再マージされない。
describe('B4: v3-r2 F-0016 raw-group replay against the real ledger', () => {
  const fixturePath = fileURLToPath(new URL('./fixtures/v3-r2-ledger.json', import.meta.url));

  function loadFixtureLedger(): FindingLedger {
    return parseFindingLedger(JSON.parse(readFileSync(fixturePath, 'utf-8')));
  }

  function pickRaw(ledger: FindingLedger, idSuffix: string): RawFinding {
    const raw = ledger.rawFindings.find((r) => r.rawFindingId.endsWith(idSuffix));
    expect(raw, `fixture raw ${idSuffix}`).toBeDefined();
    return raw!;
  }

  const RAW_SUFFIXES = ['AI-PERSIST-F-0011-ROUTING', 'AI-PERSIST-F-0006-ROUTING', 'AI-PERSIST-F-0017-ROUTING'] as const;

  it('Given the three real F-0016 raws replayed with their explicit targets When classified, assembled and reconciled Then each lands on its own target finding and no single finding re-merges them', () => {
    const ledger = loadFixtureLedger();
    // 現行 relation/targetFindingId を持つ実データ。
    // rawFindingId だけ replay 用に付け替える（台帳内の既存 id と衝突するため）。
    const replayRaws = RAW_SUFFIXES.map((suffix) => ({
      ...pickRaw(ledger, suffix),
      rawFindingId: `${pickRaw(ledger, suffix).rawFindingId}:replay`,
    }));
    expect(replayRaws.map((raw) => raw.relation)).toEqual(['persists', 'persists', 'persists']);
    // 3件とも同じ familyTag・同じ location だが、対象は3つの別 finding。
    expect(new Set(replayRaws.map((raw) => raw.familyTag)).size).toBe(1);
    expect(new Set(replayRaws.map((raw) => raw.location)).size).toBe(1);

    const mechanical = classifyRawFindingsMechanically({ previousLedger: ledger, rawFindings: replayRaws });
    // 明示参照（persists × open target）はすべて機械 same。ただし対象は別々。
    expect(mechanical.residualRawFindings).toEqual([]);
    expect(new Set(mechanical.output.matches.map((match) => match.findingId)))
      .toEqual(new Set(['F-0011', 'F-0006', 'F-0017']));

    const assembly = assembleManagerOutput({
      previousLedger: ledger,
      residualRawFindings: [],
      decisions: makeDecisions(),
      mechanicalOutput: mechanical.output,
    });
    expect(assembly.output.matches).toHaveLength(3);

    const next = reconcileFindingLedger({
      previousLedger: ledger,
      rawFindings: replayRaws,
      managerOutput: assembly.output,
      context: { workflowName: ledger.workflowName, stepName: 'reviewers', runId: 'run-replay', timestamp: '2026-07-11T00:00:00.000Z' },
    });

    // 新しい混成 finding は作られない。
    expect(next.findings).toHaveLength(ledger.findings.length);
    // 各 replay raw はそれぞれの対象 finding に付く。
    const findingFor = (id: string) => next.findings.find((f) => f.id === id)!;
    expect(findingFor('F-0011').rawFindingIds).toContain(replayRaws[0]!.rawFindingId);
    expect(findingFor('F-0006').rawFindingIds).toContain(replayRaws[1]!.rawFindingId);
    expect(findingFor('F-0017').rawFindingIds).toContain(replayRaws[2]!.rawFindingId);
    // どの finding も replay raw を2件以上抱えない（単一 finding への再マージなし）。
    const replayIds = new Set(replayRaws.map((raw) => raw.rawFindingId));
    for (const finding of next.findings) {
      const held = finding.rawFindingIds.filter((id) => replayIds.has(id));
      expect(held.length, `finding ${finding.id} must not absorb multiple replay raws`).toBeLessThanOrEqual(1);
    }
    // 元凶だった F-0016 には1件も付かない。
    expect(findingFor('F-0016').rawFindingIds.filter((id) => replayIds.has(id))).toEqual([]);
  });

  it('Given the same real raws without explicit targets (the round that created F-0016) When the manager judges them as distinct findings Then assembly and reconcile do not re-merge them into one finding', () => {
    // F-0016 が立つ前のラウンドを再現: F-0016（と F-0016 を参照する conflict）を
    // 除いた実台帳に対し、3件の raw が target 引用なし（relation new）で届く。
    const base = loadFixtureLedger();
    const ledger: FindingLedger = {
      ...base,
      findings: base.findings.filter((finding) => finding.id !== 'F-0016'),
      conflicts: base.conflicts.filter((conflict) => !conflict.findingIds.includes('F-0016')),
    };
    const replayRaws = RAW_SUFFIXES.map((suffix) => {
      const original = pickRaw(base, suffix);
      const { targetFindingId: _dropped, ...rest } = original;
      return {
        ...rest,
        rawFindingId: `${original.rawFindingId}:no-target`,
        relation: 'new' as const,
      };
    });

    // 同じ familyTag・同じ行でも、内容（title/description）が違うため機械分類は
    // 畳まず、全件 manager 送りになる（F-0016 の再現条件）。
    const mechanical = classifyRawFindingsMechanically({ previousLedger: ledger, rawFindings: replayRaws });
    expect(mechanical.output.matches).toEqual([]);
    expect(mechanical.residualRawFindings).toHaveLength(3);

    // manager の意味判断: F-0011 系は F-0011 へ same、F-0006 系は F-0006 へ same、
    // F-0017 系は新規（別問題）と判断。
    const assembly = assembleManagerOutput({
      previousLedger: ledger,
      residualRawFindings: replayRaws,
      decisions: makeDecisions({
        rawDecisions: [
          { rawFindingId: replayRaws[0]!.rawFindingId, decision: 'same', findingId: 'F-0011', evidence: 'Same distributed-cleanup concern as F-0011.' },
          { rawFindingId: replayRaws[1]!.rawFindingId, decision: 'same', findingId: 'F-0006', evidence: 'Same temp-dir leak claim as F-0006.' },
          { rawFindingId: replayRaws[2]!.rawFindingId, decision: 'new', evidence: 'Release-timing opacity is a distinct problem.' },
        ],
      }),
      mechanicalOutput: mechanical.output,
      checkMissingDecisions: true,
    });
    expect(assembly.rejectedRawDecisions).toEqual([]);
    // manager の判断が post-assembly で覆されない: 2つの別 finding への match +
    // 1つの新規（path+title の自動リダイレクトが復活していれば new が same に
    // 付け替えられてここが崩れる — codex ブロッカー B3 の回帰ガード）。
    expect(new Set(assembly.output.matches.map((match) => match.findingId))).toEqual(new Set(['F-0011', 'F-0006']));
    expect(assembly.output.newFindings).toHaveLength(1);

    const next = reconcileFindingLedger({
      previousLedger: ledger,
      rawFindings: replayRaws,
      managerOutput: assembly.output,
      context: { workflowName: ledger.workflowName, stepName: 'reviewers', runId: 'run-replay-2', timestamp: '2026-07-11T00:00:00.000Z' },
    });

    // 新規1件だけ増える（混成 finding は生まれない）。
    expect(next.findings).toHaveLength(ledger.findings.length + 1);
    const replayIds = new Set(replayRaws.map((raw) => raw.rawFindingId));
    for (const finding of next.findings) {
      const held = finding.rawFindingIds.filter((id) => replayIds.has(id));
      expect(held.length, `finding ${finding.id} must not absorb multiple replay raws`).toBeLessThanOrEqual(1);
    }
  });
});

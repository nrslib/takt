import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AgentResponse, WorkflowStep } from '../core/models/types.js';
import type { FindingLedger, FindingLedgerStore, RawFinding } from '../core/workflow/findings/types.js';
import { runFindingManagerForStep } from '../core/workflow/findings/manager-runner.js';
import { createFindingLedgerStore, type FindingManagerValidationReport } from '../core/workflow/findings/store.js';

vi.mock('../agents/agent-usecases.js', () => ({
  executeAgent: vi.fn(),
}));

const { executeAgent } = await import('../agents/agent-usecases.js');
const executeAgentMock = vi.mocked(executeAgent);

// raw admission validation（manager-runner.ts の cwd 引数）が実 fs を見るため、
// このテストファイルが使う location（src/a.ts:10/11, src/b.ts:5/20, src/c.ts:1,
// src/dup.ts:10）に対応する実ファイルを1つの共有 fixture ディレクトリへ用意する。
const FIXTURE_CWD = mkdtempSync(join(tmpdir(), 'takt-findings-runner-fixtures-'));
function writeFixtureFile(relativePath: string, lineCount: number): void {
  const fullPath = join(FIXTURE_CWD, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, `${Array.from({ length: lineCount }, (_, index) => `// line ${index + 1}`).join('\n')}\n`);
}
writeFixtureFile('src/a.ts', 30);
writeFixtureFile('src/b.ts', 30);
writeFixtureFile('src/c.ts', 5);
writeFixtureFile('src/dup.ts', 20);

afterAll(() => {
  rmSync(FIXTURE_CWD, { recursive: true, force: true });
});

function makeLedger(overrides: Partial<FindingLedger> = {}): FindingLedger {
  return {
    version: 1,
    workflowName: 'peer-review',
    nextId: 2,
    updatedAt: '2026-06-13T00:00:00.000Z',
    rawFindings: [
      {
        rawFindingId: 'raw-existing',
        stepName: 'arch-review',
        reviewer: 'arch-review',
        familyTag: 'bug',
        severity: 'high',
        title: 'Existing issue',
        location: 'src/a.ts:10',
        description: 'Existing issue body.',
      },
    ],
    conflicts: [],
    findings: [
      {
        id: 'F-0001',
        status: 'open',
        lifecycle: 'new',
        severity: 'high',
        title: 'Existing issue',
        location: 'src/a.ts:10',
        reviewers: ['arch-review'],
        rawFindingIds: ['raw-existing'],
        firstSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
        lastSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
      },
    ],
    ...overrides,
  };
}

interface Harness {
  savedLedgers: FindingLedger[];
  savedRawFindings: RawFinding[][];
  savedValidationReports: FindingManagerValidationReport[];
  run: (input: {
    reviewerRawFindings: Array<Record<string, unknown>>;
    priorStepResponseText?: string;
  }) => ReturnType<typeof runFindingManagerForStep>;
}

function makeHarness(ledger: FindingLedger): Harness {
  const savedLedgers: FindingLedger[] = [];
  const savedRawFindings: RawFinding[][] = [];
  const savedValidationReports: FindingManagerValidationReport[] = [];
  const ledgerStore: FindingLedgerStore = {
    workflowName: 'peer-review',
    loadLedger: () => ledger,
    saveLedger: (next) => { savedLedgers.push(next); },
    // テスト double は同時実行を模さない単純な読み込み → 変換 → 記録。
    updateLedger: (mutator) => {
      const next = mutator(ledger);
      savedLedgers.push(next);
      return Promise.resolve(next);
    },
    createRunCopy: () => '/tmp/ledger-copy.json',
    saveRawFindings: (_runId, _stepName, rawFindings) => {
      savedRawFindings.push(rawFindings);
      return '/tmp/raw-findings.json';
    },
    saveManagerValidationReport: (report) => {
      savedValidationReports.push(report);
      return '/tmp/manager-report.json';
    },
  };
  const optionsBuilder = {
    buildAgentOptions: () => ({}),
    resolveStepProviderModel: () => ({ provider: 'codex', model: 'gpt-test' }),
  };
  const stepExecutor = {
    buildPhase1Instruction: (instruction: string) => instruction,
    normalizeStructuredOutput: (_step: WorkflowStep, response: AgentResponse) => response,
  };
  const parentStep: WorkflowStep = { kind: 'agent', name: 'reviewers', persona: 'reviewer', edit: false } as WorkflowStep;
  const contract = {
    ledgerPath: '.takt/findings/ledger.json',
    rawFindingsPath: '.takt/findings/raw',
    manager: {
      persona: 'findings-manager',
      instruction: 'Reconcile findings.',
      outputContract: 'Return JSON.',
    },
  };
  return {
    savedLedgers,
    savedRawFindings,
    savedValidationReports,
    run: (input) => runFindingManagerForStep({
      // テスト対象が使うメソッドだけを実装した最小 double。
      contract: contract as never,
      ledgerStore,
      optionsBuilder: optionsBuilder as never,
      stepExecutor: stepExecutor as never,
      cwd: FIXTURE_CWD,
      parentStep,
      stepIteration: 2,
      subResults: [
        {
          subStep: { kind: 'agent', name: 'arch-review', persona: 'arch', edit: false } as WorkflowStep,
          response: {
            status: 'done',
            content: '',
            structuredOutput: { rawFindings: input.reviewerRawFindings },
          } as unknown as AgentResponse,
        },
      ],
      workflowName: 'peer-review',
      runId: 'run-2',
      // トップレベルの走行を模す（呼び出し名前空間なし）。既存 id の形は変わらない。
      callNamespace: '',
      timestamp: '2026-06-14T00:00:00.000Z',
      priorStepResponseText: input.priorStepResponseText,
    }),
  };
}

const CONFIRMATION_RAW = {
  rawFindingId: 'c-1',
  familyTag: 'bug',
  severity: 'high',
  title: 'Confirmed fixed',
  location: 'src/a.ts:10',
  description: 'Verified the fix at src/a.ts:10.',
  suggestion: '',
  kind: 'resolution_confirmation',
  targetFindingId: 'F-0001',
};

const UNMATCHED_ISSUE_RAW = {
  rawFindingId: 'i-1',
  familyTag: 'security',
  severity: 'medium',
  title: 'New unmatched issue',
  location: 'src/b.ts:5',
  description: 'A different problem.',
  suggestion: 'Fix it.',
  kind: 'issue',
  targetFindingId: '',
};

const ANOTHER_UNMATCHED_ISSUE_RAW = {
  rawFindingId: 'i-2',
  familyTag: 'style',
  severity: 'low',
  title: 'Another unmatched issue',
  location: 'src/c.ts:1',
  description: 'A separate different problem.',
  suggestion: 'Fix it too.',
  kind: 'issue',
  targetFindingId: '',
};

beforeEach(() => {
  executeAgentMock.mockReset();
});

describe('runFindingManagerForStep mechanical path', () => {
  it('Given only mechanically classifiable confirmations and no prior response When run Then the manager agent is not called and the ledger is updated', async () => {
    const harness = makeHarness(makeLedger());
    const result = await harness.run({ reviewerRawFindings: [CONFIRMATION_RAW] });

    expect(executeAgentMock).not.toHaveBeenCalled();
    expect(result.status).toBe('updated');
    expect(harness.savedLedgers).toHaveLength(1);
    const finding = harness.savedLedgers[0]?.findings.find((entry) => entry.id === 'F-0001');
    expect(finding?.status).toBe('resolved');
  });

  it('Given a residual raw finding When run Then the agent is called with only the residual raws and outputs are merged', async () => {
    executeAgentMock.mockResolvedValue({
      status: 'done',
      content: '',
      structuredOutput: {
        rawDecisions: [
          { rawFindingId: 'run-2:reviewers:2:arch-review:i-1', decision: 'new', evidence: 'No related open finding.' },
        ],
        disputeDecisions: [],
        conflictDecisions: [],
      },
    } as unknown as AgentResponse);

    const harness = makeHarness(makeLedger());
    const result = await harness.run({ reviewerRawFindings: [CONFIRMATION_RAW, UNMATCHED_ISSUE_RAW] });

    expect(executeAgentMock).toHaveBeenCalledTimes(1);
    const instruction = executeAgentMock.mock.calls[0]?.[1] as string;
    expect(instruction).toContain('classified mechanically');
    expect(instruction).toContain('i-1');
    expect(instruction).not.toContain('"run-2:reviewers:2:arch-review:c-1"');

    expect(result.status).toBe('updated');
    const ledger = harness.savedLedgers[0];
    expect(ledger?.findings.find((entry) => entry.id === 'F-0001')?.status).toBe('resolved');
    expect(ledger?.findings.some((entry) => entry.title === 'New unmatched issue' && entry.status === 'open')).toBe(true);
  });

  it('Given zero residual and a prior response without a Disputed Findings heading When run Then the agent is skipped', async () => {
    const harness = makeHarness(makeLedger());
    const result = await harness.run({
      reviewerRawFindings: [CONFIRMATION_RAW],
      priorStepResponseText: 'F-0001 を修正しました。全テスト green です。',
    });

    expect(executeAgentMock).not.toHaveBeenCalled();
    expect(result.status).toBe('updated');
  });

  it('Given zero residual but a prior step response When run Then the agent is still called for waiver adjudication', async () => {
    executeAgentMock.mockResolvedValue({
      status: 'done',
      content: '',
      structuredOutput: {
        rawDecisions: [],
        disputeDecisions: [],
        conflictDecisions: [],
      },
    } as unknown as AgentResponse);

    const harness = makeHarness(makeLedger());
    const result = await harness.run({
      reviewerRawFindings: [CONFIRMATION_RAW],
      priorStepResponseText: '## Disputed Findings\n- findingId: F-0001\n  reason: stale\n  evidence: src/a.ts:10',
    });

    expect(executeAgentMock).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('updated');
  });
});

describe('runFindingManagerForStep decision retry', () => {
  it('Given one rejected decision among several When run Then only the rejected item is re-asked and the accepted decision from round 1 is kept', async () => {
    // ラウンド1: i-1 は妥当な "new"（採用）、i-2 は存在しない finding への "same"（不採用）。
    executeAgentMock.mockResolvedValueOnce({
      status: 'done',
      content: '',
      structuredOutput: {
        rawDecisions: [
          { rawFindingId: 'run-2:reviewers:2:arch-review:i-1', decision: 'new', evidence: 'No related open finding.' },
          { rawFindingId: 'run-2:reviewers:2:arch-review:i-2', decision: 'same', findingId: 'F-9999', evidence: 'x' },
        ],
        disputeDecisions: [],
        conflictDecisions: [],
      },
    } as unknown as AgentResponse);
    // ラウンド2（再問い合わせ）: i-2 を妥当な "new" に訂正。
    executeAgentMock.mockResolvedValueOnce({
      status: 'done',
      content: '',
      structuredOutput: {
        rawDecisions: [
          { rawFindingId: 'run-2:reviewers:2:arch-review:i-2', decision: 'new', evidence: 'Separate unrelated issue.' },
        ],
        disputeDecisions: [],
        conflictDecisions: [],
      },
    } as unknown as AgentResponse);

    const harness = makeHarness(makeLedger());
    const result = await harness.run({ reviewerRawFindings: [UNMATCHED_ISSUE_RAW, ANOTHER_UNMATCHED_ISSUE_RAW] });

    expect(executeAgentMock).toHaveBeenCalledTimes(2);
    const retryInstruction = executeAgentMock.mock.calls[1]?.[1] as string;
    expect(retryInstruction).toContain('- rawFindingId: run-2:reviewers:2:arch-review:i-2');
    expect(retryInstruction).not.toContain('- rawFindingId: run-2:reviewers:2:arch-review:i-1');

    expect(result.status).toBe('updated');
    const ledger = harness.savedLedgers[0];
    expect(ledger?.findings.some((entry) => entry.title === 'New unmatched issue' && entry.status === 'open')).toBe(true);
    expect(ledger?.findings.some((entry) => entry.title === 'Another unmatched issue' && entry.status === 'open')).toBe(true);
    expect(harness.savedValidationReports).toHaveLength(1);
    expect(harness.savedValidationReports[0]?.ledgerUpdated).toBe(true);
  });

  it('Given the agent repeatedly tries to resolve an already-resolved finding When run Then the resolution_confirmation raw is dropped (not forced to "new") and the ledger still updates', async () => {
    // codex の再現ケース: 既に resolved の finding を、resolution_confirmation
    // raw を根拠に再び "resolved" と判断する決定は、対象 finding が open では
    // ないため decision-assembly で不採用になる。再問い合わせでも同じ不採用が
    // 続いたとき、旧実装は情報を捨てないために newFindings へ強制していたが、
    // resolution_confirmation は manager-output-validation.ts の
    // validateConfirmationRefsOnlyInResolutions が「cannot be cited as issue
    // evidence」で拒否するため、最終検証が invalid_manager_output になり
    // 台帳が更新されないまま止まっていた。
    executeAgentMock.mockResolvedValue({
      status: 'done',
      content: '',
      structuredOutput: {
        rawDecisions: [
          { rawFindingId: 'run-2:reviewers:2:arch-review:c-1', decision: 'resolved', findingId: 'F-0001', evidence: 'x' },
        ],
        disputeDecisions: [],
        conflictDecisions: [],
      },
    } as unknown as AgentResponse);

    const ledger = makeLedger({ findings: [{ ...makeLedger().findings[0]!, status: 'resolved', lifecycle: 'resolved' }] });
    const harness = makeHarness(ledger);
    const result = await harness.run({ reviewerRawFindings: [CONFIRMATION_RAW] });

    expect(executeAgentMock).toHaveBeenCalledTimes(2);
    expect(result.status).toBe('updated');
    expect(harness.savedLedgers).toHaveLength(1);
    const savedLedger = harness.savedLedgers[0];
    // resolution_confirmation は new にも強制されず、単に反映されない
    // （台帳の finding 数は増えない）。
    expect(savedLedger?.findings).toHaveLength(1);
    expect(savedLedger?.findings.find((entry) => entry.id === 'F-0001')?.status).toBe('resolved');
    expect(harness.savedValidationReports).toHaveLength(1);
    expect(harness.savedValidationReports[0]?.ledgerUpdated).toBe(true);
    expect(harness.savedValidationReports[0]?.attempts).toHaveLength(2);
  });

  it('Given the agent repeats an invalid decision on retry When run Then the raw finding is forced to "new" and recorded in invalidAttempts', async () => {
    // 存在しない findingId "F-9999" を指す "same" 決定は不採用になり、
    // 再問い合わせでも同じ不採用が続くため、情報を捨てないために new として扱う。
    executeAgentMock.mockResolvedValue({
      status: 'done',
      content: '',
      structuredOutput: {
        rawDecisions: [
          { rawFindingId: 'run-2:reviewers:2:arch-review:i-1', decision: 'same', findingId: 'F-9999', evidence: 'x' },
        ],
        disputeDecisions: [],
        conflictDecisions: [],
      },
    } as unknown as AgentResponse);

    const harness = makeHarness(makeLedger());
    const result = await harness.run({ reviewerRawFindings: [UNMATCHED_ISSUE_RAW] });

    expect(executeAgentMock).toHaveBeenCalledTimes(2);
    expect(result.status).toBe('updated');
    expect(harness.savedLedgers).toHaveLength(1);
    const ledger = harness.savedLedgers[0];
    expect(ledger?.findings.some((entry) => entry.title === 'New unmatched issue' && entry.status === 'open')).toBe(true);
    expect(harness.savedValidationReports).toHaveLength(1);
    expect(harness.savedValidationReports[0]?.ledgerUpdated).toBe(true);
    expect(harness.savedValidationReports[0]?.attempts).toHaveLength(2);
  });

  it('Given the manager omits decisions for every residual raw finding When run Then only the missing items are re-asked, and if still missing the issue-kind raw is forced to "new" while the resolution_confirmation raw is dropped', async () => {
    // 指摘: assembleManagerOutput() は「未知の raw finding id」「重複」
    // 「不正な決定」だけを rejection にしており、残余 raw finding に対する
    // decision の欠落は rejection にしていなかった。そのため manager が
    // rawDecisions: [] を返しても hasAnyRejection() が false のままになり、
    // 再問い合わせに入らず最終検証で失敗して即 invalid_manager_output に
    // なっていた。修正後は欠落分だけの再問い合わせが1回入り、それでも
    // 欠落したままなら既存の forceUnresolvedRawDecisionsAsNew の扱いに従う
    // （issue kind は new に、resolution_confirmation kind は落ちるだけ）。
    executeAgentMock.mockResolvedValue({
      status: 'done',
      content: '',
      structuredOutput: {
        rawDecisions: [],
        disputeDecisions: [],
        conflictDecisions: [],
      },
    } as unknown as AgentResponse);

    // CONFIRMATION_RAW の対象 F-0001 を resolved にしておき、機械分類で
    // 自動解決されない（LLM 判断が必要な residual になる）ようにする。
    const ledger = makeLedger({ findings: [{ ...makeLedger().findings[0]!, status: 'resolved', lifecycle: 'resolved' }] });
    const harness = makeHarness(ledger);
    const result = await harness.run({ reviewerRawFindings: [UNMATCHED_ISSUE_RAW, CONFIRMATION_RAW] });

    expect(executeAgentMock).toHaveBeenCalledTimes(2);
    const retryInstruction = executeAgentMock.mock.calls[1]?.[1] as string;
    // 欠落した2件だけが再問い合わせに列挙される。
    expect(retryInstruction).toContain('run-2:reviewers:2:arch-review:i-1');
    expect(retryInstruction).toContain('run-2:reviewers:2:arch-review:c-1');
    expect(retryInstruction).toContain('missing a decision');

    expect(result.status).toBe('updated');
    expect(harness.savedLedgers).toHaveLength(1);
    const savedLedger = harness.savedLedgers[0];
    // issue kind (i-1) は情報を捨てないため new として強制採用される。
    expect(savedLedger?.findings.some((entry) => entry.title === 'New unmatched issue' && entry.status === 'open')).toBe(true);
    // resolution_confirmation kind (c-1) は new にも強制されず、単に反映
    // されない（F-0001 は resolved のまま、"Confirmed fixed" という finding は
    // 作られない）。
    expect(savedLedger?.findings.find((entry) => entry.id === 'F-0001')?.status).toBe('resolved');
    expect(savedLedger?.findings.some((entry) => entry.title === 'Confirmed fixed')).toBe(false);
    expect(savedLedger?.findings).toHaveLength(2);
    expect(harness.savedValidationReports).toHaveLength(1);
    expect(harness.savedValidationReports[0]?.ledgerUpdated).toBe(true);
    expect(harness.savedValidationReports[0]?.attempts).toHaveLength(2);
  });
});

describe('runFindingManagerForStep conflict handling', () => {
  it('Given an active conflict in the ledger When all raws are mechanical Then the agent is still called', async () => {
    executeAgentMock.mockResolvedValue({
      status: 'done',
      content: '',
      structuredOutput: {
        rawDecisions: [],
        disputeDecisions: [],
        conflictDecisions: [{ conflictId: 'C-0001', decision: 'keep', evidence: 'Still unresolved.' }],
      },
    } as unknown as AgentResponse);

    const ledger = makeLedger({
      conflicts: [
        {
          id: 'C-0001',
          status: 'active',
          findingIds: ['F-0001'],
          rawFindingIds: ['raw-existing'],
          description: 'Reviewers disagree about F-0001.',
          firstSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
          lastSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
        },
      ],
    });
    const harness = makeHarness(ledger);
    const result = await harness.run({ reviewerRawFindings: [CONFIRMATION_RAW] });

    expect(executeAgentMock).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('updated');
  });

  it('Given an active conflict referencing a resolved finding When the agent is called Then that finding keeps full detail in the instruction', async () => {
    executeAgentMock.mockResolvedValue({
      status: 'done',
      content: '',
      structuredOutput: {
        rawDecisions: [
          { rawFindingId: 'run-2:reviewers:2:arch-review:i-1', decision: 'new', evidence: 'No related open finding.' },
        ],
        disputeDecisions: [],
        conflictDecisions: [{ conflictId: 'C-0001', decision: 'keep', evidence: 'Still unresolved.' }],
      },
    } as unknown as AgentResponse);

    const ledger = makeLedger({
      findings: [
        {
          id: 'F-0001',
          status: 'resolved',
          lifecycle: 'resolved',
          severity: 'high',
          title: 'Existing issue',
          location: 'src/a.ts:10',
          description: 'Original detailed description of the conflicted finding.',
          reviewers: ['arch-review'],
          rawFindingIds: ['raw-existing'],
          firstSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
          lastSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
        },
      ],
      conflicts: [
        {
          id: 'C-0001',
          status: 'active',
          findingIds: ['F-0001'],
          rawFindingIds: ['raw-existing'],
          description: 'Reviewers disagree about F-0001.',
          firstSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
          lastSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
        },
      ],
    });
    const harness = makeHarness(ledger);
    await harness.run({ reviewerRawFindings: [UNMATCHED_ISSUE_RAW] });

    const instruction = executeAgentMock.mock.calls[0]?.[1] as string;
    expect(instruction).toContain('Original detailed description of the conflicted finding.');
  });
});

describe('runFindingManagerForStep workflow_call sub-steps', () => {
  it('Given a workflow_call sub-step mixed into a parallel step When run Then it is excluded from raw findings extraction instead of erroring', async () => {
    // workflow_call のサブステップは AgentResponse.structuredOutput を持たない
    // （子ワークフロー側が自分の finding_contract で台帳へ取り込み済みという
    // 想定）。除外しないと「structured output が無い」という欠落と区別できず
    // fail-fast エラーになってしまう。現状の builtin workflow にこの構成は
    // 無いが、将来 parallel の子に workflow_call を混ぜても壊れないことを確認する。
    executeAgentMock.mockResolvedValue({
      status: 'done',
      content: '',
      structuredOutput: {
        rawDecisions: [
          { rawFindingId: 'run-3:reviewers:2:arch-review:i-1', decision: 'new', evidence: 'No related open finding.' },
        ],
        disputeDecisions: [],
        conflictDecisions: [],
      },
    } as unknown as AgentResponse);

    const savedLedgers: FindingLedger[] = [];
    const savedRawFindings: RawFinding[][] = [];
    const ledgerStore: FindingLedgerStore = {
      workflowName: 'peer-review',
      loadLedger: () => makeLedger(),
      saveLedger: (next) => { savedLedgers.push(next); },
      updateLedger: (mutator) => {
        const next = mutator(makeLedger());
        savedLedgers.push(next);
        return Promise.resolve(next);
      },
      createRunCopy: () => '/tmp/ledger-copy.json',
      saveRawFindings: (_runId, _stepName, rawFindings) => {
        savedRawFindings.push(rawFindings);
        return '/tmp/raw-findings.json';
      },
      saveManagerValidationReport: () => '/tmp/manager-report.json',
    };
    const optionsBuilder = {
      buildAgentOptions: () => ({}),
      resolveStepProviderModel: () => ({ provider: 'codex', model: 'gpt-test' }),
    };
    const stepExecutor = {
      buildPhase1Instruction: (instruction: string) => instruction,
      normalizeStructuredOutput: (_step: WorkflowStep, response: AgentResponse) => response,
    };
    const parentStep: WorkflowStep = { kind: 'agent', name: 'reviewers', persona: 'reviewer', edit: false } as WorkflowStep;
    const contract = {
      ledgerPath: '.takt/findings/ledger.json',
      rawFindingsPath: '.takt/findings/raw',
      manager: {
        persona: 'findings-manager',
        instruction: 'Reconcile findings.',
        outputContract: 'Return JSON.',
      },
    };
    const workflowCallSubStep: WorkflowStep = {
      kind: 'workflow_call',
      name: 'child-delegate',
      call: 'child',
      personaDisplayName: 'child-delegate',
      instruction: '',
    } as WorkflowStep;

    const result = await runFindingManagerForStep({
      contract: contract as never,
      ledgerStore,
      optionsBuilder: optionsBuilder as never,
      stepExecutor: stepExecutor as never,
      cwd: FIXTURE_CWD,
      parentStep,
      stepIteration: 2,
      subResults: [
        {
          subStep: { kind: 'agent', name: 'arch-review', persona: 'arch', edit: false } as WorkflowStep,
          response: {
            status: 'done',
            content: '',
            structuredOutput: { rawFindings: [UNMATCHED_ISSUE_RAW] },
          } as unknown as AgentResponse,
        },
        {
          // workflow_call のレスポンスは実運用でも structuredOutput を持たない
          // （WorkflowCallRunner.buildWorkflowCallResponse が返す形そのもの）。
          subStep: workflowCallSubStep,
          response: {
            persona: 'child-delegate',
            status: 'done',
            content: 'COMPLETE',
            timestamp: new Date('2026-06-14T00:00:00.000Z'),
          } as AgentResponse,
        },
      ],
      workflowName: 'peer-review',
      runId: 'run-3',
      callNamespace: '',
      timestamp: '2026-06-14T00:00:00.000Z',
    });

    expect(result.status).toBe('updated');
    expect(savedRawFindings).toHaveLength(1);
    expect(savedRawFindings[0]).toHaveLength(1);
    expect(savedRawFindings[0]?.[0]?.stepName).toBe('arch-review');
  });
});

describe('runFindingManagerForStep concurrent workflow_call lost update', () => {
  // codex の再現ケース: 並列 workflow_call の子エンジンが同じ store（親から
  // 継承した台帳）を共有すると、各子は「LLM 呼び出し前に読んだ台帳」を基準に
  // 非同期処理後に保存するため、後勝ちで一方の新規指摘が消える。
  // 台帳を実ファイルで共有する createFindingLedgerStore を使い、2つの
  // runFindingManagerForStep 呼び出しを Promise.all で同時実行して確認する。
  const cleanupDirs = new Set<string>();

  afterEach(() => {
    for (const dir of cleanupDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    cleanupDirs.clear();
  });

  it('Given two concurrent callers each reporting a distinct new issue When both resolve their LLM call around the same time Then neither new finding is lost', async () => {
    const projectCwd = mkdtempSync(join(tmpdir(), 'takt-findings-race-project-'));
    const reportDir = mkdtempSync(join(tmpdir(), 'takt-findings-race-report-'));
    cleanupDirs.add(projectCwd);
    cleanupDirs.add(reportDir);
    // raw admission validation は projectCwd を cwd として使うため、この
    // テストが引用する location に対応する実ファイルを用意する。
    mkdirSync(join(projectCwd, 'src'), { recursive: true });
    writeFileSync(join(projectCwd, 'src/a.ts'), `${Array.from({ length: 15 }, (_, i) => `// line ${i + 1}`).join('\n')}\n`);
    writeFileSync(join(projectCwd, 'src/b.ts'), `${Array.from({ length: 25 }, (_, i) => `// line ${i + 1}`).join('\n')}\n`);

    // workflow_call の並列子は親から継承した同一の FindingLedgerStore
    // インスタンスを共有する（WorkflowCallExecutor.ts の inheritedFindingContract
    // 参照）。ここでも1つの store インスタンスを両呼び出しで共有する。
    const store = createFindingLedgerStore({
      projectCwd,
      reportDir,
      workflowName: 'peer-review',
      ledgerPath: '.takt/findings/peer-review.json',
      rawFindingsPath: '.takt/findings/raw',
    });
    const storeA = store;
    const storeB = store;
    storeA.saveLedger({
      version: 1,
      workflowName: 'peer-review',
      nextId: 1,
      updatedAt: '2026-06-13T00:00:00.000Z',
      findings: [],
      rawFindings: [],
      conflicts: [],
    });

    // workflow_call の並列子は WorkflowCallExecutor から同じ reportDirName
    // （= 親の runPaths.slug）を渡されるため、実運用では2子の runId は常に
    // 一致する。異なる runId を使うと衝突条件を再現しないため、ここでは
    // 両呼び出しに同じ runId を渡し、呼び出し名前空間（callNamespace）だけで
    // 区別する。
    const SHARED_RUN_ID = 'shared-run';
    const rawFindingIdA = `${SHARED_RUN_ID}:child-a:reviewers:1:arch-review:i-1`;
    const rawFindingIdB = `${SHARED_RUN_ID}:child-b:reviewers:1:arch-review:i-1`;
    executeAgentMock.mockImplementation(async (_persona: string, instruction: string) => {
      const rawFindingId = instruction.includes(`${SHARED_RUN_ID}:child-a:`) ? rawFindingIdA : rawFindingIdB;
      // LLM 応答の返却前に一呼吸置き、2呼び出しの「読み込み → await → 保存」
      // が実際に重なるようにする。
      await new Promise((resolve) => setTimeout(resolve, 5));
      return {
        status: 'done',
        content: '',
        structuredOutput: {
          rawDecisions: [{ rawFindingId, decision: 'new', evidence: 'No related open finding.' }],
          disputeDecisions: [],
          conflictDecisions: [],
        },
      } as unknown as AgentResponse;
    });

    const optionsBuilder = {
      buildAgentOptions: () => ({}),
      resolveStepProviderModel: () => ({ provider: 'codex', model: 'gpt-test' }),
    };
    const stepExecutor = {
      buildPhase1Instruction: (instruction: string) => instruction,
      normalizeStructuredOutput: (_step: WorkflowStep, response: AgentResponse) => response,
    };
    const parentStep: WorkflowStep = { kind: 'agent', name: 'reviewers', persona: 'reviewer', edit: false } as WorkflowStep;
    const contract = {
      ledgerPath: '.takt/findings/peer-review.json',
      rawFindingsPath: '.takt/findings/raw',
      manager: {
        persona: 'findings-manager',
        instruction: 'Reconcile findings.',
        outputContract: 'Return JSON.',
      },
    };

    const runCall = (store: FindingLedgerStore, callNamespace: string, raw: Record<string, unknown>) => runFindingManagerForStep({
      contract: contract as never,
      ledgerStore: store,
      optionsBuilder: optionsBuilder as never,
      stepExecutor: stepExecutor as never,
      cwd: projectCwd,
      parentStep,
      stepIteration: 1,
      subResults: [
        {
          subStep: { kind: 'agent', name: 'arch-review', persona: 'arch', edit: false } as WorkflowStep,
          response: {
            status: 'done',
            content: '',
            structuredOutput: { rawFindings: [raw] },
          } as unknown as AgentResponse,
        },
      ],
      workflowName: 'peer-review',
      runId: SHARED_RUN_ID,
      callNamespace,
      timestamp: '2026-06-14T00:00:00.000Z',
    });

    const [resultA, resultB] = await Promise.all([
      runCall(storeA, 'child-a', {
        rawFindingId: 'i-1',
        familyTag: 'bug',
        severity: 'high',
        title: 'Issue reported by child A',
        location: 'src/a.ts:10',
        description: 'Reported by concurrent child A.',
        suggestion: '',
        kind: 'issue',
      }),
      runCall(storeB, 'child-b', {
        rawFindingId: 'i-1',
        familyTag: 'security',
        severity: 'medium',
        title: 'Issue reported by child B',
        location: 'src/b.ts:20',
        description: 'Reported by concurrent child B.',
        suggestion: '',
        kind: 'issue',
      }),
    ]);

    expect(resultA.status).toBe('updated');
    expect(resultB.status).toBe('updated');

    const finalLedger = storeA.loadLedger();
    // 両方の新規指摘が反映されている（後勝ちで片方が消えていない）。
    expect(finalLedger.findings.some((f) => f.title === 'Issue reported by child A')).toBe(true);
    expect(finalLedger.findings.some((f) => f.title === 'Issue reported by child B')).toBe(true);
    // nextId の割り当ても衝突していない（2件とも別々の finding id を持つ）。
    const ids = new Set(finalLedger.findings.map((f) => f.id));
    expect(ids.size).toBe(finalLedger.findings.length);
  });

  it('Given two concurrent callers each deciding "new" for an IDENTICAL raw (same path, title and description) When both resolve their LLM call around the same time Then only one finding is created (no F-0001/F-0002 duplicate)', async () => {
    // codex の再現ケース本体: 上のテストは意図的に異なる path/title の
    // 2件を使っているため、この競合を検出しない。ここでは両方の子が内容の
    // 完全一致する raw（path + 正規化タイトル + description が同じ。familyTag と
    // 行番号は同一性の根拠にしない設計）を "new" と判断する状況を再現する。
    // 保存直前の再照合で、後から critical section に入った側は先に保存された
    // finding を台帳上で検出し、"new" ではなく "same" として畳み込まれるべき
    // （decision-assembly.ts の openFindingKeyIndex。鍵は path+title+description の
    // 完全一致 — path+title だけのリダイレクトは manager の new 判断を意味判断
    // なしで覆す禁止マージだった: codex ブロッカー B3）。
    const projectCwd = mkdtempSync(join(tmpdir(), 'takt-findings-race-dup-project-'));
    const reportDir = mkdtempSync(join(tmpdir(), 'takt-findings-race-dup-report-'));
    cleanupDirs.add(projectCwd);
    cleanupDirs.add(reportDir);
    mkdirSync(join(projectCwd, 'src'), { recursive: true });
    writeFileSync(join(projectCwd, 'src/dup.ts'), `${Array.from({ length: 15 }, (_, i) => `// line ${i + 1}`).join('\n')}\n`);

    const store = createFindingLedgerStore({
      projectCwd,
      reportDir,
      workflowName: 'peer-review',
      ledgerPath: '.takt/findings/peer-review.json',
      rawFindingsPath: '.takt/findings/raw',
    });
    store.saveLedger({
      version: 1,
      workflowName: 'peer-review',
      nextId: 1,
      updatedAt: '2026-06-13T00:00:00.000Z',
      findings: [],
      rawFindings: [],
      conflicts: [],
    });

    // 上のテストと同じ理由で、2子の runId を揃え、callNamespace だけで区別する。
    const SHARED_RUN_ID = 'shared-run-dup';
    const rawFindingIdA = `${SHARED_RUN_ID}:child-a:reviewers:1:arch-review:i-1`;
    const rawFindingIdB = `${SHARED_RUN_ID}:child-b:reviewers:1:arch-review:i-1`;
    executeAgentMock.mockImplementation(async (_persona: string, instruction: string) => {
      const rawFindingId = instruction.includes(`${SHARED_RUN_ID}:child-a:`) ? rawFindingIdA : rawFindingIdB;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return {
        status: 'done',
        content: '',
        structuredOutput: {
          rawDecisions: [{ rawFindingId, decision: 'new', evidence: 'No related open finding.' }],
          disputeDecisions: [],
          conflictDecisions: [],
        },
      } as unknown as AgentResponse;
    });

    const optionsBuilder = {
      buildAgentOptions: () => ({}),
      resolveStepProviderModel: () => ({ provider: 'codex', model: 'gpt-test' }),
    };
    const stepExecutor = {
      buildPhase1Instruction: (instruction: string) => instruction,
      normalizeStructuredOutput: (_step: WorkflowStep, response: AgentResponse) => response,
    };
    const parentStep: WorkflowStep = { kind: 'agent', name: 'reviewers', persona: 'reviewer', edit: false } as WorkflowStep;
    const contract = {
      ledgerPath: '.takt/findings/peer-review.json',
      rawFindingsPath: '.takt/findings/raw',
      manager: {
        persona: 'findings-manager',
        instruction: 'Reconcile findings.',
        outputContract: 'Return JSON.',
      },
    };

    const runCall = (callNamespace: string, raw: Record<string, unknown>) => runFindingManagerForStep({
      contract: contract as never,
      ledgerStore: store,
      optionsBuilder: optionsBuilder as never,
      stepExecutor: stepExecutor as never,
      cwd: projectCwd,
      parentStep,
      stepIteration: 1,
      subResults: [
        {
          subStep: { kind: 'agent', name: 'arch-review', persona: 'arch', edit: false } as WorkflowStep,
          response: {
            status: 'done',
            content: '',
            structuredOutput: { rawFindings: [raw] },
          } as unknown as AgentResponse,
        },
      ],
      workflowName: 'peer-review',
      runId: SHARED_RUN_ID,
      callNamespace,
      timestamp: '2026-06-14T00:00:00.000Z',
    });

    const [resultA, resultB] = await Promise.all([
      runCall('child-a', {
        rawFindingId: 'i-1',
        familyTag: 'bug',
        severity: 'high',
        title: 'Duplicate issue at src/dup.ts',
        location: 'src/dup.ts:10',
        description: 'The handle opened at src/dup.ts:10 is never released.',
        suggestion: '',
        kind: 'issue',
      }),
      runCall('child-b', {
        rawFindingId: 'i-1',
        // familyTag と行番号が違っても、内容（path+title+description）が完全一致
        // すれば同一性の索引に掛かる（familyTag は分類ヒントに過ぎず識別根拠では
        // ないことの確認）。
        familyTag: 'security',
        severity: 'high',
        title: 'Duplicate issue at src/dup.ts',
        location: 'src/dup.ts:10',
        description: 'The handle opened at src/dup.ts:10 is never released.',
        suggestion: '',
        kind: 'issue',
      }),
    ]);

    expect(resultA.status).toBe('updated');
    expect(resultB.status).toBe('updated');

    const finalLedger = store.loadLedger();
    const openAtLocation = finalLedger.findings.filter((f) => f.location === 'src/dup.ts:10' && f.status === 'open');
    // F-0001 と F-0002 の重複が起きない: 1件だけ立つ。
    expect(openAtLocation).toHaveLength(1);
    // 両方の raw finding id がその1件に紐づく（片方は "new" から "same" へ
    // リダイレクトされている）。
    const rawFindingIdsOnFinding = openAtLocation[0]?.rawFindingIds ?? [];
    expect(rawFindingIdsOnFinding).toContain(rawFindingIdA);
    expect(rawFindingIdsOnFinding).toContain(rawFindingIdB);
  });
});

describe('runFindingManagerForStep stale rejection excluded from unmentioned fallback', () => {
  it('Given a "same" decision that the freshly re-read ledger rejects (target no longer open) When run Then the raw is excluded from the unmentioned-raw fallback and no duplicate finding is created', async () => {
    // codex 指摘: assembleManagerOutput() は保存直前に最新台帳へ再照合するが、
    // そこで不採用になった raw は reconcileFindingLedger() の「未言及の raw は
    // 新規 finding にする」フォールバックにそのまま回っていた。項目単位の
    // 不採用が実質不成立になっていたケースを再現する。
    executeAgentMock.mockResolvedValue({
      status: 'done',
      content: '',
      structuredOutput: {
        rawDecisions: [
          {
            rawFindingId: 'run-2:reviewers:2:arch-review:i-1',
            decision: 'same',
            findingId: 'F-0001',
            evidence: 'Same root cause as F-0001, restated at a nearby line.',
          },
        ],
        disputeDecisions: [],
        conflictDecisions: [],
      },
    } as unknown as AgentResponse);

    const initialLedger = makeLedger(); // F-0001 は open, location src/a.ts:10
    // 保存直前の再読込で見える「最新台帳」では、別の並列子が既に F-0001 を
    // 解消済みにしている想定。
    const staleFreshLedger: FindingLedger = {
      ...initialLedger,
      findings: [
        {
          ...initialLedger.findings[0]!,
          status: 'resolved',
          lifecycle: 'resolved',
          resolvedAt: '2026-06-14T00:00:00.000Z',
          resolvedEvidence: 'Resolved by a concurrent child.',
        },
      ],
    };

    const savedLedgers: FindingLedger[] = [];
    const savedValidationReports: FindingManagerValidationReport[] = [];
    const ledgerStore: FindingLedgerStore = {
      workflowName: 'peer-review',
      loadLedger: () => initialLedger,
      saveLedger: (next) => { savedLedgers.push(next); },
      updateLedger: (mutator) => {
        const next = mutator(staleFreshLedger);
        savedLedgers.push(next);
        return Promise.resolve(next);
      },
      createRunCopy: () => '/tmp/ledger-copy.json',
      saveRawFindings: () => '/tmp/raw-findings.json',
      saveManagerValidationReport: (report) => {
        savedValidationReports.push(report);
        return '/tmp/manager-report.json';
      },
    };
    const optionsBuilder = {
      buildAgentOptions: () => ({}),
      resolveStepProviderModel: () => ({ provider: 'codex', model: 'gpt-test' }),
    };
    const stepExecutor = {
      buildPhase1Instruction: (instruction: string) => instruction,
      normalizeStructuredOutput: (_step: WorkflowStep, response: AgentResponse) => response,
    };
    const parentStep: WorkflowStep = { kind: 'agent', name: 'reviewers', persona: 'reviewer', edit: false } as WorkflowStep;
    const contract = {
      ledgerPath: '.takt/findings/ledger.json',
      rawFindingsPath: '.takt/findings/raw',
      manager: {
        persona: 'findings-manager',
        instruction: 'Reconcile findings.',
        outputContract: 'Return JSON.',
      },
    };

    // 台帳の F-0001 (src/a.ts:10) とは1行ずれた場所にしておき、機械分類の
    // 完全一致（location 文字列一致）には掛からず LLM 判断（residual）に回す。
    const rawFinding = {
      rawFindingId: 'i-1',
      familyTag: 'bug',
      severity: 'high',
      title: 'Restated existing issue',
      location: 'src/a.ts:11',
      description: 'Same bug, reported again at a nearby line.',
      suggestion: '',
      kind: 'issue',
    };

    const result = await runFindingManagerForStep({
      contract: contract as never,
      ledgerStore,
      optionsBuilder: optionsBuilder as never,
      stepExecutor: stepExecutor as never,
      cwd: FIXTURE_CWD,
      parentStep,
      stepIteration: 2,
      subResults: [
        {
          subStep: { kind: 'agent', name: 'arch-review', persona: 'arch', edit: false } as WorkflowStep,
          response: {
            status: 'done',
            content: '',
            structuredOutput: { rawFindings: [rawFinding] },
          } as unknown as AgentResponse,
        },
      ],
      workflowName: 'peer-review',
      runId: 'run-2',
      callNamespace: '',
      timestamp: '2026-06-14T00:00:00.000Z',
    });

    expect(result.status).toBe('updated');
    expect(savedLedgers).toHaveLength(1);
    const savedLedger = savedLedgers[0];
    // 不採用になった raw が「未言及」フォールバックで新規 finding に化けていない。
    expect(savedLedger?.findings).toHaveLength(1);
    expect(savedLedger?.findings[0]?.id).toBe('F-0001');
    expect(savedLedger?.findings[0]?.status).toBe('resolved');
    expect(savedLedger?.findings.some((f) => f.title === 'Restated existing issue')).toBe(false);
    // 除外した理由は validation report に残る。
    expect(savedValidationReports).toHaveLength(1);
    expect(savedValidationReports[0]?.ledgerUpdated).toBe(true);
    const lastAttempt = savedValidationReports[0]?.attempts.at(-1);
    expect(lastAttempt?.validationErrors.some((e) => e.includes('i-1'))).toBe(true);
    expect(lastAttempt?.validationErrors.some((e) => e.includes('not open'))).toBe(true);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentResponse, WorkflowStep } from '../core/models/types.js';
import type { FindingLedger, FindingLedgerStore, RawFinding } from '../core/workflow/findings/types.js';
import { runFindingManagerForParallelStep } from '../core/workflow/findings/manager-runner.js';

vi.mock('../agents/agent-usecases.js', () => ({
  executeAgent: vi.fn(),
}));

const { executeAgent } = await import('../agents/agent-usecases.js');
const executeAgentMock = vi.mocked(executeAgent);

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
  run: (input: {
    reviewerRawFindings: Array<Record<string, unknown>>;
    priorStepResponseText?: string;
  }) => ReturnType<typeof runFindingManagerForParallelStep>;
}

function makeHarness(ledger: FindingLedger): Harness {
  const savedLedgers: FindingLedger[] = [];
  const savedRawFindings: RawFinding[][] = [];
  const ledgerStore: FindingLedgerStore = {
    loadLedger: () => ledger,
    saveLedger: (next) => { savedLedgers.push(next); },
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
  return {
    savedLedgers,
    savedRawFindings,
    run: (input) => runFindingManagerForParallelStep({
      // テスト対象が使うメソッドだけを実装した最小 double。
      contract: contract as never,
      ledgerStore,
      optionsBuilder: optionsBuilder as never,
      stepExecutor: stepExecutor as never,
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

beforeEach(() => {
  executeAgentMock.mockReset();
});

describe('runFindingManagerForParallelStep mechanical path', () => {
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
        matches: [],
        newFindings: [
          { rawFindingIds: ['run-2:reviewers:2:arch-review:i-1'], title: 'New unmatched issue', severity: 'medium' },
        ],
        resolvedFindings: [],
        reopenedFindings: [],
        conflicts: [],
        resolvedConflicts: [],
        waivedFindings: [],
        disputeNotes: [],
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
        matches: [],
        newFindings: [],
        resolvedFindings: [],
        reopenedFindings: [],
        conflicts: [],
        resolvedConflicts: [],
        waivedFindings: [],
        disputeNotes: [],
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

describe('runFindingManagerForParallelStep invalid manager output', () => {
  it('Given the agent returns semantically invalid output twice When run Then the result is invalid_manager_output and the ledger is not saved', async () => {
    // 存在しない findingId への match は意味検証で invalid になる。
    executeAgentMock.mockResolvedValue({
      status: 'done',
      content: '',
      structuredOutput: {
        matches: [{ findingId: 'F-9999', rawFindingIds: ['run-2:reviewers:2:arch-review:i-1'], evidence: null }],
        newFindings: [],
        resolvedFindings: [],
        reopenedFindings: [],
        conflicts: [],
        resolvedConflicts: [],
        waivedFindings: [],
        disputeNotes: [],
      },
    } as unknown as AgentResponse);

    const harness = makeHarness(makeLedger());
    const result = await harness.run({ reviewerRawFindings: [UNMATCHED_ISSUE_RAW] });

    expect(executeAgentMock).toHaveBeenCalledTimes(2);
    expect(result.status).toBe('invalid_manager_output');
    expect(harness.savedLedgers).toHaveLength(0);
  });
});

describe('runFindingManagerForParallelStep conflict handling', () => {
  it('Given an active conflict in the ledger When all raws are mechanical Then the agent is still called', async () => {
    executeAgentMock.mockResolvedValue({
      status: 'done',
      content: '',
      structuredOutput: {
        matches: [],
        newFindings: [],
        resolvedFindings: [],
        reopenedFindings: [],
        conflicts: [],
        resolvedConflicts: [],
        waivedFindings: [],
        disputeNotes: [],
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
        matches: [],
        newFindings: [
          { rawFindingIds: ['run-2:reviewers:2:arch-review:i-1'], title: 'New unmatched issue', severity: 'medium' },
        ],
        resolvedFindings: [],
        reopenedFindings: [],
        conflicts: [],
        resolvedConflicts: [],
        waivedFindings: [],
        disputeNotes: [],
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

import { describe, expect, it, vi } from 'vitest';
import type { AgentResponse, AgentWorkflowStep, FindingContractConfig } from '../core/models/types.js';
import type { FindingLedger, RawFinding } from '../core/workflow/findings/types.js';
import type { RunFindingManagerForStepInput } from '../core/workflow/findings/manager-contracts.js';
import {
  buildManagerInputLedger,
  managerPromptTargetView,
  managerRawFindingView,
} from '../core/workflow/findings/manager-agent.js';
import { RAW_FINDING_FIELD_LIMITS } from '../core/models/finding-contract-limits.js';
import { runMainManagerTasks } from '../core/workflow/findings/manager-task-runner.js';
import {
  boundPromptArray,
  boundPromptString,
  FINDING_MANAGER_INPUT_MAX_BYTES,
  FINDING_MANAGER_PROMPT_LEDGER_LOCATIONS_ARRAY_MAX_BYTES,
  FINDING_MANAGER_PROMPT_BUDGETS,
  FINDING_MANAGER_PROMPT_FIELD_LIMITS,
  FINDING_MANAGER_PROMPT_BUDGET_ITEM_COUNT,
  MIN_PROMPT_ARRAY_TRUNCATION_MARKER_BYTES,
  MIN_PROMPT_STRING_TRUNCATION_MARKER_BYTES,
  promptJsonUtf8Bytes,
  rawTaskSectionBudget,
  renderCompactJsonBlock,
} from '../core/workflow/findings/prompt-bounds.js';
import { canonicalRawFindingFixture } from './helpers/finding-lifecycle-fixture.js';

vi.mock('../agents/agent-usecases.js', () => ({ executeAgent: vi.fn() }));

const { executeAgent } = await import('../agents/agent-usecases.js');
const executeAgentMock = vi.mocked(executeAgent);

const contract: FindingContractConfig = {
  manager: {
    persona: 'findings-manager',
    instruction: 'Reconcile the supplied raw findings.',
    outputContract: 'Return structured JSON.',
  },
};

const managerStep: AgentWorkflowStep = {
  kind: 'agent',
  name: 'findings-manager',
  persona: 'findings-manager',
  edit: false,
};

function emptyLedger(overrides: Partial<FindingLedger> = {}): FindingLedger {
  return {
    workflowName: 'prompt-budget-test',
    nextId: 1,
    updatedAt: '2026-08-10T00:00:00.000Z',
    findings: [],
    evidenceRecords: [],
    evidenceBindings: [],
    lifecycleReservations: [],
    lifecycleEvents: [],
    rawFindings: [],
    conflicts: [],
    ...overrides,
  };
}

function sectionJson<T>(instruction: string, heading: string): T {
  const start = instruction.indexOf(`${heading}\n`);
  if (start < 0) {
    throw new Error(`Missing section ${heading}`);
  }
  const rest = instruction.slice(start + heading.length + 1);
  const match = /^(`{3,})json\n([\s\S]*?)\n\1/m.exec(rest);
  if (match?.[2] === undefined) {
    throw new Error(`Missing JSON block after ${heading}`);
  }
  return JSON.parse(match[2]) as T;
}

function response(structuredOutput: Record<string, unknown>): AgentResponse {
  return {
    persona: 'findings-manager',
    status: 'done',
    content: '',
    timestamp: new Date('2026-08-10T00:00:00.000Z'),
    structuredOutput,
  };
}

function maxRawFinding(): RawFinding {
  return canonicalRawFindingFixture({
    rawFindingId: 'raw-budget-001',
    stepName: 's'.repeat(256),
    reviewer: 'r'.repeat(256),
    familyTag: 'f'.repeat(RAW_FINDING_FIELD_LIMITS.maxFamilyTagChars),
    severity: 'high',
    title: 't'.repeat(RAW_FINDING_FIELD_LIMITS.maxTitleChars),
    description: 'd'.repeat(RAW_FINDING_FIELD_LIMITS.maxDescriptionChars),
    suggestion: 's'.repeat(RAW_FINDING_FIELD_LIMITS.maxSuggestionChars),
    rawExcerpt: 'e'.repeat(RAW_FINDING_FIELD_LIMITS.maxDescriptionChars),
    target: {
      kind: 'code',
      paths: Array.from({ length: 8 }, (_, index) => `${'path/'.repeat(80)}${index}.ts`),
    },
    relation: 'new',
    targetFindingId: null,
    evidence: Array.from({ length: 4 }, (_, index) => ({
      kind: 'file_quote' as const,
      path: `src/${index}/${'quoted/'.repeat(80)}file.ts`,
      startLine: index + 1,
      endLine: index + 2,
      verbatimExcerpt: `quote-${index}-😀`.repeat(50),
      snapshotId: 'a'.repeat(64),
    })),
  });
}

describe('finding manager prompt budget', () => {
  it('keeps every section allocation below the provider input limit', () => {
    const raw = maxRawFinding();
    const oneRawSectionBudgets = {
      fixedPrefix: FINDING_MANAGER_PROMPT_BUDGETS.fixedPrefixMaxBytes,
      structure: FINDING_MANAGER_PROMPT_BUDGETS.structureMaxBytes,
      manifest: rawTaskSectionBudget('manifest', [raw.rawFindingId]),
      reportExcerpts: rawTaskSectionBudget('reportExcerpts', [raw.rawFindingId]),
      quoteWindows: rawTaskSectionBudget('quoteWindows', [raw.rawFindingId]),
      ledgerProjection: rawTaskSectionBudget('ledgerProjection', [raw.rawFindingId]),
    };
    const total = Object.values(oneRawSectionBudgets)
      .reduce((sum, value) => sum + value, 0);
    expect(FINDING_MANAGER_PROMPT_BUDGET_ITEM_COUNT).toBe(1);
    expect(total).toBeLessThanOrEqual(FINDING_MANAGER_INPUT_MAX_BYTES);
    expect(total).toBeLessThanOrEqual(FINDING_MANAGER_PROMPT_BUDGETS.totalMaxBytes);
  });

  it('proves every bounded string and array budget can carry its smallest marker', () => {
    const stringBudgets = [
      FINDING_MANAGER_PROMPT_FIELD_LIMITS.rawTitleMaxBytes,
      FINDING_MANAGER_PROMPT_FIELD_LIMITS.rawDescriptionMaxBytes,
      FINDING_MANAGER_PROMPT_FIELD_LIMITS.rawSuggestionMaxBytes,
      FINDING_MANAGER_PROMPT_FIELD_LIMITS.rawExcerptMaxBytes,
      FINDING_MANAGER_PROMPT_FIELD_LIMITS.targetLiteralMaxBytes,
      FINDING_MANAGER_PROMPT_FIELD_LIMITS.targetCollectionItemMaxBytes,
      FINDING_MANAGER_PROMPT_FIELD_LIMITS.quoteWindowPathMaxBytes,
      FINDING_MANAGER_PROMPT_FIELD_LIMITS.evidenceVerbatimExcerptMaxBytes,
      FINDING_MANAGER_PROMPT_FIELD_LIMITS.ledgerEvidenceVerbatimExcerptMaxBytes,
      FINDING_MANAGER_PROMPT_FIELD_LIMITS.ledgerTitleMaxBytes,
      FINDING_MANAGER_PROMPT_FIELD_LIMITS.ledgerDescriptionMaxBytes,
      FINDING_MANAGER_PROMPT_FIELD_LIMITS.ledgerSuggestionMaxBytes,
      FINDING_MANAGER_PROMPT_FIELD_LIMITS.ledgerLocationMaxBytes,
      FINDING_MANAGER_PROMPT_FIELD_LIMITS.provisionalReasonMaxBytes,
      FINDING_MANAGER_PROMPT_FIELD_LIMITS.conflictReasonMaxBytes,
      FINDING_MANAGER_PROMPT_FIELD_LIMITS.reviewerMaxBytes,
      FINDING_MANAGER_PROMPT_FIELD_LIMITS.stepNameMaxBytes,
      FINDING_MANAGER_PROMPT_FIELD_LIMITS.familyTagMaxBytes,
    ];
    const arrayBudgets = [
      FINDING_MANAGER_PROMPT_FIELD_LIMITS.evidenceArrayMaxBytes,
      FINDING_MANAGER_PROMPT_FIELD_LIMITS.ledgerEvidenceArrayMaxBytes,
      FINDING_MANAGER_PROMPT_FIELD_LIMITS.taskLedgerEvidenceArrayMaxBytes,
      FINDING_MANAGER_PROMPT_FIELD_LIMITS.ledgerLocationMaxBytes,
      FINDING_MANAGER_PROMPT_LEDGER_LOCATIONS_ARRAY_MAX_BYTES,
    ];

    expect(Math.min(...stringBudgets)).toBeGreaterThanOrEqual(
      MIN_PROMPT_STRING_TRUNCATION_MARKER_BYTES,
    );
    expect(Math.min(...arrayBudgets)).toBeGreaterThanOrEqual(
      MIN_PROMPT_ARRAY_TRUNCATION_MARKER_BYTES,
    );
  });

  it('retains four maximum-shape ledger locations within the ledger section budget', () => {
    const evidenceIds = Array.from(
      { length: FINDING_MANAGER_PROMPT_FIELD_LIMITS.ledgerMaxLocations },
      (_, index) => `evidence-${index}`,
    );
    const ledger = emptyLedger({
      findings: [{
        id: 'F-0001',
        status: 'open',
        lifecycle: 'new',
        revision: 1,
        target: { kind: 'code', paths: ['src/a.ts'] },
        targetIdentityHash: 'a'.repeat(64),
        claimIdentityHash: 'b'.repeat(64),
        semanticClaimIdentityHash: 'c'.repeat(64),
        severity: 'high',
        title: 'Finding',
        evidenceIds,
        description: 'Description',
        reviewers: ['reviewer'],
        rawFindingIds: [],
        firstSeen: { runId: 'run', stepName: 'review', timestamp: '2026-08-10T00:00:00.000Z' },
        lastSeen: { runId: 'run', stepName: 'review', timestamp: '2026-08-10T00:00:00.000Z' },
      }],
      evidenceRecords: evidenceIds.map((evidenceId, index) => ({
        evidenceId,
        kind: 'file_quote' as const,
        path: `${'x'.repeat(230)}${index}`,
        startLine: 1,
        endLine: 1,
        verbatimExcerpt: 'x',
        snapshotId: 'd'.repeat(64),
        claimIdentityHash: 'e'.repeat(64),
        fileHash: 'f'.repeat(64),
      })),
    });
    const projection = buildManagerInputLedger(
      ledger,
      new Set(['F-0001']),
      { includeRawFindingDetails: false },
    ) as { findings: Array<{ locations: string[] }> };
    const locations = projection.findings[0]!.locations;
    const section = [
      '## Relevant ledger projection',
      renderCompactJsonBlock({ findings: [{ locations }], conflicts: [] }),
    ].join('\n');

    expect(locations).toHaveLength(FINDING_MANAGER_PROMPT_FIELD_LIMITS.ledgerMaxLocations);
    expect(promptJsonUtf8Bytes({ items: locations })).toBeLessThanOrEqual(
      FINDING_MANAGER_PROMPT_LEDGER_LOCATIONS_ARRAY_MAX_BYTES,
    );
    expect(Buffer.byteLength(section, 'utf8')).toBeLessThanOrEqual(
      FINDING_MANAGER_PROMPT_BUDGETS.ledgerProjectionMaxBytes,
    );
  });

  it('does not leak future raw finding fields into the prompt DTO', () => {
    const raw = maxRawFinding() as RawFinding & { futureField: string };
    raw.futureField = 'must not be rendered';
    const view = managerRawFindingView(raw, []) as Record<string, unknown>;
    expect(view).not.toHaveProperty('futureField');
    expect(view).toHaveProperty('rawFindingId', raw.rawFindingId);
  });

  it('renders a schema-maximum raw finding within the total budget', async () => {
    executeAgentMock.mockImplementation(async (_persona, instruction) => {
      const manifest = sectionJson<{
        taskId: string;
        rawFindings: Array<{ rawFindingId: string; componentId: string }>;
      }>(instruction, '## Task manifest');
      return response({
        taskId: manifest.taskId,
        decisions: manifest.rawFindings.map((finding) => ({
          rawFindingId: finding.rawFindingId,
          componentId: finding.componentId,
          decision: 'new',
          findingId: '',
          evidence: 'bounded prompt test',
        })),
      });
    });

    let prompt = '';
    const result = await runMainManagerTasks({
      contract,
      previousLedger: emptyLedger(),
      reviewScopeSnapshotId: 'scope-test',
      residualRawFindings: [maxRawFinding()],
      mechanicallyClassifiedCount: 0,
      priorStepResponseText: undefined,
      invalidLocationCandidates: new Map(),
      dismissCandidates: new Map(),
      evidenceRecordsByRawFindingId: new Map(),
      managerStep,
      runInput: {
        optionsBuilder: { buildAgentOptions: () => ({}) },
        stepExecutor: {
          buildPhase1Instruction: (instruction: string) => {
            prompt = instruction;
            return instruction;
          },
          recordSynthesizedAgentUsage: () => {},
          normalizeStructuredOutput: (_step: unknown, response: unknown) => response,
        },
      } as Pick<RunFindingManagerForStepInput, 'optionsBuilder' | 'stepExecutor'>,
      managerAuthority: 'standard',
      workflowTask: 'Review the requested implementation.',
      subResults: [],
    });

    expect(result.rawFailures.size).toBe(0);
    expect(executeAgentMock).toHaveBeenCalledTimes(1);
    expect(result.taskAudits).toMatchObject([{ taskKind: 'raw', status: 'succeeded' }]);
    expect(result.taskAudits).not.toContainEqual(
      expect.objectContaining({ status: 'input_overflow' }),
    );
    expect(Buffer.byteLength(prompt, 'utf8'))
      .toBeLessThanOrEqual(FINDING_MANAGER_PROMPT_BUDGETS.totalMaxBytes);
    expect(Buffer.byteLength(prompt, 'utf8')).toBeLessThanOrEqual(FINDING_MANAGER_INPUT_MAX_BYTES);
  });

  it('keeps four-byte Unicode code points intact at a truncation boundary', () => {
    const bounded = boundPromptString({
      value: '😀'.repeat(100),
      fieldPath: 'raw.description',
      maxRenderedBytes: 300,
    });
    expect(bounded.truncation).toBeDefined();
    expect(bounded.text).not.toContain('\uFFFD');
    expect(Buffer.byteLength(bounded.text, 'utf8') % 4).toBe(0);
    expect(promptJsonUtf8Bytes(bounded.text)
      + promptJsonUtf8Bytes(bounded.truncation!)).toBeLessThanOrEqual(300);
  });

  it('counts source UTF-8 bytes separately from escaped JSON rendering bytes', () => {
    const value = '"\\\n😀'.repeat(20);
    const bounded = boundPromptString({
      value,
      fieldPath: 'raw.description',
      maxRenderedBytes: 170,
    });
    expect(bounded.truncation?.omittedUtf8Bytes).toBe(
      Buffer.byteLength(value, 'utf8') - Buffer.byteLength(bounded.text, 'utf8'),
    );
    expect(promptJsonUtf8Bytes(value)).toBeGreaterThan(Buffer.byteLength(value, 'utf8'));
    expect(bounded.truncation).toEqual({
      kind: 'takt_prompt_truncation_v1',
      omittedUtf8Bytes: expect.any(Number),
    });
  });

  it('returns an empty array and marker instead of throwing below marker budget', () => {
    expect(() => boundPromptArray({
      items: ['must be omitted'],
      fieldPath: 'raw.evidence',
      maxItems: 1,
      maxRenderedBytes: 0,
    })).not.toThrow();
    expect(boundPromptArray({
      items: ['must be omitted'],
      fieldPath: 'raw.evidence',
      maxItems: 1,
      maxRenderedBytes: 0,
    })).toEqual({
      items: [],
      truncation: {
        kind: 'takt_prompt_truncation_v1',
        omittedCount: 1,
      },
    });
  });

  it('bounds target collections while retaining the target kind', () => {
    const target = managerPromptTargetView({
      kind: 'code',
      paths: Array.from({ length: 20 }, (_, index) => `${'x'.repeat(300)}-${index}`),
    });
    expect(promptJsonUtf8Bytes(target)).toBeLessThanOrEqual(
      FINDING_MANAGER_PROMPT_FIELD_LIMITS.targetMaxBytes,
    );
    expect(target).toMatchObject({ kind: 'code' });
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentResponse,
  AgentWorkflowStep,
  FindingContractConfig,
  WorkflowStep,
} from '../core/models/types.js';
import type {
  FindingLedger,
  FindingLedgerConflict,
  FindingLedgerEntry,
  RawFinding,
} from '../core/workflow/findings/types.js';
import type { RunFindingManagerForStepInput } from '../core/workflow/findings/manager-contracts.js';
import {
  createMainManagerControlTaskManifest,
  createMainManagerRawTaskManifest,
  runMainManagerTasks,
} from '../core/workflow/findings/manager-task-runner.js';
import { MAIN_MANAGER_INPUT_MAX_BYTES } from '../core/workflow/findings/manager-task-contracts.js';
import { canonicalRawFindingFixture } from './helpers/finding-lifecycle-fixture.js';
import { serializeFindingManagerValidationReport } from '../core/workflow/findings/manager-report-content.js';
import { parseFindingManagerValidationReport } from '../core/workflow/findings/schemas.js';
import type { FindingManagerValidationReport } from '../core/workflow/findings/store.js';
import {
  createFindingReviewPublication,
  STRUCTURED_FINDING_REVIEW_PUBLICATION_PROTOCOL,
} from '../core/workflow/findings/review-publication.js';
import {
  bindReviewerReportExcerpt,
} from '../core/workflow/findings/raw-canonicalization.js';
import {
  collectTaskScopeReportExcerpts,
} from '../core/workflow/findings/task-scope-adjudication.js';
import {
  PROVIDER_ANCHOR_RELEVANCE_INSTRUCTION,
} from '../core/workflow/findings/manager-raw-decision-adapter.js';

vi.mock('../agents/agent-usecases.js', () => ({ executeAgent: vi.fn() }));

const { executeAgent } = await import('../agents/agent-usecases.js');
const executeAgentMock = vi.mocked(executeAgent);

const contract: FindingContractConfig = {
  manager: {
    persona: 'findings-manager',
    instruction: 'Reconcile only the supplied task.',
    outputContract: 'Return structured JSON.',
  },
};

const managerStep: AgentWorkflowStep = {
  kind: 'agent',
  name: 'findings-manager',
  persona: 'findings-manager',
  edit: false,
};

const runInput = {
  optionsBuilder: {
    buildAgentOptions: () => ({}),
  },
  stepExecutor: {
    buildPhase1Instruction: (instruction: string) => instruction,
    normalizeStructuredOutput: (_step: WorkflowStep, response: AgentResponse) => response,
    recordSynthesizedAgentUsage: () => {},
  },
} as Pick<RunFindingManagerForStepInput, 'optionsBuilder' | 'stepExecutor'>;

function emptyLedger(overrides: Partial<FindingLedger> = {}): FindingLedger {
  return {
    workflowName: 'manager-task-runner',
    nextId: 1,
    updatedAt: '2026-07-29T00:00:00.000Z',
    findings: [],
    evidenceRecords: [],
    evidenceBindings: [],
    lifecycleReservations: [],
    lifecycleEvents: [],
    rawRecoveryAttempts: [],
    rawRecoveryResults: [],
    rawFindings: [],
    conflicts: [],
    interpretations: [],
    ...overrides,
  };
}

function rawFinding(
  index: number,
  overrides: Partial<RawFinding> = {},
): RawFinding {
  return canonicalRawFindingFixture({
    rawFindingId: `raw-${String(index).padStart(3, '0')}`,
    stepName: 'reviewer',
    reviewer: 'reviewer',
    familyTag: 'bug',
    severity: 'high',
    title: `Issue ${index}`,
    description: `Distinct issue ${index}`,
    suggestion: `Fix issue ${index}`,
    relation: 'new',
    targetFindingId: null,
    evidence: [],
    ...overrides,
  });
}

function ledgerFinding(index: number): FindingLedgerEntry {
  const raw = rawFinding(index);
  return {
    id: `F-${String(index).padStart(4, '0')}`,
    status: 'open',
    lifecycle: 'new',
    revision: 1,
    target: raw.target,
    targetIdentityHash: raw.targetIdentityHash,
    claimIdentityHash: raw.claimIdentityHash,
    semanticClaimIdentityHash: raw.semanticClaimIdentityHash,
    severity: 'high',
    title: raw.title!,
    evidenceIds: [],
    description: raw.description ?? undefined,
    reviewers: ['reviewer'],
    rawFindingIds: [],
    firstSeen: { runId: 'run', stepName: 'reviewer', timestamp: '2026-07-29T00:00:00.000Z' },
    lastSeen: { runId: 'run', stepName: 'reviewer', timestamp: '2026-07-29T00:00:00.000Z' },
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

interface RawManifestView {
  taskId: string;
  ownedRawFindingIds: string[];
  rawFindings: Array<{
    rawFindingId: string;
    componentId: string;
  }>;
}

interface ControlManifestView {
  taskId: string;
  kind: string;
  ownedEntityIds: string[];
  candidateIntents: Array<{
    intentId: string;
    kind: string;
    entityId: string;
  }>;
}

function reviewPublication(
  reportContent: string,
  rawFindings: readonly unknown[],
) {
  return createFindingReviewPublication({
    identity: {
      scopeIdentity: 'scope-test',
      callNamespace: '',
      parentStepName: 'reviewers',
      stepIteration: 1,
      reviewerStepName: 'reviewer',
      reportName: 'reviewer.md',
    },
    protocol: STRUCTURED_FINDING_REVIEW_PUBLICATION_PROTOCOL,
    reportContent,
    rawFindings,
  });
}

function response(structuredOutput: Record<string, unknown>): AgentResponse {
  return {
    persona: 'findings-manager',
    status: 'done',
    content: '',
    timestamp: new Date('2026-07-29T00:00:00.000Z'),
    structuredOutput,
  };
}

function successfulRawResponse(
  instruction: string,
  decision: 'new' | 'same' | 'conflict' = 'new',
): AgentResponse {
  const manifest = sectionJson<RawManifestView>(instruction, '## Task manifest');
  return response({
    taskId: manifest.taskId,
    decisions: manifest.rawFindings.map((raw) => ({
      rawFindingId: raw.rawFindingId,
      componentId: raw.componentId,
      decision,
      findingId: decision === 'new' ? '' : 'F-0001',
      evidence: 'manager decision',
    })),
  });
}

async function run(rawFindings: RawFinding[], previousLedger = emptyLedger()) {
  return runMainManagerTasks({
    contract,
    previousLedger,
    reviewScopeSnapshotId: 'scope-test',
    residualRawFindings: rawFindings,
    mechanicallyClassifiedCount: 0,
    priorStepResponseText: undefined,
    invalidLocationCandidates: new Map(),
    dismissCandidates: new Map(),
    evidenceRecordsByRawFindingId: new Map(),
    managerStep,
    runInput,
    managerAuthority: 'standard',
    workflowTask: 'Review the requested implementation.',
    subResults: [],
  });
}

beforeEach(() => {
  executeAgentMock.mockReset();
});

describe('main manager bounded task runner', () => {
  it('binds control task ids to authority, workflow task, and related publication excerpts', () => {
    const finding = {
      ...ledgerFinding(1),
      title: 'GitLab attachment support is missing',
    };
    const rawFinding = {
      rawExcerpt: 'GitLab attachment support is missing',
      candidate: {
        rawFindingId: 'raw-001',
        targetFindingIds: ['F-0001'],
      },
    };
    const publication = reviewPublication(
      'GitLab attachment support is missing',
      [rawFinding],
    );
    const taskIdFor = (
      managerAuthority: 'standard' | 'terminal_adjudication',
      workflowTask: string,
      reportContent = publication.reportContent,
    ): string => createMainManagerControlTaskManifest({
      previousLedger: emptyLedger({ findings: [finding] }),
      reviewScopeSnapshotId: 'scope-test',
      priorStepResponseText: undefined,
      invalidLocationCandidates: new Map(),
      dismissCandidates: new Map([['F-0001', 'terminal claim']]),
      managerAuthority,
      workflowTask,
      subResults: [{
        subStep: managerStep,
        publication: reviewPublication(reportContent, [rawFinding]),
      }],
    })[0]!.task.taskId;

    const base = taskIdFor(
      'terminal_adjudication',
      'Support GitHub issue attachments.',
    );
    expect(taskIdFor(
      'standard',
      'Support GitHub issue attachments.',
    )).not.toBe(base);
    expect(taskIdFor(
      'terminal_adjudication',
      'Support GitHub and GitLab issue attachments.',
    )).not.toBe(base);
    expect(taskIdFor(
      'terminal_adjudication',
      'Support GitHub issue attachments.',
      `Current review:\n${publication.reportContent}`,
    )).not.toBe(base);
    const unrelatedPublication = reviewPublication(
      'An unrelated reviewer report.',
      [{
        rawExcerpt: 'An unrelated reviewer report.',
        candidate: {
          rawFindingId: 'unrelated',
          targetFindingIds: ['F-9999'],
        },
      }],
    );
    const unrelated = createMainManagerControlTaskManifest({
      previousLedger: emptyLedger({ findings: [finding] }),
      reviewScopeSnapshotId: 'scope-test',
      priorStepResponseText: undefined,
      invalidLocationCandidates: new Map(),
      dismissCandidates: new Map([['F-0001', 'terminal claim']]),
      managerAuthority: 'terminal_adjudication',
      workflowTask: 'Support GitHub issue attachments.',
      subResults: [{
        subStep: managerStep,
        publication: unrelatedPublication,
      }],
    })[0]!;
    expect(unrelated.task.taskScopeContext?.reportExcerpts).toEqual([]);
  });

  it('does not bind raw-1 to raw-10 by identifier substring', () => {
    const finding = {
      ...ledgerFinding(1),
      rawFindingIds: ['raw-1'],
    };
    const publication = reviewPublication(
      'raw-10 reports an unrelated concern',
      [{
        rawExcerpt: 'raw-10 reports an unrelated concern',
        candidate: {
          rawFindingId: 'raw-10',
          targetFindingIds: [],
        },
      }],
    );

    expect(collectTaskScopeReportExcerpts({
      finding,
      ledgerRawFindings: [],
      publications: [publication],
    })).toEqual([]);
  });

  it('does not bind a local raw id to a namespaced suffix without source proof', () => {
    const finding = {
      ...ledgerFinding(1),
      rawFindingIds: ['run:reviewers:1:reviewer:raw-1'],
    };
    const publication = reviewPublication(
      'A local raw-1 observation',
      [{
        rawExcerpt: 'A local raw-1 observation',
        candidate: {
          rawFindingId: 'raw-1',
          targetFindingIds: [],
        },
      }],
    );

    expect(collectTaskScopeReportExcerpts({
      finding,
      ledgerRawFindings: [],
      publications: [publication],
    })).toEqual([]);
  });

  it('selects only the later excerpt with an exact target finding id', () => {
    const finding = ledgerFinding(1);
    const unrelatedExcerpt = 'F-00010 is unrelated';
    const relatedExcerpt = 'F-0001 is the exact target';
    const publication = reviewPublication(
      `${unrelatedExcerpt}\n${relatedExcerpt}`,
      [
        {
          rawExcerpt: unrelatedExcerpt,
          candidate: {
            rawFindingId: 'raw-10',
            targetFindingIds: ['F-00010'],
          },
        },
        {
          rawExcerpt: relatedExcerpt,
          candidate: {
            rawFindingId: 'raw-1',
            targetFindingIds: ['F-0001'],
          },
        },
      ],
    );

    expect(collectTaskScopeReportExcerpts({
      finding,
      ledgerRawFindings: [],
      publications: [publication],
    })).toMatchObject([{
      excerpt: relatedExcerpt,
    }]);
  });

  it('binds a namespaced ledger raw through its verified source binding', () => {
    const excerpt = 'GitLab attachment support is missing';
    const publication = reviewPublication(excerpt, [{
      rawExcerpt: excerpt,
      candidate: {
        rawFindingId: 'raw-1',
        targetFindingIds: [],
      },
    }]);
    const namespacedRawId = 'run:reviewers:1:reviewer:raw-1';
    const ledgerRaw = rawFinding(1, {
      rawFindingId: namespacedRawId,
      sourceBinding: bindReviewerReportExcerpt(
        publication.reportContent,
        excerpt,
      ),
    });
    const finding = {
      ...ledgerFinding(1),
      rawFindingIds: [namespacedRawId],
    };

    expect(collectTaskScopeReportExcerpts({
      finding,
      ledgerRawFindings: [ledgerRaw],
      publications: [publication],
    })).toMatchObject([{ excerpt }]);
  });

  it('omits task-scope bindings from standard, dismissless, and conflict task ids', () => {
    const finding = ledgerFinding(1);
    const conflict: FindingLedgerConflict = {
      id: 'C-0001',
      status: 'active',
      findingIds: [finding.id],
      rawFindingIds: [],
      description: 'Needs adjudication',
      firstSeen: finding.firstSeen,
      lastSeen: finding.lastSeen,
      revision: 1,
    };
    const manifestFor = (input: {
      authority: 'standard' | 'terminal_adjudication';
      workflowTask: string;
      dismiss?: boolean;
      invalidate?: boolean;
      conflict?: boolean;
    }) => createMainManagerControlTaskManifest({
      previousLedger: emptyLedger({
        findings: [finding],
        conflicts: input.conflict ? [conflict] : [],
      }),
      reviewScopeSnapshotId: 'scope-test',
      priorStepResponseText: undefined,
      invalidLocationCandidates: input.invalidate
        ? new Map([[finding.id, 'invalid location']])
        : new Map(),
      dismissCandidates: input.dismiss
        ? new Map([[finding.id, 'terminal claim']])
        : new Map(),
      managerAuthority: input.authority,
      workflowTask: input.workflowTask,
      subResults: [],
    })[0]!.task;

    const standardA = manifestFor({
      authority: 'standard',
      workflowTask: 'TASK-SCOPE-MARKER-A',
      dismiss: true,
    });
    const standardB = manifestFor({
      authority: 'standard',
      workflowTask: 'TASK-SCOPE-MARKER-B',
      dismiss: true,
    });
    expect(standardA.taskScopeContext).toBeUndefined();
    expect(standardB.taskId).toBe(standardA.taskId);

    const dismisslessA = manifestFor({
      authority: 'terminal_adjudication',
      workflowTask: 'TASK-SCOPE-MARKER-A',
      invalidate: true,
    });
    const dismisslessB = manifestFor({
      authority: 'terminal_adjudication',
      workflowTask: 'TASK-SCOPE-MARKER-B',
      invalidate: true,
    });
    expect(dismisslessA.taskScopeContext).toBeUndefined();
    expect(dismisslessB.taskId).toBe(dismisslessA.taskId);

    const conflictA = manifestFor({
      authority: 'terminal_adjudication',
      workflowTask: 'TASK-SCOPE-MARKER-A',
      conflict: true,
    });
    const conflictB = manifestFor({
      authority: 'terminal_adjudication',
      workflowTask: 'TASK-SCOPE-MARKER-B',
      conflict: true,
    });
    expect(conflictA.taskScopeContext).toBeUndefined();
    expect(conflictB.taskId).toBe(conflictA.taskId);
  });

  it('does not place a terminal workflow task in a dismissless control prompt', async () => {
    const workflowTaskMarker = 'TASK-SCOPE-INPUT-MUST-NOT-APPEAR';
    const workflowTask = workflowTaskMarker
      + 'x'.repeat(MAIN_MANAGER_INPUT_MAX_BYTES + 1);
    executeAgentMock.mockImplementation(async (_persona, instruction) => {
      expect(instruction).toContain('## Control task output override');
      expect(instruction).not.toContain('## Original workflow task');
      expect(instruction).not.toContain(workflowTaskMarker);
      const manifest = sectionJson<ControlManifestView>(
        instruction,
        '## Task manifest',
      );
      return response({
        taskId: manifest.taskId,
        evaluations: manifest.candidateIntents.map((intent) => ({
          intentId: intent.intentId,
          result: { kind: 'no_action', reason: 'No action required' },
        })),
        selectedIntentId: null,
      });
    });

    const result = await runMainManagerTasks({
      contract,
      previousLedger: emptyLedger({ findings: [ledgerFinding(1)] }),
      reviewScopeSnapshotId: 'scope-test',
      residualRawFindings: [],
      mechanicallyClassifiedCount: 0,
      priorStepResponseText: undefined,
      invalidLocationCandidates: new Map([['F-0001', 'invalid location']]),
      dismissCandidates: new Map(),
      evidenceRecordsByRawFindingId: new Map(),
      managerStep,
      runInput,
      managerAuthority: 'terminal_adjudication',
      workflowTask,
      subResults: [],
    });

    expect(result.taskAudits).toMatchObject([{ status: 'succeeded' }]);
  });

  it.each([
    {
      name: 'accepts a GitLab claim as outside a GitHub-only terminal task',
      authority: 'terminal_adjudication' as const,
      workflowTask: 'Support GitHub issue attachments.',
      taskQuote: 'GitHub issue attachments',
      accepted: true,
    },
    {
      name: 'rejects outside_task_scope under standard authority',
      authority: 'standard' as const,
      workflowTask: 'Support GitHub issue attachments.',
      taskQuote: 'GitHub issue attachments',
      accepted: false,
    },
    {
      name: 'rejects a taskQuote that is not byte-exact',
      authority: 'terminal_adjudication' as const,
      workflowTask: 'Support GitHub issue attachments.',
      taskQuote: 'Support GitLab issue attachments.',
      accepted: false,
    },
  ])('$name', async ({ authority, workflowTask, taskQuote, accepted }) => {
    executeAgentMock.mockImplementation(async (_persona, instruction) => {
      expect(instruction).toContain('## Control task output override');
      expect(instruction).toContain(
        'Return exactly one object whose only top-level fields are taskId, evaluations, and selectedIntentId.',
      );
      expect(instruction).toContain(
        'Do not return rawDecisions, dismissDecisions, or any other legacy envelope field.',
      );
      expect(instruction).toContain(
        '{"kind":"dismiss","findingId":"<intent entityId>","basis":"outside_task_scope"',
      );
      if (authority === 'terminal_adjudication') {
        expect(instruction).toContain('## Original workflow task');
        expect(instruction).toContain(workflowTask);
      } else {
        expect(instruction).not.toContain('## Original workflow task');
        expect(instruction).not.toContain(workflowTask);
      }
      const manifest = sectionJson<ControlManifestView>(
        instruction as string,
        '## Task manifest',
      );
      const intent = manifest.candidateIntents[0]!;
      return response({
        taskId: manifest.taskId,
        evaluations: [{
          intentId: intent.intentId,
          result: {
            kind: 'dismiss',
            findingId: intent.entityId,
            basis: 'outside_task_scope',
            reason: 'The finding concerns GitLab, outside this GitHub-only task.',
            taskQuote,
          },
        }],
        selectedIntentId: intent.intentId,
      });
    });

    const result = await runMainManagerTasks({
      contract,
      previousLedger: emptyLedger({
        findings: [{
          ...ledgerFinding(1),
          title: 'GitLab attachment support is missing',
        }],
      }),
      reviewScopeSnapshotId: 'scope-test',
      residualRawFindings: [],
      mechanicallyClassifiedCount: 0,
      priorStepResponseText: undefined,
      invalidLocationCandidates: new Map(),
      dismissCandidates: new Map([['F-0001', 'terminal claim']]),
      evidenceRecordsByRawFindingId: new Map(),
      managerStep,
      runInput,
      managerAuthority: authority,
      workflowTask,
      subResults: [],
    });

    expect(result.decisions.dismissDecisions).toHaveLength(accepted ? 1 : 0);
    expect(result.taskAudits[0]?.status).toBe(accepted ? 'succeeded' : 'failed');
  });

  it('retains a GitLab claim when the workflow task requests both GitHub and GitLab', async () => {
    executeAgentMock.mockImplementation(async (_persona, instruction) => {
      const manifest = sectionJson<ControlManifestView>(
        instruction as string,
        '## Task manifest',
      );
      return response({
        taskId: manifest.taskId,
        evaluations: manifest.candidateIntents.map((intent) => ({
          intentId: intent.intentId,
          result: {
            kind: 'no_action',
            reason: 'GitLab is explicitly within the original task.',
          },
        })),
        selectedIntentId: null,
      });
    });
    const result = await runMainManagerTasks({
      contract,
      previousLedger: emptyLedger({ findings: [ledgerFinding(1)] }),
      reviewScopeSnapshotId: 'scope-test',
      residualRawFindings: [],
      mechanicallyClassifiedCount: 0,
      priorStepResponseText: undefined,
      invalidLocationCandidates: new Map(),
      dismissCandidates: new Map([['F-0001', 'terminal claim']]),
      evidenceRecordsByRawFindingId: new Map(),
      managerStep,
      runInput,
      managerAuthority: 'terminal_adjudication',
      workflowTask: 'Support GitHub and GitLab issue attachments.',
      subResults: [],
    });

    expect(result.decisions.dismissDecisions).toEqual([]);
    expect(result.taskAudits[0]?.status).toBe('succeeded');
  });

  it('rejects a raw task atomically when exact cover is missing', async () => {
    const shared = {
      title: 'Shared issue',
      description: 'The same semantic claim',
      target: { kind: 'code' as const, paths: ['src/shared.ts'] },
    };
    const raws = [rawFinding(1, shared), rawFinding(2, shared)];
    executeAgentMock.mockImplementation(async (_persona, instruction) => {
      const manifest = sectionJson<RawManifestView>(instruction, '## Task manifest');
      const first = manifest.rawFindings[0]!;
      return response({
        taskId: manifest.taskId,
        decisions: [{
          rawFindingId: first.rawFindingId,
          componentId: first.componentId,
          decision: 'new',
          findingId: '',
          evidence: 'partial output',
        }],
      });
    });

    const result = await run(raws);

    expect(result.decisions.rawDecisions).toEqual([]);
    expect([...result.rawFailures.keys()].sort()).toEqual(['raw-001', 'raw-002']);
    expect(result.taskAudits).toMatchObject([{ status: 'failed' }]);
  });

  it('preserves successful tasks when another provider task fails', async () => {
    executeAgentMock
      .mockRejectedValueOnce(new Error('provider unavailable'))
      .mockImplementation(async (_persona, instruction) => (
        successfulRawResponse(instruction)
      ));

    const raws = Array.from({ length: 17 }, (_, index) => rawFinding(index + 1));
    const result = await run(raws);

    expect(result.rawFailures.size).toBe(16);
    expect(result.rawFailures.has('raw-017')).toBe(false);
    expect(result.decisions.rawDecisions.map((item) => item.rawFindingId))
      .toEqual(['raw-017']);
    expect(result.taskAudits.map((audit) => audit.status))
      .toEqual(['failed', 'succeeded']);
  });

  it('rejects an entire component when split tasks return incompatible outcomes', async () => {
    const shared = {
      title: 'One semantic issue',
      description: 'One semantic description',
      target: { kind: 'code' as const, paths: ['src/one.ts'] },
    };
    const componentRaws = Array.from(
      { length: 17 },
      (_, index) => rawFinding(index + 1, shared),
    );
    const unrelated = rawFinding(999);
    const raws = [...componentRaws, unrelated];
    let call = 0;
    executeAgentMock.mockImplementation(async (_persona, instruction) => {
      call += 1;
      const manifest = sectionJson<RawManifestView>(instruction, '## Task manifest');
      return response({
        taskId: manifest.taskId,
        decisions: manifest.rawFindings.map((raw) => ({
          rawFindingId: raw.rawFindingId,
          componentId: raw.componentId,
          decision: raw.rawFindingId === unrelated.rawFindingId
            ? 'new'
            : call === 1 ? 'new' : 'conflict',
          findingId: raw.rawFindingId === unrelated.rawFindingId || call === 1
            ? ''
            : 'F-0001',
          evidence: 'component decision',
        })),
      });
    });

    const result = await run(raws);

    expect(executeAgentMock).toHaveBeenCalledTimes(2);
    expect(result.decisions.rawDecisions.map((decision) => decision.rawFindingId))
      .toEqual([unrelated.rawFindingId]);
    expect(result.rawFailures.size).toBe(17);
    expect(result.invalidAttemptMessages.join('\n')).toContain('incompatible cross-task outcomes');
  });

  it('accepts explicit control no_action as a complete task result', async () => {
    const finding = ledgerFinding(1);
    const conflict: FindingLedgerConflict = {
      id: 'C-0001',
      status: 'active',
      findingIds: ['F-0001'],
      rawFindingIds: [],
      description: 'Needs more evidence',
      firstSeen: finding.firstSeen,
      lastSeen: finding.lastSeen,
      revision: 1,
    };
    executeAgentMock.mockImplementation(async (_persona, instruction) => {
      expect(instruction).not.toContain('## Original workflow task');
      expect(instruction).not.toContain('## Relevant current review report excerpts');
      const manifest = sectionJson<ControlManifestView>(instruction, '## Task manifest');
      return response({
        taskId: manifest.taskId,
        evaluations: manifest.candidateIntents.map((intent) => ({
          intentId: intent.intentId,
          result: { kind: 'no_action', reason: 'Insufficient evidence' },
        })),
        selectedIntentId: null,
      });
    });

    const result = await run([], emptyLedger({
      nextId: 2,
      findings: [finding],
      conflicts: [conflict],
    }));

    expect(result.decisions).toEqual({
      rawDecisions: [],
      disputeDecisions: [],
      conflictDecisions: [],
      invalidateDecisions: [],
      duplicateDecisions: [],
      dismissDecisions: [],
    });
    expect(result.taskAudits).toMatchObject([{
      taskKind: 'conflict',
      status: 'succeeded',
      output: {
        evaluations: [{
          result: { kind: 'no_action' },
        }],
        selectedIntentId: null,
      },
    }]);
  });

  it('drains more than 64 raw tasks without a per-step call cap', async () => {
    executeAgentMock.mockImplementation(async (_persona, instruction) => {
      expect(instruction).toContain(PROVIDER_ANCHOR_RELEVANCE_INSTRUCTION);
      return successfulRawResponse(instruction);
    });
    const raws = Array.from({ length: 65 }, (_, index) => rawFinding(index + 1));

    const result = await run(raws);

    expect(executeAgentMock).toHaveBeenCalledTimes(5);
    expect(result.decisions.rawDecisions).toHaveLength(65);
    expect(result.decisions.rawDecisions.every(
      (decision) => decision.anchorRelevance === 'not_applicable',
    )).toBe(true);
    expect(result.rawFailures.size).toBe(0);
    expect(result.taskAudits).toHaveLength(5);
  });

  it('splits oversized multi-raw input and never sends more than 24KB', async () => {
    const shared = {
      title: 'Large shared issue',
      description: `Large semantic body ${'x'.repeat(1_800)}`,
      target: { kind: 'code' as const, paths: ['src/large.ts'] },
    };
    const raws = Array.from({ length: 16 }, (_, index) => rawFinding(index + 1, shared));
    const sentBytes: number[] = [];
    executeAgentMock.mockImplementation(async (_persona, instruction) => {
      sentBytes.push(Buffer.byteLength(instruction, 'utf8'));
      return successfulRawResponse(instruction);
    });

    const result = await run(raws);

    expect(executeAgentMock.mock.calls.length).toBeGreaterThan(1);
    expect(Math.max(...sentBytes)).toBeLessThanOrEqual(MAIN_MANAGER_INPUT_MAX_BYTES);
    expect(result.decisions.rawDecisions).toHaveLength(16);
    expect(result.rawFailures.size).toBe(0);
  });

  it('lands a single irreducible oversized raw as manager-input-overflow without calling the provider', async () => {
    const raw = rawFinding(1, {
      description: `Irreducible ${'x'.repeat(30_000)}`,
    });

    const result = await run([raw]);

    expect(executeAgentMock).not.toHaveBeenCalled();
    expect(result.rawFailures.get(raw.rawFindingId)?.kind)
      .toBe('manager-input-overflow');
    expect(result.taskAudits).toMatchObject([{ status: 'input_overflow' }]);
  });

  it('creates the same finite manifest regardless of input order', () => {
    const raws = Array.from({ length: 20 }, (_, index) => rawFinding(index + 1));
    const forward = createMainManagerRawTaskManifest({
      previousLedger: emptyLedger(),
      residualRawFindings: raws,
    });
    const reversed = createMainManagerRawTaskManifest({
      previousLedger: emptyLedger(),
      residualRawFindings: [...raws].reverse(),
    });

    expect(forward.map((item) => ({
      taskId: item.task.taskId,
      ids: item.task.ownedRawFindingIds,
    }))).toEqual(reversed.map((item) => ({
      taskId: item.task.taskId,
      ids: item.task.ownedRawFindingIds,
    })));
  });

  it('keeps distinct semantic claims for the same target in separate components across the 16-item boundary', () => {
    const raws = Array.from({ length: 17 }, (_, index) => rawFinding(index + 1, {
      relation: 'persists',
      targetFindingId: 'F-0001',
      title: `Targeted claim ${index + 1}`,
      description: `Distinct targeted semantic claim ${index + 1}`,
    }));

    const manifest = createMainManagerRawTaskManifest({
      previousLedger: emptyLedger(),
      residualRawFindings: raws,
    });
    const componentIds = manifest.flatMap((item) => (
      [...item.task.componentIdByRawFindingId.values()]
    ));

    expect(manifest.map((item) => item.task.ownedRawFindingIds.length))
      .toEqual([16, 1]);
    expect(new Set(componentIds).size).toBe(17);
  });

  it('keeps different relation intents separate when one semantic claim spans split tasks', async () => {
    const shared = {
      targetFindingId: 'F-0001',
      title: 'One target claim',
      description: 'The same semantic target claim.',
      target: { kind: 'code' as const, paths: ['src/relation-target.ts'] },
    };
    const persists = Array.from({ length: 17 }, (_, index) => rawFinding(
      index + 1,
      { ...shared, relation: 'persists' },
    ));
    const confirmations = Array.from({ length: 17 }, (_, index) => rawFinding(
      index + 101,
      { ...shared, relation: 'resolution_confirmation' },
    ));
    executeAgentMock.mockImplementation(async (_persona, instruction) => {
      const manifest = sectionJson<RawManifestView>(instruction, '## Task manifest');
      return response({
        taskId: manifest.taskId,
        decisions: manifest.rawFindings.map((raw) => ({
          rawFindingId: raw.rawFindingId,
          componentId: raw.componentId,
          decision: Number(raw.rawFindingId.slice(4)) >= 101 ? 'resolved' : 'same',
          findingId: 'F-0001',
          evidence: 'relation-specific decision',
        })),
      });
    });

    const result = await run(
      [...persists, ...confirmations],
      emptyLedger({ findings: [ledgerFinding(1)] }),
    );

    const initialManifest = createMainManagerRawTaskManifest({
      previousLedger: emptyLedger({ findings: [ledgerFinding(1)] }),
      residualRawFindings: [...persists, ...confirmations],
    });
    expect(initialManifest.map((item) => item.task.ownedRawFindingIds.length))
      .toEqual([16, 1, 16, 1]);
    expect(executeAgentMock).toHaveBeenCalledTimes(result.taskAudits.length);
    expect(executeAgentMock.mock.calls[0]?.[1]).toContain(
      'the original finding failure mode and required fix are actually satisfied',
    );
    expect(executeAgentMock.mock.calls[0]?.[1]).toContain(
      'A valid quote at the same path, or a valid quote by itself, is not evidence of semantic resolution',
    );
    expect(result.decisions.rawDecisions).toHaveLength(34);
    expect(result.rawFailures.size).toBe(0);
  });

  it('provides the original finding in full detail and does not resolve from a valid but semantically unrelated quote', async () => {
    const original = rawFinding(1, {
      target: { kind: 'code', paths: ['src/original.ts'] },
      description: 'The error branch leaks the acquired handle.',
      suggestion: 'Release the handle on every error branch.',
      evidence: [{
        kind: 'file_quote',
        path: 'src/original.ts',
        startLine: 10,
        endLine: 10,
        verbatimExcerpt: 'return withoutReleasing(handle);',
        snapshotId: 'a'.repeat(64),
      }],
    });
    const finding: FindingLedgerEntry = {
      ...ledgerFinding(1),
      target: original.target,
      targetIdentityHash: original.targetIdentityHash,
      claimIdentityHash: original.claimIdentityHash,
      semanticClaimIdentityHash: original.semanticClaimIdentityHash,
      description: original.description ?? undefined,
      suggestion: original.suggestion ?? undefined,
      rawFindingIds: [original.rawFindingId],
    };
    const confirmation = rawFinding(2, {
      relation: 'resolution_confirmation',
      targetFindingId: finding.id,
      target: original.target,
      title: 'Nearby cleanup refactor landed',
      description: 'A nearby helper was renamed at the same path.',
      evidence: [{
        kind: 'file_quote',
        path: 'src/original.ts',
        startLine: 20,
        endLine: 20,
        verbatimExcerpt: 'const renamedHelper = true;',
        snapshotId: 'a'.repeat(64),
      }],
    });
    executeAgentMock.mockImplementationOnce(async (_persona, instruction) => {
      const manifest = sectionJson<RawManifestView>(instruction, '## Task manifest');
      const ledger = sectionJson<{
        findings: Array<{
          id: string;
          description?: string;
          suggestion?: string;
          target: unknown;
          rawFindings?: Array<{ evidenceDetails: Array<{ verbatimExcerpt?: string }> }>;
        }>;
      }>(instruction, '## Relevant ledger projection');
      expect(ledger.findings).toEqual([expect.objectContaining({
        id: 'F-0001',
        description: 'The error branch leaks the acquired handle.',
        suggestion: 'Release the handle on every error branch.',
        target: { kind: 'code', paths: ['src/original.ts'] },
        rawFindings: [expect.objectContaining({
          evidenceDetails: [expect.objectContaining({
            verbatimExcerpt: 'return withoutReleasing(handle);',
          })],
        })],
      })]);
      return response({
        taskId: manifest.taskId,
        decisions: [{
          rawFindingId: confirmation.rawFindingId,
          componentId: manifest.rawFindings[0]!.componentId,
          decision: 'same',
          findingId: finding.id,
          evidence: 'The valid quote does not address the original failure mode or required fix.',
        }],
      });
    });

    const result = await run([confirmation], emptyLedger({
      findings: [finding],
      rawFindings: [original],
    }));

    expect(result.decisions.rawDecisions).toEqual([expect.objectContaining({
      rawFindingId: confirmation.rawFindingId,
      decision: 'same',
      findingId: finding.id,
    })]);
    expect(result.decisions.rawDecisions.some((decision) => decision.decision === 'resolved'))
      .toBe(false);
  });

  it('assigns every finding control candidate to one unique task without priority dropping', () => {
    const finding = ledgerFinding(1);
    const tasks = createMainManagerControlTaskManifest({
      previousLedger: emptyLedger({ findings: [finding] }),
      reviewScopeSnapshotId: 'scope-test',
      priorStepResponseText:
        '## Disputed Findings\n- findingId: F-0001\n  reason: stale\n  evidence: src/a.ts:10',
      invalidLocationCandidates: new Map([['F-0001', 'missing location']]),
      dismissCandidates: new Map([['F-0001', 'expired provisional']]),
      managerAuthority: 'standard',
      workflowTask: 'Review the requested implementation.',
      subResults: [],
    });

    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.task.ownedEntityIds).toEqual(['F-0001']);
    expect(tasks[0]!.task.candidateIntents.map((intent) => intent.kind).sort())
      .toEqual(['dismiss', 'dispute', 'invalidate']);
  });

  it.each(['missing', 'duplicate'] as const)(
    'rejects a multi-intent control task with %s intent coverage',
    async (mode) => {
      const finding = ledgerFinding(1);
      executeAgentMock.mockImplementation(async (_persona, instruction) => {
        const manifest = sectionJson<ControlManifestView>(
          instruction,
          '## Task manifest',
        );
        const intents = mode === 'missing'
          ? manifest.candidateIntents.slice(0, -1)
          : [
              ...manifest.candidateIntents,
              manifest.candidateIntents[0]!,
            ];
        return response({
          taskId: manifest.taskId,
          evaluations: intents.map((intent) => ({
            intentId: intent.intentId,
            result: { kind: 'no_action', reason: 'Not selected' },
          })),
          selectedIntentId: null,
        });
      });

      const result = await runMainManagerTasks({
        contract,
        previousLedger: emptyLedger({ findings: [finding] }),
        reviewScopeSnapshotId: 'scope-test',
        residualRawFindings: [],
        mechanicallyClassifiedCount: 0,
        priorStepResponseText:
          '## Disputed Findings\n- findingId: F-0001\n  reason: stale\n  evidence: src/a.ts:10',
        invalidLocationCandidates: new Map([['F-0001', 'missing location']]),
        dismissCandidates: new Map([['F-0001', 'expired provisional']]),
        evidenceRecordsByRawFindingId: new Map(),
        managerStep,
        runInput,
        managerAuthority: 'standard',
        workflowTask: 'Review the requested implementation.',
        subResults: [],
      });

      expect(result.taskAudits).toMatchObject([{
        taskKind: 'finding_control',
        status: 'failed',
      }]);
      expect(result.decisions.disputeDecisions).toEqual([]);
      expect(result.decisions.invalidateDecisions).toEqual([]);
      expect(result.decisions.dismissDecisions).toEqual([]);
    },
  );

  it.each(['multiple_actions', 'selected_mismatch'] as const)(
    'rejects a multi-intent control task with %s',
    async (mode) => {
      const finding = ledgerFinding(1);
      executeAgentMock.mockImplementation(async (_persona, instruction) => {
        const manifest = sectionJson<ControlManifestView>(
          instruction,
          '## Task manifest',
        );
        const dispute = manifest.candidateIntents.find(
          (intent) => intent.kind === 'dispute',
        )!;
        const invalidate = manifest.candidateIntents.find(
          (intent) => intent.kind === 'invalidate',
        )!;
        return response({
          taskId: manifest.taskId,
          evaluations: manifest.candidateIntents.map((intent) => ({
            intentId: intent.intentId,
            result: intent.intentId === dispute.intentId
              ? {
                  kind: 'note',
                  findingId: intent.entityId,
                  reason: 'Keep the note.',
                  evidence: 'Independent evidence.',
                }
              : mode === 'multiple_actions'
                && intent.intentId === invalidate.intentId
                ? {
                    kind: 'invalidate',
                    findingId: intent.entityId,
                    evidence: 'Invalid location.',
                  }
                : { kind: 'no_action', reason: 'Not selected' },
          })),
          selectedIntentId: mode === 'selected_mismatch'
            ? invalidate.intentId
            : dispute.intentId,
        });
      });

      const result = await runMainManagerTasks({
        contract,
        previousLedger: emptyLedger({ findings: [finding] }),
        reviewScopeSnapshotId: 'scope-test',
        residualRawFindings: [],
        mechanicallyClassifiedCount: 0,
        priorStepResponseText:
          '## Disputed Findings\n- findingId: F-0001\n  reason: stale\n  evidence: src/a.ts:10',
        invalidLocationCandidates: new Map([['F-0001', 'missing location']]),
        dismissCandidates: new Map(),
        evidenceRecordsByRawFindingId: new Map(),
        managerStep,
        runInput,
        managerAuthority: 'standard',
        workflowTask: 'Review the requested implementation.',
        subResults: [],
      });

      expect(result.taskAudits).toMatchObject([{ status: 'failed' }]);
      expect(result.decisions.disputeDecisions).toEqual([]);
      expect(result.decisions.invalidateDecisions).toEqual([]);
    },
  );

  it('audits a fully rendered oversized control task without calling the provider', async () => {
    const finding = {
      ...ledgerFinding(1),
      title: `Oversized control ${'x'.repeat(30_000)}`,
    };

    const result = await runMainManagerTasks({
      contract,
      previousLedger: emptyLedger({ findings: [finding] }),
      reviewScopeSnapshotId: 'scope-test',
      residualRawFindings: [],
      mechanicallyClassifiedCount: 0,
      priorStepResponseText: undefined,
      invalidLocationCandidates: new Map([['F-0001', 'missing location']]),
      dismissCandidates: new Map(),
      evidenceRecordsByRawFindingId: new Map(),
      managerStep,
      runInput,
      managerAuthority: 'standard',
      workflowTask: 'Review the requested implementation.',
      subResults: [],
    });

    expect(executeAgentMock).not.toHaveBeenCalled();
    expect(result.taskAudits).toMatchObject([{
      taskKind: 'finding_control',
      status: 'input_overflow',
    }]);
  });

  it('does not create fuzzy same-locus duplicate control tasks', () => {
    const findings = Array.from({ length: 17 }, (_, index) => ({
      ...ledgerFinding(index + 1),
      target: { kind: 'code' as const, paths: ['src/same-locus.ts'] },
    }));

    const tasks = createMainManagerControlTaskManifest({
      previousLedger: emptyLedger({ findings }),
      reviewScopeSnapshotId: 'scope-test',
      priorStepResponseText: undefined,
      invalidLocationCandidates: new Map(),
      dismissCandidates: new Map(),
      managerAuthority: 'standard',
      workflowTask: 'Review the requested implementation.',
      subResults: [],
    });

    expect(tasks).toEqual([]);
  });

  it('keeps rendered input invariant when thousands of irrelevant findings exist', async () => {
    executeAgentMock.mockImplementation(async (_persona, instruction) => (
      successfulRawResponse(instruction)
    ));
    const raw = rawFinding(1, {
      target: { kind: 'code', paths: ['src/current-only.ts'] },
    });

    const baseline = await run([raw], emptyLedger());
    executeAgentMock.mockClear();
    const irrelevantFindings = Array.from(
      { length: 2_000 },
      (_, index) => ledgerFinding(index + 10_000),
    );
    const crowded = await run([raw], emptyLedger({
      nextId: 20_001,
      findings: irrelevantFindings,
    }));

    expect(baseline.taskAudits[0]?.status).toBe('succeeded');
    expect(crowded.taskAudits[0]?.status).toBe('succeeded');
    if (
      baseline.taskAudits[0]?.status === 'succeeded'
      && crowded.taskAudits[0]?.status === 'succeeded'
    ) {
      expect(crowded.taskAudits[0].inputBytes)
        .toBe(baseline.taskAudits[0].inputBytes);
    }
  });

  it('round-trips task audits through the existing validation report schema', () => {
    const report: FindingManagerValidationReport = {
      version: 1,
      runId: 'run',
      stepName: 'reviewers',
      retryCount: 0,
      ledgerUpdated: true,
      finalErrors: [],
      attempts: [],
      managerTaskAudits: [{
        taskId: 'a'.repeat(64),
        taskKind: 'raw',
        ownedIds: ['raw-002', 'raw-001'],
        status: 'succeeded',
        inputBytes: 1_024,
        output: {
          taskId: 'a'.repeat(64),
          decisions: [],
        },
      }],
    };

    const serialized = serializeFindingManagerValidationReport(report);
    const parsed = parseFindingManagerValidationReport(JSON.parse(serialized));

    expect(parsed.managerTaskAudits).toEqual([{
      ...report.managerTaskAudits![0],
      ownedIds: ['raw-001', 'raw-002'],
    }]);
  });
});

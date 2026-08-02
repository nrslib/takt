import { describe, expect, it, vi } from 'vitest';
import type { FindingLedger, FindingLedgerEntry } from '../core/workflow/findings/types.js';
import type { WorkflowState, WorkflowStep } from '../core/models/types.js';
import {
  createSharedRuntime,
  createWorkflowEngineServices,
} from '../core/workflow/engine/WorkflowEngineSetup.js';
import { createStructuredOutputNormalizerRegistry } from '../core/workflow/engine/structured-output-normalizer.js';
import { buildRunPaths } from '../core/workflow/run/run-paths.js';

function makeFinding(
  id: string,
  status: FindingLedgerEntry['status'],
): FindingLedgerEntry {
  return {
    id,
    status,
    lifecycle: status === 'open' ? 'new' : status,
    severity: 'high',
    title: `${status} finding`,
    reviewers: ['reviewer'],
    rawFindingIds: [],
    firstSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-08-01T00:00:00.000Z' },
    lastSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-08-01T00:00:00.000Z' },
    revision: 1,
  };
}

function makePendingLedger(): FindingLedger {
  return {
    workflowName: 'peer-review',
    nextId: 1,
    updatedAt: '2026-08-01T00:00:00.000Z',
    findings: [],
    rawFindings: [],
    conflicts: [],
    interpretations: [],
    pendingManagerCommit: {
      roundMarker: 'round-1',
      publication: {
        publicationId: 'a'.repeat(64),
        domainId: 'b'.repeat(64),
        originRunId: 'run-1',
        destinationRunId: 'run-1',
        fileName: 'findings-manager-validation.reviewers.json',
        contentSha256: 'c'.repeat(64),
        report: {
          version: 1,
          runId: 'run-1',
          stepName: 'reviewers',
          retryCount: 0,
          ledgerUpdated: true,
          finalErrors: [],
          attempts: [],
        },
      },
      completed: {
        nextId: 4,
        updatedAt: '2026-08-01T00:01:00.000Z',
        findings: [
          makeFinding('F-0001', 'open'),
          makeFinding('F-0002', 'waived'),
          makeFinding('F-0003', 'dismissed'),
        ],
        rawFindings: [],
        conflicts: [],
        interpretations: [],
      },
    },
  };
}

describe('WorkflowEngineSetup finding instruction context', () => {
  it('uses one pending manager projection for every ledger view and state flag', () => {
    const cwd = process.cwd();
    const runPaths = buildRunPaths(cwd, 'finding-context-test');
    const step: WorkflowStep = {
      name: 'fix',
      persona: 'personas/fixer.md',
      instruction: 'Fix findings',
      rules: [],
    };
    const state: WorkflowState = {
      workflowName: 'test-workflow',
      currentStep: step.name,
      iteration: 1,
      stepOutputs: new Map(),
      structuredOutputs: new Map(),
      systemContexts: new Map(),
      effectResults: new Map(),
      userInputs: [],
      personaSessions: new Map(),
      stepIterations: new Map(),
      restoredStepIterationNames: new Set(),
      dynamicParallelSelections: new Map(),
      resumedDynamicParallelSteps: new Set(),
      status: 'running',
    };
    const services = createWorkflowEngineServices({
      config: {
        name: 'test-workflow',
        initialStep: step.name,
        maxSteps: 10,
        steps: [step],
      },
      state,
      task: 'test task',
      projectCwd: cwd,
      getCwd: () => cwd,
      getReportDir: () => runPaths.reportsRel,
      getRunPaths: () => runPaths,
      getMaxSteps: () => 10,
      options: {
        projectCwd: cwd,
        structuredOutputNormalizers: createStructuredOutputNormalizerRegistry([]),
      },
      structuredCaller: {
        evaluateCondition: vi.fn(),
        judgeStatus: vi.fn(),
        decomposeTask: vi.fn(),
        requestMoreParts: vi.fn(),
      },
      sharedRuntime: createSharedRuntime(undefined, 10),
      resumeStackPrefix: [],
      runPaths,
      updateMaxSteps: vi.fn(),
      setActiveResumePoint: vi.fn(),
      persistDynamicParallelSelection: vi.fn(),
      refreshFindingsState: vi.fn(),
      findingContract: {} as never,
      findingLedgerStore: {
        loadLedger: () => makePendingLedger(),
      } as never,
      updatePersonaSession: vi.fn(),
      resolveNextStepFromDone: vi.fn(),
      resetCycleDetector: vi.fn(),
      emitEvent: vi.fn(),
      createEngine: vi.fn(),
    });

    const context = services.optionsBuilder.buildFindingContractInstructionContext(step, false);
    expect(context).toBeDefined();
    const ledgerSummary = JSON.parse(String(context?.ledgerSummary)) as {
      open: Array<{ id: string }>;
      waived: Array<{ id: string }>;
      dismissed: Array<{ id: string }>;
    };
    const reportSummary = JSON.parse(String(context?.reportLedgerSummary)) as {
      openFindingIds: string[];
      waivedFindings: Array<{ id: string }>;
      dismissedFindingIds: string[];
    };
    expect(ledgerSummary.open.map(({ id }) => id)).toEqual(['F-0001']);
    expect(ledgerSummary.waived.map(({ id }) => id)).toEqual(['F-0002']);
    expect(ledgerSummary.dismissed.map(({ id }) => id)).toEqual(['F-0003']);
    expect(reportSummary.openFindingIds).toEqual(['F-0001']);
    expect(reportSummary.waivedFindings.map(({ id }) => id)).toEqual(['F-0002']);
    expect(reportSummary.dismissedFindingIds).toEqual(['F-0003']);
    expect(context).toMatchObject({
      hasOpenFindings: true,
      hasWaivedFindings: true,
      hasDismissedFindings: true,
    });
  });
});

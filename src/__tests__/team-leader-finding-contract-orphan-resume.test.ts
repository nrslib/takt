import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentResponse,
  PartDefinition,
  PartResult,
  WorkflowState,
  WorkflowStep,
} from '../core/models/types.js';
import { TeamLeaderRunner } from '../core/workflow/engine/TeamLeaderRunner.js';
import {
  FindingContractOperationJournal,
  type FindingContractOperationBoundary,
  type FindingContractWorkerBoundaryRequest,
} from '../core/workflow/engine/team-leader-finding-contract-operation-journal.js';
import {
  ManualRestartRequiredError,
  OperationRecoveryBlockedError,
} from '../core/workflow/operations/operation-recovery-error.js';
import { buildRunPaths } from '../core/workflow/run/run-paths.js';
import { createOperationJournalStore } from '../infra/workflow/operation-journal-store.js';

const { executeAgentMock } = vi.hoisted(() => ({ executeAgentMock: vi.fn() }));

vi.mock('../agents/agent-usecases.js', () => ({
  executeAgent: executeAgentMock,
}));

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
  vi.clearAllMocks();
});

const PART: PartDefinition = {
  id: 'p1',
  title: 'Repair finding',
  instruction: 'Repair the assigned finding',
  findingContract: {
    findingIds: ['F-0001'],
    role: 'repair',
    readPaths: ['src/fix.ts'],
  },
};

const STEP: WorkflowStep = {
  name: 'fix',
  persona: 'coder',
  personaDisplayName: 'coder',
  instruction: 'Fix findings',
  edit: true,
  teamLeader: {
    mode: 'finding_contract_fix',
    maxConcurrency: 1,
    timeoutMs: 1_000,
    partPersona: 'coder',
    partEdit: true,
    partPermissionMode: 'edit',
  },
};

function makeState(): WorkflowState {
  return {
    workflowName: 'workflow',
    currentStep: 'fix',
    iteration: 1,
    stepOutputs: new Map(),
    structuredOutputs: new Map(),
    systemContexts: new Map(),
    effectResults: new Map(),
    lastOutput: undefined,
    previousResponseSourcePath: undefined,
    userInputs: [],
    personaSessions: new Map(),
    stepIterations: new Map(),
    status: 'running',
  };
}

function request(): FindingContractWorkerBoundaryRequest {
  if (PART.findingContract === undefined) {
    throw new Error('Test part is missing its Finding Contract assignment');
  }
  return {
    partId: PART.id,
    title: PART.title,
    instruction: PART.instruction,
    findingAssignment: PART.findingContract,
  };
}

function seedSuccessor(): {
  readonly cwd: string;
  readonly boundary: FindingContractOperationBoundary;
} {
  const cwd = mkdtempSync(join(tmpdir(), 'takt-orphan-worker-resume-'));
  temporaryDirectories.push(cwd);
  const paths = buildRunPaths(cwd, 'run-a');
  const openJournal = (
    claimToken: string,
    sourceClaimToken?: string,
  ) => FindingContractOperationJournal.open({
    context: {
      store: createOperationJournalStore(paths.operationJournalAbs),
      journalRunSlug: paths.slug,
      claimToken,
      ...(sourceClaimToken === undefined ? {} : { sourceClaimToken }),
    },
    workflowName: 'workflow',
    stepName: 'fix',
    stepIteration: 1,
    executionScope: { runPathNamespace: [], workflowStack: [] },
  });
  const predecessor = openJournal('claim-a');
  predecessor.boundary(
    'part:p1:completion',
    'finding_contract_part_completion',
    request(),
  ).markWorkerStarted('edit');
  predecessor.terminate(new ManualRestartRequiredError(
    'Worker boundary "part:p1:completion" stopped after dispatch and before its result was journaled',
    { boundaryId: 'part:p1:completion' },
  ));
  const successor = openJournal('claim-b', 'claim-a');
  return {
    cwd,
    boundary: successor.boundary(
      'part:p1:completion',
      'finding_contract_part_completion',
      request(),
    ),
  };
}

function createRunner(cwd: string): TeamLeaderRunner {
  const state = makeState();
  return new TeamLeaderRunner({
    optionsBuilder: {
      buildAgentOptions: vi.fn(() => ({
        cwd,
        sessionId: 'stale-worker-session',
        resolvedProvider: 'mock',
        resolvedModel: 'mock-model',
      })),
      resolveStepProviderModel: vi.fn(() => ({ provider: 'mock', model: 'mock-model' })),
    },
    stepExecutor: {
      buildInstruction: vi.fn((step: WorkflowStep) => step.instruction),
      buildPhase1Instruction: vi.fn((instruction: string) => instruction),
    },
    engineOptions: { projectCwd: cwd, language: 'en' },
    getCwd: () => cwd,
    getTask: () => 'task',
    getState: () => state,
    getWorkflowName: () => 'workflow',
    getInteractive: () => false,
    getRunPaths: () => buildRunPaths(cwd, 'run-b'),
    observabilityEnabled: false,
    emitEvent: vi.fn(),
  } as unknown as ConstructorParameters<typeof TeamLeaderRunner>[0]);
}

type RunSinglePart = (
  step: WorkflowStep,
  leaderWorkflowMeta: undefined,
  part: PartDefinition,
  partIndex: number,
  parentIteration: number,
  state: WorkflowState,
  task: string,
  maxSteps: number,
  defaultTimeoutMs: number,
  updatePersonaSession: (persona: string, sessionId: string | undefined) => void,
  parallelLogger: undefined,
  runtime: undefined,
  instructionTransaction: undefined,
  findingContractSummary: string,
  operationBoundary: FindingContractOperationBoundary,
  onFindingContractRecoveryAttempt: undefined,
  executionAbortSignal: undefined,
  publicationFence: undefined,
) => Promise<PartResult>;

function runRecoveredPart(
  runner: TeamLeaderRunner,
  boundary: FindingContractOperationBoundary,
): Promise<PartResult> {
  const runSinglePart = (runner as unknown as { runSinglePart: RunSinglePart }).runSinglePart.bind(runner);
  return runSinglePart(
    STEP,
    undefined,
    PART,
    0,
    1,
    makeState(),
    'task',
    20,
    1_000,
    vi.fn(),
    undefined,
    undefined,
    undefined,
    'F-0001: repair this finding',
    boundary,
    undefined,
    undefined,
    undefined,
  );
}

describe('Finding Contract Team Leader orphan worker resume', () => {
  it('redispatches once with a fresh session and current-worktree reconciliation instruction', async () => {
    const { cwd, boundary } = seedSuccessor();
    const runner = createRunner(cwd);
    let releaseWorker: ((response: AgentResponse) => void) | undefined;
    executeAgentMock.mockImplementationOnce((
      _persona: string,
      _instruction: string,
      options: { onDispatch?: (permissionMode: 'edit') => void },
    ) => new Promise<AgentResponse>((resolve) => {
      options.onDispatch?.('edit');
      releaseWorker = resolve;
    }));

    const firstDispatch = runRecoveredPart(runner, boundary);
    await vi.waitFor(() => expect(executeAgentMock).toHaveBeenCalledOnce());
    await expect(runRecoveredPart(runner, boundary)).rejects.toThrow(ManualRestartRequiredError);
    expect(executeAgentMock).toHaveBeenCalledOnce();
    const [, instruction, options] = executeAgentMock.mock.calls[0] ?? [];
    expect(instruction).toContain('partial edits may remain in the worktree');
    expect(instruction).toContain('perform only the remaining work');
    expect(options).toEqual(expect.objectContaining({ sessionId: undefined }));

    if (releaseWorker === undefined) throw new Error('Worker dispatch did not start');
    releaseWorker({
      persona: 'coder',
      status: 'rate_limited',
      content: 'retry with fallback',
      timestamp: new Date(),
    });
    await expect(firstDispatch).resolves.toMatchObject({ response: { status: 'rate_limited' } });
  });

  it.each(['readonly', 'full', undefined] as const)(
    'blocks an orphan dispatched with effective %s permission before any provider call',
    async (permissionMode) => {
      const { cwd, boundary } = seedSuccessor();
      const runner = createRunner(cwd);
      let providerCalled = false;
      executeAgentMock.mockImplementationOnce((
        _persona: string,
        _instruction: string,
        options: {
          onDispatch?: (
            mode: 'readonly' | 'edit' | 'full' | undefined,
          ) => void;
        },
      ) => {
        options.onDispatch?.(permissionMode);
        providerCalled = true;
      });

      await expect(runRecoveredPart(runner, boundary))
        .rejects.toThrow(OperationRecoveryBlockedError);
      expect(executeAgentMock).toHaveBeenCalledOnce();
      expect(providerCalled).toBe(false);
    },
  );
});

import { describe, expect, it, vi } from 'vitest';
import type { AgentResponse, PartDefinition, WorkflowStep } from '../core/models/types.js';
import type { OptionsBuilder } from '../core/workflow/engine/OptionsBuilder.js';
import type { StepExecutor } from '../core/workflow/engine/StepExecutor.js';
import {
  validateOrRecoverFindingContractPartCompletion,
} from '../core/workflow/engine/team-leader-finding-contract-part-completion-recovery.js';
import type {
  TeamLeaderExecutionTerminalState,
} from '../core/workflow/engine/team-leader-execution-terminal.js';

const { requestCorrectionMock } = vi.hoisted(() => ({
  requestCorrectionMock: vi.fn(),
}));

vi.mock('../core/workflow/engine/team-leader-part-runner.js', () => ({
  buildPartScopedSessionKey: () => 'part-session',
  requestTeamLeaderPartCompletionCorrection: requestCorrectionMock,
}));

const part: PartDefinition = {
  id: 'repair',
  title: 'Repair',
  instruction: 'repair',
  findingContract: {
    findingIds: ['F-0001'],
    role: 'repair',
    readPaths: ['src'],
    writePaths: ['src'],
  },
};

const step: WorkflowStep = {
  name: 'fix',
  persona: 'coder',
  instruction: 'fix',
  teamLeader: {
    mode: 'finding_contract_fix',
    partPersona: 'coder',
  },
};

function response(
  structuredOutput: Record<string, unknown>,
  overrides?: Partial<AgentResponse>,
): AgentResponse {
  return {
    persona: 'coder',
    status: 'done',
    content: JSON.stringify(structuredOutput),
    timestamp: new Date(),
    structuredOutput,
    ...overrides,
  };
}

describe('Finding Contract part completion recovery', () => {
  it('publishes only late usage after the terminal fence closes', async () => {
    const controller = new AbortController();
    let terminalState: TeamLeaderExecutionTerminalState = 'running';
    let resolveCorrection: ((value: AgentResponse) => void) | undefined;
    requestCorrectionMock.mockImplementationOnce(() => new Promise<AgentResponse>((resolve) => {
      resolveCorrection = resolve;
    }));
    const recordUsage = vi.fn();
    const assertRunning = vi.fn((operation: string) => {
      if (terminalState !== 'running') {
        throw new Error(`fenced: ${operation}`);
      }
    });
    const onAttempt = vi.fn();
    const initial = response({
      findingOutcomes: [{
        findingId: 'F-0001',
        outcome: 'disputed',
        evidence: ['missing location'],
      }],
      changedPaths: ['src/repair.ts'],
      checks: [],
      summary: 'repaired',
    }, { sessionId: 'session-a' });
    const normalizeStructuredOutputWithDiagnostics = vi.fn((
      _partStep: WorkflowStep,
      correctionResponse: AgentResponse,
    ) => ({ response: correctionResponse }));
    const recovery = validateOrRecoverFindingContractPartCompletion(
      {
        optionsBuilder: {
          resolveStepProviderModel: vi.fn().mockReturnValue({
            provider: 'mock',
            model: 'mock-model',
          }),
        } as unknown as OptionsBuilder,
        stepExecutor: {
          normalizeStructuredOutputWithDiagnostics,
        } as unknown as StepExecutor,
        language: 'en',
        recordUsage,
      },
      {
        step,
        part,
        response: initial,
        updatePersonaSession: vi.fn(),
        onAttempt,
        abortSignal: controller.signal,
        publicationFence: {
          get state() {
            return terminalState;
          },
          assertRunning,
        },
      },
    );

    await vi.waitFor(() => expect(requestCorrectionMock).toHaveBeenCalledTimes(1));
    const callsBeforeTerminal = assertRunning.mock.calls.length;
    terminalState = 'terminated';
    controller.abort(new Error('terminal sibling'));
    await expect(recovery).rejects.toThrow('terminal sibling');

    resolveCorrection?.(response({
      findingOutcomes: [{
        findingId: 'F-0001',
        outcome: 'disputed',
        evidence: ['src/repair.ts:1'],
      }],
      changedPaths: ['src/repair.ts'],
      checks: [],
      summary: 'repaired',
    }, {
      sessionId: 'late-session',
      providerUsage: { usageMissing: false, totalTokens: 17 },
    }));

    await vi.waitFor(() => expect(recordUsage).toHaveBeenCalledTimes(1));
    expect(recordUsage).toHaveBeenCalledWith(
      'fix.repair',
      { provider: 'mock', model: 'mock-model' },
      false,
      { usageMissing: false, totalTokens: 17 },
    );
    expect(assertRunning).toHaveBeenCalledTimes(callsBeforeTerminal);
    expect(onAttempt.mock.calls.flatMap(([event]) => event.type)).not.toContain('late');
  });
});

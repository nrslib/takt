import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TeamLeaderRunner } from '../core/piece/engine/TeamLeaderRunner.js';
import type { PieceMovement, PieceState } from '../core/models/types.js';

const {
  mockExecuteAgent,
} = vi.hoisted(() => ({
  mockExecuteAgent: vi.fn(),
}));

vi.mock('../agents/agent-usecases.js', () => ({
  executeAgent: mockExecuteAgent,
}));

describe('TeamLeaderRunner with structuredCaller', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should delegate decomposition and feedback to structuredCaller instead of legacy usecases', async () => {
    mockExecuteAgent.mockResolvedValue({
      persona: 'coder',
      status: 'done',
      content: 'API done',
      timestamp: new Date('2026-04-01T00:00:00.000Z'),
    });
    const resolveStepProviderModel = vi.fn().mockReturnValue({ provider: 'cursor', model: 'gpt-5' });

    const structuredCaller = {
      decomposeTask: vi.fn().mockImplementation(async (_instruction, _maxParts, options) => {
        options.onPromptResolved?.({
          systemPrompt: 'team-leader-system',
          userInstruction: 'leader instruction',
        });
        return [
          { id: 'part-1', title: 'API', instruction: 'Implement API' },
        ];
      }),
      requestMoreParts: vi.fn().mockResolvedValue({
        done: true,
        reasoning: 'enough',
        parts: [],
      }),
    };

    const runner = new TeamLeaderRunner({
      optionsBuilder: {
        buildAgentOptions: vi.fn().mockReturnValue({ cwd: '/tmp/project' }),
        resolveStepProviderModel,
      },
      movementExecutor: {
        buildInstruction: vi.fn().mockReturnValue('leader instruction'),
        applyPostExecutionPhases: vi.fn(async (_step, _state, _iteration, response) => response),
        persistPreviousResponseSnapshot: vi.fn(),
        emitMovementReports: vi.fn(),
      },
      engineOptions: {
        projectCwd: '/tmp/project',
        structuredCaller,
      },
      getCwd: () => '/tmp/project',
      getInteractive: () => false,
    } as ConstructorParameters<typeof TeamLeaderRunner>[0] & {
      engineOptions: { projectCwd: string; structuredCaller: typeof structuredCaller };
    });

    const step: PieceMovement = {
      name: 'implement',
      persona: 'coder',
      personaDisplayName: 'coder',
      instruction: 'Task: {task}',
      passPreviousResponse: true,
      teamLeader: {
        persona: 'team-leader',
        maxParts: 2,
        refillThreshold: 0,
        timeoutMs: 1000,
        partPersona: 'coder',
        partAllowedTools: ['Read', 'Edit'],
        partEdit: true,
        partPermissionMode: 'edit',
      },
      rules: [{ condition: 'done', next: 'COMPLETE' }],
    };

    const state: PieceState = {
      pieceName: 'piece',
      currentMovement: 'implement',
      iteration: 1,
      movementOutputs: new Map(),
      lastOutput: undefined,
      previousResponseSourcePath: undefined,
      userInputs: [],
      personaSessions: new Map(),
      movementIterations: new Map(),
      status: 'running',
    };

    const result = await runner.runTeamLeaderMovement(
      step,
      state,
      'implement feature',
      5,
      vi.fn(),
    );

    expect(result.response.status).toBe('done');
    expect(result.response.content).toContain('part-1');
    expect(structuredCaller.decomposeTask).toHaveBeenCalledWith(
      'leader instruction',
      2,
      expect.objectContaining({
        cwd: '/tmp/project',
        model: 'gpt-5',
        persona: 'team-leader',
        provider: 'cursor',
      }),
    );
    expect(structuredCaller.requestMoreParts).toHaveBeenCalledWith(
      'leader instruction',
      [
        {
          id: 'part-1',
          title: 'API',
          status: 'done',
          content: 'API done',
        },
      ],
      ['part-1'],
      19,
      expect.objectContaining({
        cwd: '/tmp/project',
        model: 'gpt-5',
        persona: 'team-leader',
        provider: 'cursor',
      }),
    );
    expect(resolveStepProviderModel).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'implement',
        persona: 'team-leader',
      }),
    );
  });
});

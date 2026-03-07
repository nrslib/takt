import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PieceMovement } from '../core/models/types.js';
import { runStatusJudgmentPhase } from '../core/piece/status-judgment-phase.js';

const { mockJudgeStatus } = vi.hoisted(() => ({
  mockJudgeStatus: vi.fn(),
}));

vi.mock('../agents/agent-usecases.js', () => ({
  judgeStatus: mockJudgeStatus,
}));

describe('runStatusJudgmentPhase', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should pass judge stage callbacks through PhaseRunnerContext', async () => {
    mockJudgeStatus.mockImplementation(
      async (_structured: string, _tag: string, _rules: unknown[], options: { onJudgeStage?: (entry: {
        stage: 1 | 2 | 3;
        method: 'structured_output' | 'phase3_tag' | 'ai_judge';
        status: 'done' | 'error' | 'skipped';
        instruction: string;
        response: string;
      }) => void; onStructuredPromptResolved?: (promptParts: { systemPrompt: string; userInstruction: string }) => void }) => {
        options.onStructuredPromptResolved?.({
          systemPrompt: 'conductor-system',
          userInstruction: 'structured prompt',
        });
        options.onJudgeStage?.({
          stage: 1,
          method: 'structured_output',
          status: 'done',
          instruction: 'structured prompt',
          response: '{"step":2}',
        });
        return { ruleIndex: 1, method: 'structured_output' as const };
      },
    );

    const step: PieceMovement = {
      name: 'review',
      persona: 'reviewer',
      personaDisplayName: 'reviewer',
      instruction: 'Review',
      passPreviousResponse: true,
      rules: [
        { condition: 'needs_fix', next: 'fix' },
        { condition: 'approved', next: 'COMPLETE' },
      ],
    };
    const onPhaseStart = vi.fn();
    const onPhaseComplete = vi.fn();
    const onJudgeStage = vi.fn();

    const result = await runStatusJudgmentPhase(step, {
      cwd: '/tmp/project',
      reportDir: '/tmp/project/.takt/reports',
      lastResponse: 'response body',
      iteration: 4,
      getSessionId: vi.fn(),
      buildResumeOptions: vi.fn(),
      buildNewSessionReportOptions: vi.fn(),
      updatePersonaSession: vi.fn(),
      onPhaseStart,
      onPhaseComplete,
      onJudgeStage,
    });

    expect(result).toEqual({
      tag: '[REVIEW:2]',
      ruleIndex: 1,
      method: 'structured_output',
    });
    expect(onPhaseStart).toHaveBeenCalledWith(
      step,
      3,
      'judge',
      expect.any(String),
      {
        systemPrompt: 'conductor-system',
        userInstruction: 'structured prompt',
      },
      'review:4:3:1',
      4,
    );
    expect(onJudgeStage).toHaveBeenCalledWith(
      step,
      3,
      'judge',
      expect.objectContaining({ stage: 1, method: 'structured_output' }),
      'review:4:3:1',
      4,
    );
    expect(onPhaseComplete).toHaveBeenCalledWith(step, 3, 'judge', '[REVIEW:2]', 'done', undefined, 'review:4:3:1', 4);
  });

  it('should fail fast when iteration is missing', async () => {
    mockJudgeStatus.mockResolvedValue({ ruleIndex: 0, method: 'structured_output' });

    const step: PieceMovement = {
      name: 'review',
      persona: 'reviewer',
      personaDisplayName: 'reviewer',
      instruction: 'Review',
      passPreviousResponse: true,
      rules: [
        { condition: 'needs_fix', next: 'fix' },
        { condition: 'approved', next: 'COMPLETE' },
      ],
    };

    await expect(runStatusJudgmentPhase(step, {
      cwd: '/tmp/project',
      reportDir: '/tmp/project/.takt/reports',
      lastResponse: 'response body',
      getSessionId: vi.fn(),
      buildResumeOptions: vi.fn(),
      buildNewSessionReportOptions: vi.fn(),
      updatePersonaSession: vi.fn(),
    })).rejects.toThrow('Status judgment requires iteration for movement "review"');
  });
});

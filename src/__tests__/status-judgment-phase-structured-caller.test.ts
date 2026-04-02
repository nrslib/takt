import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PieceMovement } from '../core/models/types.js';
import { runStatusJudgmentPhase } from '../core/piece/status-judgment-phase.js';

describe('runStatusJudgmentPhase with structuredCaller', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should delegate phase 3 judgment to structuredCaller instead of legacy judgeStatus', async () => {
    const structuredCaller = {
      judgeStatus: vi.fn().mockImplementation(async (_structured, _tag, _rules, options) => {
        options.onStructuredPromptResolved?.({
          systemPrompt: 'judge-system',
          userInstruction: 'judge-instruction',
        });
        return { ruleIndex: 1, method: 'phase3_tag' as const };
      }),
    };

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

    const result = await runStatusJudgmentPhase(step, {
      cwd: '/tmp/project',
      reportDir: '/tmp/project/.takt/reports',
      lastResponse: 'response body',
      iteration: 2,
      getSessionId: vi.fn(),
      buildResumeOptions: vi.fn(),
      buildNewSessionReportOptions: vi.fn(),
      updatePersonaSession: vi.fn(),
      resolveProvider: vi.fn().mockReturnValue('cursor'),
      structuredCaller,
    } as Parameters<typeof runStatusJudgmentPhase>[1] & {
      structuredCaller: { judgeStatus: typeof structuredCaller.judgeStatus };
    });

    expect(result).toEqual({
      tag: '[REVIEW:2]',
      ruleIndex: 1,
      method: 'phase3_tag',
    });
    expect(structuredCaller.judgeStatus).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      step.rules,
      expect.objectContaining({
        cwd: '/tmp/project',
        movementName: 'review',
        provider: 'cursor',
      }),
    );
  });
});

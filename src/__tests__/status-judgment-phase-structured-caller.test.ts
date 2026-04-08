import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowStep } from '../core/models/types.js';
import { runStatusJudgmentPhase } from '../core/workflow/status-judgment-phase.js';

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

    const step: WorkflowStep = {
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
        stepName: 'review',
        provider: 'cursor',
      }),
    );
  });

  it('should pass resolvedProvider and resolvedModel to judgeStatus aligned with step resolution (#556)', async () => {
    const structuredCaller = {
      judgeStatus: vi.fn().mockImplementation(async (_structured, _tag, _rules, options) => {
        options.onStructuredPromptResolved?.({
          systemPrompt: 'judge-system',
          userInstruction: 'judge-instruction',
        });
        return { ruleIndex: 0, method: 'structured_output' as const };
      }),
    };

    const step: WorkflowStep = {
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

    type PhaseCtx = Parameters<typeof runStatusJudgmentPhase>[1] & {
      resolveStepProviderModel: (s: WorkflowStep) => { provider: 'codex'; model: string };
    };

    await runStatusJudgmentPhase(step, {
      cwd: '/tmp/project',
      reportDir: '/tmp/project/.takt/reports',
      lastResponse: 'response body',
      iteration: 2,
      getSessionId: vi.fn(),
      buildResumeOptions: vi.fn(),
      buildNewSessionReportOptions: vi.fn(),
      updatePersonaSession: vi.fn(),
      resolveProvider: vi.fn().mockReturnValue('codex'),
      resolveStepProviderModel: vi.fn().mockReturnValue({ provider: 'codex', model: 'gpt-5.2-codex' }),
      structuredCaller,
    } as PhaseCtx);

    expect(structuredCaller.judgeStatus).toHaveBeenCalledTimes(1);
    const judgeOptions = structuredCaller.judgeStatus.mock.calls[0]?.[3];
    expect(judgeOptions).toEqual(
      expect.objectContaining({
        cwd: '/tmp/project',
        stepName: 'review',
        provider: 'codex',
        resolvedProvider: 'codex',
        resolvedModel: 'gpt-5.2-codex',
      }),
    );
  });
});

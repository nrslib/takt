import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowStep } from '../core/models/types.js';
import { runStatusJudgmentPhase } from '../core/workflow/status-judgment-phase.js';
import { runAgent } from '../agents/runner.js';
import { PromptBasedStructuredCaller } from '../agents/structured-caller.js';

vi.mock('../agents/runner.js', () => ({
  runAgent: vi.fn(),
}));

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
      resolveStepProviderModel: vi.fn().mockReturnValue({ provider: 'cursor', model: undefined }),
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

  it('passes childProcessEnv to phase 3 structured caller judgment', async () => {
    const childProcessEnv = { TAKT_OBSERVABILITY: '{"enabled":true}' };
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

    await runStatusJudgmentPhase(step, {
      cwd: '/tmp/project',
      reportDir: '/tmp/project/.takt/reports',
      lastResponse: 'response body',
      iteration: 2,
      childProcessEnv,
      resolveStepProviderModel: vi.fn().mockReturnValue({ provider: 'codex', model: 'gpt-5.2-codex' }),
      structuredCaller,
    } as Parameters<typeof runStatusJudgmentPhase>[1] & {
      structuredCaller: { judgeStatus: typeof structuredCaller.judgeStatus };
    });

    expect(structuredCaller.judgeStatus).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      step.rules,
      expect.objectContaining({ childProcessEnv }),
    );
  });

  it('records provider usage for every structured judgment stage', async () => {
    const providerUsage = {
      inputTokens: 9,
      outputTokens: 2,
      totalTokens: 11,
      usageMissing: false,
    };
    const structuredCaller = {
      judgeStatus: vi.fn().mockImplementation(async (_structured, _tag, _rules, options) => {
        options.onStructuredPromptResolved?.({
          systemPrompt: 'judge-system',
          userInstruction: 'judge-instruction',
        });
        options.onJudgeStage?.({
          stage: 1,
          method: 'structured_output',
          status: 'done',
          instruction: 'judge-instruction',
          response: '{"step":1}',
          providerUsage,
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
        { condition: 'approved', next: 'COMPLETE' },
        { condition: 'needs_fix', next: 'fix' },
      ],
    };
    const onProviderAttempt = vi.fn();

    await runStatusJudgmentPhase(step, {
      cwd: '/tmp/project',
      reportDir: '/tmp/project/.takt/reports',
      lastResponse: 'response body',
      iteration: 2,
      resolveStepProviderModel: vi.fn().mockReturnValue({ provider: 'codex', model: 'gpt-5' }),
      structuredCaller,
      onProviderAttempt,
    } as Parameters<typeof runStatusJudgmentPhase>[1] & {
      structuredCaller: { judgeStatus: typeof structuredCaller.judgeStatus };
    });

    expect(onProviderAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'codex', model: 'gpt-5' }),
      true,
      providerUsage,
    );
  });

  it('records a rejected second provider attempt after the first judgment response', async () => {
    vi.mocked(runAgent)
      .mockImplementationOnce(async (_persona, _instruction, options) => {
        options?.onPromptResolved?.({
          systemPrompt: 'judge-system',
          userInstruction: 'judge-instruction',
        });
        return {
          persona: 'conductor',
          status: 'done',
          content: 'not-json',
          timestamp: new Date(),
        };
      })
      .mockRejectedValueOnce(new Error('tag attempt rejected'));
    const step: WorkflowStep = {
      name: 'review',
      persona: 'reviewer',
      personaDisplayName: 'reviewer',
      instruction: 'Review',
      passPreviousResponse: true,
      rules: [
        { condition: 'approved', next: 'COMPLETE' },
        { condition: 'needs_fix', next: 'fix' },
      ],
    };
    const onProviderAttempt = vi.fn();

    await expect(runStatusJudgmentPhase(step, {
      cwd: '/tmp/project',
      reportDir: '/tmp/project/.takt/reports',
      lastResponse: 'response body',
      iteration: 2,
      resolveStepProviderModel: vi.fn().mockReturnValue({ provider: 'cursor', model: undefined }),
      structuredCaller: new PromptBasedStructuredCaller(),
      onProviderAttempt,
    } as Parameters<typeof runStatusJudgmentPhase>[1])).rejects.toThrow('tag attempt rejected');

    expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(2);
    expect(onProviderAttempt).toHaveBeenCalledTimes(2);
    expect(onProviderAttempt.mock.calls.map(([, success]) => success)).toEqual([true, false]);
  });

  it('records a rejected third provider attempt after two completed judgment responses', async () => {
    vi.mocked(runAgent)
      .mockImplementationOnce(async (_persona, _instruction, options) => {
        options?.onPromptResolved?.({
          systemPrompt: 'judge-system',
          userInstruction: 'judge-instruction',
        });
        return {
          persona: 'conductor',
          status: 'done',
          content: 'not-json',
          timestamp: new Date(),
        };
      })
      .mockResolvedValueOnce({
        persona: 'conductor',
        status: 'done',
        content: 'no matching tag',
        timestamp: new Date(),
      })
      .mockRejectedValueOnce(new Error('ai judge attempt rejected'));
    const step: WorkflowStep = {
      name: 'review',
      persona: 'reviewer',
      personaDisplayName: 'reviewer',
      instruction: 'Review',
      passPreviousResponse: true,
      rules: [
        { condition: 'approved', next: 'COMPLETE' },
        { condition: 'needs_fix', next: 'fix' },
      ],
    };
    const onProviderAttempt = vi.fn();

    await expect(runStatusJudgmentPhase(step, {
      cwd: '/tmp/project',
      reportDir: '/tmp/project/.takt/reports',
      lastResponse: 'response body',
      iteration: 2,
      resolveStepProviderModel: vi.fn().mockReturnValue({ provider: 'cursor', model: undefined }),
      structuredCaller: new PromptBasedStructuredCaller(),
      onProviderAttempt,
    } as Parameters<typeof runStatusJudgmentPhase>[1])).rejects.toThrow('ai judge attempt rejected');

    expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(3);
    expect(onProviderAttempt).toHaveBeenCalledTimes(3);
    expect(onProviderAttempt.mock.calls.map(([, success]) => success)).toEqual([true, true, false]);
  });
});

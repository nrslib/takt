import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkflowStep } from '../core/models/types.js';
import { normalizeRule } from '../infra/config/loaders/workflowRuleNormalizer.js';

const { mockRunWithPhaseSpan, phaseOutcomes } = vi.hoisted(() => ({
  mockRunWithPhaseSpan: vi.fn(),
  phaseOutcomes: [] as unknown[],
}));

vi.mock('../core/workflow/observability/workflowSpans.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../core/workflow/observability/workflowSpans.js')>()),
  runWithPhaseSpan: mockRunWithPhaseSpan,
}));

import { runStatusJudgmentPhase } from '../core/workflow/status-judgment-phase.js';
import { RuleDetectionExhaustedError } from '../core/workflow/evaluation/RuleDetectionExhaustedError.js';

describe('runStatusJudgmentPhase', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    phaseOutcomes.length = 0;
    mockRunWithPhaseSpan.mockImplementation(async (_params, execute, getOutcome) => {
      const result = await execute();
      phaseOutcomes.push(getOutcome(result));
      return result;
    });
  });

  it('should reject a single semantic candidate before resolving a provider', async () => {
    const resolveStepProviderModel = vi.fn();
    const structuredCaller = { judgeStatus: vi.fn() };
    const step: WorkflowStep = {
      name: 'review',
      persona: 'reviewer',
      personaDisplayName: 'reviewer',
      instruction: 'Review',
      rules: [normalizeRule({ condition: 'approved', next: 'COMPLETE' })],
    };

    await expect(runStatusJudgmentPhase(step, {
      cwd: '/tmp/project',
      reportDir: '/tmp/project/.takt/reports',
      lastResponse: 'response body',
      iteration: 1,
      resolveStepProviderModel,
      structuredCaller,
    })).rejects.toThrow('Status judgment requires multiple semantic rules for step "review"');

    expect(resolveStepProviderModel).not.toHaveBeenCalled();
    expect(structuredCaller.judgeStatus).not.toHaveBeenCalled();
  });

  it('should pass judge stage callbacks through status judgment context', async () => {
    const structuredCaller = {
      judgeStatus: vi.fn().mockImplementation(
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
        return { candidateIndex: 1, method: 'structured_output' as const };
      },
      ),
    };

    const step: WorkflowStep = {
      name: 'review',
      persona: 'reviewer',
      personaDisplayName: 'reviewer',
      instruction: 'Review',
      passPreviousResponse: true,
      rules: [
        normalizeRule({ condition: 'needs_fix', next: 'fix' }),
        normalizeRule({ condition: 'approved', next: 'COMPLETE' }),
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
      resolveStepProviderModel: vi.fn().mockReturnValue({ provider: 'cursor', model: undefined }),
      structuredCaller,
      onPhaseStart,
      onPhaseComplete,
      onJudgeStage,
    });

    expect(result).toEqual({
      label: 'approved',
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
    expect(onPhaseComplete).toHaveBeenCalledWith(step, 3, 'judge', 'approved', 'done', undefined, 'review:4:3:1', 4);
  });

  it('should pass abortSignal to the Phase 3 structured caller', async () => {
    const abortController = new AbortController();
    const structuredCaller = {
      judgeStatus: vi.fn().mockImplementation(async (_structured, _tag, _candidates, options) => {
        options.onStructuredPromptResolved?.({
          systemPrompt: 'conductor-system',
          userInstruction: 'structured prompt',
        });
        return { candidateIndex: 0, method: 'structured_output' as const };
      }),
    };
    const step: WorkflowStep = {
      name: 'review',
      persona: 'reviewer',
      personaDisplayName: 'reviewer',
      instruction: 'Review',
      passPreviousResponse: true,
      rules: [
        normalizeRule({ condition: 'approved', next: 'COMPLETE' }),
        normalizeRule({ condition: 'needs_fix', next: 'fix' }),
      ],
    };

    await runStatusJudgmentPhase(step, {
      cwd: '/tmp/project',
      reportDir: '/tmp/project/.takt/reports',
      lastResponse: 'response body',
      iteration: 4,
      abortSignal: abortController.signal,
      resolveStepProviderModel: vi.fn().mockReturnValue({ provider: 'cursor', model: undefined }),
      structuredCaller,
    });

    expect(structuredCaller.judgeStatus).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({ abortSignal: abortController.signal }),
    );
  });

  it('should filter interactive-only rules before passing semantic candidates to the structured caller', async () => {
    const structuredCaller = {
      judgeStatus: vi.fn().mockImplementation(async (_structured, _tag, candidates, options) => {
        options.onStructuredPromptResolved?.({
          systemPrompt: 'conductor-system',
          userInstruction: 'structured prompt',
        });
        return { candidateIndex: candidates.length - 1, method: 'structured_output' as const };
      }),
    };
    const step: WorkflowStep = {
      name: 'review',
      persona: 'reviewer',
      personaDisplayName: 'reviewer',
      instruction: 'Review',
      passPreviousResponse: true,
      rules: [
        normalizeRule({ condition: 'approved', next: 'COMPLETE' }),
        normalizeRule({ condition: 'blocked', next: 'ABORT', interactive_only: true }),
        normalizeRule({ condition: 'needs_fix', next: 'fix' }),
      ],
    };
    const run = (interactive: boolean) => runStatusJudgmentPhase(step, {
      cwd: '/tmp/project',
      reportDir: '/tmp/project/.takt/reports',
      lastResponse: 'response body',
      iteration: 4,
      interactive,
      resolveStepProviderModel: vi.fn().mockReturnValue({ provider: 'cursor', model: undefined }),
      structuredCaller,
    });

    await run(false);
    await run(true);

    expect(structuredCaller.judgeStatus).toHaveBeenNthCalledWith(
      1,
      expect.any(String),
      expect.any(String),
      [{ label: 'approved' }, { label: 'needs_fix' }],
      expect.any(Object),
    );
    expect(structuredCaller.judgeStatus).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      expect.any(String),
      [{ label: 'approved' }, { label: 'blocked' }, { label: 'needs_fix' }],
      expect.any(Object),
    );
  });

  it('should fail fast when iteration is missing', async () => {
    const structuredCaller = {
      judgeStatus: vi.fn().mockResolvedValue({ candidateIndex: 0, method: 'structured_output' }),
    };

    const step: WorkflowStep = {
      name: 'review',
      persona: 'reviewer',
      personaDisplayName: 'reviewer',
      instruction: 'Review',
      passPreviousResponse: true,
      rules: [
        normalizeRule({ condition: 'needs_fix', next: 'fix' }),
        normalizeRule({ condition: 'approved', next: 'COMPLETE' }),
      ],
    };

    await expect(runStatusJudgmentPhase(step, {
      cwd: '/tmp/project',
      reportDir: '/tmp/project/.takt/reports',
      lastResponse: 'response body',
      resolveStepProviderModel: vi.fn().mockReturnValue({ provider: 'cursor', model: undefined }),
      structuredCaller,
    })).rejects.toThrow('Status judgment requires iteration for step "review"');
  });

  it('should emit error phase completion when provider resolution fails', async () => {
    const structuredCaller = {
      judgeStatus: vi.fn().mockResolvedValue({ candidateIndex: 0, method: 'structured_output' }),
    };
    const providerError = new Error('provider resolution failed');
    const step: WorkflowStep = {
      name: 'review',
      persona: 'reviewer',
      personaDisplayName: 'reviewer',
      instruction: 'Review',
      passPreviousResponse: true,
      rules: [
        normalizeRule({ condition: 'needs_fix', next: 'fix' }),
        normalizeRule({ condition: 'approved', next: 'COMPLETE' }),
      ],
    };
    const onPhaseComplete = vi.fn();
    const resolveStepProviderModel = vi.fn(() => {
      throw providerError;
    });

    await expect(runStatusJudgmentPhase(step, {
      cwd: '/tmp/project',
      reportDir: '/tmp/project/.takt/reports',
      lastResponse: 'response body',
      iteration: 4,
      resolveStepProviderModel,
      structuredCaller,
      onPhaseComplete,
    })).rejects.toThrow(providerError);

    expect(resolveStepProviderModel).toHaveBeenCalledWith(step);
    expect(structuredCaller.judgeStatus).not.toHaveBeenCalled();
    expect(onPhaseComplete).toHaveBeenCalledWith(
      step,
      3,
      'judge',
      '',
      'error',
      'provider resolution failed',
      'review:4:3:1',
      4,
    );
  });

  it('should reject an invalid candidate before recording a successful phase outcome', async () => {
    const structuredCaller = {
      judgeStatus: vi.fn().mockImplementation(async (_structured, _tag, _rules, options) => {
        options.onStructuredPromptResolved?.({
          systemPrompt: 'judge-system',
          userInstruction: 'judge-instruction',
        });
        return { candidateIndex: 2, method: 'structured_output' as const };
      }),
    };
    const step: WorkflowStep = {
      name: 'review',
      persona: 'reviewer',
      personaDisplayName: 'reviewer',
      instruction: 'Review',
      passPreviousResponse: true,
      rules: [
        normalizeRule({ condition: 'approved', next: 'COMPLETE' }),
        normalizeRule({ condition: 'needs_fix', next: 'fix' }),
      ],
    };
    const onPhaseComplete = vi.fn();

    await expect(runStatusJudgmentPhase(step, {
      cwd: '/tmp/project',
      reportDir: '/tmp/project/.takt/reports',
      lastResponse: 'response body',
      iteration: 4,
      observabilityEnabled: true,
      resolveStepProviderModel: vi.fn().mockReturnValue({ provider: 'cursor', model: undefined }),
      structuredCaller,
      onPhaseComplete,
    })).rejects.toBeInstanceOf(RuleDetectionExhaustedError);

    expect(phaseOutcomes).toEqual([]);
    expect(onPhaseComplete).toHaveBeenCalledWith(
      step,
      3,
      'judge',
      '',
      'error',
      'Status not found for step "review": no rule matched after all detection phases',
      'review:4:3:1',
      4,
    );
  });

  it('should reject missing prompt parts before recording a successful phase outcome', async () => {
    const structuredCaller = {
      judgeStatus: vi.fn().mockResolvedValue({ candidateIndex: 0, method: 'structured_output' as const }),
    };
    const step: WorkflowStep = {
      name: 'review',
      persona: 'reviewer',
      personaDisplayName: 'reviewer',
      instruction: 'Review',
      passPreviousResponse: true,
      rules: [
        normalizeRule({ condition: 'approved', next: 'COMPLETE' }),
        normalizeRule({ condition: 'needs_fix', next: 'fix' }),
      ],
    };
    const onPhaseComplete = vi.fn();

    await expect(runStatusJudgmentPhase(step, {
      cwd: '/tmp/project',
      reportDir: '/tmp/project/.takt/reports',
      lastResponse: 'response body',
      iteration: 4,
      observabilityEnabled: true,
      resolveStepProviderModel: vi.fn().mockReturnValue({ provider: 'cursor', model: undefined }),
      structuredCaller,
      onPhaseComplete,
    })).rejects.toThrow('Missing prompt parts for phase start: review:3');

    expect(phaseOutcomes).toEqual([]);
    expect(onPhaseComplete).toHaveBeenCalledWith(
      step,
      3,
      'judge',
      '',
      'error',
      'Missing prompt parts for phase start: review:3',
      'review:4:3:1',
      4,
    );
  });
});

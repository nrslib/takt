import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createFindingContractDecisionValidationIssue,
  createFindingContractTeamLeaderDecisionValidationError,
  type FindingContractRejectedDecisionDigest,
} from '../core/workflow/team-leader-finding-contract-decision-validation.js';
import {
  FINDING_CONTRACT_RECOVERY_EMERGENCY_CALL_LIMIT,
  FINDING_CONTRACT_RECOVERY_DEADLINE_MS,
  FindingContractRecoveryDeadlineError,
  FindingContractRecoveryCallLimitError,
  FindingContractRecoveryExhaustedError,
  requestValidFindingContractControlOutput,
  type FindingContractRecoveryMode,
  type FindingContractRecoveryPromptContext,
} from '../core/workflow/engine/team-leader-finding-contract-recovery.js';
import {
  FindingContractPartCompletionValidationError,
} from '../core/workflow/team-leader-finding-contract-part-completion-validation.js';
import {
  createFindingContractControlValidationIssue,
} from '../core/workflow/team-leader-finding-contract-control-validation.js';
import {
  FindingContractAttemptUsageRecorder,
} from '../core/workflow/engine/finding-contract-attempt-usage-recorder.js';

afterEach(() => {
  vi.useRealTimers();
});

function decisionValidationError(input: {
  code: string;
  category?: 'decision_contract' | 'reference' | 'evidence';
  raw?: unknown;
}) {
  return createFindingContractTeamLeaderDecisionValidationError(
    input.raw ?? { decision: 'complete', parts: [], fixCoverage: [], blockers: [] },
    [createFindingContractDecisionValidationIssue({
      code: input.code,
      category: input.category ?? 'decision_contract',
      path: input.code,
      message: `invalid ${input.code}`,
    })],
  );
}

function decisionAdapter(
  request: (context: FindingContractRecoveryPromptContext<FindingContractRejectedDecisionDigest>) => Promise<unknown>,
) {
  return {
    boundaryKind: 'decision' as const,
    requestOnce: async ({ recoveryContext, attemptToken }: {
      recoveryContext: FindingContractRecoveryPromptContext<FindingContractRejectedDecisionDigest>;
      attemptToken: string;
    }) => ({
      raw: await request(recoveryContext),
      attemptToken,
    }),
    validate: (envelope: { raw: unknown }) => envelope.raw,
  };
}

describe('Finding Contract control output recovery', () => {
  it('uses normal mode for three rejected calls and strict mode from the fourth call', async () => {
    const modes: FindingContractRecoveryMode[] = [];
    const request = vi.fn(async (context: FindingContractRecoveryPromptContext<FindingContractRejectedDecisionDigest>) => {
      modes.push(context.mode);
      if (modes.length <= 3) {
        throw decisionValidationError({
          code: `decision_contract.invalid_${modes.length}`,
          raw: { decision: `invalid-${modes.length}`, parts: [], fixCoverage: [], blockers: [] },
        });
      }
      return { decision: 'complete' };
    });

    await expect(requestValidFindingContractControlOutput({
      adapter: decisionAdapter(request),
    })).resolves.toEqual({ decision: 'complete' });

    expect(modes).toEqual(['normal', 'normal', 'normal', 'strict']);
    expect(request.mock.calls[3]?.[0].strictReason).toBe('normal_attempts_exhausted');
  });

  it('continues the durable call counter, deadline, and rejection history after resume', async () => {
    const prior = decisionValidationError({
      code: 'decision_contract.parts',
      raw: { decision: 'invalid', parts: [] },
    });
    const now = Date.now();
    const contexts: FindingContractRecoveryPromptContext<FindingContractRejectedDecisionDigest>[] = [];
    const attempts: number[] = [];

    await expect(requestValidFindingContractControlOutput({
      resumeState: {
        startedAt: now - 1_000,
        deadlineAt: now + 10_000,
        completedCalls: 3,
        mode: 'strict',
        strictReason: 'normal_attempts_exhausted',
        rejectedOutputs: [{
          attempt: 3,
          mode: 'normal',
          issues: prior.issues,
          issueFingerprint: prior.issueFingerprint,
          outputDigest: prior.outputDigest,
          repeatCount: 1,
        }],
      },
      adapter: {
        ...decisionAdapter(async (context) => {
          contexts.push(context);
          return { decision: 'complete' };
        }),
        requestOnce: async ({ recoveryContext, attemptToken }) => {
          contexts.push(recoveryContext);
          attempts.push(recoveryContext.attempt);
          return { raw: { decision: 'complete' }, attemptToken };
        },
      },
    })).resolves.toEqual({ decision: 'complete' });

    expect(attempts).toEqual([4]);
    expect(contexts[0]).toMatchObject({
      attempt: 4,
      mode: 'strict',
      strictReason: 'normal_attempts_exhausted',
      latestRejection: {
        attempt: 3,
        issueFingerprint: prior.issueFingerprint,
      },
    });
  });

  it.each(['reference', 'evidence'] as const)(
    'enters strict mode after the first %s issue',
    async (category) => {
      const contexts: FindingContractRecoveryPromptContext<FindingContractRejectedDecisionDigest>[] = [];
      const request = vi.fn(async (context: FindingContractRecoveryPromptContext<FindingContractRejectedDecisionDigest>) => {
        contexts.push(context);
        if (contexts.length === 1) {
          throw decisionValidationError({ code: `${category}.invalid`, category });
        }
        return { decision: 'replan' };
      });

      await requestValidFindingContractControlOutput({ adapter: decisionAdapter(request) });

      expect(contexts.map((context) => context.mode)).toEqual(['normal', 'strict']);
      expect(contexts[1]?.strictReason).toBe('evidence_or_reference_issue');
    },
  );

  it('enters strict mode for repeated issue sets and repeated canonical outputs', async () => {
    const issueContexts: FindingContractRecoveryPromptContext<FindingContractRejectedDecisionDigest>[] = [];
    const issueRequest = vi.fn(async (context: FindingContractRecoveryPromptContext<FindingContractRejectedDecisionDigest>) => {
      issueContexts.push(context);
      if (issueContexts.length <= 2) {
        throw decisionValidationError({
          code: 'decision_contract.parts',
          raw: { decision: `invalid-${issueContexts.length}`, parts: [], fixCoverage: [], blockers: [] },
        });
      }
      return { decision: 'replan' };
    });
    await requestValidFindingContractControlOutput({ adapter: decisionAdapter(issueRequest) });
    expect(issueContexts[2]?.strictReason).toBe('repeated_issue_set');

    const outputContexts: FindingContractRecoveryPromptContext<FindingContractRejectedDecisionDigest>[] = [];
    const outputRequest = vi.fn(async (context: FindingContractRecoveryPromptContext<FindingContractRejectedDecisionDigest>) => {
      outputContexts.push(context);
      if (outputContexts.length <= 2) {
        throw decisionValidationError({
          code: `decision_contract.invalid_${outputContexts.length}`,
          raw: { decision: 'same', parts: [], fixCoverage: [], blockers: [] },
        });
      }
      return { decision: 'replan' };
    });
    await requestValidFindingContractControlOutput({ adapter: decisionAdapter(outputRequest) });
    expect(outputContexts[2]?.strictReason).toBe('repeated_output');
  });

  it('allows acceptance on the emergency ceiling and exhausts after the final rejection', async () => {
    let acceptedCalls = 0;
    const accepted = vi.fn(async () => {
      acceptedCalls += 1;
      if (acceptedCalls < FINDING_CONTRACT_RECOVERY_EMERGENCY_CALL_LIMIT) {
        throw decisionValidationError({
          code: `decision_contract.invalid_${acceptedCalls}`,
          raw: { decision: `invalid-${acceptedCalls}`, parts: [], fixCoverage: [], blockers: [] },
        });
      }
      return { decision: 'complete' };
    });
    await expect(requestValidFindingContractControlOutput({
      adapter: decisionAdapter(accepted),
    })).resolves.toEqual({ decision: 'complete' });

    const rejected = vi.fn(async () => {
      throw decisionValidationError({ code: 'decision_contract.invalid' });
    });
    await expect(requestValidFindingContractControlOutput({
      adapter: decisionAdapter(rejected),
    })).rejects.toBeInstanceOf(FindingContractRecoveryExhaustedError);
    expect(rejected).toHaveBeenCalledTimes(FINDING_CONTRACT_RECOVERY_EMERGENCY_CALL_LIMIT);
  });

  it('does not dispatch call 101 after resuming an in-flight call at the ceiling', async () => {
    const requestOnce = vi.fn(async () => ({
      raw: {},
      attemptToken: 'decision:101',
    }));
    await expect(requestValidFindingContractControlOutput({
      resumeState: {
        startedAt: Date.now() - 1_000,
        deadlineAt: Date.now() + 10_000,
        completedCalls: FINDING_CONTRACT_RECOVERY_EMERGENCY_CALL_LIMIT,
        mode: 'strict',
        strictReason: 'normal_attempts_exhausted',
        rejectedOutputs: [],
      },
      adapter: {
        boundaryKind: 'decision',
        requestOnce,
        validate: (envelope) => envelope.raw,
      },
    })).rejects.toBeInstanceOf(FindingContractRecoveryCallLimitError);
    expect(requestOnce).not.toHaveBeenCalled();
  });

  it('does not retry provider errors or parent abort', async () => {
    const providerError = new Error('provider failed');
    const providerRequest = vi.fn(async () => {
      throw providerError;
    });
    await expect(requestValidFindingContractControlOutput({
      adapter: decisionAdapter(providerRequest),
    })).rejects.toBe(providerError);
    expect(providerRequest).toHaveBeenCalledTimes(1);

    const controller = new AbortController();
    controller.abort(new Error('parent stopped'));
    const abortedRequest = vi.fn(async () => ({ decision: 'complete' }));
    await expect(requestValidFindingContractControlOutput({
      adapter: decisionAdapter(abortedRequest),
      abortSignal: controller.signal,
    })).rejects.toThrow('parent stopped');
    expect(abortedRequest).not.toHaveBeenCalled();
  });

  it('does not call the provider for a seeded terminal completion violation', async () => {
    const terminal = new FindingContractPartCompletionValidationError([
      createFindingContractControlValidationIssue({
        boundaryKind: 'part_completion',
        code: 'authority.unassigned_finding',
        category: 'authority',
        path: 'findingOutcomes[0].findingId',
        message: 'unassigned finding',
        retryability: 'terminal',
      }),
    ], {});
    const requestOnce = vi.fn(async () => ({
      raw: {},
      attemptToken: 'part_completion:1',
    }));

    await expect(requestValidFindingContractControlOutput({
      initialValidationError: terminal,
      adapter: {
        boundaryKind: 'part_completion',
        requestOnce,
        validate: () => ({}),
      },
    })).rejects.toBe(terminal);
    expect(requestOnce).not.toHaveBeenCalled();
  });

  it('uses the seeded completion diagnostics in the first correction and counts only correction calls', async () => {
    const initial = new FindingContractPartCompletionValidationError([
      createFindingContractControlValidationIssue({
        boundaryKind: 'part_completion',
        code: 'evidence.disputed_file_line',
        category: 'evidence',
        path: 'findingOutcomes[0].evidence',
        message: 'file:line required',
        retryability: 'corrective_retry',
      }),
    ], { findingOutcomes: [] });
    const contexts: FindingContractRecoveryPromptContext[] = [];
    const events: Array<{ type: string; attempt: number; raw?: unknown }> = [];

    await requestValidFindingContractControlOutput({
      initialValidationError: initial,
      initialEnvelope: {
        raw: { originalClaim: true },
        attemptToken: 'part_completion:initial',
      },
      adapter: {
        boundaryKind: 'part_completion',
        requestOnce: async ({ recoveryContext, attemptToken }) => {
          contexts.push(recoveryContext);
          return { raw: { accepted: true }, attemptToken };
        },
        validate: (envelope) => envelope.raw,
      },
      onAttempt: (event) => events.push({
        type: event.type,
        attempt: event.attempt,
        ...(event.envelope === undefined ? {} : { raw: event.envelope.raw }),
      }),
    });

    expect(contexts).toHaveLength(1);
    expect(contexts[0]).toEqual(expect.objectContaining({
      attempt: 1,
      mode: 'strict',
      strictReason: 'evidence_or_reference_issue',
      latestRejection: expect.objectContaining({ attempt: 0 }),
    }));
    expect(events).toEqual([
      { type: 'rejected', attempt: 0, raw: { originalClaim: true } },
      { type: 'started', attempt: 1 },
      { type: 'accepted', attempt: 1, raw: { accepted: true } },
    ]);
  });

  it('terminates at the deadline without starting another call', async () => {
    vi.useFakeTimers();
    const request = vi.fn(async () => {
      await new Promise<void>(() => undefined);
      return { decision: 'complete' };
    });
    const promise = requestValidFindingContractControlOutput({
      adapter: decisionAdapter(request),
    });
    const rejection = expect(promise).rejects.toBeInstanceOf(FindingContractRecoveryDeadlineError);
    await vi.advanceTimersByTimeAsync(FINDING_CONTRACT_RECOVERY_DEADLINE_MS);
    await rejection;
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('fences a late response after abort while exposing its usage once', async () => {
    const controller = new AbortController();
    let resolveRequest: ((value: {
      raw: { decision: string };
      attemptToken: string;
      sessionId: string;
      usage: { usageMissing: boolean; totalTokens: number };
    }) => void) | undefined;
    const requestOnce = vi.fn(({ attemptToken }: { attemptToken: string }) => (
      new Promise<{
        raw: { decision: string };
        attemptToken: string;
        sessionId: string;
        usage: { usageMissing: boolean; totalTokens: number };
      }>((resolve) => {
        resolveRequest = resolve;
      })
    ));
    const events: Array<{ type: string; sessionId?: string; totalTokens?: number }> = [];
    const promise = requestValidFindingContractControlOutput({
      abortSignal: controller.signal,
      adapter: {
        boundaryKind: 'decision',
        requestOnce,
        validate: (envelope) => envelope.raw,
      },
      onAttempt: (event) => {
        events.push({
          type: event.type,
          ...(event.envelope?.sessionId === undefined
            ? {}
            : { sessionId: event.envelope.sessionId }),
          ...(event.envelope?.usage?.totalTokens === undefined
            ? {}
            : { totalTokens: event.envelope.usage.totalTokens }),
        });
      },
    });
    controller.abort(new Error('stopped'));
    await expect(promise).rejects.toThrow('stopped');
    resolveRequest?.({
      raw: { decision: 'complete' },
      attemptToken: 'decision:1',
      sessionId: 'late-session',
      usage: { usageMissing: false, totalTokens: 42 },
    });
    await vi.waitFor(() => {
      expect(events.filter((event) => event.type === 'late')).toHaveLength(1);
    });

    expect(events.filter((event) => event.totalTokens === 42)).toEqual([
      { type: 'late', sessionId: 'late-session', totalTokens: 42 },
    ]);
  });

  it('records one provider usage when accepted publication fails and emits terminated', async () => {
    const usageRecorder = new FindingContractAttemptUsageRecorder();
    const publishUsage = vi.fn();
    const eventTypes: string[] = [];

    await expect(requestValidFindingContractControlOutput({
      adapter: {
        boundaryKind: 'decision',
        requestOnce: async ({ attemptToken }) => ({
          raw: { decision: 'complete' },
          attemptToken,
          usage: { usageMissing: false, totalTokens: 21 },
        }),
        validate: (envelope) => envelope.raw,
      },
      onAttempt: (event) => {
        eventTypes.push(event.type);
        usageRecorder.record(event.attemptToken, event.envelope?.usage, publishUsage);
        if (event.type === 'accepted') {
          throw new Error('audit publication failed');
        }
      },
    })).rejects.toThrow('audit publication failed');

    expect(eventTypes).toEqual(['started', 'accepted', 'terminated']);
    expect(publishUsage).toHaveBeenCalledTimes(1);
    expect(publishUsage).toHaveBeenCalledWith({
      usageMissing: false,
      totalTokens: 21,
    });
  });
});

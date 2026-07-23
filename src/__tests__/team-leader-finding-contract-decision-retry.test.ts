import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createFindingContractDecisionValidationIssue,
  createFindingContractTeamLeaderDecisionValidationError,
  type FindingContractDecisionValidationCategory,
} from '../core/workflow/team-leader-finding-contract-decision-validation.js';
import {
  FINDING_CONTRACT_DECISION_EMERGENCY_CALL_LIMIT,
  FINDING_CONTRACT_DECISION_RECOVERY_DEADLINE_MS,
  FindingContractDecisionRecoveryDeadlineError,
  FindingContractDecisionRecoveryExhaustedError,
  requestValidFindingContractDecision,
  type FindingContractDecisionAttemptEvent,
  type FindingContractDecisionRecoveryMode,
  type FindingContractDecisionRecoveryPromptContext,
} from '../core/workflow/engine/team-leader-finding-contract-decision-retry.js';

afterEach(() => {
  vi.useRealTimers();
});

function validationError(input: {
  code: string;
  category?: FindingContractDecisionValidationCategory;
  path?: string;
  findingId?: string;
  partId?: string;
  raw?: unknown;
}) {
  return createFindingContractTeamLeaderDecisionValidationError(
    input.raw ?? {
      decision: 'complete',
      parts: [],
      fixCoverage: [],
      blockers: [],
    },
    [createFindingContractDecisionValidationIssue({
      code: input.code,
      category: input.category ?? 'decision_contract',
      path: input.path ?? input.code,
      message: `invalid ${input.code}`,
      ...(input.findingId === undefined ? {} : { findingId: input.findingId }),
      ...(input.partId === undefined ? {} : { partId: input.partId }),
    })],
  );
}

describe('Finding Contract Team Leader decision retry', () => {
  it('uses normal mode for three rejected calls and strict mode from the fourth call', async () => {
    const modes: FindingContractDecisionRecoveryMode[] = [];
    const request = vi.fn(async ({ recoveryContext }: {
      recoveryContext: FindingContractDecisionRecoveryPromptContext;
    }) => {
      modes.push(recoveryContext.mode);
      if (modes.length <= 3) {
        throw validationError({
          code: `decision_contract.invalid_${modes.length}`,
          raw: { decision: `invalid-${modes.length}`, parts: [], fixCoverage: [], blockers: [] },
        });
      }
      return { decision: 'complete' };
    });

    await expect(requestValidFindingContractDecision({ request })).resolves.toEqual({ decision: 'complete' });

    expect(modes).toEqual(['normal', 'normal', 'normal', 'strict']);
    expect(request.mock.calls[3]?.[0].recoveryContext.strictReason).toBe('normal_attempts_exhausted');
  });

  it.each(['reference', 'evidence'] as const)(
    'enters strict mode after the first %s issue',
    async (category) => {
      const contexts: FindingContractDecisionRecoveryPromptContext[] = [];
      const request = vi.fn(async ({ recoveryContext }) => {
        contexts.push(recoveryContext);
        if (contexts.length === 1) {
          throw validationError({
            code: `${category}.invalid`,
            category,
          });
        }
        return { decision: 'replan' };
      });

      await requestValidFindingContractDecision({ request });

      expect(contexts.map((context) => context.mode)).toEqual(['normal', 'strict']);
      expect(contexts[1]?.strictReason).toBe('evidence_or_reference_issue');
    },
  );

  it('enters strict mode when the same issue set repeats across different decisions', async () => {
    const contexts: FindingContractDecisionRecoveryPromptContext[] = [];
    const request = vi.fn(async ({ recoveryContext }) => {
      contexts.push(recoveryContext);
      if (contexts.length <= 2) {
        throw validationError({
          code: 'decision_contract.parts',
          raw: {
            decision: 'continue',
            parts: [{ id: `part-${contexts.length}`, findingContract: { findingIds: ['F-0001'] } }],
            fixCoverage: [],
            blockers: [],
          },
        });
      }
      return { decision: 'replan' };
    });

    await requestValidFindingContractDecision({ request });

    expect(contexts.map((context) => context.mode)).toEqual(['normal', 'normal', 'strict']);
    expect(contexts[2]?.strictReason).toBe('repeated_issue_set');
  });

  it('enters strict mode when the same canonical decision repeats with different issues', async () => {
    const contexts: FindingContractDecisionRecoveryPromptContext[] = [];
    const request = vi.fn(async ({ recoveryContext }) => {
      contexts.push(recoveryContext);
      if (contexts.length <= 2) {
        throw validationError({
          code: `decision_contract.invalid_${contexts.length}`,
          path: `issue:${contexts.length}`,
          raw: {
            decision: 'complete',
            reasoning: `wording ${contexts.length}`,
            parts: [],
            fixCoverage: [],
            blockers: [],
          },
        });
      }
      return { decision: 'replan' };
    });

    await requestValidFindingContractDecision({ request });

    expect(contexts.map((context) => context.mode)).toEqual(['normal', 'normal', 'strict']);
    expect(contexts[2]?.strictReason).toBe('repeated_decision');
  });

  it('never returns to normal mode after strict recovery begins', async () => {
    const modes: FindingContractDecisionRecoveryMode[] = [];
    const request = vi.fn(async ({ recoveryContext }) => {
      modes.push(recoveryContext.mode);
      if (modes.length === 1) {
        throw validationError({ code: 'reference.unknown_part', category: 'reference' });
      }
      if (modes.length === 2) {
        throw validationError({
          code: 'decision_contract.different',
          raw: { decision: 'different', parts: [], fixCoverage: [], blockers: [] },
        });
      }
      return { decision: 'replan' };
    });

    await requestValidFindingContractDecision({ request });

    expect(modes).toEqual(['normal', 'strict', 'strict']);
  });

  it('does not merge the same issue code for different findings', async () => {
    const contexts: FindingContractDecisionRecoveryPromptContext[] = [];
    const findingIds = ['F-0001', 'F-0002', 'F-0003'];
    const request = vi.fn(async ({ recoveryContext }) => {
      contexts.push(recoveryContext);
      const findingId = findingIds[contexts.length - 1];
      if (findingId !== undefined) {
        throw validationError({
          code: 'decision_contract.missing_finding_coverage',
          path: `fixCoverage.finding:${findingId}`,
          findingId,
          raw: { decision: `invalid-${findingId}`, parts: [], fixCoverage: [], blockers: [] },
        });
      }
      return { decision: 'replan' };
    });

    await requestValidFindingContractDecision({ request });

    expect(contexts.map((context) => context.mode)).toEqual(['normal', 'normal', 'normal', 'strict']);
  });

  it('fingerprints equivalent issues independently of array index and display message', () => {
    const first = createFindingContractTeamLeaderDecisionValidationError({}, [
      createFindingContractDecisionValidationIssue({
        code: 'shape.finding_id',
        category: 'shape',
        path: 'fixCoverage[0].findingId',
        message: 'first display message',
      }),
    ]);
    const second = createFindingContractTeamLeaderDecisionValidationError({}, [
      createFindingContractDecisionValidationIssue({
        code: 'shape.finding_id',
        category: 'shape',
        path: 'fixCoverage[9].findingId',
        message: 'different display message',
      }),
    ]);

    expect(second.issueFingerprint).toBe(first.issueFingerprint);
  });

  it('does not collapse distinct long issue identities', () => {
    const prefix = 'x'.repeat(600);
    const first = createFindingContractTeamLeaderDecisionValidationError({}, [
      createFindingContractDecisionValidationIssue({
        code: 'reference.unknown_part',
        category: 'reference',
        path: 'parts',
        message: 'first',
        partId: `${prefix}A`,
      }),
    ]);
    const second = createFindingContractTeamLeaderDecisionValidationError({}, [
      createFindingContractDecisionValidationIssue({
        code: 'reference.unknown_part',
        category: 'reference',
        path: 'parts',
        message: 'second',
        partId: `${prefix}B`,
      }),
    ]);

    expect(second.issueFingerprint).not.toBe(first.issueFingerprint);
  });

  it('allows a valid result on the one-hundredth call', async () => {
    let calls = 0;
    const request = vi.fn(async () => {
      calls += 1;
      if (calls < FINDING_CONTRACT_DECISION_EMERGENCY_CALL_LIMIT) {
        throw validationError({
          code: `decision_contract.invalid_${calls}`,
          path: `attempt:${calls}`,
          raw: { decision: `invalid-${calls}`, parts: [], fixCoverage: [], blockers: [] },
        });
      }
      return { decision: 'complete' };
    });

    await expect(requestValidFindingContractDecision({ request })).resolves.toEqual({ decision: 'complete' });
    expect(request).toHaveBeenCalledTimes(FINDING_CONTRACT_DECISION_EMERGENCY_CALL_LIMIT);
  });

  it('stops after the one-hundredth invalid call without making call 101', async () => {
    const events: FindingContractDecisionAttemptEvent[] = [];
    const request = vi.fn(async () => {
      throw validationError({ code: 'decision_contract.invalid' });
    });

    await expect(requestValidFindingContractDecision({
      request,
      onAttempt: (event) => events.push(event),
    }))
      .rejects.toBeInstanceOf(FindingContractDecisionRecoveryExhaustedError);
    expect(request).toHaveBeenCalledTimes(FINDING_CONTRACT_DECISION_EMERGENCY_CALL_LIMIT);
    expect(events.at(-1)).toEqual(expect.objectContaining({
      type: 'terminated',
      attempt: 100,
      terminationReason: 'emergency_call_limit',
      terminationError: expect.objectContaining({
        name: 'FindingContractTeamLeaderDecisionValidationError',
      }),
    }));
  });

  it('does not retry provider or engine errors', async () => {
    const providerError = new Error('provider unavailable');
    const request = vi.fn().mockRejectedValue(providerError);
    const events: FindingContractDecisionAttemptEvent[] = [];

    await expect(requestValidFindingContractDecision({
      request,
      onAttempt: (event) => events.push(event),
    })).rejects.toBe(providerError);
    expect(request).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toEqual(expect.objectContaining({
      type: 'terminated',
      terminationReason: 'provider_or_engine_error',
      terminationError: {
        name: 'Error',
        message: 'provider unavailable',
      },
    }));
  });

  it('preserves the user abort reason during an in-flight request', async () => {
    const controller = new AbortController();
    const abortReason = new Error('user stopped the run');
    const request = vi.fn(async ({ abortSignal }: { abortSignal: AbortSignal }) => (
      await new Promise((_resolve, reject) => {
        abortSignal.addEventListener('abort', () => reject(abortSignal.reason), { once: true });
      })
    ));

    const result = requestValidFindingContractDecision({
      abortSignal: controller.signal,
      request,
    });
    controller.abort(abortReason);

    await expect(result).rejects.toBe(abortReason);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('prioritizes a parent abort reason when parent and deadline are both aborted', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const abortReason = new Error('parent abort wins');
    const request = vi.fn(async ({ abortSignal }: { abortSignal: AbortSignal }) => (
      await new Promise((_resolve, reject) => {
        abortSignal.addEventListener('abort', () => reject(abortSignal.reason), { once: true });
      })
    ));
    const result = requestValidFindingContractDecision({
      abortSignal: controller.signal,
      request,
    });
    const assertion = expect(result).rejects.toBe(abortReason);

    controller.abort(abortReason);
    await vi.advanceTimersByTimeAsync(FINDING_CONTRACT_DECISION_RECOVERY_DEADLINE_MS);

    await assertion;
  });

  it('aborts an in-flight request at the shared thirty-minute deadline', async () => {
    vi.useFakeTimers();
    const events: FindingContractDecisionAttemptEvent[] = [];
    const request = vi.fn(async ({ abortSignal }: { abortSignal: AbortSignal }) => (
      await new Promise((_resolve, reject) => {
        abortSignal.addEventListener('abort', () => reject(abortSignal.reason), { once: true });
      })
    ));
    const result = requestValidFindingContractDecision({
      request,
      onAttempt: (event) => events.push(event),
    });
    const assertion = expect(result).rejects.toBeInstanceOf(FindingContractDecisionRecoveryDeadlineError);

    await vi.advanceTimersByTimeAsync(FINDING_CONTRACT_DECISION_RECOVERY_DEADLINE_MS);

    await assertion;
    expect(request).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toEqual(expect.objectContaining({
      type: 'terminated',
      terminationReason: 'deadline',
      terminationError: expect.objectContaining({
        name: 'FindingContractDecisionRecoveryDeadlineError',
      }),
    }));
  });

  it('does not start another request after the absolute deadline when the timer callback is delayed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const events: FindingContractDecisionAttemptEvent[] = [];
    const request = vi.fn(async () => {
      vi.setSystemTime(FINDING_CONTRACT_DECISION_RECOVERY_DEADLINE_MS);
      throw validationError({
        code: 'shape.invalid',
        path: 'decision',
        raw: { decision: 'invalid', parts: [], fixCoverage: [], blockers: [] },
      });
    });

    await expect(requestValidFindingContractDecision({
      request,
      onAttempt: (event) => events.push(event),
    })).rejects.toBeInstanceOf(FindingContractDecisionRecoveryDeadlineError);

    expect(request).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toEqual(expect.objectContaining({
      type: 'terminated',
      attempt: 2,
      terminationReason: 'deadline',
    }));
  });

  it('disposes the deadline timer after a successful decision', async () => {
    vi.useFakeTimers();

    await requestValidFindingContractDecision({
      request: vi.fn().mockResolvedValue({ decision: 'complete' }),
    });

    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds visible issue history to the latest twenty unique issue sets', async () => {
    let finalContext: FindingContractDecisionRecoveryPromptContext | undefined;
    let calls = 0;
    await requestValidFindingContractDecision({
      request: async ({ recoveryContext }) => {
        calls += 1;
        if (calls <= 21) {
          throw validationError({
            code: `decision_contract.invalid_${calls}`,
            path: `issue:${calls}`,
            raw: { decision: `invalid-${calls}`, parts: [], fixCoverage: [], blockers: [] },
          });
        }
        finalContext = recoveryContext;
        return { decision: 'replan' };
      },
    });

    expect(finalContext?.issueHistory).toHaveLength(20);
    expect(finalContext?.issueHistory[0]?.issues[0]?.code).toBe('decision_contract.invalid_2');
    expect(finalContext?.issueHistory.at(-1)?.issues[0]?.code).toBe('decision_contract.invalid_21');
  });
});

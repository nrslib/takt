import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../shared/utils/private-file.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../shared/utils/private-file.js')>();
  return {
    ...actual,
    writeNewPrivateFileWithMode: vi.fn(actual.writeNewPrivateFileWithMode),
  };
});

import {
  writeNewPrivateFileWithMode,
} from '../shared/utils/private-file.js';
import { buildRunPaths, type RunPaths } from '../core/workflow/run/run-paths.js';
import {
  buildTeamLeaderAttemptArtifactDirectory,
} from '../core/workflow/engine/team-leader-artifacts.js';
import {
  recordFindingContractRecoveryAttempt,
} from '../core/workflow/engine/team-leader-finding-contract-recovery-recorder.js';
import type {
  FindingContractRecoveryAttemptEvent,
} from '../core/workflow/engine/team-leader-finding-contract-recovery.js';
import type { AgentResponse, PartDefinition } from '../core/models/types.js';
import {
  createFindingContractDecisionBoundaryAdapter,
  createFindingContractDecompositionBoundaryAdapter,
} from '../core/workflow/engine/team-leader-finding-contract-boundary-adapters.js';
import {
  FindingContractTeamLeaderDecisionValidationError,
} from '../core/workflow/team-leader-finding-contract-decision-validation.js';
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

describe('Finding Contract recovery recorder', () => {
  interface RejectedDigest {
    readonly hash: string;
    readonly preview: string;
    readonly full: string;
  }

  let root: string;
  let runPaths: RunPaths;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'takt-recovery-recorder-'));
    runPaths = buildRunPaths(root, 'run-1');
    vi.mocked(writeNewPrivateFileWithMode).mockClear();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function rejectedEvent(input: {
    raw: unknown;
    attemptToken?: string;
    envelopeAttemptToken?: string;
  }): FindingContractRecoveryAttemptEvent<RejectedDigest> {
    const attemptToken = input.attemptToken ?? 'attempt-token-2';
    return {
      boundaryKind: 'decision',
      type: 'rejected',
      attempt: 2,
      attemptToken,
      mode: 'strict',
      strictReason: 'evidence_or_reference_issue',
      elapsedMs: 250,
      remainingMs: 1_000,
      envelope: {
        raw: input.raw,
        attemptToken: input.envelopeAttemptToken ?? attemptToken,
        sessionId: 'session-1',
      },
      rejectedOutput: {
        attempt: 2,
        mode: 'strict',
        issueFingerprint: 'issue-fingerprint',
        repeatCount: 2,
        issues: [{
          boundaryKind: 'decision',
          code: 'decision.invalid',
          category: 'decision_contract',
          path: 'decision',
          message: 'invalid decision',
          retryability: 'corrective_retry',
        }],
        outputDigest: {
          hash: 'validation-digest',
          preview: 'digest preview must not be audited',
          full: 'digest full value must not be audited',
        },
      },
    };
  }

  function attemptDirectory(): ReturnType<typeof buildTeamLeaderAttemptArtifactDirectory> {
    return buildTeamLeaderAttemptArtifactDirectory({
      runPaths,
      stepName: '../../fix',
      attemptId: '../../attempt',
    });
  }

  function auditPath(): string {
    return join(attemptDirectory().absoluteDirectory, 'finding-contract-recovery.jsonl');
  }

  function record(event: FindingContractRecoveryAttemptEvent<RejectedDigest>): void {
    recordFindingContractRecoveryAttempt({
      runPaths,
      stepName: '../../fix',
      attemptId: '../../attempt',
      boundaryId: '../../boundary',
      event,
    });
  }

  it('stores rejected raw output as an atomic private artifact referenced by the audit record', () => {
    const secret = 'raw-secret-value';
    const raw = { decision: 'invalid', secret, nested: { complete: true } };

    record(rejectedEvent({ raw }));

    const auditText = readFileSync(auditPath(), 'utf8');
    expect(auditText).not.toContain(secret);
    expect(auditText).not.toContain('digest preview must not be audited');
    expect(auditText).not.toContain('digest full value must not be audited');
    expect(auditText).not.toContain('"preview"');
    const audit = JSON.parse(auditText) as {
      boundaryId: string;
      attemptToken: string;
      rawOutputDigest?: unknown;
      rawOutputArtifact: { path: string; sha256: string; bytes: number };
      rejectedDecision: { outputDigest: Record<string, unknown> };
    };
    expect(audit.boundaryId).toBe('../../boundary');
    expect(audit.attemptToken).toBe('attempt-token-2');
    expect(audit.rawOutputDigest).toBeUndefined();
    expect(audit.rejectedDecision.outputDigest).toEqual({ hash: 'validation-digest' });

    const artifactPath = join(root, audit.rawOutputArtifact.path);
    const content = readFileSync(artifactPath, 'utf8');
    expect(JSON.parse(content)).toEqual(raw);
    expect(audit.rawOutputArtifact).toEqual({
      path: expect.stringMatching(/finding-contract-rejected-[a-f0-9]{64}\.json$/),
      sha256: createHash('sha256').update(content).digest('hex'),
      bytes: Buffer.byteLength(content),
    });
    if (process.platform !== 'win32') {
      expect(statSync(artifactPath).mode & 0o777).toBe(0o600);
    }
    expect(writeNewPrivateFileWithMode).toHaveBeenCalledWith(artifactPath, content, 0o600);
  });

  it('keeps traversal-shaped identifiers out of the artifact path', () => {
    record(rejectedEvent({
      raw: { decision: 'invalid' },
      attemptToken: '../../../../token',
      envelopeAttemptToken: '../../../../token',
    }));

    const audit = JSON.parse(readFileSync(auditPath(), 'utf8')) as {
      rawOutputArtifact: { path: string };
    };
    const artifactPath = resolve(root, audit.rawOutputArtifact.path);
    const expectedRoot = `${resolve(attemptDirectory().absoluteDirectory)}${sep}`;
    expect(artifactPath.startsWith(expectedRoot)).toBe(true);
    expect(audit.rawOutputArtifact.path).not.toContain('../../boundary');
    expect(audit.rawOutputArtifact.path).not.toContain('../../../../token');
  });

  it('fails before appending another audit record when the artifact name conflicts', () => {
    const event = rejectedEvent({ raw: { decision: 'invalid' } });
    record(event);

    expect(() => record(event)).toThrow('Private artifact file already exists');
    expect(readFileSync(auditPath(), 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('fails without an audit reference when private artifact publication fails', () => {
    vi.mocked(writeNewPrivateFileWithMode).mockImplementationOnce(() => {
      throw new Error('injected artifact write failure');
    });

    expect(() => record(rejectedEvent({ raw: { decision: 'invalid' } })))
      .toThrow('injected artifact write failure');
    expect(existsSync(auditPath())).toBe(false);
  });

  it('fails when the event and envelope attempt tokens do not match', () => {
    expect(() => record(rejectedEvent({
      raw: { decision: 'invalid' },
      attemptToken: 'event-token',
      envelopeAttemptToken: 'other-token',
    }))).toThrow('Finding Contract recovery event attempt token does not match its envelope');
    expect(existsSync(auditPath())).toBe(false);
  });

  it('preserves accepted and terminated audit metadata without embedding output previews', () => {
    const accepted: FindingContractRecoveryAttemptEvent<RejectedDigest> = {
      boundaryKind: 'decision',
      type: 'accepted',
      attempt: 3,
      attemptToken: 'accepted-token',
      mode: 'strict',
      strictReason: 'repeated_output',
      elapsedMs: 500,
      remainingMs: 750,
      envelope: {
        raw: { decision: 'complete', secret: 'accepted-raw-secret' },
        attemptToken: 'accepted-token',
        sessionId: 'session-accepted',
      },
      acceptedValue: { decision: 'complete', secret: 'accepted-value-secret' },
    };
    const terminated: FindingContractRecoveryAttemptEvent<RejectedDigest> = {
      boundaryKind: 'decision',
      type: 'terminated',
      attempt: 4,
      attemptToken: 'terminated-token',
      mode: 'strict',
      elapsedMs: 750,
      remainingMs: 0,
      terminationReason: 'deadline',
      terminationError: {
        name: 'FindingContractRecoveryDeadlineError',
        message: 'deadline reached',
      },
    };

    record(accepted);
    record(terminated);

    const auditText = readFileSync(auditPath(), 'utf8');
    expect(auditText).not.toContain('accepted-raw-secret');
    expect(auditText).not.toContain('accepted-value-secret');
    expect(auditText).not.toContain('"preview"');
    const records = auditText.trim().split('\n').map((line) => JSON.parse(line) as {
      type: string;
      rawOutputDigest?: { hash: string };
      normalizedOutputDigest?: { hash: string };
      sessionId?: string;
      terminationReason?: string;
      terminationError?: { name: string; message: string };
    });
    expect(records[0]).toEqual(expect.objectContaining({
      type: 'accepted',
      sessionId: 'session-accepted',
      rawOutputDigest: { hash: expect.stringMatching(/^[a-f0-9]{64}$/) },
      normalizedOutputDigest: { hash: expect.stringMatching(/^[a-f0-9]{64}$/) },
    }));
    expect(records[1]).toEqual(expect.objectContaining({
      type: 'terminated',
      terminationReason: 'deadline',
      terminationError: {
        name: 'FindingContractRecoveryDeadlineError',
        message: 'deadline reached',
      },
    }));
    expect(writeNewPrivateFileWithMode).not.toHaveBeenCalled();
  });
});

describe('Finding Contract control boundary adapters', () => {
  const validPart: PartDefinition = {
    id: 'repair-f1',
    title: 'Repair F1',
    instruction: 'Repair the assigned finding',
    findingContract: {
      findingIds: ['F-0001'],
      role: 'repair',
      readPaths: ['src/file.ts'],
    },
  };

  function rawResponse(
    structuredOutput: Record<string, unknown>,
    sessionId: string,
  ): AgentResponse {
    return {
      persona: 'leader',
      status: 'done',
      content: JSON.stringify(structuredOutput),
      structuredOutput,
      sessionId,
      providerUsage: { usageMissing: false, totalTokens: 12 },
      timestamp: new Date(),
    };
  }

  it('keeps invalid decomposition raw/session/usage in the common recovery protocol', async () => {
    const requestRaw = vi.fn()
      .mockResolvedValueOnce(rawResponse({
        parts: [{
          id: '',
          title: '',
          instruction: '',
          findingContract: {},
        }],
      }, 'session-invalid'))
      .mockResolvedValueOnce(rawResponse({ parts: [validPart] }, 'session-valid'));
    const rejectedEvents: Array<{
      readonly sessionId?: string;
      readonly totalTokens?: number;
      readonly issueCount: number;
    }> = [];

    const result = await requestValidFindingContractControlOutput({
      adapter: createFindingContractDecompositionBoundaryAdapter({
        requestRaw,
        maxInitialParts: 4,
        targetFindingIds: ['F-0001'],
      }),
      onAttempt: (event) => {
        if (event.type !== 'rejected') return;
        rejectedEvents.push({
          sessionId: event.envelope?.sessionId,
          totalTokens: event.envelope?.usage?.totalTokens,
          issueCount: event.rejectedOutput?.issues.length ?? 0,
        });
      },
    });

    expect(result.parts).toEqual([validPart]);
    expect(rejectedEvents).toEqual([{
      sessionId: 'session-invalid',
      totalTokens: 12,
      issueCount: expect.any(Number),
    }]);
    expect(rejectedEvents[0]?.issueCount).toBeGreaterThan(1);
  });

  it('returns an unvalidated decision envelope before aggregating all schema issues', async () => {
    const adapter = createFindingContractDecisionBoundaryAdapter({
      requestRaw: async () => rawResponse({
        decision: 'invalid',
        extra: true,
      }, 'decision-session'),
      validationContext: {
        targetFindingIds: ['F-0001'],
        plannedParts: [validPart],
        evidence: {
          entries: [],
          findings: [],
        },
      },
    });

    const envelope = await adapter.requestOnce({
      recoveryContext: {
        boundaryKind: 'decision',
        attempt: 1,
        maxCalls: 100,
        mode: 'normal',
        recentRejectedOutputs: [],
        issueHistory: [],
      },
      abortSignal: new AbortController().signal,
      attemptToken: 'decision:1',
    });

    expect(envelope).toEqual(expect.objectContaining({
      attemptToken: 'decision:1',
      sessionId: 'decision-session',
      usage: expect.objectContaining({ totalTokens: 12 }),
    }));
    expect(() => adapter.validate(envelope)).toThrow(
      FindingContractTeamLeaderDecisionValidationError,
    );
    try {
      adapter.validate(envelope);
    } catch (error) {
      if (!(error instanceof FindingContractTeamLeaderDecisionValidationError)) throw error;
      expect(error.issues.length).toBeGreaterThan(1);
      expect(error.issues.every((issue) => issue.category === 'shape')).toBe(true);
    }
  });

  it('stops decomposition recovery on a provider stream parse failure', async () => {
    const parseResponse: AgentResponse = {
      persona: 'leader',
      status: 'error',
      content: '',
      error: 'provider stream parse error: Failed to parse item: decomposition',
      failureCategory: 'provider_stream_parse_error',
      timestamp: new Date(),
    };
    const requestRaw = vi.fn().mockResolvedValue(parseResponse);

    await expect(requestValidFindingContractControlOutput({
      adapter: createFindingContractDecompositionBoundaryAdapter({
        requestRaw,
        maxInitialParts: 4,
        targetFindingIds: ['F-0001'],
      }),
    })).rejects.toMatchObject({
      name: 'ProviderStreamParseError',
      failureCategory: 'provider_stream_parse_error',
      reason: 'Failed to parse item: decomposition',
      message: 'provider stream parse error: Failed to parse item: decomposition',
    });
    expect(requestRaw).toHaveBeenCalledOnce();
  });

  it('stops decision recovery on a provider stream parse failure', async () => {
    const parseResponse: AgentResponse = {
      persona: 'leader',
      status: 'error',
      content: '',
      error: 'provider stream parse error: Failed to parse item: decision',
      failureCategory: 'provider_stream_parse_error',
      timestamp: new Date(),
    };
    const requestRaw = vi.fn().mockResolvedValue(parseResponse);

    await expect(requestValidFindingContractControlOutput({
      adapter: createFindingContractDecisionBoundaryAdapter({
        requestRaw,
        validationContext: {
          targetFindingIds: ['F-0001'],
          plannedParts: [validPart],
          evidence: { entries: [], findings: [] },
        },
      }),
    })).rejects.toMatchObject({
      name: 'ProviderStreamParseError',
      failureCategory: 'provider_stream_parse_error',
      reason: 'Failed to parse item: decision',
      message: 'provider stream parse error: Failed to parse item: decision',
    });
    expect(requestRaw).toHaveBeenCalledOnce();
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { AgentResponse, PartDefinition } from '../core/models/types.js';
import {
  createFindingContractDecisionBoundaryAdapter,
  createFindingContractDecompositionBoundaryAdapter,
} from '../core/workflow/engine/team-leader-finding-contract-boundary-adapters.js';
import {
  requestValidFindingContractControlOutput,
} from '../core/workflow/engine/team-leader-finding-contract-recovery.js';
import {
  FindingContractTeamLeaderDecisionValidationError,
} from '../core/workflow/team-leader-finding-contract-decision-validation.js';

const validPart: PartDefinition = {
  id: 'repair-f1',
  title: 'Repair F1',
  instruction: 'Repair the assigned finding',
  findingContract: {
    findingIds: ['F-0001'],
    role: 'repair',
    writePaths: ['src/file.ts'],
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

describe('Finding Contract control boundary adapters', () => {
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
});

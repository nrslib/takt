import { describe, expect, it, vi } from 'vitest';
import {
  moderateCompanionResult,
  validateModeratorDecisions,
} from '../core/workflow/companion/moderator.js';
import { executeCompanionReviewRound } from '../core/workflow/companion/review-round.js';

const reviewerResult = {
  findings: [
    { severity: 'must_fix' as const, file: 'src/a.ts', line: 1, finding: 'first' },
    { severity: 'nit' as const, file: 'src/b.ts', line: 2, finding: 'second' },
  ],
};

const moderatorEvidence = {
  task: 'implement the requested contract',
  baselineSha: 'base-123',
};

describe('companion moderator', () => {
  it('returns only accepted findings from the current round', async () => {
    const result = await moderateCompanionResult({
      reviewerResult,
      ...moderatorEvidence,
      runModerator: vi.fn().mockResolvedValue({
        findings: [
          { action: 'accept', sourceIndex: 0 },
          { action: 'reject', sourceIndex: 1 },
        ],
      }),
    });

    expect(result?.accepted.findings).toEqual([reviewerResult.findings[0]]);
  });

  it('does not invoke a moderator for an empty reviewer list', async () => {
    const runModerator = vi.fn();
    const result = await moderateCompanionResult({
      reviewerResult: { findings: [] },
      ...moderatorEvidence,
      runModerator,
    });

    expect(result).toBeUndefined();
    expect(runModerator).not.toHaveBeenCalled();
  });

  it('passes baseline context to both calls without injecting the diff body', async () => {
    const diffBody = '+const changed = true;';
    const reviewerPrompts: string[] = [];
    const moderatorPrompts: string[] = [];

    await executeCompanionReviewRound({
      companionName: 'reviewer',
      diff: {
        digest: 'digest-1',
        changedLines: 1,
        content: diffBody,
        changedFiles: ['src/a.ts'],
        fileFingerprints: { 'src/a.ts': 'fingerprint' },
        hunkFingerprints: { 'src/a.ts:1': 'hunk' },
        omittedBytes: 0,
        truncated: false,
      },
      trigger: 'completion',
      observedGeneration: 1,
      baselineSha: moderatorEvidence.baselineSha,
      signal: new AbortController().signal,
      task: moderatorEvidence.task,
      stepName: 'implement',
      moderatorName: 'moderator',
      mailboxPath: '/unused/rejected-findings.jsonl',
      systemPrompt: (name) => name,
      callStructured: async (purpose, _agentName, _systemPrompt, prompt) => {
        if (purpose === 'reviewer') {
          reviewerPrompts.push(prompt);
          return { status: 'done', content: 'review', structuredOutput: reviewerResult };
        }
        moderatorPrompts.push(prompt);
        return {
          status: 'done',
          content: 'moderate',
          structuredOutput: {
            findings: reviewerResult.findings.map((_, sourceIndex) => ({
              action: 'reject',
              sourceIndex,
            })),
          },
        };
      },
      emitFinding: () => undefined,
      markReviewed: () => undefined,
      onRoundCompleted: () => undefined,
    });

    expect(reviewerPrompts).toHaveLength(1);
    expect(moderatorPrompts).toHaveLength(1);
    expect(reviewerPrompts[0]).toContain('base-123');
    expect(reviewerPrompts[0]).not.toContain(diffBody);
    expect(reviewerPrompts[0]).toContain('git diff <baseline_sha>');
    expect(moderatorPrompts[0]).toContain(
      '"label":"task","value":"implement the requested contract"',
    );
    expect(moderatorPrompts[0]).toContain('base-123');
    expect(moderatorPrompts[0]).not.toContain(diffBody);
    expect(moderatorPrompts[0]).toContain('verify each submitted finding');
  });

  it.each([
    {
      decisions: [{ action: 'accept' as const, sourceIndex: 0 }],
      message: 'exactly once',
    },
    {
      decisions: [
        { action: 'accept' as const, sourceIndex: 0 },
        { action: 'reject' as const, sourceIndex: 0 },
      ],
      message: 'more than once',
    },
    {
      decisions: [
        { action: 'accept' as const, sourceIndex: 0 },
        { action: 'reject' as const, sourceIndex: 3 },
      ],
      message: 'unknown finding index',
    },
  ])('validates sourceIndex cardinality: $message', ({ decisions, message }) => {
    expect(() => validateModeratorDecisions({ findings: decisions }, reviewerResult))
      .toThrow(message);
  });
});

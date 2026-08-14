import { describe, expect, it } from 'vitest';
import {
  buildCompanionModeratorPrompt,
  buildCompanionReviewPrompt,
} from '../core/workflow/companion/prompt.js';
import { buildCompanionFollowUpInstruction } from '../core/workflow/companion/evidence.js';

describe('companion prompt contract', () => {
  it('reviews only the current diff without prior finding state', () => {
    const prompt = buildCompanionReviewPrompt({
      companionName: 'security-reviewer',
      task: 'implement',
      stepName: 'code',
      cumulativeDiff: '+change',
      changedSincePreviousReview: ['src/a.ts:1-2'],
      diffSummary: 'one file',
      implementerExplanation: 'done',
    });

    expect(prompt).toContain('cumulative_diff');
    expect(prompt).not.toContain('prior_findings');
    expect(prompt).not.toContain('prior_notes');
    expect(prompt).not.toContain('open_findings');
  });

  it('gives the moderator only the current reviewer result', () => {
    const prompt = buildCompanionModeratorPrompt({
      reviewerResult: {
        findings: [{ severity: 'nit', file: 'src/a.ts', line: 1, finding: 'rename' }],
      },
      diffSummary: 'one file',
    });

    expect(prompt).toContain('reviewer_result');
    expect(prompt).not.toContain('open_findings');
  });

  it('embeds only newly delivered engine-owned rows in the follow-up prompt', () => {
    const prompt = buildCompanionFollowUpInstruction([{
      companion: 'security-reviewer',
      reviewedAt: '2026-08-14T00:00:00.000Z',
      reviewedDigest: 'digest-1',
      severity: 'should_fix',
      file: 'src/a.ts',
      line: 2,
      finding: 'verify this claim',
    }]);

    expect(prompt).toContain('new_companion_findings');
    expect(prompt).toContain('digest-1');
    expect(prompt).toContain('decide whether to act');
    expect(prompt).toContain('explain why');
  });
});

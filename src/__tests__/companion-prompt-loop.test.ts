import { describe, expect, it } from 'vitest';
import {
  buildCompanionModeratorPrompt,
  buildCompanionReviewPrompt,
} from '../core/workflow/companion/prompt.js';
import { buildCompanionFollowUpInstruction } from '../core/workflow/companion/evidence.js';
import { COMPANION_PROMPT_LIMITS } from '../core/workflow/companion/limits.js';

describe('companion prompt behavior', () => {
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

    expect(prompt).not.toContain('prior_findings');
    expect(prompt).not.toContain('prior_notes');
    expect(prompt).not.toContain('open_findings');
  });

  it('embeds the current task, step, and review evidence in the review prompt', () => {
    const task = 'refactor the companion runtime';
    const stepName = 'implement-step';
    const changedPaths = ['src/a.ts:1-2', 'src/b.ts:4-5'];
    const diffSummary = 'two files changed';
    const explanation = 'centralized prompt capacity checks';
    const prompt = buildCompanionReviewPrompt({
      companionName: 'architecture-reviewer',
      task,
      stepName,
      cumulativeDiff: '+const changed = true;',
      changedSincePreviousReview: changedPaths,
      diffSummary,
      implementerExplanation: explanation,
    });

    for (const value of [task, stepName, ...changedPaths, diffSummary, explanation]) {
      expect(prompt).toContain(value);
    }
  });

  it('gives the moderator the current reviewer result and its verification evidence', () => {
    const task = 'implement the requested change';
    const diff = '+const changed = true;';
    const prompt = buildCompanionModeratorPrompt({
      reviewerResult: {
        findings: [{ severity: 'nit', file: 'src/a.ts', line: 1, finding: 'rename' }],
      },
      task,
      cumulativeDiff: diff,
      diffSummary: 'one file',
    });

    expect(prompt).toContain('rename');
    expect(prompt).toContain(task);
    expect(prompt).toContain(diff);
    expect(prompt).not.toContain('open_findings');
  });

  it('embeds only newly delivered engine-owned rows in the follow-up prompt', () => {
    const severity = 'should_fix';
    const prompt = buildCompanionFollowUpInstruction([{
      companion: 'security-reviewer',
      reviewedAt: '2026-08-14T00:00:00.000Z',
      reviewedDigest: 'digest-1',
      severity,
      file: 'src/a.ts',
      line: 2,
      finding: 'verify this claim',
    }]);

    expect(prompt).toContain('digest-1');
    expect(prompt).toContain(severity);
  });

  it('rejects a follow-up prompt that exceeds companion prompt capacity', () => {
    let thrown: unknown;
    try {
      buildCompanionFollowUpInstruction([{
        companion: 'security-reviewer',
        reviewedAt: '2026-08-14T00:00:00.000Z',
        reviewedDigest: 'digest-1',
        severity: 'must_fix',
        file: 'src/a.ts',
        line: 1,
        finding: 'x'.repeat(COMPANION_PROMPT_LIMITS.maxPromptBytes),
      }]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(String(thrown)).toContain(String(COMPANION_PROMPT_LIMITS.maxPromptBytes));
  });
});

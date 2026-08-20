import { describe, expect, it } from 'vitest';
import {
  buildCompanionModeratorPrompt,
  buildCompanionReviewPrompt,
} from '../core/workflow/companion/prompt.js';
import { buildCompanionFollowUpInstruction } from '../core/workflow/companion/evidence.js';
import { COMPANION_PROMPT_LIMITS } from '../core/workflow/companion/limits.js';

describe('companion prompt behavior', () => {
  it('reviews the current repository from a baseline without prior finding state', () => {
    const diffBody = '+change that must not be injected';
    const prompt = buildCompanionReviewPrompt({
      companionName: 'security-reviewer',
      task: 'implement',
      stepName: 'code',
      baselineSha: 'base-123',
      implementerExplanation: 'done',
    });

    expect(prompt).not.toContain('prior_findings');
    expect(prompt).not.toContain('prior_notes');
    expect(prompt).not.toContain('open_findings');
    expect(prompt).not.toContain(diffBody);
    expect(prompt).toContain('base-123');
    expect(prompt).toContain('read-only repository tools');
    expect(prompt).toContain('git diff <baseline_sha>');
  });

  it('embeds the current task, step, and review evidence in the review prompt', () => {
    const task = 'refactor the companion runtime';
    const stepName = 'implement-step';
    const summaryContext = 'two files changed';
    const changedPath = 'src/a.ts:1-2';
    const explanation = 'centralized prompt capacity checks';
    const prompt = buildCompanionReviewPrompt({
      companionName: 'architecture-reviewer',
      task,
      stepName,
      baselineSha: 'base-456',
      implementerExplanation: explanation,
    });

    for (const value of [task, stepName, explanation]) {
      expect(prompt).toContain(value);
    }
    expect(prompt).not.toContain(changedPath);
    expect(prompt).not.toContain(summaryContext);
  });

  it('gives the moderator the current reviewer result and its verification evidence', () => {
    const task = 'implement the requested change';
    const diffBody = '+const changed = true;';
    const prompt = buildCompanionModeratorPrompt({
      reviewerResult: {
        findings: [{ severity: 'nit', file: 'src/a.ts', line: 1, finding: 'rename' }],
      },
      task,
      baselineSha: 'base-789',
    });

    expect(prompt).toContain('rename');
    expect(prompt).toContain(task);
    expect(prompt).not.toContain(diffBody);
    expect(prompt).toContain('base-789');
    expect(prompt).toContain('verify each submitted finding');
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

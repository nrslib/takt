import { describe, expect, it } from 'vitest';
import {
  buildCompanionModeratorPrompt,
  buildCompanionReviewPrompt,
} from '../core/workflow/companion/prompt.js';
import { buildCompanionFollowUpInstruction } from '../core/workflow/companion/evidence.js';
import { COMPANION_PROMPT_LIMITS } from '../core/workflow/companion/limits.js';

describe('companion prompt behavior', () => {
  it('reviews the current repository from a baseline without prior finding state', () => {
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
    expect(prompt).toContain('"label":"companion_name","value":"security-reviewer"');
    expect(prompt).toContain('"label":"task","value":"implement"');
    expect(prompt).toContain('"label":"step_name","value":"code"');
    expect(prompt).toContain('"label":"baseline_sha","value":"base-123"');
    expect(prompt).toContain('`git diff base-123 --`');
  });

  it('embeds the current task, step, and review evidence in the review prompt', () => {
    const task = 'refactor the companion runtime';
    const stepName = 'implement-step';
    const explanation = 'centralized prompt capacity checks';
    const prompt = buildCompanionReviewPrompt({
      companionName: 'architecture-reviewer',
      task,
      stepName,
      baselineSha: 'base-456',
      implementerExplanation: explanation,
    });

    expect(prompt).toContain(`"label":"task","value":"${task}"`);
    expect(prompt).toContain(`"label":"step_name","value":"${stepName}"`);
    expect(prompt).toContain('"label":"baseline_sha","value":"base-456"');
    expect(prompt).toContain(
      '"label":"implementer_explanation","value":"centralized prompt capacity checks"',
    );
  });

  it('gives the moderator the current reviewer result and its verification evidence', () => {
    const prompt = buildCompanionModeratorPrompt({
      reviewerResult: {
        findings: [{ severity: 'nit', file: 'src/a.ts', line: 1, finding: 'rename' }],
      },
      task: 'implement the requested change',
      baselineSha: 'base-789',
    });

    expect(prompt).toContain('"label":"reviewer_result"');
    expect(prompt).toContain('"finding":"rename"');
    expect(prompt).toContain(
      '"label":"task","value":"implement the requested change"',
    );
    expect(prompt).toContain('"label":"baseline_sha","value":"base-789"');
    expect(prompt).toContain('`git diff base-789 --`');
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

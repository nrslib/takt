import { describe, expect, it } from 'vitest';
import type { WorkflowStep } from '../core/models/types.js';
import { InstructionBuilder } from '../core/workflow/instruction/InstructionBuilder.js';
import type { InstructionContext } from '../core/workflow/instruction/instruction-context.js';

const step = {
  kind: 'agent',
  name: 'review',
  persona: 'reviewer',
  instruction: 'Review the implementation.',
  edit: false,
} as WorkflowStep;

function buildContext(prContext?: InstructionContext['prContext']): InstructionContext {
  return {
    task: 'Review PR changes',
    iteration: 1,
    maxSteps: 5,
    stepIteration: 1,
    cwd: '/tmp/worktree',
    projectCwd: '/tmp/project',
    userInputs: [],
    language: 'en',
    ...(prContext ? { prContext } : {}),
  };
}

describe('InstructionBuilder PR context', () => {
  it('injects the resolved PR base-to-head range into Phase 1', () => {
    const instruction = new InstructionBuilder(step, buildContext({
      source: 'pr_review',
      prNumber: 861,
      baseBranch: 'release/2026.07',
      headBranch: 'feature/pr-context',
      baseBranchSource: 'pull_request',
      baseDiffRef: 'refs/heads/release/2026.07',
      headDiffRef: 'refs/heads/feature/pr-context',
    })).build();

    expect(instruction).toContain('## PR Context');
    expect(instruction).toContain(
      'refs/heads/release/2026.07...refs/heads/feature/pr-context',
    );
    expect(instruction).toContain('review-target.md');
  });

  it('keeps normal task prompts free of PR-only guidance', () => {
    const instruction = new InstructionBuilder(step, buildContext()).build();

    expect(instruction).not.toContain('## PR Context');
    expect(instruction).not.toContain('review-target.md');
  });
});

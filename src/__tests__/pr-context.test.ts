import { describe, expect, it } from 'vitest';
import {
  createPullRequestContext,
  decodePullRequestContext,
  encodePullRequestContext,
  renderPullRequestContext,
} from '../core/workflow/pr-context.js';

describe('PullRequestContext', () => {
  const context = {
    source: 'pr_review' as const,
    prNumber: 861,
    baseBranch: 'release/2026.07',
    headBranch: 'feature/saved-pr-head',
    baseBranchSource: 'pull_request' as const,
  };

  it.each(['en', 'ja'] as const)('renders the saved base-to-head range in %s', (language) => {
    const rendered = renderPullRequestContext(context, language);

    expect(rendered).toContain('release/2026.07...feature/saved-pr-head');
    expect(rendered).toContain('review-target.md');
    expect(rendered).not.toContain('release/2026.07...HEAD');
  });

  it('states when the default branch was used as a fallback', () => {
    const rendered = renderPullRequestContext({
      ...context,
      baseBranch: 'main',
      baseBranchSource: 'default_branch_fallback',
    }, 'en');

    expect(rendered).toContain('default branch is being used as the base');
  });

  it('validates and snapshots PR context values', () => {
    const input = { ...context };
    const snapshot = createPullRequestContext(input);
    input.baseBranch = 'release/changed';

    expect(snapshot.baseBranch).toBe('release/2026.07');
    expect(() => createPullRequestContext({ ...context, prNumber: 0 })).toThrow(/positive safe integer/);
    expect(() => createPullRequestContext({ ...context, headBranch: ' origin/main' })).toThrow(/branch/i);
    expect(() => createPullRequestContext({ ...context, headBranch: 'HEAD' })).toThrow(/pseudo-ref/i);
  });

  it('encodes and decodes only the strict snake_case persisted form', () => {
    const persisted = encodePullRequestContext(context);

    expect(persisted).toEqual({
      source: 'pr_review',
      pr_number: 861,
      base_branch: 'release/2026.07',
      head_branch: 'feature/saved-pr-head',
      base_branch_source: 'pull_request',
    });
    expect(decodePullRequestContext(persisted)).toEqual(context);
    expect(() => decodePullRequestContext({ ...persisted, prNumber: 861 })).toThrow(/snake_case/);
    expect(() => decodePullRequestContext({ ...persisted, head_branch: 'HEAD' })).toThrow(/snake_case/);
  });
});

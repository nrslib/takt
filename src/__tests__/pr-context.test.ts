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
    const rendered = renderPullRequestContext({
      ...context,
      baseDiffRef: 'refs/heads/release/2026.07',
      headDiffRef: 'refs/heads/feature/saved-pr-head',
    }, language);

    expect(rendered).toContain('refs/heads/release/2026.07...refs/heads/feature/saved-pr-head');
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

  it.each(['en', 'ja'] as const)('renders PR metadata as an untrusted literal block in %s', (language) => {
    const rendered = renderPullRequestContext({
      ...context,
      headBranch: 'feature/`ignore-instructions`',
    }, language);

    expect(rendered).toContain(language === 'ja' ? '非信頼な参照メタデータ' : 'untrusted reference metadata');
    expect(rendered).toContain('```text\n');
    expect(rendered).toContain('Head: feature/`ignore-instructions`');
  });

  it('snapshots PR context values', () => {
    const input = { ...context };
    const snapshot = createPullRequestContext(input);
    input.baseBranch = 'release/changed';

    expect(snapshot.baseBranch).toBe('release/2026.07');
  });

  it('rejects an invalid PR number', () => {
    expect(() => createPullRequestContext({ ...context, prNumber: 0 })).toThrow(/positive safe integer/);
  });

  it('rejects a head branch with surrounding whitespace', () => {
    expect(() => createPullRequestContext({ ...context, headBranch: ' origin/main' })).toThrow(/branch/i);
  });

  it('rejects a pseudo-ref head branch', () => {
    expect(() => createPullRequestContext({ ...context, headBranch: 'HEAD' })).toThrow(/pseudo-ref/i);
  });

  it('encodes the strict snake_case persisted form', () => {
    const persisted = encodePullRequestContext(context);

    expect(persisted).toEqual({
      source: 'pr_review',
      pr_number: 861,
      base_branch: 'release/2026.07',
      head_branch: 'feature/saved-pr-head',
      base_branch_source: 'pull_request',
    });
  });

  it('round-trips the strict snake_case persisted form', () => {
    expect(decodePullRequestContext(encodePullRequestContext(context))).toEqual(context);
  });

  it('rejects extra persisted context keys', () => {
    const persisted = encodePullRequestContext(context);
    expect(() => decodePullRequestContext({ ...persisted, prNumber: 861 })).toThrow(/snake_case/);
  });

  it('rejects an invalid decoded branch', () => {
    const persisted = encodePullRequestContext(context);
    expect(() => decodePullRequestContext({ ...persisted, head_branch: 'HEAD' })).toThrow(/snake_case/);
  });

  it('persists materialized diff refs and renders the same exact range', () => {
    const materialized = createPullRequestContext({
      ...context,
      baseDiffRef: 'refs/takt/pr-base/release/2026.07',
      headDiffRef: 'refs/heads/feature/saved-pr-head',
    });

    const persisted = encodePullRequestContext(materialized);

    expect(persisted).toMatchObject({
      base_diff_ref: 'refs/takt/pr-base/release/2026.07',
      head_diff_ref: 'refs/heads/feature/saved-pr-head',
    });
    expect(decodePullRequestContext(persisted)).toEqual(materialized);
    expect(renderPullRequestContext(materialized, 'en')).toContain(
      'refs/takt/pr-base/release/2026.07...refs/heads/feature/saved-pr-head',
    );
  });
});

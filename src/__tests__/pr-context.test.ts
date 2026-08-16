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
  });

  it('keeps untrusted branch metadata inside a fence wider than any embedded backticks', () => {
    const headBranch = 'feature/```untrusted```';
    const rendered = renderPullRequestContext({ ...context, headBranch }, 'en');
    const lines = rendered.split('\n');
    const openingIndex = lines.findIndex((line) => /^`{3,}text$/.test(line));
    const closingIndex = lines.findIndex((line, index) => index > openingIndex && /^`{3,}$/.test(line));
    const longestEmbeddedFence = Math.max(...[...headBranch.matchAll(/`+/g)].map((match) => match[0].length));

    expect(openingIndex).toBeGreaterThanOrEqual(0);
    expect(closingIndex).toBeGreaterThan(openingIndex);
    expect(lines.slice(openingIndex + 1, closingIndex).join('\n')).toContain(headBranch);
    expect(lines[closingIndex]!.length).toBeGreaterThan(longestEmbeddedFence);
  });
});

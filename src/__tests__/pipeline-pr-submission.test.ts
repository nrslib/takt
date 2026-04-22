import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockBuildPrBody = vi.fn(() => 'Default PR body');
const mockBuildTaktManagedPrOptions = vi.fn((body: string) => ({
  body: `${body}\n\n<!-- takt:managed -->`,
  labels: ['takt-managed'],
}));
const mockCreatePullRequest = vi.fn();
const mockExpandPipelineTemplate = vi.fn();
const mockCreatePullRequestSafely = vi.fn((
  provider: { createPullRequest: (options: unknown, cwd: string) => unknown },
  options: unknown,
  cwd: string,
) => provider.createPullRequest(options, cwd));

vi.mock('../features/pipeline/templateExpander.js', () => ({
  expandPipelineTemplate: (...args: unknown[]) =>
    mockExpandPipelineTemplate(...(args as [string, Record<string, string>])),
}));

vi.mock('../infra/git/index.js', () => ({
  buildPrBody: (...args: unknown[]) => mockBuildPrBody(...args),
  buildTaktManagedPrOptions: (...args: unknown[]) => mockBuildTaktManagedPrOptions(...(args as [string])),
  createPullRequestSafely: (...args: unknown[]) => mockCreatePullRequestSafely(...args),
  getGitProvider: () => ({
    createPullRequest: (...args: unknown[]) => mockCreatePullRequest(...args),
  }),
}));

const mockInfo = vi.fn();
const mockError = vi.fn();
const mockSuccess = vi.fn();

vi.mock('../shared/ui/index.js', () => ({
  info: (...args: unknown[]) => mockInfo(...args),
  error: (...args: unknown[]) => mockError(...args),
  success: (...args: unknown[]) => mockSuccess(...args),
}));

const { submitPullRequest } = await import('../features/pipeline/prSubmission.js');

describe('submitPullRequest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBuildPrBody.mockReturnValue('Default PR body');
    mockExpandPipelineTemplate.mockImplementation(
      (template: string, vars: Record<string, string>) => template
        .replace('{title}', vars.title)
        .replace('{issue}', vars.issue)
        .replace('{issue_body}', vars.issue_body)
        .replace('{report}', vars.report),
    );
    mockBuildTaktManagedPrOptions.mockImplementation((body: string) => ({
      body: `${body}\n\n<!-- takt:managed -->`,
      labels: ['takt-managed'],
    }));
    mockCreatePullRequestSafely.mockImplementation((
      provider: { createPullRequest: (options: unknown, cwd: string) => unknown },
      options: unknown,
      cwd: string,
    ) => provider.createPullRequest(options, cwd));
  });

  it('should create a managed PR with pipeline template output', () => {
    mockCreatePullRequest.mockReturnValueOnce({ success: true, url: 'https://example.com/pr/1' });

    const prUrl = submitPullRequest(
      '/repo',
      'takt/issue-42',
      'main',
      {
        issue: {
          number: 42,
          title: 'Fix pipeline',
          body: 'Issue body',
          labels: [],
          comments: [],
        },
      },
      'auto-improvement-loop',
      {
        prBodyTemplate: 'Title: {title}\nIssue: {issue}\nBody: {issue_body}\nReport: {report}',
      },
      {
        draftPr: true,
        repo: 'owner/repo',
        task: undefined,
      },
    );

    expect(prUrl).toBe('https://example.com/pr/1');
    expect(mockExpandPipelineTemplate).toHaveBeenCalledWith(
      'Title: {title}\nIssue: {issue}\nBody: {issue_body}\nReport: {report}',
      {
        title: 'Fix pipeline',
        issue: '42',
        issue_body: 'Issue body',
        report: 'Workflow `auto-improvement-loop` completed successfully.',
      },
    );
    expect(mockBuildTaktManagedPrOptions).toHaveBeenCalledWith(
      'Title: Fix pipeline\nIssue: 42\nBody: Issue body\nReport: Workflow `auto-improvement-loop` completed successfully.',
    );
    expect(mockCreatePullRequest).toHaveBeenCalledWith({
      base: 'main',
      body: 'Title: Fix pipeline\nIssue: 42\nBody: Issue body\nReport: Workflow `auto-improvement-loop` completed successfully.\n\n<!-- takt:managed -->',
      branch: 'takt/issue-42',
      draft: true,
      labels: ['takt-managed'],
      repo: 'owner/repo',
      title: '[#42] Fix pipeline',
    }, '/repo');
    expect(mockSuccess).toHaveBeenCalledWith('PR created: https://example.com/pr/1');
  });
});

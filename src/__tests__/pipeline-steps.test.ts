import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockExpandPipelineTemplate = vi.fn();

vi.mock('../features/pipeline/templateExpander.js', () => ({
  expandPipelineTemplate: (...args: unknown[]) =>
    mockExpandPipelineTemplate(...(args as [string, Record<string, string>])),
}));

const { buildCommitMessage } = await import('../features/pipeline/steps.js');

describe('buildCommitMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should delegate commit message template expansion to the shared pipeline helper', () => {
    mockExpandPipelineTemplate.mockReturnValueOnce('expanded commit message');

    const result = buildCommitMessage(
      { commitMessageTemplate: 'feat: {title} (#{issue})' },
      {
        number: 42,
        title: 'Fix pipeline',
        body: 'Issue body',
        labels: [],
        comments: [],
      },
      undefined,
    );

    expect(result).toBe('expanded commit message');
    expect(mockExpandPipelineTemplate).toHaveBeenCalledWith('feat: {title} (#{issue})', {
      title: 'Fix pipeline',
      issue: '42',
    });
  });
});

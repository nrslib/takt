/**
 * Tests for workflow selection helpers
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkflowDirEntry } from '../infra/config/loaders/workflowLoader.js';

const selectOptionMock = vi.fn();

vi.mock('../shared/prompt/index.js', () => ({
  selectOption: selectOptionMock,
}));

vi.mock('../infra/config/global/index.js', () => ({
  getBookmarkedWorkflows: () => [],
  toggleBookmark: vi.fn(),
}));

const { selectWorkflowFromEntries } = await import('../features/workflowSelection/index.js');

describe('selectWorkflowFromEntries', () => {
  beforeEach(() => {
    selectOptionMock.mockReset();
  });

  it('should select from custom workflows when source is chosen', async () => {
    const entries: WorkflowDirEntry[] = [
      { name: 'custom-flow', path: '/tmp/custom.yaml', source: 'user' },
      { name: 'builtin-flow', path: '/tmp/builtin.yaml', source: 'builtin' },
    ];

    selectOptionMock
      .mockResolvedValueOnce('custom')
      .mockResolvedValueOnce('custom-flow');

    const selected = await selectWorkflowFromEntries(entries, '');
    expect(selected).toBe('custom-flow');
    expect(selectOptionMock).toHaveBeenCalledTimes(2);
  });

  it('should skip source selection when only builtin workflows exist', async () => {
    const entries: WorkflowDirEntry[] = [
      { name: 'builtin-flow', path: '/tmp/builtin.yaml', source: 'builtin' },
    ];

    selectOptionMock.mockResolvedValueOnce('builtin-flow');

    const selected = await selectWorkflowFromEntries(entries, '');
    expect(selected).toBe('builtin-flow');
    expect(selectOptionMock).toHaveBeenCalledTimes(1);
  });
});

/**
 * Tests for reset categories command behavior.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../infra/config/global/workflowCategories.js', () => ({
  resetWorkflowCategories: vi.fn(),
  getWorkflowCategoriesPath: vi.fn(() => '/tmp/user-workflow-categories.yaml'),
}));

vi.mock('../shared/ui/index.js', () => ({
  header: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
}));

import { resetWorkflowCategories } from '../infra/config/global/workflowCategories.js';
import { header, success, info } from '../shared/ui/index.js';
import { resetCategoriesToDefault } from '../features/config/resetCategories.js';

const mockResetWorkflowCategories = vi.mocked(resetWorkflowCategories);
const mockHeader = vi.mocked(header);
const mockSuccess = vi.mocked(success);
const mockInfo = vi.mocked(info);

describe('resetCategoriesToDefault', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should reset user category overlay and show updated message', async () => {
    // Given
    const cwd = '/tmp/test-cwd';

    // When
    await resetCategoriesToDefault(cwd);

    // Then
    expect(mockHeader).toHaveBeenCalledWith('Reset Categories');
    expect(mockResetWorkflowCategories).toHaveBeenCalledWith(cwd);
    expect(mockSuccess).toHaveBeenCalledWith('User category overlay reset.');
    expect(mockInfo).toHaveBeenCalledWith('  /tmp/user-workflow-categories.yaml');
  });
});

/**
 * Tests for pushBranch in infra/task/git.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

import { execFileSync } from 'node:child_process';
const mockExecFileSync = vi.mocked(execFileSync);

import { pushBranch, pushHeadToOriginBranch } from '../infra/task/git.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('pushBranch', () => {
  it('should call git push origin <branch>', () => {
    // Given
    mockExecFileSync.mockReturnValue(Buffer.from(''));

    // When
    pushBranch('/project', 'feature/my-branch');

    // Then
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git',
      ['push', 'origin', 'feature/my-branch'],
      { cwd: '/project', stdio: 'pipe' },
    );
  });

  it('should throw when git push fails', () => {
    // Given
    mockExecFileSync.mockImplementation(() => {
      throw new Error('error: failed to push some refs');
    });

    // When / Then
    expect(() => pushBranch('/project', 'feature/my-branch')).toThrow(
      'error: failed to push some refs',
    );
  });
});

describe('pushHeadToOriginBranch', () => {
  it('should call git push origin HEAD:refs/heads/<branch>', () => {
    mockExecFileSync.mockReturnValue(Buffer.from(''));

    pushHeadToOriginBranch('/clone', 'feature/my-branch');

    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git',
      ['push', 'origin', 'HEAD:refs/heads/feature/my-branch'],
      { cwd: '/clone', stdio: 'pipe' },
    );
  });
});

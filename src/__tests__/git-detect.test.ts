/**
 * Tests for git/detect module
 *
 * Tests VCS provider auto-detection from git remote URL.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockExecFileSync = vi.fn();
vi.mock('node:child_process', () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

import { detectVcsProvider } from '../infra/git/detect.js';
import type { VcsProviderType } from '../infra/git/detect.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('detectVcsProvider', () => {
  describe('HTTPS URLs', () => {
    it('github.com の HTTPS URL は "github" を返す', () => {
      // Given
      mockExecFileSync.mockReturnValue('https://github.com/org/repo.git\n');

      // When
      const result = detectVcsProvider();

      // Then
      expect(result).toBe('github');
    });

    it('gitlab.com の HTTPS URL は "gitlab" を返す', () => {
      // Given
      mockExecFileSync.mockReturnValue('https://gitlab.com/org/repo.git\n');

      // When
      const result = detectVcsProvider();

      // Then
      expect(result).toBe('gitlab');
    });

    it('未知のホストの HTTPS URL は undefined を返す', () => {
      // Given
      mockExecFileSync.mockReturnValue('https://bitbucket.org/org/repo.git\n');

      // When
      const result = detectVcsProvider();

      // Then
      expect(result).toBeUndefined();
    });
  });

  describe('SSH URLs', () => {
    it('github.com の SSH URL は "github" を返す', () => {
      // Given
      mockExecFileSync.mockReturnValue('git@github.com:org/repo.git\n');

      // When
      const result = detectVcsProvider();

      // Then
      expect(result).toBe('github');
    });

    it('gitlab.com の SSH URL は "gitlab" を返す', () => {
      // Given
      mockExecFileSync.mockReturnValue('git@gitlab.com:org/repo.git\n');

      // When
      const result = detectVcsProvider();

      // Then
      expect(result).toBe('gitlab');
    });

    it('未知のホストの SSH URL は undefined を返す', () => {
      // Given
      mockExecFileSync.mockReturnValue('git@bitbucket.org:org/repo.git\n');

      // When
      const result = detectVcsProvider();

      // Then
      expect(result).toBeUndefined();
    });
  });

  describe('セルフホスト URL', () => {
    it('カスタムドメインの GitLab は undefined を返す（設定で明示指定が必要）', () => {
      // Given
      mockExecFileSync.mockReturnValue('https://git.company.com/org/repo.git\n');

      // When
      const result = detectVcsProvider();

      // Then
      expect(result).toBeUndefined();
    });

    it('カスタムドメインの SSH URL は undefined を返す', () => {
      // Given
      mockExecFileSync.mockReturnValue('git@git.company.com:org/repo.git\n');

      // When
      const result = detectVcsProvider();

      // Then
      expect(result).toBeUndefined();
    });
  });

  describe('エラーケース', () => {
    it('git remote get-url origin が失敗した場合は undefined を返す', () => {
      // Given
      mockExecFileSync.mockImplementation(() => {
        throw new Error('fatal: not a git repository');
      });

      // When
      const result = detectVcsProvider();

      // Then
      expect(result).toBeUndefined();
    });

    it('空の出力の場合は undefined を返す', () => {
      // Given
      mockExecFileSync.mockReturnValue('\n');

      // When
      const result = detectVcsProvider();

      // Then
      expect(result).toBeUndefined();
    });
  });

  describe('コマンド引数', () => {
    it('git remote get-url origin を正しく呼び出す', () => {
      // Given
      mockExecFileSync.mockReturnValue('https://github.com/org/repo.git\n');

      // When
      detectVcsProvider();

      // Then
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'git',
        ['remote', 'get-url', 'origin'],
        expect.any(Object),
      );
    });
  });

  describe('URL バリエーション', () => {
    it('.git サフィックスなしの HTTPS URL でも検出できる', () => {
      // Given
      mockExecFileSync.mockReturnValue('https://github.com/org/repo\n');

      // When
      const result = detectVcsProvider();

      // Then
      expect(result).toBe('github');
    });

    it('末尾のスペース/改行をトリムする', () => {
      // Given
      mockExecFileSync.mockReturnValue('  https://gitlab.com/org/repo.git  \n');

      // When
      const result = detectVcsProvider();

      // Then
      expect(result).toBe('gitlab');
    });
  });
});

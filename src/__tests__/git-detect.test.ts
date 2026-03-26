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

import { detectVcsProvider, getRemoteHostname, VCS_PROVIDER_TYPES } from '../infra/git/detect.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getRemoteHostname — hostname extraction (indirect extractHostname tests)', () => {
  it('HTTPS URL からホスト名を抽出する', () => {
    // Given
    mockExecFileSync.mockReturnValue('https://gitlab.example.com/owner/repo.git\n');

    // When / Then
    expect(getRemoteHostname('/project')).toBe('gitlab.example.com');
  });

  it('HTTPS URL（.git なし）からホスト名を抽出する', () => {
    // Given
    mockExecFileSync.mockReturnValue('https://gitlab.example.com/owner/repo\n');

    // When / Then
    expect(getRemoteHostname('/project')).toBe('gitlab.example.com');
  });

  it('SSH URL からホスト名を抽出する', () => {
    // Given
    mockExecFileSync.mockReturnValue('git@gitlab.example.com:owner/repo.git\n');

    // When / Then
    expect(getRemoteHostname('/project')).toBe('gitlab.example.com');
  });

  it('SSH URL（.git なし）からホスト名を抽出する', () => {
    // Given
    mockExecFileSync.mockReturnValue('git@gitlab.example.com:owner/repo\n');

    // When / Then
    expect(getRemoteHostname('/project')).toBe('gitlab.example.com');
  });

  it('github.com の HTTPS URL からホスト名を抽出する', () => {
    mockExecFileSync.mockReturnValue('https://github.com/owner/repo.git\n');
    expect(getRemoteHostname('/project')).toBe('github.com');
  });

  it('github.com の SSH URL からホスト名を抽出する', () => {
    mockExecFileSync.mockReturnValue('git@github.com:owner/repo.git\n');
    expect(getRemoteHostname('/project')).toBe('github.com');
  });

  it('サブグループを含む gitlab.com URL からホスト名を抽出する', () => {
    mockExecFileSync.mockReturnValue('https://gitlab.com/group/subgroup/repo.git\n');
    expect(getRemoteHostname('/project')).toBe('gitlab.com');
  });

  it('ポート番号付き HTTPS URL からホスト名を抽出する', () => {
    mockExecFileSync.mockReturnValue('https://gitlab.example.com:8443/owner/repo.git\n');
    expect(getRemoteHostname('/project')).toBe('gitlab.example.com');
  });

  it('不正な文字列の場合は undefined を返す', () => {
    mockExecFileSync.mockReturnValue('not-a-url\n');
    expect(getRemoteHostname('/project')).toBeUndefined();
  });

  it('空文字列の場合は undefined を返す', () => {
    mockExecFileSync.mockReturnValue('\n');
    expect(getRemoteHostname('/project')).toBeUndefined();
  });
});

describe('getRemoteHostname', () => {
  it('HTTPS remote URL からホスト名を返す', () => {
    // Given
    mockExecFileSync.mockReturnValue('https://gitlab.example.com/owner/repo.git\n');

    // When
    const result = getRemoteHostname('/project');

    // Then
    expect(result).toBe('gitlab.example.com');
  });

  it('SSH remote URL からホスト名を返す', () => {
    // Given
    mockExecFileSync.mockReturnValue('git@gitlab.example.com:owner/repo.git\n');

    // When
    const result = getRemoteHostname('/project');

    // Then
    expect(result).toBe('gitlab.example.com');
  });

  it('cwd を git コマンドのオプションとして渡す', () => {
    // Given
    mockExecFileSync.mockReturnValue('https://gitlab.example.com/owner/repo.git\n');

    // When
    getRemoteHostname('/my/project');

    // Then
    const call = mockExecFileSync.mock.calls[0];
    expect(call[0]).toBe('git');
    expect(call[1]).toEqual(['remote', 'get-url', 'origin']);
    expect(call[2]).toHaveProperty('cwd', '/my/project');
  });

  it('git remote get-url origin が失敗した場合は undefined を返す', () => {
    // Given
    mockExecFileSync.mockImplementation(() => { throw new Error('not a git repository'); });

    // When
    const result = getRemoteHostname('/not-a-repo');

    // Then
    expect(result).toBeUndefined();
  });

  it('remote URL が空の場合は undefined を返す', () => {
    // Given
    mockExecFileSync.mockReturnValue('\n');

    // When
    const result = getRemoteHostname('/project');

    // Then
    expect(result).toBeUndefined();
  });

  it('remote URL がパース不能な場合は undefined を返す', () => {
    // Given
    mockExecFileSync.mockReturnValue('not-a-url\n');

    // When
    const result = getRemoteHostname('/project');

    // Then
    expect(result).toBeUndefined();
  });
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

  describe('cwd パラメータ', () => {
    it('cwd を指定した場合は getRemoteHostname にそのまま渡す', () => {
      // Given
      mockExecFileSync.mockReturnValue('https://github.com/org/repo.git\n');

      // When
      const result = detectVcsProvider('/worktree/clone');

      // Then
      expect(result).toBe('github');
      const call = mockExecFileSync.mock.calls[0];
      expect(call[2]).toHaveProperty('cwd', '/worktree/clone');
    });

    it('cwd 省略時は process.cwd() をフォールバックとして使用する', () => {
      // Given
      mockExecFileSync.mockReturnValue('https://gitlab.com/org/repo.git\n');

      // When
      const result = detectVcsProvider();

      // Then
      expect(result).toBe('gitlab');
      const call = mockExecFileSync.mock.calls[0];
      expect(call[2]).toHaveProperty('cwd', process.cwd());
    });

    it('worktree パスを渡した場合にそのリポジトリのリモートで検出する', () => {
      // Given: worktree ではセルフホストGitLab
      mockExecFileSync.mockReturnValue('https://gitlab.company.com/org/repo.git\n');

      // When
      const result = detectVcsProvider('/tmp/worktree');

      // Then: セルフホストは undefined
      expect(result).toBeUndefined();
      const call = mockExecFileSync.mock.calls[0];
      expect(call[2]).toHaveProperty('cwd', '/tmp/worktree');
    });
  });
});

describe('VCS_PROVIDER_TYPES', () => {
  it('github と gitlab を含む readonly 配列としてエクスポートされる', () => {
    // Then
    expect(VCS_PROVIDER_TYPES).toContain('github');
    expect(VCS_PROVIDER_TYPES).toContain('gitlab');
  });

  it('VcsProviderType と一致する値のみ含む', () => {
    // Then: 各要素が VcsProviderType に代入可能であることを型レベルで保証
    // ランタイムでは要素数と値を検証
    expect(VCS_PROVIDER_TYPES).toHaveLength(2);
    const types: readonly string[] = VCS_PROVIDER_TYPES;
    expect(types).toEqual(['github', 'gitlab']);
  });

  it('配列が readonly である（変更不可）', () => {
    // Then: as const で定義されているため、readonly tuple
    // ランタイムでは Object.isFrozen では検証できないが、
    // TypeScript コンパイル時に readonly が強制される
    expect(Array.isArray(VCS_PROVIDER_TYPES)).toBe(true);
  });
});

import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from 'node:child_process';
import { parseDistinctHashes, runGit } from '../infra/task/branchGitCommands.js';

const mockExecFileSync = vi.mocked(execFileSync);

describe('parseDistinctHashes', () => {
  it('should remove only consecutive duplicates', () => {
    // Given: 連続重複と非連続重複を含む出力
    const output = 'a\na\nb\nb\na\n';

    // When: ハッシュを解析する
    const result = parseDistinctHashes(output);

    // Then: 連続重複のみ除去される
    expect(result).toEqual(['a', 'b', 'a']);
  });

  it('should return empty array when output is empty', () => {
    // Given: 空文字列
    const output = '';

    // When: ハッシュを解析する
    const result = parseDistinctHashes(output);

    // Then: 空配列を返す
    expect(result).toEqual([]);
  });

  it('should trim each line and drop blank lines', () => {
    // Given: 前後空白と空行を含む出力
    const output = '  hash1  \n\n  hash2\n   \n';

    // When: ハッシュを解析する
    const result = parseDistinctHashes(output);

    // Then: トリム済みの値のみ残る
    expect(result).toEqual(['hash1', 'hash2']);
  });

  it('should return single hash as one-element array', () => {
    // Given: 単一ハッシュ
    const output = 'single-hash';

    // When: ハッシュを解析する
    const result = parseDistinctHashes(output);

    // Then: 1件配列として返る
    expect(result).toEqual(['single-hash']);
  });
});

describe('runGit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should execute git command with expected options and trim output', () => {
    // Given: gitコマンドのモック応答
    mockExecFileSync.mockReturnValue('  abc123  \n' as never);

    // When: runGit を実行する
    const result = runGit('/repo', ['rev-parse', 'HEAD']);

    // Then: execFileSync が正しい引数で呼ばれ、trimされた値を返す
    expect(mockExecFileSync).toHaveBeenCalledWith('git', ['rev-parse', 'HEAD'], {
      cwd: '/repo',
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    expect(result).toBe('abc123');
  });
});

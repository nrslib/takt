import { describe, expect, it } from 'vitest';
import { markdownTitle } from '../../web-ui/public/markdown-view.js';

describe('Web UI Markdown view', () => {
  it('uses the first Markdown heading as the compact task title', () => {
    expect(markdownTitle([
      '# タスク指示書: 設定パスの衝突を検出する',
      '',
      '## 背景',
      '詳細',
    ].join('\n'))).toBe('設定パスの衝突を検出する');
  });

  it('keeps ordinary first-line instructions readable', () => {
    expect(markdownTitle('依存関係を更新してください\n\n追加条件')).toBe('依存関係を更新してください');
    expect(markdownTitle('# Task instructions: Update dependencies')).toBe('Update dependencies');
  });
});

import { describe, expect, it } from 'vitest';
import { buildGitRules } from '../core/workflow/instruction/instruction-context.js';

describe('buildGitRules', () => {
  it('returns nothing when the step may commit on its own', () => {
    expect(buildGitRules(true, 'ja', 'phase1')).toBe('');
    expect(buildGitRules(true, 'en', 'phase1')).toBe('');
  });

  it('keeps phase2 limited to commit and push', () => {
    const en = buildGitRules(false, 'en', 'phase2');
    expect(en).toContain('git commit');
    expect(en).toContain('git push');

    const ja = buildGitRules(false, 'ja', 'phase2');
    expect(ja).toContain('git commit');
    expect(ja).toContain('git push');

    for (const rules of [en, ja]) {
      expect(rules).not.toContain('git add');
      expect(rules).not.toContain('untracked');
      expect(rules).not.toContain('index');
    }
  });

  // 「git add を実行するな」は行為の禁止で、指摘を立てる判断は禁じていなかった。
  // レビュアーはその文を受け取った上で、未追跡を根拠に修正不能な finding を立てた（#1012）。
  it('forbids raising findings based on the index state in phase1', () => {
    const en = buildGitRules(undefined, 'en', 'phase1');
    expect(en).toContain('Do NOT run git add');
    expect(en).toContain('index state (staged / unstaged / untracked)');
    expect(en).toContain('Do not propose staging or committing as a remedy');

    const ja = buildGitRules(undefined, 'ja', 'phase1');
    expect(ja).toContain('git add を実行しないでください');
    expect(ja).toContain('index の状態（staged / unstaged / untracked）');
    expect(ja).toContain('修正案にしないでください');
  });

});

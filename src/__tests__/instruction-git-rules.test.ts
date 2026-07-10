import { describe, expect, it } from 'vitest';
import { buildGitRules } from '../core/workflow/instruction/instruction-context.js';

describe('buildGitRules', () => {
  it('returns nothing when the step may commit on its own', () => {
    expect(buildGitRules(true, 'ja', 'phase1')).toBe('');
    expect(buildGitRules(true, 'en', 'phase1')).toBe('');
  });

  it('keeps phase2 limited to commit and push', () => {
    // 除外の検証だけでは空文字列でも通ってしまう。commit / push 禁止文が
    // 実際に含まれることを正の assertion で固定する。
    const en = buildGitRules(false, 'en', 'phase2');
    expect(en).toContain('**Do NOT run git commit.** Commits are handled automatically by the system after workflow completion.');
    expect(en).toContain('**Do NOT run git push.** Pushes are also handled automatically by the system.');

    const ja = buildGitRules(false, 'ja', 'phase2');
    expect(ja).toContain('**git commit を実行しないでください。** コミットはワークフロー完了後にシステムが自動で行います。');
    expect(ja).toContain('**git push を実行しないでください。** プッシュもシステムが自動で行います。');

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

  it('renders without trailing blank lines from the conditional block', () => {
    for (const language of ['ja', 'en'] as const) {
      for (const phase of ['phase1', 'phase2'] as const) {
        const rules = buildGitRules(false, language, phase);
        expect(rules).not.toMatch(/\n\s*$/);
        expect(rules).not.toMatch(/\n{3}/);
      }
    }
  });
});

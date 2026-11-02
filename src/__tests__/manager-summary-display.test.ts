import { describe, expect, it } from 'vitest';
import type { PendingSummary } from '../infra/conversations/schema.js';
import { formatPendingSummary } from '../features/manager/summaryDisplay.js';

function proposal(): PendingSummary {
  return { revision: 4, repositoryDirectory: '/test/repository', summary: {
    objective: 'Export the data', outOfScope: ['Notifications'],
    acceptanceCriteria: Array.from({ length: 12 }, (_, index) => `Criterion ${String(index + 1).padStart(2, '0')}`),
    constraints: ['Use the mock provider'], startBranch: 'release', integrationBranch: 'main',
  } };
}

describe.each(['ja', 'en'] as const)('formatPendingSummary in %s', (lang) => {
  it('includes the repository, objective, all criteria, constraints and supplied branches', () => {
    const pending = proposal();
    const text = formatPendingSummary(pending, lang);
    for (const value of [pending.repositoryDirectory, pending.summary.objective,
      ...pending.summary.outOfScope, ...pending.summary.acceptanceCriteria, ...pending.summary.constraints]) {
      expect(text.split(value)).toHaveLength(2);
    }
    expect(text).toContain('startBranch: release');
    expect(text).toContain('integrationBranch: main');
    const sections = lang === 'ja' ? ['登録する要約', '範囲外', '受け入れ条件', '作業の制約']
      : ['Summary to register', 'Out of scope', 'Acceptance criteria', 'Work constraints'];
    for (const section of sections) expect(text).toContain(section);
  });

  it.each(['outOfScope', 'acceptanceCriteria', 'constraints'] as const)('preserves order, duplicate items and multiline indentation in %s', (field) => {
    const pending = proposal();
    const values = ['CSV\nNotifications', 'CSV; Notifications', 'CSV","Notifications', 'CSV', 'CSV'];
    const summary = { ...pending.summary, [field]: values };
    const before = structuredClone(summary);
    const text = formatPendingSummary({ ...pending, summary }, lang);
    expect(text).toContain('- CSV\n  Notifications\n- CSV; Notifications\n- CSV","Notifications\n- CSV\n- CSV');
    expect(summary).toEqual(before);
  });

  it('sanitizes each value before joining it without consuming the following field', () => {
    const pending: PendingSummary = { revision: 4, repositoryDirectory: '/test/\x1b[31mrepository\x1b[0m', summary: {
      objective: 'Objective\x1b[', outOfScope: ['Excluded\x1b[', 'Next exclusion'],
      acceptanceCriteria: ['\x1b[31mCriterion\x1b[0m', 'Next criterion'], constraints: ['Constraint\x1b[', 'Next constraint'],
      startBranch: 'release\x1b[', integrationBranch: 'main\x1b[',
    } };
    const before = structuredClone(pending);
    const text = formatPendingSummary(pending, lang);
    for (const value of ['/test/repository', 'Objective', '- Excluded\n- Next exclusion',
      '- Criterion\n- Next criterion', '- Constraint\n- Next constraint', 'startBranch: release', 'integrationBranch: main']) {
      expect(text).toContain(value);
    }
    expect(text).not.toContain('\x1b');
    expect(pending).toEqual(before);
  });

  it('omits branch fields when neither optional branch is supplied', () => {
    const pending = proposal();
    const { startBranch: _startBranch, integrationBranch: _integrationBranch, ...summary } = pending.summary;
    const text = formatPendingSummary({ ...pending, summary }, lang);
    expect(text.split('\n').filter((line) => /^(?:startBranch|integrationBranch):/u.test(line))).toEqual([]);
    expect(text).toContain(summary.objective);
  });
});

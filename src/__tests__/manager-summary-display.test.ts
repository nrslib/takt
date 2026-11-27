import { describe, expect, it } from 'vitest';
import type { PendingSummary } from '../infra/conversations/schema.js';
import { getLabel } from '../shared/i18n/index.js';
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
    expect(text).toContain(`${getLabel('manager.summary.startBranch', lang)}: release`);
    expect(text).toContain(`${getLabel('manager.summary.integrationBranch', lang)}: main`);
    const sections = lang === 'ja' ? ['ゴールの登録案', 'リポジトリ: /test/repository', '目的: Export the data', '範囲外:', '受け入れ条件:', '作業の制約:', '作業ブランチの作成元: release', '取り込み先のブランチ: main']
      : ['Proposed goal', 'Repository: /test/repository', 'Objective: Export the data', 'Out of scope:', 'Acceptance criteria:', 'Work constraints:', 'Branch to start from: release', 'Merge target branch: main'];
    for (const section of sections) expect(text).toContain(section);
  });

  it('indents the continuation lines of a multiline objective', () => {
    const pending = proposal();
    const summary = { ...pending.summary, objective: 'Export the data\nKeep the columns\nPreserve ordering' };
    expect(formatPendingSummary({ ...pending, summary }, lang)).toContain(
      `${getLabel('manager.summary.objective', lang)}: Export the data\n  Keep the columns\n  Preserve ordering\n${getLabel('manager.summary.outOfScope', lang)}:`,
    );
  });

  it.each(['outOfScope', 'acceptanceCriteria', 'constraints'] as const)('shows an explicit empty item for %s without changing other lists', (field) => {
    const pending = proposal();
    const text = formatPendingSummary({ ...pending, summary: { ...pending.summary, [field]: [] } }, lang);
    expect(text).toContain(`${getLabel(`manager.summary.${field}`, lang)}:\n- ${lang === 'ja' ? 'なし' : 'None'}\n`);
    for (const other of ['outOfScope', 'acceptanceCriteria', 'constraints'] as const) {
      if (other !== field) for (const item of pending.summary[other]) expect(text).toContain(`- ${item}`);
    }
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
      '- Criterion\n- Next criterion', '- Constraint\n- Next constraint', `${getLabel('manager.summary.startBranch', lang)}: release`, `${getLabel('manager.summary.integrationBranch', lang)}: main`]) {
      expect(text).toContain(value);
    }
    expect(text).not.toContain('\x1b');
    expect(pending).toEqual(before);
  });

  it('omits branch fields when neither optional branch is supplied', () => {
    const pending = proposal();
    const { startBranch: _startBranch, integrationBranch: _integrationBranch, ...summary } = pending.summary;
    const text = formatPendingSummary({ ...pending, summary }, lang);
    expect(text).not.toContain(getLabel('manager.summary.startBranch', lang));
    expect(text).not.toContain(getLabel('manager.summary.integrationBranch', lang));
    expect(text).toContain(summary.objective);
  });
});


it('shows complete fenced specifications in the TUI proposal', () => {
  const pending = proposal();
  const specifications = { gherkin: 'Feature: CSV\n  Scenario: Export', quint: 'module csv {}', alloy: 'sig CSV {}' };
  const text = formatPendingSummary({ ...pending, summary: { ...pending.summary, specifications } }, 'ja');
  for (const [notation, code] of Object.entries(specifications)) expect(text).toContain(`\`\`\`${notation}\n${code}\n\`\`\``);
});

it.each(['```', '`````', 'prefix ```` suffix'])('keeps embedded backticks inside displayed specification fences: %s', (ticks) => {
  const pending = proposal();
  const code = `Feature: CSV\n${ticks}\n  Scenario: Export`;
  const text = formatPendingSummary({ ...pending, summary: { ...pending.summary, specifications: { gherkin: code } } }, 'ja');
  const fence = '`'.repeat(ticks.match(/`+/)![0].length + 1);
  expect(text).toContain(`${fence}gherkin\n${code}\n${fence}`);
});

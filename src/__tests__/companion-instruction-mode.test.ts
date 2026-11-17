import { describe, expect, it } from 'vitest';
import { InstructionBuilder } from '../core/workflow/instruction/InstructionBuilder.js';
import { makeInstructionContext, makeStep } from './test-helpers.js';

describe('companion implementation instructions', () => {
  it.each([
    { language: 'en' as const, completion: 'Do not poll the mailbox', live: 'Read new records after finishing each file' },
    { language: 'ja' as const, completion: '応答中にメールボックスを確認する必要はありません', live: '各ファイルの実装完了後' },
  ])('switches delivery guidance with review mode in $language', ({ language, completion, live }) => {
    const step = makeStep({ instruction: 'Implement the change.', edit: true, companion: { fixed: ['reviewer'], pool: [] } });
    const build = (reviewMode: 'completion' | 'live') => new InstructionBuilder(step, {
      ...makeInstructionContext({ language }),
      companion: { mailboxDirectory: '/tmp/current-mailbox', reviewMode },
    }).build();
    const completed = build('completion');
    const active = build('live');

    for (const prompt of [completed, active]) expect(prompt).toContain('/tmp/current-mailbox');
    expect(completed).toContain(completion);
    expect(completed).not.toContain(live);
    expect(active).toContain(live);
    expect(active).not.toContain(completion);
  });
});

import { expect, it } from 'vitest';
import { buildSlackInquiry as build } from '../features/manager/slackInquiryBlocks.js';
import type { ActionsBlock, Button, SectionBlock } from '@slack/types';
import { createInquiry } from '../infra/goals/inquiry.js';
import type { ManagerAssignment } from '../features/manager/startupResolution.js';
import type { PendingQuestion } from '../features/manager/inquiryAnswer.js';

const assignment: ManagerAssignment = { kind: 'repository', repositoryDirectory: '/repo', repositoryDirectories: ['/repo'] };
const buildSlackInquiry = (target: PendingQuestion, _manager: ManagerAssignment, language: 'ja' | 'en') => build(target, language, 'inquiry-marker');
function approval(): PendingQuestion {
  return { goalId: '550e8400-e29b-41d4-a716-446655440000', repositoryDirectory: '/repo', objective: 'Goal',
    question: createInquiry({ kind: 'approval', body: 'Allow?', operation: { toolName: 'Bash', args: 'npm test', cwd: '/repo' } }) };
}

it('preserves full choice values even when Slack button labels need shortening', () => {
  const target = { ...approval(), question: createInquiry({ body: 'Choose', options: ['A'.repeat(100), 'B'] }) };
  const result = buildSlackInquiry(target, assignment, 'ja');
  expect(result.actions.get('option_0')).toEqual({ kind: 'answer', answer: { text: 'A'.repeat(100) } });
  expect(result.actions.get('option_1')).toEqual({ kind: 'answer', answer: { text: 'B' } });
});

it('creates explicit completed and unable reports for operation requests', () => {
  const result = buildSlackInquiry({ ...approval(), question: createInquiry({ kind: 'operation_request', body: 'Login' }) }, assignment, 'en');
  expect([...result.actions.values()]).toEqual([
    { kind: 'answer', answer: { report: 'completed' } }, { kind: 'answer', answer: { report: 'unable' } },
  ]);
});

it('distinguishes choices with the same long prefix using their number and full displayed text', () => {
  const options = [`${'A'.repeat(75)}東`, `${'A'.repeat(75)}西`];
  const result = buildSlackInquiry({ ...approval(), question: createInquiry({ body: 'Q', options }) }, assignment, 'ja');
  const blocks = result.blocks;
  const texts = blocks.filter((block): block is SectionBlock => block.type === 'section').map(({ text }) => text!.text);
  expect(texts).toContain(`1. ${options[0]}`);
  expect(texts).toContain(`2. ${options[1]}`);
  const labels = blocks.filter((block): block is ActionsBlock => block.type === 'actions')
    .flatMap(({ elements }) => elements.filter((item): item is Button => item.type === 'button'))
    .filter(({ value }) => value?.startsWith('option_')).map(({ text }) => text.text);
  expect(labels[0]).toMatch(/^1\. /u);
  expect(labels[1]).toMatch(/^2\. /u);
  expect(labels[0]).not.toBe(labels[1]);
});

it('does not offer permission actions for a historical approval', () => {
  expect(buildSlackInquiry(approval(), assignment, 'en').actions.size).toBe(0);
});

import { expect, it } from 'vitest';
import { buildSlackInquiry as build, buildSlackPermissionModal } from '../features/manager/slackInquiryBlocks.js';
import type { ActionsBlock, Button, SectionBlock } from '@slack/types';
import { createInquiry } from '../infra/goals/inquiry.js';
import type { ManagerAssignment } from '../features/manager/startupResolution.js';
import type { PendingQuestion } from '../features/manager/inquiryAnswer.js';

const assignment: ManagerAssignment = { kind: 'repository', repositoryDirectory: '/repo', repositoryDirectories: ['/repo'] };
const buildSlackInquiry = (target: PendingQuestion, manager: ManagerAssignment, language: 'ja' | 'en') => build(target, manager, language, 'inquiry-marker');
function approval(): PendingQuestion {
  return { goalId: '550e8400-e29b-41d4-a716-446655440000', repositoryDirectory: '/repo', objective: 'Goal',
    question: createInquiry({ kind: 'approval', body: 'Allow?', operation: { toolName: 'Bash', args: 'npm test', cwd: '/repo' } }) };
}

it('uses direct answers for once and goal and confirmed permissions for writable scopes', () => {
  const result = buildSlackInquiry(approval(), assignment, 'en');
  expect(result.actions.get('allow_once')).toEqual({ kind: 'answer', answer: { decision: 'allow', scope: 'once' } });
  expect(result.actions.get('allow_goal')).toEqual({ kind: 'answer', answer: { decision: 'allow', scope: 'goal' } });
  expect(result.actions.get('deny')).toEqual({ kind: 'answer', answer: { decision: 'deny' } });
  expect(result.actions.get('allow_project')).toMatchObject({ kind: 'permission', choice: { value: 'project', permission: { kind: 'project', projectDirectory: '/repo' } } });
  expect(result.actions.has('allow_workspace')).toBe(false);
});

it('keeps semantic scope actions stable when workspace membership changes their display order', () => {
  const result = buildSlackInquiry(approval(), { kind: 'workspace', workspaceId: '750e8400-e29b-41d4-a716-446655440001',
    name: 'Workspace', repositoryDirectories: ['/repo', '/other'] }, 'en');
  expect(result.actions.get('allow_global')).toMatchObject({ kind: 'permission', choice: { value: 'global', permission: { kind: 'global' } } });
  expect(result.actions.get('allow_workspace')).toMatchObject({ kind: 'permission', choice: { value: 'workspace' } });
});

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

it.each(['ja', 'en'] as const)('builds an editable permission modal carrying only opaque correlation metadata in %s', (language) => {
  const view = buildSlackPermissionModal('Allow npm test.', 'opaque-id', language);
  expect(view).toMatchObject({ type: 'modal', private_metadata: 'opaque-id', notify_on_close: true,
    blocks: [{ type: 'input', element: { type: 'plain_text_input', initial_value: 'Allow npm test.' } }] });
  expect(view.title.text).not.toMatch(/^manager\./u);
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

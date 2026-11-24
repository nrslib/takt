import { expect, it } from 'vitest';
import { buildSlackGoalProposal, parseSlackGoalProposal, SLACK_GOAL_APPROVE, SLACK_GOAL_DISMISS } from '../features/manager/slackGoalProposal.js';

const pending = { revision: 4, managerId: `manager-${'a'.repeat(64)}`, repositoryDirectory: '/blog',
  summary: { objective: 'Publish articles', outOfScope: ['Editing'], acceptanceCriteria: ['List articles'], constraints: [] } };

it('shows the assignment and required contents with both revision-bound buttons', () => {
  const messages = buildSlackGoalProposal('director-id', pending, 'en');
  expect(messages).toHaveLength(1);
  for (const text of [pending.managerId, '/blog', 'Publish articles', 'Editing', 'List articles']) expect(messages[0]!.text).toContain(text);
  const actions = messages[0]!.blocks.find((block) => block.type === 'actions');
  expect(actions?.type).toBe('actions');
  if (actions?.type !== 'actions') throw new Error('Missing proposal actions');
  expect(actions.elements.map((element) => 'action_id' in element && element.action_id)).toEqual([SLACK_GOAL_APPROVE, SLACK_GOAL_DISMISS]);
  for (const element of actions.elements) {
    if (element.type !== 'button') throw new Error('Missing button');
    expect(parseSlackGoalProposal(element.value!)).toEqual({ conversationId: 'director-id', revision: 4 });
  }
});

it('splits long content without splitting surrogate pairs and places buttons only on the final message', () => {
  const messages = buildSlackGoalProposal('director-id', { ...pending, summary: { ...pending.summary, objective: '😀'.repeat(20000) } }, 'ja');
  expect(messages.length).toBeGreaterThan(1);
  let actions = 0;
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type === 'actions') { actions++; expect(message).toBe(messages.at(-1)); }
      if (block.type === 'section' && block.text !== undefined) {
        expect(block.text.text.length).toBeLessThanOrEqual(2900);
        expect(block.text.text.isWellFormed()).toBe(true);
      }
    }
  }
  expect(actions).toBe(1);
});

it.each(['invalid', 'null', '[]', '{"conversationId":"x","revision":-1}', '{"conversationId":"x","revision":1,"extra":true}', '{"conversationId":"x","revision":1.5}'])('ignores malformed button values: %s', (value) => {
  expect(parseSlackGoalProposal(value)).toBeUndefined();
});

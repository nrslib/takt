import { randomUUID } from 'node:crypto';
import { conversationId } from '../../infra/conversations/identity.js';
import { expect, it } from 'vitest';
import stringWidth from 'string-width';
import { ManagerClientDouble, mount, showProposal, waitFor, summaryA, SUMMARY_MENU } from './manager-tui-fixtures.js';
import { getLabel } from '../../shared/i18n/index.js';

it.each(['ja', 'en'] as const)('shows the experimental notice and assignment without sending a provider request in %s', async (lang) => {
  const context = mount(lang);
  await waitFor(() => {
    expect(context.app.lastFrame()).toContain('manager-repository');
    expect(context.app.lastFrame()!.replace(/\s+/gu, '')).toContain(getLabel('manager.experimentalNotice', lang).replace(/\s+/gu, ''));
  });
  expect(context.client.submit).not.toHaveBeenCalled();
});

it.each([40, 80])('keeps Japanese guidance and the experimental notice within %i columns', async (width) => {
  const context = mount('ja');
  Object.defineProperty(context.app.stdout, 'columns', { configurable: true, value: width });
  context.app.stdout.emit('resize');
  await waitFor(() => {
    const frame = context.app.lastFrame()!;
    for (const line of frame.split('\n')) expect(stringWidth(line)).toBeLessThanOrEqual(width);
    expect(frame.replace(/\s+/gu, '')).toContain(getLabel('manager.inputHint', 'ja').replace(/\s+/gu, ''));
    expect(frame.replace(/\s+/gu, '')).toContain(getLabel('manager.experimentalNotice', 'ja').replace(/\s+/gu, ''));
  });
});

it.each(['reading', 'incomplete'] as const)('never approves a displayed proposal while the same read is %s', async (readStatus) => {
  const context = mount();
  await showProposal(context);
  context.client.change({ readStatus });
  context.app.stdin.write(SUMMARY_MENU);
  await waitFor(() => expect(context.app.lastFrame()).toContain(getLabel('manager.conversation.' + readStatus, 'en')));
  expect(context.client.submit).not.toHaveBeenCalled();
  context.client.change({ readStatus: 'complete' });
  context.app.stdin.write(SUMMARY_MENU);
  await waitFor(() => expect(context.client.commands()).toEqual([{ kind: 'approve_summary', revision: 4 }]));
});

it('keeps the same screen and proposal while disconnected, then enables approval only after the new complete read', async () => {
  const context = mount();
  await showProposal(context);
  context.client.change({ connection: 'disconnected', readStatus: 'incomplete' });
  context.app.stdin.write(SUMMARY_MENU);
  await waitFor(() => expect(context.app.lastFrame()).toContain(getLabel('manager.conversation.disconnected', 'en')));
  expect(context.client.submit).not.toHaveBeenCalled();
  context.client.change({ connection: 'connected', readStatus: 'reading' });
  context.app.stdin.write(SUMMARY_MENU);
  expect(context.client.submit).not.toHaveBeenCalled();
  context.client.change({ readStatus: 'complete' });
  context.app.stdin.write(SUMMARY_MENU);
  await waitFor(() => expect(context.client.commands()).toEqual([{ kind: 'approve_summary', revision: 4 }]));
});

it('displays the interruption state and preserves the conversation identity while accepting a new message', async () => {
  const client = new ManagerClientDouble();
  const conversationId = client.getSnapshot().state!.conversationId;
  client.change({ state: { ...client.getSnapshot().state!, interrupted: true } });
  const context = mount('en', client);
  await waitFor(() => expect(context.app.lastFrame()).toContain(getLabel('manager.conversation.interrupted', 'en')));
  context.app.stdin.write('Continue after restart\r');
  await waitFor(() => expect(client.commands()).toEqual([{ kind: 'message', text: 'Continue after restart' }]));
  expect(client.getSnapshot().state?.conversationId).toBe(conversationId);
});

it('projects each business event once, suppresses history, and retains new records across refresh on the same screen', async () => {
  const context = mount();
  const assignment = context.client.getSnapshot().items[0]!;
  context.client.change({ items: [assignment,
    { kind: 'display_event', event: { id: 'old', message: 'Historical record', suppressInitialDisplay: true } },
    { kind: 'display_event', event: { id: 'new', message: 'New work record' } },
  ] });
  await waitFor(() => expect(context.app.lastFrame()).toContain('New work record'));
  context.client.change({ items: [...context.client.getSnapshot().items] });
  await new Promise((resolve) => setTimeout(resolve, 550));
  expect(context.app.lastFrame()).not.toContain('Historical record');
  expect(context.app.lastFrame()!.match(/New work record/gu)).toHaveLength(1);
  expect(context.client.refresh).toHaveBeenCalled();
});

it('shows a failed read without replacing the prior complete data with an empty assignment', async () => {
  const context = mount();
  await showProposal(context, summaryA);
  context.client.change({ error: 'Read failed', readStatus: 'incomplete' });
  await waitFor(() => {
    expect(context.app.lastFrame()).toContain('Read failed');
    expect(context.app.lastFrame()).toContain(summaryA.objective);
    expect(context.app.lastFrame()).toContain('manager-repository');
  });
  context.client.change({ error: null, readStatus: 'complete' });
  expect(context.client.getSnapshot().state?.pending?.summary).toEqual(summaryA);
});

it('follows a replacement assignment in the same mounted screen', async () => {
  const context = mount();
  const old = context.client.getSnapshot().state!;
  const workspaceId = randomUUID();
  context.client.change({ state: { ...old, assignment: { kind: 'workspace', workspaceId }, conversationId: conversationId({ kind: 'workspace', workspaceId }) },
    items: [{ kind: 'assignment', assignment: { kind: 'workspace', workspaceId, name: 'Current workspace',
      repositoryDirectories: ['/work/current-repository'] } }] });
  await waitFor(() => {
    expect(context.app.lastFrame()).toContain('current-repository');
    expect(context.app.lastFrame()).not.toContain('manager-repository');
  });
});

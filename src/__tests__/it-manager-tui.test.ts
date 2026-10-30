import './helpers/manager-tui-input.js';
import './helpers/manager-tui-startup.js';
import './helpers/manager-tui-selection.js';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { ConversationTransferReceiver } from '../features/manager/conversationTransferReceiver.js';
import { conversationTransferFrames } from '../features/daemon/conversationFrames.js';
import type { ConversationState } from '../features/manager/conversationPort.js';
import { getLabel } from '../shared/i18n/index.js';
import { toDisplayText } from '../features/tui/displayText.js';
import { goalRecord } from './helpers/goal-fixtures.js';
import { cwd, mount, showProposal, summaryA, summaryB, waitFor, finish, ENTER, UP, DOWN, ESC, typeAndSubmit, approveSummary, promptFrame, ManagerClientDouble } from './helpers/manager-tui-fixtures.js';

it('shows a remote message once and avoids repeating its own accepted message', async () => {
  const context = mount();
  await waitFor(() => expect(context.app.lastFrame()).toContain('Discuss your goal'));
  const remote = { kind: 'user_message' as const, operationId: randomUUID(), message: 'Remote request sk-remote12345678' };
  context.client.output(remote); context.client.output(remote);
  await waitFor(() => expect(context.app.lastFrame()!.split('Remote request [REDACTED]')).toHaveLength(2));
  const local = 'Local request sk-local12345678';
  await typeAndSubmit(context, local);
  await waitFor(() => expect(context.client.commands()).toEqual([{ kind: 'message', text: local }]));
  const operationId = await context.client.operation();
  context.client.output({ kind: 'user_message', operationId, message: local });
  await waitFor(() => {
    expect(context.app.lastFrame()!.split('Local request [REDACTED]')).toHaveLength(2);
    expect(context.app.lastFrame()!.split('Remote request [REDACTED]')).toHaveLength(2);
    expect(context.app.lastFrame()).not.toContain('sk-local12345678');
    expect(context.app.lastFrame()).not.toContain('sk-remote12345678');
  });
});

it.each(['ja', 'en'] as const)('creates a proposal from a conversation with /make-goal and registers only after Up and Enter in %s', async (lang) => {
  const context = mount(lang);
  await typeAndSubmit(context, 'Export the current data');
  await waitFor(() => expect(context.client.commands()).toHaveLength(1));
  await finish(context, 'Which output format should be used?');
  await typeAndSubmit(context, '/make-goal');
  await waitFor(() => expect(context.client.commands()).toEqual([
    { kind: 'message', text: 'Export the current data' },
    { kind: 'message', text: getLabel('manager.goSummaryRequest', lang), display: false },
  ]));
  await showProposal(context, summaryA, 5);
  await finish(context, 'Proposal ready');
  expect(context.app.lastFrame()).toContain(getLabel('manager.summaryInputHint', lang));
  context.app.stdin.write(UP);
  context.app.stdin.write(DOWN);
  context.app.stdin.write(UP);
  expect(context.client.commands()).toHaveLength(2);
  context.app.stdin.write(ENTER);
  await waitFor(() => expect(context.client.commands().at(-1)).toEqual({ kind: 'approve_summary', revision: 5 }));
});

it.each(['typed', 'Tab completion', 'pasted'] as const)('regenerates a displayed proposal without approval or competing withdrawal using %s input', async (delivery) => {
  const context = mount();
  await showProposal(context, summaryA, 4);
  if (delivery === 'pasted') await typeAndSubmit(context, '  /make-goal  ');
  else {
    for (const character of delivery === 'typed' ? '/make-goal' : '/ma') {
      context.app.stdin.write(character);
    }
    if (delivery === 'Tab completion') {
      await waitFor(() => expect(context.app.lastFrame()).toMatch(/^❯ \/make-goal  /mu));
      context.app.stdin.write('\t');
    }
    await waitFor(() => expect(promptFrame(context)).toContain('/make-goal'));
    context.app.stdin.write(ENTER);
  }
  await waitFor(() => expect(context.client.commands()).toEqual([
    { kind: 'message', text: getLabel('manager.goSummaryRequest', 'en'), display: false },
  ]));
  await showProposal(context, summaryB, 5);
  await finish(context, 'Replacement ready');
  await waitFor(() => {
    expect(context.app.lastFrame()).toContain(summaryB.objective);
    expect(context.app.lastFrame()).not.toContain(summaryA.objective);
  });
  expect(context.client.commands().map((command) => command.kind)).toEqual(['message']);
  expect(context.client.getSnapshot().state?.approval).toBeNull();
});

it.each(['empty', 'draft', 'proposal'].flatMap((state) => [
  { name: 'Ctrl+O', key: '\x0f' }, { name: 'Ctrl+N', key: '\x0e' }, { name: 'Ctrl+P', key: '\x10' },
].map((entry) => ({ state, ...entry }))))(
  'keeps $state input and the displayed proposal unchanged after retired key $name', async ({ state, key }) => {
    const client = new ManagerClientDouble();
    const context = mount('en', client);
    if (state === 'proposal') await showProposal(context);
    else if (state === 'draft') {
      context.app.stdin.write('unsent draft');
      await waitFor(() => expect(promptFrame(context)).toContain('unsent draft'));
    } else await waitFor(() => expect(promptFrame(context)).toContain('Discuss your goal'));
    const before = context.app.lastFrame();
    context.app.stdin.write(key);
    await new Promise<void>((resolve) => { setTimeout(resolve, 50); });
    expect(context.client.commands()).toEqual([]);
    expect(context.app.lastFrame()).toBe(before);
  });

it('withdraws the displayed proposal when a /make-goal prefix becomes ordinary conversation input', async () => {
  const context = mount();
  await showProposal(context);
  context.app.stdin.write('/ma');
  await waitFor(() => expect(promptFrame(context)).toContain('/ma'));
  expect(context.client.commands()).toEqual([]);
  context.app.stdin.write('p');
  await waitFor(() => {
    expect(context.client.commands()).toEqual([{ kind: 'dismiss_summary', revision: 4 }]);
    expect(promptFrame(context)).toContain('/map');
  });
});

it.each(['ja', 'en'] as const)('sends the summary instruction but displays only short processing status in %s', async (lang) => {
  const context = mount(lang);
  const { client, app } = context;
  client.submit.mockImplementation(async (_command, onAccepted) => {
    const operationId = randomUUID();
    onAccepted?.(operationId);
    client.change({ state: { ...client.getSnapshot().state!, running: { operationId, kind: 'message' } } });
    return { kind: 'accepted', operationId };
  });
  await typeAndSubmit(context, '/make-goal');
  await waitFor(() => {
    expect(client.commands()).toEqual([{ kind: 'message', text: getLabel('manager.goSummaryRequest', lang), display: false }]);
    expect(app.lastFrame()).toContain(getLabel('manager.summaryWorking', lang));
    expect(app.lastFrame()).not.toContain(getLabel('manager.goSummaryRequest', lang));
  });
  await finish(context, 'Please describe the objective.');
  await waitFor(() => expect(app.lastFrame()!.replace(/\s/gu, '')).toContain(getLabel('manager.goSummaryUnavailable', lang).replace(/\s/gu, '')));
  app.stdin.write('Next message\r');
  await waitFor(() => expect(client.commands().at(-1)).toEqual({ kind: 'message', text: 'Next message' }));
});

it.each(['ja', 'en'] as const)('approves exactly the restored revision with Up and Enter in %s', async (lang) => {
  const context = mount(lang);
  await showProposal(context, summaryB, 4);
  approveSummary(context);
  await waitFor(() => expect(context.client.commands()).toEqual([{ kind: 'approve_summary', revision: 4 }]));
  const operationId = await context.client.operation();
  const goal = { ...goalRecord(), ...summaryB };
  context.client.change({ state: { ...context.client.getSnapshot().state!, revision: 5, pending: null } });
  context.client.output({ kind: 'result', operationId, result: { kind: 'goal_registered', goal } });
  await waitFor(() => {
    expect(context.app.lastFrame()).toContain(goal.id);
    expect(context.app.lastFrame()).toContain(goal.branch);
    expect(context.app.lastFrame()).not.toContain(lang === 'ja' ? '登録する要約' : 'Summary to register');
  });
});

it.each([ENTER, ESC, '修正', '/g', '\x1b[13;2u', '\x1b[13;3u'])('immediately withdraws revision four on editing or continuing with %j', async (input) => {
  const context = mount();
  await showProposal(context);
  context.app.stdin.write(input);
  await waitFor(() => expect(context.client.commands()[0]).toEqual({ kind: 'dismiss_summary', revision: 4 }));
  expect(context.client.commands().some((command) => command.kind === 'approve_summary')).toBe(false);
});

it('restores the authoritative proposal when immediate withdrawal is refused', async () => {
  const context = mount();
  await showProposal(context);
  context.client.submit.mockResolvedValueOnce({ kind: 'busy', operationId: randomUUID() });
  context.app.stdin.write(ESC);
  await waitFor(() => {
    expect(context.client.commands()).toEqual([{ kind: 'dismiss_summary', revision: 4 }]);
    expect(context.app.lastFrame()).toContain(summaryA.objective);
    expect(context.app.lastFrame()).toContain(getLabel('manager.conversation.busy', 'en'));
  });
});

it('displays a stale approval error and requires review of the refreshed revision', async () => {
  const context = mount();
  await showProposal(context);
  context.client.submit.mockResolvedValueOnce({ kind: 'error', code: 'stale_summary',
    message: getLabel('manager.conversation.stale_summary', 'en') });
  context.client.refresh.mockImplementation(async () => { context.client.proposal(summaryB, 5); });
  approveSummary(context);
  await waitFor(() => expect(context.app.lastFrame()).toContain(summaryB.objective));
  expect(context.client.commands()).toEqual([{ kind: 'approve_summary', revision: 4 }]);
  expect(context.app.lastFrame()).toContain(getLabel('manager.conversation.stale_summary', 'en'));
  approveSummary(context);
  await waitFor(() => expect(context.client.commands()).toEqual([
    { kind: 'approve_summary', revision: 4 }, { kind: 'approve_summary', revision: 5 },
  ]));
});

it.each(['ja', 'en'] as const)('keeps original array boundaries and multiline bullet indentation in %s', async (lang) => {
  for (const field of ['outOfScope', 'acceptanceCriteria', 'constraints'] as const) {
    const context = mount(lang);
    const summary = { ...summaryA, [field]: ['CSV\n通知\n配信', 'CSV; 通知', 'CSV","通知', 'CSV', 'CSV'] };
    await showProposal(context, summary);
    const lines = context.app.lastFrame()!.split('\n').map((line) => line.replace(/^│/u, '').replace(/[│\s]+$/gu, ''));
    const index = lines.indexOf('- CSV');
    expect(index).toBeGreaterThanOrEqual(0);
    expect(lines.slice(index, index + 3)).toEqual(['- CSV', '  通知', '  配信']);
    expect(lines.filter((line) => line === '- CSV').length).toBeGreaterThanOrEqual(3);
    expect(context.client.getSnapshot().state?.pending?.summary[field]).toEqual(summary[field]);
    context.app.stdin.write(UP);
    context.app.stdin.write(ENTER);
    await waitFor(() => expect(context.client.commands()).toEqual([{ kind: 'approve_summary', revision: 4 }]));
    context.app.unmount();
  }
});

it.each(['ja', 'en'] as const)('sanitizes each bullet independently without changing the authoritative summary in %s', async (lang) => {
  const context = mount(lang);
  const summary = { ...summaryA, outOfScope: ['CSV\x1b[', '通知'], acceptanceCriteria: ['\x1b[31mCSVを取得できる\x1b[0m'] };
  await showProposal(context, summary);
  const frame = context.app.lastFrame()!;
  expect(frame).toContain('- CSV');
  expect(frame).toContain('- 通知');
  expect(frame).toContain('- CSVを取得できる');
  expect(frame).not.toContain('\x1b');
  expect(context.client.getSnapshot().state?.pending?.summary).toEqual(summary);
});

it.each([7, 9])('keeps every element of a proposal containing %i large constraints at the display boundary', async (count) => {
  const context = mount();
  const constraints = Array.from({ length: count }, (_, index) => 'constraint-' + index + '-' + 'x'.repeat(128 * 1024));
  const summary = { ...summaryA, constraints };
  await showProposal(context, summary);
  const text = context.app.lastFrame()!.replace(/[│\s]/gu, '');
  for (const value of constraints) expect(text).toContain(toDisplayText(value));
  expect(context.client.getSnapshot().state?.pending?.summary.constraints).toEqual(constraints);
});

it('keeps revision five on the same mounted screen after delayed revision four data and end', async () => {
  const context = mount();
  const { client } = context;
  const initial = { ...client.getSnapshot().state!, pending: { revision: 4, repositoryDirectory: cwd, summary: summaryA } };
  const receiver = new ConversationTransferReceiver(initial.conversationId, {
    state: (state) => client.change({ state }), item() {}, remove() {}, output: (output) => client.output(output),
    read: (readStatus) => client.change({ readStatus }),
  });
  const metadata = (revision: number, stateSequence: number) => ({ conversationId: initial.conversationId,
    transferId: randomUUID(), mode: 'initial' as const, revision, stateSequence, operationId: null });
  const collect = async (read: ReturnType<typeof metadata>, state: ConversationState, snapshot = false) => {
    const frames = [];
    for await (const { frame } of conversationTransferFrames(initial.conversationId, snapshot ? read : { ...read, mode: undefined }, snapshot ? 'snapshot' : 'output',
      (async function* () { yield snapshot ? { kind: 'state', state } : { kind: 'pending', state }; })())) frames.push(frame);
    return frames;
  };
  const old = metadata(4, 1); receiver.expectRead(old);
  const oldFrames = await collect(old, initial, true);
  oldFrames.slice(0, -1).forEach((frame) => receiver.receive(frame));
  await waitFor(() => expect(context.app.lastFrame()).toContain(summaryA.objective));
  const next = { ...initial, revision: 5, pending: { ...initial.pending, revision: 5, summary: summaryB } };
  for (const frame of await collect(metadata(5, 3), next)) receiver.receive(frame);
  receiver.receive(oldFrames.at(-1));
  for (const frame of await collect(metadata(4, 2), initial)) receiver.receive(frame);
  await waitFor(() => {
    expect(context.app.lastFrame()).toContain(summaryB.objective);
    expect(context.app.lastFrame()).not.toContain(summaryA.objective);
  });
  approveSummary(context);
  await waitFor(() => expect(client.commands()).toEqual([{ kind: 'approve_summary', revision: 5 }]));
});

it('disables approval after a mid-item disconnect and restores the whole proposal on the same screen and conversation', async () => {
  const context = mount();
  const { client } = context;
  const state = { ...client.getSnapshot().state!, pending: { revision: 4, repositoryDirectory: cwd, summary: summaryA } };
  const receiver = new ConversationTransferReceiver(state.conversationId, {
    state: (value) => client.change({ state: value }), item() {}, remove() {}, output: (output) => client.output(output),
    read: (readStatus) => client.change({ readStatus }),
  });
  const read = { conversationId: state.conversationId, transferId: randomUUID(), mode: 'initial' as const, revision: 4, stateSequence: 2, operationId: null };
  receiver.expectRead(read);
  const { conversationId, ...wire } = read;
  receiver.receive({ protocolVersion: 1, type: 'event', conversationId,
    output: { kind: 'transfer_start', purpose: 'snapshot', ...wire } });
  receiver.receive({ protocolVersion: 1, type: 'event', conversationId,
    output: { kind: 'transfer_data', transferId: read.transferId, itemIndex: 0, fragmentIndex: 0,
      finalFragment: false, data: Buffer.from('{"kind":"state",').toString('base64') } });
  receiver.disconnect();
  client.change({ connection: 'disconnected' });
  client.submit.mockResolvedValueOnce({ kind: 'error', code: 'unavailable_attachment', message: 'Disconnected' });
  await waitFor(() => expect(context.app.lastFrame()).toContain(getLabel('manager.conversation.incomplete', 'en')));
  await typeAndSubmit(context, '/make-goal');
  await waitFor(() => expect(client.submit).toHaveBeenCalledOnce());
  expect(client.commands().some((command) => command.kind === 'approve_summary')).toBe(false);
  expect(client.getSnapshot().state?.pending).toBeNull();
  receiver.authenticated();
  const restored = { ...read, transferId: randomUUID(), stateSequence: 0 };
  receiver.expectRead(restored);
  client.change({ connection: 'connected' });
  for await (const { frame } of conversationTransferFrames(conversationId, restored, 'snapshot',
    (async function* () { yield { kind: 'state', state }; })())) receiver.receive(frame);
  await waitFor(() => expect(context.app.lastFrame()).toContain(summaryA.objective));
  expect(client.getSnapshot().state?.conversationId).toBe(conversationId);
  expect(client.getSnapshot().state?.pending?.summary).toEqual(summaryA);
  approveSummary(context);
  await waitFor(() => expect(client.commands().filter((command) => command.kind === 'approve_summary')).toEqual([
    { kind: 'approve_summary', revision: 4 },
  ]));
});

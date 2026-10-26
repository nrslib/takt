import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { mount, promptFrame, waitFor, typeAndSubmit, showProposal, summaryA, ENTER, ESC, approveSummary } from './manager-tui-fixtures.js';
import { getLabel } from '../../shared/i18n/index.js';

it.each(['/help', '/make-goal extra', '説明 /make-goal', '> /make-goal', '`/make-goal`', '~~~\n/make-goal\n~~~', '```\n/make-goal\n```', '```\n/make-goal', '````\n```\n/make-goal\n```\n````', '/go', '  /go  ', '/go extra', '/answer ID', '/pause ID', '/resume ID', '/abort ID', '/goal', '> /go', '説明 /go', '\x60\x60\x60\n/go\n\x60\x60\x60'])(
  'sends slash and quoted input unchanged as a message: %j', async (text) => {
    const context = mount();
    await typeAndSubmit(context, text);
    await waitFor(() => expect(context.client.commands()).toEqual([{ kind: 'message', text }]));
    expect(context.app.lastFrame()).not.toMatch(/Queued messages|送信待ち/u);
  });

it.each(['separate CR', 'character with CR', 'character with LF', 'character with CRLF'])(
  'submits exactly one message after character input with %s', async (delivery) => {
    const context = mount();
    context.app.stdin.write('a');
    context.app.stdin.write('b');
    if (delivery === 'separate CR') { context.app.stdin.write('c'); context.app.stdin.write(ENTER); }
    else context.app.stdin.write('c' + (delivery.endsWith('CRLF') ? '\r\n' : delivery.endsWith('LF') ? '\n' : '\r'));
    await waitFor(() => expect(context.client.commands()).toEqual([{ kind: 'message', text: 'abc' }]));
    expect(promptFrame(context)).not.toContain('abc');
  });

it.each(['bracketed', 'unbracketed', 'separate Enter'] as const)('submits a long %s paste once without shortening it', async (delivery) => {
  const context = mount();
  const text = '長い貼り付け本文'.repeat(180) + '末尾';
  if (delivery === 'bracketed') context.app.stdin.write('\x1b[200~' + text + '\x1b[201~');
  else context.app.stdin.write(text + (delivery === 'unbracketed' ? '\r' : ''));
  if (delivery !== 'unbracketed') {
    await waitFor(() => expect(promptFrame(context)).toContain('末尾'));
    context.app.stdin.write(ENTER);
  }
  await waitFor(() => expect(context.client.commands()).toEqual([{ kind: 'message', text }]));
});

it.each(['\n', '\r'])('keeps a bracketed paste containing %j as an unsent draft until an outside Enter', async (separator) => {
  const context = mount();
  const text = 'first' + separator + 'second';
  context.app.stdin.write('\x1b[200~' + text + '\x1b[201~');
  await waitFor(() => expect(promptFrame(context)).toContain('second'));
  expect(context.client.submit).not.toHaveBeenCalled();
  context.app.stdin.write(ENTER);
  await waitFor(() => expect(context.client.commands()).toEqual([{ kind: 'message', text: separator === '\r' ? 'firstsecond' : 'first\nsecond' }]));
});

it('keeps Ctrl+A, Ctrl+E, Ctrl+K and cursor editing in the conversation draft', async () => {
  const context = mount('ja');
  context.app.stdin.write('あいう');
  await waitFor(() => expect(promptFrame(context)).toContain('あいう'));
  context.app.stdin.write('\x01');
  context.app.stdin.write('前');
  context.app.stdin.write('\x05');
  context.app.stdin.write('後');
  await waitFor(() => expect(promptFrame(context)).toContain('前あいう後'));
  context.app.stdin.write('\x01');
  context.app.stdin.write('\x1b[C');
  context.app.stdin.write('\x0b');
  context.app.stdin.write(ENTER);
  await waitFor(() => expect(context.client.commands()).toEqual([{ kind: 'message', text: '前' }]));
});

it('keeps an unsent draft and Shift+Enter newline across completion of the active operation', async () => {
  const context = mount();
  const operationId = randomUUID();
  context.client.change({ state: { ...context.client.getSnapshot().state!, running: { operationId, kind: 'message' } } });
  context.app.stdin.write('first');
  context.app.stdin.write('\x1b[13;2u');
  context.app.stdin.write('second');
  await waitFor(() => expect(promptFrame(context)).toContain('second'));
  expect(context.client.submit).not.toHaveBeenCalled();
  context.client.change({ state: { ...context.client.getSnapshot().state!, running: null } });
  context.app.stdin.write(ENTER);
  await waitFor(() => expect(context.client.commands()).toEqual([{ kind: 'message', text: 'first\nsecond' }]));
});

it.each(['message', 'approve_summary'] as const)('never resends input rejected while a %s operation is running', async (kind) => {
  const context = mount();
  const operationId = randomUUID();
  context.client.change({ state: { ...context.client.getSnapshot().state!, running: { operationId, kind } } });
  context.client.submit.mockResolvedValueOnce({ kind: 'busy', operationId });
  await typeAndSubmit(context, 'Rejected input');
  await waitFor(() => expect(context.app.lastFrame()).toContain(getLabel('manager.conversation.busy', 'en')));
  context.app.stdin.write('Unsent draft');
  context.client.change({ state: { ...context.client.getSnapshot().state!, running: null } });
  await waitFor(() => expect(promptFrame(context)).toContain('Unsent draft'));
  await new Promise((resolve) => setTimeout(resolve, 550));
  expect(context.client.commands()).toEqual([{ kind: 'message', text: 'Rejected input' }]);
  expect(context.app.lastFrame()).not.toMatch(/Queued messages|送信待ち/u);
});

it.each(['', '/'])('aborts only the authoritative running operation on Escape with draft %j', async (draft) => {
  const context = mount();
  const operationId = randomUUID();
  context.client.change({ state: { ...context.client.getSnapshot().state!, running: { operationId, kind: 'message' } } });
  await waitFor(() => expect(context.app.lastFrame()).toContain('Working'));
  if (draft !== '') {
    context.app.stdin.write(draft);
    await waitFor(() => expect(promptFrame(context)).toContain('❯ ' + draft));
  }
  context.app.stdin.write(ESC);
  await waitFor(() => expect(context.client.commands()).toEqual([{ kind: 'abort_turn', operationId }]));
  expect(context.onExit).not.toHaveBeenCalled();
});

it.each(['message', 'approve_summary'] as const)('detaches on Ctrl+C during %s without sending abort_turn', async (kind) => {
  const context = mount();
  context.client.change({ state: { ...context.client.getSnapshot().state!, running: { operationId: randomUUID(), kind } } });
  context.app.stdin.write('\x03');
  await waitFor(() => expect(context.onExit).toHaveBeenCalledOnce());
  context.app.unmount();
  expect(context.client.close).toHaveBeenCalledOnce();
  expect(context.client.submit).not.toHaveBeenCalled();
});

it('does not queue a summary instruction rejected as busy or approve a later arriving summary', async () => {
  const context = mount();
  const operationId = randomUUID();
  context.client.change({ state: { ...context.client.getSnapshot().state!, running: { operationId, kind: 'message' } } });
  context.client.submit.mockResolvedValueOnce({ kind: 'busy', operationId });
  await typeAndSubmit(context, '/make-goal');
  await waitFor(() => expect(context.app.lastFrame()).toContain(getLabel('manager.conversation.busy', 'en')));
  await showProposal(context, summaryA, 5);
  await waitFor(() => expect(context.client.refresh).toHaveBeenCalled());
  expect(context.client.commands()).toEqual([{ kind: 'message', text: getLabel('manager.goSummaryRequest', 'en') }]);
  approveSummary(context);
  await waitFor(() => expect(context.client.commands()).toEqual([
    { kind: 'message', text: getLabel('manager.goSummaryRequest', 'en') },
    { kind: 'approve_summary', revision: 5 },
  ]));
});

import { createElement } from 'react';
import { renderToString } from 'ink';
import { describe, expect, it } from 'vitest';
import { ManagerSummaryDialog } from '../features/manager/ManagerSummaryDialog.js';
import type { Submission } from '../features/manager/conversationPort.js';
import { getLabel } from '../shared/i18n/index.js';
import { stripAnsi } from '../shared/utils/text.js';
import { mount, showProposal, waitFor, typeAndSubmit, ESC, ENTER, UP, DOWN } from './helpers/manager-tui-fixtures.js';

describe.each(['ja', 'en'] as const)('goal proposal confirmation in %s', (lang) => {
  it.each([false, true])('shows the question, registration choices and dismissal explanation with approve=%s', (approve) => {
    const text = stripAnsi(renderToString(createElement(ManagerSummaryDialog, { approve, lang }), { columns: 120 }));
    const rows = text.split('\n').slice(1, -1).map((row) => row.replace(/^│\s*|\s*│$/gu, ''));
    expect(rows).toEqual(lang === 'ja' ? [
      'この内容でゴールを登録しますか？', '登録する', '登録せずに会話に戻る',
      '会話に戻るか、修正内容を入力すると、この登録案は取り下げられます。',
    ] : [
      'Register this goal?', 'Register goal', 'Return to conversation without registering',
      'Returning to the conversation or typing changes dismisses this proposal.',
    ]);
  });

  it.each(['running', 'queued', 'sending'] as const)('switches Escape guidance between idle and %s processing', async (phase) => {
    const context = mount(lang);
    await showProposal(context);
    const compact = (text: string): string => text.replace(/\s/gu, '');
    const idle = compact(getLabel('manager.summaryInputHint', lang));
    const working = compact(getLabel('manager.summaryInputHintWorking', lang));
    await waitFor(() => expect(compact(context.app.lastFrame()!)).toContain(idle));
    const state = context.client.getSnapshot().state!;
    let finishSending: (() => void) | undefined;
    if (phase === 'sending') {
      context.client.submit.mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => { finishSending = resolve; });
        return { kind: 'accepted', operationId: 'summary' };
      });
      await typeAndSubmit(context, '/make-goal');
    } else {
      context.client.change({ state: { ...state, ...(phase === 'running'
        ? { running: { operationId: 'turn', generation: 1, kind: 'message' as const } }
        : { queuedMessageCount: 1 }) } });
    }
    try {
      await waitFor(() => {
        expect(compact(context.app.lastFrame()!)).toContain(working);
        expect(compact(context.app.lastFrame()!)).not.toContain(idle);
      });
    } finally {
      finishSending?.();
      context.client.change({ state });
    }
    await waitFor(() => expect(compact(context.app.lastFrame()!)).toContain(idle));
  });

  it.each(['approve_summary', 'dismiss_summary'] as const)('hides the confirmation while %s awaits its response', async (kind) => {
    const context = mount(lang);
    await showProposal(context);
    let respond!: (response: Submission) => void;
    let firstSubmittedFrame!: number;
    context.client.submit.mockImplementationOnce(() => {
      firstSubmittedFrame = context.app.frames.length;
      return new Promise((resolve) => { respond = resolve; });
    });
    if (kind === 'approve_summary') context.app.stdin.write(UP);
    context.app.stdin.write(ENTER);
    try {
      await waitFor(() => {
        expect(context.client.commands()).toEqual([{ kind, revision: 4 }]);
        expect(context.app.lastFrame()).not.toContain(getLabel('manager.summary.confirmation', lang));
        expect(context.app.lastFrame()).toContain(lang === 'ja' ? '処理中' : 'Working');
      });
      for (const frame of context.app.frames.slice(firstSubmittedFrame)) {
        expect(frame).not.toContain(getLabel('manager.summary.confirmation', lang));
      }
      context.app.stdin.write(DOWN);
      context.app.stdin.write(ENTER);
      expect(context.client.commands()).toHaveLength(1);
    } finally {
      respond({ kind: 'accepted', operationId: kind });
    }
    await context.client.operation();
    const state = context.client.getSnapshot().state!;
    context.client.change({ state: { ...state,
      pending: kind === 'approve_summary' ? structuredClone(state.pending) : state.pending,
      running: { operationId: kind, kind } } });
    context.client.output({ kind: 'progress', operationId: kind, message: 'Operation pending' });
    await waitFor(() => {
      expect(context.app.lastFrame()).toContain('Operation pending');
      expect(context.app.lastFrame()).toContain(lang === 'ja' ? '処理中' : 'Working');
      expect(context.app.lastFrame()).not.toContain(getLabel('manager.summary.confirmation', lang));
    });
  });

  it.each(['rejected', 'disconnected', 'result'] as const)('restores the confirmation with the default choice after registration fails via %s', async (failure) => {
    const context = mount(lang);
    await showProposal(context);
    if (failure === 'rejected') {
      context.client.submit.mockResolvedValueOnce({ kind: 'error', code: 'queue_full', message: 'Registration rejected' });
    } else if (failure === 'disconnected') {
      context.client.submit.mockRejectedValueOnce(new Error('Registration disconnected'));
    }
    context.app.stdin.write(UP);
    context.app.stdin.write(ENTER);
    await waitFor(() => expect(context.client.commands()).toEqual([{ kind: 'approve_summary', revision: 4 }]));
    if (failure === 'result') {
      const operationId = await context.client.operation();
      await waitFor(() => expect(context.app.lastFrame()).not.toContain(getLabel('manager.summary.confirmation', lang)));
      context.client.output({ kind: 'result', operationId,
        result: { kind: 'error', code: 'registration_failed', message: 'Registration failed' } });
    }
    await waitFor(() => {
      expect(context.app.lastFrame()).toContain(getLabel('manager.summary.confirmation', lang));
      expect(context.app.lastFrame()).toContain('Registration');
    });
    context.app.stdin.write(ENTER);
    await waitFor(() => expect(context.client.commands()).toEqual([
      { kind: 'approve_summary', revision: 4 }, { kind: 'dismiss_summary', revision: 4 },
    ]));
  });

  it.each([ENTER, DOWN + ENTER, ESC])('dismisses the proposal without registration on %j', async (input) => {
    const context = mount(lang);
    await showProposal(context);
    if (input === DOWN + ENTER) context.app.stdin.write(DOWN);
    context.app.stdin.write(input === DOWN + ENTER ? ENTER : input);
    await waitFor(() => expect(context.client.commands()).toEqual([{ kind: 'dismiss_summary', revision: 4 }]));
  });
});

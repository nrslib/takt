import { createElement } from 'react';
import { renderToString } from 'ink';
import { describe, expect, it } from 'vitest';
import { ManagerSummaryDialog } from '../features/manager/ManagerSummaryDialog.js';
import { getLabel } from '../shared/i18n/index.js';
import { stripAnsi } from '../shared/utils/text.js';
import { mount, showProposal, waitFor, ESC, ENTER, UP, DOWN } from './helpers/manager-tui-fixtures.js';

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
        return { kind: 'accepted', operationId: 'registration' };
      });
      context.app.stdin.write(UP);
      context.app.stdin.write(ENTER);
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

  it.each([ENTER, DOWN + ENTER, ESC])('dismisses the proposal without registration on %j', async (input) => {
    const context = mount(lang);
    await showProposal(context);
    if (input === DOWN + ENTER) context.app.stdin.write(DOWN);
    context.app.stdin.write(input === DOWN + ENTER ? ENTER : input);
    await waitFor(() => expect(context.client.commands()).toEqual([{ kind: 'dismiss_summary', revision: 4 }]));
  });
});

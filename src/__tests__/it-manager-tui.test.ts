import { createElement, type ComponentProps } from 'react';
import { cleanup, render } from 'ink-testing-library';
import stringWidth from 'string-width';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toDisplayText } from '../features/tui/displayText.js';
import { ManagerView } from '../features/manager/ManagerView.js';
import { createManagerConversationSession } from '../features/manager/conversationSession.js';
import { createGoalConfirmation } from '../features/manager/goalConfirmation.js';
import type { ManagerGoalSummary } from '../features/manager/goalConfirmation.js';
import { verifyGoalConfirmation } from '../infra/goals/confirmation.js';
import { makeProvider } from './test-helpers.js';
import { goalRecord } from './helpers/goal-fixtures.js';
import { GoalConfirmationPayloadSchema, GoalCreateInputSchema, GoalSchema } from '../infra/goals/schema.js';
import { firstTextContent } from './helpers/mcp-content.js';
import type { ProviderAgent } from '../infra/providers/types.js';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getLabel } from '../shared/i18n/index.js';
vi.mock('../infra/goals/store.js', () => ({ GoalStore: class { async list() { return { goals: [], errors: [] }; } } }));
vi.mock('../features/manager/autoRun.js', () => ({ ensureManagerRun: vi.fn(async () => {}) }));
const startupDoubles = vi.hoisted(() => ({ flush: vi.fn(async () => {}) }));
vi.mock('ink', async (importOriginal) => {
  const original = await importOriginal<typeof import('ink')>();
  return { ...original, useApp: () => ({ ...original.useApp(), waitUntilRenderFlush: startupDoubles.flush }) };
});

const cwd = '/test/manager-repository';
const summaryA = { objective: 'CSVを出力する', outOfScope: ['JSON出力'], acceptanceCriteria: ['CSVを取得できる'] };
const summaryB = { objective: 'JSONを出力する', outOfScope: ['CSV出力', '通知'], acceptanceCriteria: ['JSONを取得できる', '列名を含む'], startBranch: 'release', integrationBranch: 'main' };
const ENTER = '\r';
const UP = '\x1b[A';

function response(summary: typeof summaryA | null) {
  const structuredOutput = { message: 'Please review the summary.', summary };
  return { persona: 'manager', status: 'done' as const, timestamp: new Date('2026-10-05T12:00:00Z'), content: JSON.stringify(structuredOutput), structuredOutput };
}

function mount(lang: 'ja' | 'en' = 'en', startup?: ComponentProps<typeof ManagerView>['startup']) {
  const call = vi.fn<ProviderAgent['call']>().mockImplementation(async (prompt) => response(prompt.includes('goalRegistered') ? null : summaryA));
  const confirmation = createGoalConfirmation(cwd);
  const sign = vi.spyOn(confirmation, 'sign');
  const callTool = vi.fn<Client['callTool']>().mockImplementation(async ({ arguments: args }) => {
    const payload = GoalConfirmationPayloadSchema.parse(JSON.parse(GoalCreateInputSchema.parse(args).confirmation.payload));
    const { id, projectRoot: _root, confirmedAt, confirmedBy, ...approvedSummary } = payload;
    const goal = { ...goalRecord(), ...approvedSummary, id, confirmation: { confirmedAt, confirmedBy } };
    return { content: [{ type: 'text', text: JSON.stringify({ goal }) }] };
  });
  const session = createManagerConversationSession({
    cwd, confirmation, mcpClient: { callTool },
    plan: {
      ctx: { providerType: 'mock', model: undefined, lang, provider: makeProvider({ supportsStructuredOutput: true, setup: () => ({ call }) }) },
      strategy: { systemPrompt: 'manager fixture', allowedTools: ['Read'] },
    },
  });
  const onExit = vi.fn();
  const app = render(createElement(ManagerView, { cwd, lang, session, initialDiagnostics: [], onExit, startup }));
  return { app, call, sign, callTool, session, confirmation, lang, onExit };
}

async function send(context: ReturnType<typeof mount>, text: string, summary: ManagerGoalSummary) {
  const { app, call, session } = context;
  const before = call.mock.calls.length;
  app.stdin.write(text);
  await vi.waitFor(() => expect(app.lastFrame()).toContain(text));
  app.stdin.write(ENTER);
  await vi.waitFor(() => {
    expect(call).toHaveBeenCalledTimes(before + 1);
    expect(session.getPendingSummary()?.summary).toEqual(summary);
  });
  await vi.waitFor(() => {
    const frame = app.lastFrame();
    expect(frame).toContain(summary.objective);
    expect(frame).toContain(context.lang === 'ja' ? '範囲外:' : 'Out of scope:');
    expect(frame).toContain(context.lang === 'ja' ? '受け入れ条件:' : 'Acceptance criteria:');
    for (const item of [...summary.outOfScope, ...summary.acceptanceCriteria]) {
      expect(frame).toContain(`- ${toDisplayText(item).split('\n')[0]}`);
    }
    if (summary.startBranch !== undefined) expect(frame).toContain(`startBranch: ${summary.startBranch}`);
    if (summary.integrationBranch !== undefined) expect(frame).toContain(`integrationBranch: ${summary.integrationBranch}`);
  });
}

async function approve(context: ReturnType<typeof mount>, summary: ManagerGoalSummary) {
  const { app, sign, callTool, confirmation } = context;
  expect(sign).not.toHaveBeenCalled();
  expect(callTool).not.toHaveBeenCalled();

  app.stdin.write(UP);
  app.stdin.write(ENTER);

  await vi.waitFor(() => expect(callTool).toHaveBeenCalledTimes(1));
  expect(sign).toHaveBeenCalledExactlyOnceWith(summary);
  expect(callTool.mock.calls[0]![0]).toMatchObject({ name: 'takt_create_goal', arguments: summary });
  const request = GoalCreateInputSchema.parse(callTool.mock.calls[0]![0].arguments);
  expect(() => verifyGoalConfirmation(request, confirmation.publicKey)).not.toThrow();
  expect(GoalConfirmationPayloadSchema.parse(JSON.parse(request.confirmation.payload))).toMatchObject(summary);
  const registered = GoalSchema.parse(JSON.parse(firstTextContent((await callTool.mock.results[0]!.value).content)).goal);
  await vi.waitFor(() => {
    expect(app.lastFrame()).toContain(registered.id);
    expect(app.lastFrame()).toContain(registered.branch);
  });
}

beforeEach(() => { vi.clearAllMocks(); startupDoubles.flush.mockReset().mockResolvedValue(undefined); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('manager TUI human approval', () => {
  describe.each([
    { lang: 'ja' as const, changes: /manager は実験的機能.*動作・設定・保存するデータの形式.*予告なく/u, costs: /自動でタスクを投入・実行.*provider の API の費用/u },
    { lang: 'en' as const, changes: /manager is experimental.*behavior, settings, and saved data formats.*without notice/iu, costs: /automatically queues and runs tasks.*provider API costs/iu },
  ])('experimental notices in $lang', ({ lang, changes, costs }) => {
    function expectNotices(frame: string | undefined): void {
      const text = frame?.replace(/\s+/gu, ' ');
      expect(text).toMatch(changes);
      expect(text).toMatch(costs);
      expect(text).toContain('Enter: send');
      expect(text!.search(costs)).toBeLessThan(text!.indexOf('Enter: send'));
    }

    it('shows both notices on every startup without calling the provider', async () => {
      for (let startup = 0; startup < 2; startup++) {
        const context = mount(lang);
        await vi.waitFor(() => expectNotices(context.app.lastFrame()));
        expect(context.call).not.toHaveBeenCalled();
        expect(context.callTool).not.toHaveBeenCalled();
        expect(context.sign).not.toHaveBeenCalled();
        context.app.unmount();
        await context.session.close();
      }
    });

    it('displays both notices and waits for stdout before running startup recovery and automatic execution', async () => {
      let finishFlush!: () => void;
      startupDoubles.flush.mockReturnValueOnce(new Promise<void>((resolve) => { finishFlush = resolve; }));
      const startup = {
        run: vi.fn(async () => {
          expectNotices(context.app.lastFrame());
          return ['startup diagnostic'];
        }),
        fail: vi.fn(),
      };
      const context = mount(lang, startup);
      await vi.waitFor(() => {
        expectNotices(context.app.lastFrame());
        expect(startupDoubles.flush).toHaveBeenCalledTimes(1);
      });
      expect(startup.run).not.toHaveBeenCalled();
      context.app.stdin.write('premature input');
      context.app.stdin.write(ENTER);
      expect(context.call).not.toHaveBeenCalled();

      finishFlush();
      await vi.waitFor(() => expect(context.app.lastFrame()).toContain('startup diagnostic'));
      expect(startup.run).toHaveBeenCalledTimes(1);
      expect(startup.fail).not.toHaveBeenCalled();
      expect(context.call).not.toHaveBeenCalled();
      await send(context, 'CSV出力を追加したい', summaryA);
      expectNotices(context.app.lastFrame());
      expect(startup.run).toHaveBeenCalledTimes(1);
      await context.session.close();
    });

    it.each(['flush', 'startup'] as const)('reports a %s failure to the mount', async (source) => {
      const failure = new Error(`${source} failed`);
      const startup = { run: vi.fn(async () => [] as string[]), fail: vi.fn() };
      if (source === 'flush') startupDoubles.flush.mockRejectedValueOnce(failure);
      else startup.run.mockRejectedValueOnce(failure);
      const context = mount(lang, startup);

      await vi.waitFor(() => expect(startup.fail).toHaveBeenCalledExactlyOnceWith(failure));
      expect(startup.run).toHaveBeenCalledTimes(source === 'flush' ? 0 : 1);
      expect(context.call).not.toHaveBeenCalled();
      await context.session.close();
    });

    it('accepts Ctrl+C while stdout is flushing and skips recovery', async () => {
      let finishFlush!: () => void;
      startupDoubles.flush.mockReturnValueOnce(new Promise<void>((resolve) => { finishFlush = resolve; }));
      const startup = { run: vi.fn(async (_signal: AbortSignal) => [] as string[]), fail: vi.fn() };
      const context = mount(lang, startup);
      await vi.waitFor(() => expect(startupDoubles.flush).toHaveBeenCalledTimes(1));

      context.app.stdin.write('ignored');
      context.app.stdin.write(ENTER);
      context.app.stdin.write('\x03');
      await vi.waitFor(() => expect(context.onExit).toHaveBeenCalledTimes(1));
      finishFlush();
      await startupDoubles.flush.mock.results[0]!.value;

      expect(startup.run).not.toHaveBeenCalled();
      expect(startup.fail).not.toHaveBeenCalled();
      expect(context.call).not.toHaveBeenCalled();
      await context.session.close();
    });

    it.each([false, true])('aborts recovery on Ctrl+C without accepting other input when recovery rejects=%s', async (rejects) => {
      let finishRecovery!: () => void;
      const recovery = new Promise<void>((resolve) => { finishRecovery = resolve; });
      const startup = {
        run: vi.fn(async (signal: AbortSignal) => {
          await recovery;
          if (rejects) throw signal.reason;
          return ['late recovery diagnostic'];
        }),
        fail: vi.fn(),
      };
      const context = mount(lang, startup);
      await vi.waitFor(() => expect(startup.run).toHaveBeenCalledTimes(1));
      const signal = startup.run.mock.calls[0]![0];

      context.app.stdin.write('ignored');
      context.app.stdin.write(ENTER);
      context.app.stdin.write('\x1b[27u');
      expect(signal.aborted).toBe(false);
      context.app.stdin.write('\x03');
      await vi.waitFor(() => {
        expect(signal.aborted).toBe(true);
        expect(context.onExit).toHaveBeenCalledTimes(1);
      });
      finishRecovery();
      await Promise.allSettled([startup.run.mock.results[0]!.value]);
      context.app.stdin.write('ignored after abort');
      context.app.stdin.write(ENTER);
      context.app.stdin.write('\x03');

      expect(context.onExit).toHaveBeenCalledTimes(1);
      expect(startup.fail).not.toHaveBeenCalled();
      expect(context.app.lastFrame()).not.toContain('late recovery diagnostic');
      expect(context.app.lastFrame()).not.toContain('ignored');
      expect(context.call).not.toHaveBeenCalled();
      await context.session.close();
    });

    it('does not start recovery when the TUI unmounts before stdout is flushed', async () => {
      let finishFlush!: () => void;
      startupDoubles.flush.mockReturnValueOnce(new Promise<void>((resolve) => { finishFlush = resolve; }));
      const startup = { run: vi.fn(async () => [] as string[]), fail: vi.fn() };
      const context = mount(lang, startup);
      await vi.waitFor(() => expect(startupDoubles.flush).toHaveBeenCalledTimes(1));
      context.app.unmount();

      finishFlush();
      await startupDoubles.flush.mock.results[0]!.value;
      expect(startup.run).not.toHaveBeenCalled();
      expect(startup.fail).not.toHaveBeenCalled();
      await context.session.close();
    });

    it('keeps both notices above the input after a conversation redraw and a summary', async () => {
      const context = mount(lang);
      await vi.waitFor(() => expectNotices(context.app.lastFrame()));
      await send(context, 'CSV出力を追加したい', summaryA);
      expectNotices(context.app.lastFrame());
    });

    it.each([40, 80])('wraps both notices within a %i-column terminal', async (columns) => {
      const context = mount(lang);
      vi.spyOn(context.app.stdout, 'columns', 'get').mockReturnValue(columns);
      context.app.rerender(createElement(ManagerView, {
        cwd, lang, session: context.session, initialDiagnostics: [], onExit: vi.fn(),
      }));

      await vi.waitFor(() => {
        const frame = context.app.lastFrame()!;
        const text = frame.replace(/\s+/gu, '');
        for (const key of ['manager.experimentalNotice', 'manager.costNotice']) {
          expect(text).toContain(getLabel(key, lang).replace(/\s+/gu, ''));
        }
        for (const line of frame.split('\n')) expect(stringWidth(line)).toBeLessThanOrEqual(columns);
      });
      expect(context.call).not.toHaveBeenCalled();
    });
  });

  it('does not sign quoted summaries when the provider has no current summary', async () => {
    const { app, call, sign, callTool, session } = mount();
    const structuredOutput = { message: `Quoted summary: ${JSON.stringify(summaryA)}`, summary: null };
    call.mockResolvedValueOnce({ ...response(summaryA), content: JSON.stringify(structuredOutput), structuredOutput });
    await vi.waitFor(() => expect(app.lastFrame()).toContain(cwd));
    app.stdin.write('要件を相談したい');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('要件を相談したい'));
    app.stdin.write(ENTER);
    await vi.waitFor(() => expect(app.lastFrame()).toContain('Quoted summary'));
    app.stdin.write(UP);
    app.stdin.write(ENTER);
    expect(session.getPendingSummary()).toBeNull();
    expect(sign).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalled();
  });
  it('identifies the manager, target repository and experimental status without starting a conversation', async () => {
    const { app, call, sign, callTool } = mount();

    await vi.waitFor(() => {
      expect(app.lastFrame()).toMatch(/manager/iu);
      expect(app.lastFrame()).toContain(cwd);
      expect(app.lastFrame()).toMatch(/experimental/iu);
    });
    expect(call).not.toHaveBeenCalled();
    expect(sign).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalled();
  });

  it('continues conversation on the default confirmation choice without signing', async () => {
    const context = mount();
    const { app, sign, callTool } = context;
    await vi.waitFor(() => expect(app.lastFrame()).toContain(cwd));
    await send(context, 'CSV出力を追加したい', summaryA);

    app.stdin.write(ENTER);
    await vi.waitFor(() => expect(context.session.getPendingSummary()).toBeNull());
    await send(context, '範囲外の内容を確認してください', summaryA);

    expect(sign).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalled();
  });

  it('approves the revised displayed summary only through the confirmation keys in the same mounted screen', async () => {
    const context = mount();
    const { app, call } = context;
    await vi.waitFor(() => expect(app.lastFrame()).toContain(cwd));
    await send(context, 'CSV出力を追加したい', summaryA);
    app.stdin.write(ENTER);
    call.mockResolvedValueOnce(response(summaryB));
    await send(context, 'JSONに変更してください', summaryB);
    await approve(context, summaryB);
  });

  describe.each(['ja', 'en'] as const)('approval lists in %s', (lang) => {
    describe.each(['structuredOutput', 'content'] as const)('array boundaries from %s', (format) => {
      describe.each(['outOfScope', 'acceptanceCriteria'] as const)('%s', (field) => {
        it.each([
          ['CSV', '通知'],
          ['CSV; 通知'],
          ['CSV","通知'],
          ['CSV\n通知\t\\'],
          ['CSV'],
          ['CSV', 'CSV'],
        ])('shows separate bullets for %j and signs the original array', async (...values) => {
          const context = mount(lang);
          const summary = { objective: summaryA.objective, outOfScope: ['基準'], acceptanceCriteria: ['基準'], [field]: values };
          const reply = response(summary);
          context.call.mockResolvedValueOnce({ ...reply, structuredOutput: format === 'content' ? undefined : reply.structuredOutput });
          await vi.waitFor(() => expect(context.app.lastFrame()).toContain(cwd));

          await send(context, '要約を確認してください', summary);

          const lines = context.app.lastFrame()!.split('\n').map((line) => line.replace(/^[│\s]+|[│\s]+$/gu, ''));
          const label = field === 'outOfScope'
            ? (lang === 'ja' ? '範囲外:' : 'Out of scope:')
            : (lang === 'ja' ? '受け入れ条件:' : 'Acceptance criteria:');
          const index = lines.indexOf(label);
          expect(index).toBeGreaterThanOrEqual(0);
          expect(lines.slice(index + 1).filter((line) => line.startsWith('- ')).slice(0, values.length))
            .toEqual(values.map((value) => `- ${toDisplayText(value).split('\n')[0]}`));
          await approve(context, summary);
        });

        it('indents continuation lines by the bullet width and signs the original array', async () => {
          const context = mount(lang);
          const values = ['CSV\n通知\n配信', '次の項目'];
          const summary = { ...summaryA, [field]: values };
          const reply = response(summary);
          context.call.mockResolvedValueOnce({ ...reply, structuredOutput: format === 'content' ? undefined : reply.structuredOutput });
          await vi.waitFor(() => expect(context.app.lastFrame()).toContain(cwd));

          await send(context, '要約を確認してください', summary);

          const lines = context.app.lastFrame()!.split('\n')
            .map((line) => line.replace(/^│/u, '').replace(/[│\s]+$/gu, ''));
          const index = lines.indexOf('- CSV');
          expect(index).toBeGreaterThanOrEqual(0);
          expect(lines.slice(index, index + 4)).toEqual(['- CSV', '  通知', '  配信', '- 次の項目']);
          await approve(context, summary);
        });
      });

      it('shows an empty out-of-scope list without changing the registered summary', async () => {
        const context = mount(lang);
        const summary = { ...summaryA, outOfScope: [] };
        const reply = response(summary);
        context.call.mockResolvedValueOnce({ ...reply, structuredOutput: format === 'content' ? undefined : reply.structuredOutput });
        await vi.waitFor(() => expect(context.app.lastFrame()).toContain(cwd));

        await send(context, '要約を確認してください', summary);

        expect(context.app.lastFrame()).not.toContain('[]');
        await approve(context, summary);
      });
    });

    it('sanitizes each displayed bullet independently', async () => {
      const context = mount(lang);
      const summary = { ...summaryA, outOfScope: ['CSV\x1b[', '通知'], acceptanceCriteria: ['\x1b[31mCSVを取得できる\x1b[0m'] };
      vi.spyOn(context.session, 'getPendingSummary').mockReturnValue({ revision: 1, summary });
      await vi.waitFor(() => expect(context.app.lastFrame()).toContain(cwd));
      context.app.stdin.write('要約を確認してください');
      await vi.waitFor(() => expect(context.app.lastFrame()).toContain('要約を確認してください'));
      context.app.stdin.write(ENTER);
      await vi.waitFor(() => {
        expect(context.app.lastFrame()).toContain('- CSV');
        expect(context.app.lastFrame()).toContain('- 通知');
        expect(context.app.lastFrame()).toContain('- CSVを取得できる');
        expect(context.app.lastFrame()).not.toContain('\x1b');
      });
      expect(context.sign).not.toHaveBeenCalled();
    });
  });
});

it('displays registration and initial turn failure and accepts a retry without registering again', async () => {
  const context = mount();
  const { app, call, callTool } = context;
  await vi.waitFor(() => expect(app.lastFrame()).toContain(cwd));
  await send(context, 'CSV出力を追加したい', summaryA);
  const error = 'injected initial work failure';
  call.mockRejectedValueOnce(new Error(error));
  await approve(context, summaryA);
  await vi.waitFor(() => expect(app.lastFrame()).toContain(error));
  const retry = 'Retry registered goal work';
  const structuredOutput = { message: 'retry complete', summary: null };
  call.mockResolvedValueOnce({ ...response(null), content: JSON.stringify(structuredOutput), structuredOutput });
  app.stdin.write(retry);
  await vi.waitFor(() => expect(app.lastFrame()).toContain(retry));
  app.stdin.write(ENTER);
  await vi.waitFor(() => expect(app.lastFrame()).toContain('retry complete'));
  expect(call.mock.calls[2]![0]).toBe(retry);
  expect(callTool).toHaveBeenCalledOnce();
  await context.session.close();
});

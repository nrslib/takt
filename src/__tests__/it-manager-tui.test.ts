import { createElement } from 'react';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

const cwd = '/test/manager-repository';
const summaryA = { objective: 'CSVを出力する', outOfScope: ['JSON出力'], acceptanceCriteria: ['CSVを取得できる'] };
const summaryB = { objective: 'JSONを出力する', outOfScope: ['CSV出力', '通知'], acceptanceCriteria: ['JSONを取得できる', '列名を含む'], startBranch: 'release', integrationBranch: 'main' };
const ENTER = '\r';
const UP = '\x1b[A';

function response(summary: typeof summaryA) {
  const structuredOutput = { message: 'Please review the summary.', summary };
  return { persona: 'manager', status: 'done' as const, timestamp: new Date('2026-10-05T12:00:00Z'), content: JSON.stringify(structuredOutput), structuredOutput };
}

function mount() {
  const call = vi.fn<ProviderAgent['call']>().mockResolvedValue(response(summaryA));
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
      ctx: { providerType: 'mock', model: undefined, lang: 'en', provider: makeProvider({ supportsStructuredOutput: true, setup: () => ({ call }) }) },
      strategy: { systemPrompt: 'manager fixture', allowedTools: ['Read'] },
    },
  });
  const app = render(createElement(ManagerView, { cwd, lang: 'en', session, onExit: vi.fn() }));
  return { app, call, sign, callTool, session, confirmation };
}

async function send({ app, call, session }: ReturnType<typeof mount>, text: string, summary: ManagerGoalSummary) {
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
    expect(frame).toContain(`Out of scope: ${JSON.stringify(summary.outOfScope)}`);
    expect(frame).toContain(`Acceptance criteria: ${JSON.stringify(summary.acceptanceCriteria)}`);
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

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { cleanup(); });

describe('manager TUI human approval', () => {
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

  describe.each(['structuredOutput', 'content'] as const)('array boundaries from %s', (format) => {
    describe.each([
      { field: 'outOfScope', label: 'Out of scope' },
      { field: 'acceptanceCriteria', label: 'Acceptance criteria' },
    ] as const)('$field', ({ field, label }) => {
      it.each([
        { values: ['CSV', '通知'], display: '["CSV","通知"]' },
        { values: ['CSV; 通知'], display: '["CSV; 通知"]' },
        { values: ['CSV","通知'], display: String.raw`["CSV\",\"通知"]` },
        { values: ['CSV\n通知\t\\'], display: String.raw`["CSV\n通知\t\\"]` },
        { values: ['CSV'], display: '["CSV"]' },
        { values: ['CSV', 'CSV'], display: '["CSV","CSV"]' },
      ])('shows $display before approval and signs the original array', async ({ values, display }) => {
        const context = mount();
        const summary = { objective: summaryA.objective, outOfScope: ['基準'], acceptanceCriteria: ['基準'], [field]: values };
        const reply = response(summary);
        context.call.mockResolvedValueOnce({ ...reply, structuredOutput: format === 'content' ? undefined : reply.structuredOutput });
        await vi.waitFor(() => expect(context.app.lastFrame()).toContain(cwd));

        await send(context, '要約を確認してください', summary);

        expect(context.app.lastFrame()).toContain(`${label}: ${display}`);
        await approve(context, summary);
      });
    });

    it('shows an empty out-of-scope array before approval without changing the registered summary', async () => {
      const context = mount();
      const summary = { ...summaryA, outOfScope: [] };
      const reply = response(summary);
      context.call.mockResolvedValueOnce({ ...reply, structuredOutput: format === 'content' ? undefined : reply.structuredOutput });
      await vi.waitFor(() => expect(context.app.lastFrame()).toContain(cwd));

      await send(context, '要約を確認してください', summary);

      expect(context.app.lastFrame()).toContain('Out of scope: []');
      await approve(context, summary);
    });
  });
});

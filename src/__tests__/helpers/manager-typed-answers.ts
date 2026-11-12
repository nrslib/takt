import { readManagerTestDisplay } from './manager-display-items.js';
import * as managerAssignment from '../../features/manager/assignment.js';
import chalk from 'chalk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { render } from 'ink-testing-library';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ManagerView } from '../../features/manager/ManagerView.js';
import { ensureDaemon } from '../../features/daemon/lifecycle.js';
import { ensureManagerRun } from '../../features/manager/autoRun.js';
import { ManagerServiceClient, spyConversationCommand } from './manager-service-client.js';
import { createTaktMcpServer } from '../../features/mcp/server.js';
import { PromptInput } from '../../features/tui/PromptInput.js';
import { getGlobalConfigDir } from '../../infra/config/paths.js';
import { invalidateResolvedConfigCache } from '../../infra/config/resolveConfigValue.js';
import * as repositories from '../../infra/task/repositoryDirectory.js';
import { createInquiry } from '../../infra/goals/inquiry.js';
import { saveManagerEvent } from '../../infra/goals/events.js';
import type { GoalAnswerInput, GoalQuestion, GoalQuestionInput } from '../../infra/goals/schema.js';
import { StandaloneInquiryStore } from '../../infra/goals/standalone-inquiries.js';
import { GoalStore } from '../../infra/goals/store.js';
import { MockProvider } from '../../infra/providers/mock.js';
import { getLabel } from '../../shared/i18n/index.js';
import * as privateFiles from '../../shared/utils/private-file.js';
import { goalId, goalRecord } from './goal-fixtures.js';

const ENTER = '\r';
const DOWN = '\x1b[B';
const ESC = '\x1b[27u';
const workspaceId = '750e8400-e29b-41d4-a716-446655440001';
const waitFor = (assertion: () => void | Promise<void>) => vi.waitFor(assertion, { timeout: 10_000 });

export function registerManagerTypedAnswerTests(): void {
  describe('manager typed inquiry answers', () => {
    let cwd: string;
    let configDirectory: string;
    let app: ReturnType<typeof render> | undefined;
    let session: ManagerServiceClient | undefined;
    let chalkLevel: typeof chalk.level;
    let language: 'ja' | 'en';

    beforeEach(() => {
      chalkLevel = chalk.level;
      chalk.level = 1;
      vi.mocked(saveManagerEvent).mockReset();
      vi.mocked(ensureDaemon).mockClear();
      vi.mocked(ensureManagerRun).mockClear();
      vi.mocked(PromptInput).mockClear();
      configDirectory = getGlobalConfigDir();
      const root = join(process.cwd(), '.tmp');
      mkdirSync(root, { recursive: true });
      cwd = realpathSync(mkdtempSync(join(root, 'manager-typed-answers-')));
      mkdirSync(join(cwd, '.takt'));
      writeFileSync(join(cwd, '.takt', 'config.yaml'), 'provider: mock\nmanager:\n  auto_run: false\n');
      vi.spyOn(repositories, 'resolveGitRepositoryDirectory').mockImplementation(async (directory) => realpathSync(directory));
    });

    afterEach(async () => {
      app?.unmount();
      app = undefined;
      try { await session?.dispose(); }
      finally {
        session = undefined;
        chalk.level = chalkLevel;
        rmSync(cwd, { recursive: true, force: true });
      }
    });

    const frame = (): string => stripVTControlCharacters(app!.lastFrame()!);
    const boxes = (): string[] => frame().match(/╭[^\n]*\n[\s\S]*?╰[^\n]*/gu) ?? [];
    const selectedRows = (): string[] => [...app!.lastFrame()!.matchAll(/\x1b\[7m([^\n]*?)\x1b\[27m/gu)]
      .map((match) => stripVTControlCharacters(match[1]!).trim()).filter((row) => row !== '');
    const press = (key: string): void => { app!.stdin.write(key); };
    const prompt = (): string => boxes().at(-1)!;

    async function mount(lang: 'ja' | 'en' = 'en', workspace = false): Promise<void> {
      language = lang;
      const config = join(cwd, '.takt', 'config.yaml');
      const source = readFileSync(config, 'utf8');
      writeFileSync(config, /^language:/mu.test(source) ? source.replace(/^language:.*$/mu, `language: ${lang}`) : `${source}\nlanguage: ${lang}\n`);
      invalidateResolvedConfigCache(cwd);
      session = new ManagerServiceClient({
        cwd,
        assignment: workspace ? { kind: 'workspace', workspaceId } : { kind: 'repository', repositoryDirectory: cwd },
        plan: { ctx: { providerType: 'mock', model: undefined, lang, provider: new MockProvider() },
          strategy: { systemPrompt: 'manager fixture' } },
      });
      await session.ready;
      app = render(createElement(ManagerView, { cwd, lang, client: session, assignment: { kind: 'repository', repositoryDirectory: cwd, repositoryDirectories: [cwd] }, initialDiagnostics: [], onExit: vi.fn() }));
      await waitFor(() => expect(frame()).toContain('manager'));
    }

    async function putWorkspace(directories: readonly string[]): Promise<void> {
      const directory = join(configDirectory, 'workspaces', workspaceId);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, 'workspace.json'), JSON.stringify({ id: workspaceId, name: 'Answer workspace', repositoryDirectories: directories }));
    }

    async function putGoal(input: GoalQuestionInput): Promise<GoalQuestion> {
      const question = createInquiry(input);
      await new GoalStore(cwd).create({ ...goalRecord(), objective: 'Answer goal', questions: [question] });
      return question;
    }

    const operationRequest = (): GoalQuestionInput => ({ kind: 'operation_request', body: 'Confirm writing the selected output' });
    const savedQuestion = async (): Promise<GoalQuestion> => (await new GoalStore(cwd).get(goalId)).questions![0]!;

    async function openAnswer(summary: string): Promise<void> {
      await session!.refresh();
      await waitFor(() => expect(frame()).not.toMatch(/処理中|Working/u));
      press('\x12');
      await waitFor(() => expect(boxes().some((box) => box.includes(summary) && /↑|↓/u.test(box))).toBe(true));
      press(ENTER);
      await waitFor(() => {
        expect(frame()).not.toContain(getLabel('manager.selectionTitles.answer', language));
        expect(boxes().some((box) => box.includes(summary))).toBe(true);
      });
    }

    async function choose(label: RegExp): Promise<void> {
      await waitFor(() => expect(frame().split('\n').some((row) => label.test(row.replace(/^│\s*|\s*│$/gu, '').trim()))).toBe(true));
      if (selectedRows().length === 0) press(DOWN);
      await waitFor(() => expect(selectedRows().length).toBeGreaterThan(0));
      for (let index = 0; index < 7; index++) {
        if (selectedRows().some((row) => label.test(row))) {
          const previous = selectedRows();
          press(ENTER);
          await waitFor(() => expect(selectedRows()).not.toEqual(previous));
          return;
        }
        const previous = selectedRows();
        press(DOWN);
        await waitFor(() => expect(selectedRows()).not.toEqual(previous));
      }
      throw new Error(`選択肢が見つかりません: ${label}`);
    }

    async function comment(text: string): Promise<void> {
      await waitFor(() => expect(frame()).toMatch(/comment|コメント/iu));
      if (text !== '') {
        press(text);
        await waitFor(() => expect(prompt()).toContain(text));
      }
      press(ENTER);
    }

    async function expectAnswer(answer: GoalAnswerInput): Promise<void> {
      await waitFor(async () => expect(await savedQuestion()).toMatchObject({ status: 'answered', answer: { ...answer, source: 'tui' } }));
      expect(vi.mocked(saveManagerEvent)).toHaveBeenCalledWith(cwd, expect.objectContaining({
        kind: 'answer', goalId, answer: expect.objectContaining({ ...answer, source: 'tui' }),
      }));
    }

    it('closes the saved answer before reporting an event failure and cannot submit it again', async () => {
      const question = await putGoal(operationRequest());
      await mount();
      const save = vi.spyOn(session!, 'submit');
      vi.mocked(saveManagerEvent).mockImplementationOnce(() => { throw new Error('answer-event-write-failed'); });
      await openAnswer(question.body);
      await choose(/^Completed$/u);
      await comment('saved comment');
      await waitFor(async () => {
        expect((await savedQuestion()).status).toBe('answered');
        expect(frame()).toContain(getLabel('manager.conversation.operation_failed', language));
        expect(vi.mocked(PromptInput).mock.calls.at(-1)![0]).toMatchObject({ text: '', placeholder: 'Discuss your goal' });
        expect(frame()).not.toContain(question.body);
      });
      expect(session!.results.at(-1)).toMatchObject({ kind: 'error', code: 'operation_failed', answerSaved: true });
      press(ENTER);
      press(ENTER);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(save).toHaveBeenCalledOnce();
      expect(ensureDaemon).not.toHaveBeenCalled();
      expect(ensureManagerRun).not.toHaveBeenCalled();
    });

    it.each([false, true])('closes a persisted answer even when releasing its file lock fails (failure=%s)', async (failure) => {
      const question = await putGoal({ body: 'Choose output format' });
      await mount();
      const save = vi.spyOn(session!, 'submit');
      await openAnswer(question.body);
      press('CSV with headers');
      await waitFor(() => expect(vi.mocked(PromptInput).mock.calls.at(-1)![0].text).toBe('CSV with headers'));
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      const lockPath = join(cwd, '.takt', 'goals', goalId, 'goal.json.lock');
      const error = Object.assign(new Error('answer-lock-release-failed'), { code: 'EACCES' });
      vi.mocked(unlinkSync).mockImplementation((path) => {
        if (failure && path === lockPath) throw error;
        actual.unlinkSync(path);
      });
      try {
        press(ENTER);
        await waitFor(async () => expect(await savedQuestion()).toMatchObject({
          status: 'answered', answer: { text: 'CSV with headers', source: 'tui' },
        }));
        await waitFor(() => {
          if (failure) expect(frame()).toContain(getLabel('manager.conversation.operation_failed', language));
          expect(vi.mocked(PromptInput).mock.calls.at(-1)![0]).toMatchObject({ text: '', placeholder: 'Discuss your goal' });
          expect(frame()).not.toContain(question.body);
        });
        expect(session!.results.at(-1)).toMatchObject({ kind: failure ? 'error' : 'answer_saved', answerSaved: true });
        if (failure) {
          for (const effect of [saveManagerEvent, ensureDaemon, ensureManagerRun]) expect(effect).not.toHaveBeenCalled();
        }
        press(ENTER);
        press(ENTER);
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(save).toHaveBeenCalledOnce();
      } finally {
        vi.mocked(unlinkSync).mockImplementation(actual.unlinkSync);
      }
    });

    it('keeps a free-text answer after saving fails and retries the same input without retyping', async () => {
      const question = await putGoal({ body: 'Choose output format' });
      await mount();
      await openAnswer(question.body);
      press('CSV with headers');
      await waitFor(() => expect(vi.mocked(PromptInput).mock.calls.at(-1)![0].text).toBe('CSV with headers'));
      const save = vi.spyOn(session!, 'submit');
      vi.spyOn(privateFiles, 'writePrivateFile').mockImplementationOnce(() => { throw new Error('answer-save-failed'); });
      press(ENTER);
      await waitFor(async () => {
        expect(frame()).toContain(getLabel('manager.conversation.operation_failed', language));
        expect(frame()).not.toContain('Working');
        expect((await savedQuestion()).status).toBe('pending');
        expect(vi.mocked(PromptInput).mock.calls.at(-1)![0]).toMatchObject({ text: 'CSV with headers', placeholder: 'Enter your answer' });
      });
      expect(session!.results.at(-1)).toMatchObject({ kind: 'error', code: 'operation_failed', answerSaved: false });
      expect(saveManagerEvent).not.toHaveBeenCalled();
      expect(ensureDaemon).not.toHaveBeenCalled();
      expect(ensureManagerRun).not.toHaveBeenCalled();
      press(ENTER);
      await expectAnswer({ text: 'CSV with headers' });
      await waitFor(() => expect(vi.mocked(PromptInput).mock.calls.at(-1)![0]).toMatchObject({ text: '', placeholder: 'Discuss your goal' }));
    });

    it('rejects a selected goal removed from the assignment before answer side effects', async () => {
      const second = join(cwd, 'second');
      mkdirSync(second);
      await putWorkspace([cwd, second]);
      const question = await putGoal(operationRequest());
      await new GoalStore(cwd).update(goalId, (goal) => ({ ...goal, executionStatus: 'aborted' }));
      const before = await new GoalStore(cwd).get(goalId);
      await mount('en', true);
      await openAnswer(question.body);
      await choose(/^Completed$/u);
      const server = createTaktMcpServer({}, { toolSet: 'manager', allowedProjectRoot: cwd,
        managerAssignment: { kind: 'workspace', workspaceId } });
      const client = new Client({ name: 'manager-answer-test', version: '1.0.0' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      try {
        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
        const result = await client.callTool({ name: 'takt_remove_workspace_repository', arguments: { repositoryDirectory: cwd } });
        expect(result.isError).not.toBe(true);
      } finally { await client.close(); await server.close(); }
      expect((await managerAssignment.resolveCurrentManagerAssignment({ kind: 'workspace', workspaceId }, configDirectory))!.repositoryDirectories).toEqual([second]);
      await comment('');
      await waitFor(() => expect(frame()).toContain(getLabel('manager.conversation.invalid_assignment', language)));
      expect(await new GoalStore(cwd).get(goalId)).toEqual(before);
      for (const effect of [saveManagerEvent, ensureDaemon, ensureManagerRun]) expect(effect).not.toHaveBeenCalled();
    });

    it.each([
      { lang: 'ja', report: 'completed' }, { lang: 'ja', report: 'unable' },
      { lang: 'en', report: 'completed' }, { lang: 'en', report: 'unable' },
    ] as const)('displays the human procedure and saves the explicit $report report in $lang', async ({ lang, report }) => {
      await putGoal({ kind: 'operation_request', body: '1. 認証を更新する\n2. 接続を確認する' });
      await mount(lang);
      await openAnswer('1. 認証を更新する');
      await waitFor(() => expect(frame()).toContain('2. 接続を確認する'));
      await choose(report === 'completed' ? /^(?:Completed|Done|実施した)$/u : /^(?:Unable|Cannot complete|対応できない)$/u);
      await comment('作業結果');
      await expectAnswer({ report, text: '作業結果' });
    });

    it.each(['typed', 'pasted'] as const)('does not interpret %s report text as a completed operation', async (delivery) => {
      const question = await putGoal({ kind: 'operation_request', body: '1. 認証を更新する' });
      await mount();
      const conversation = spyConversationCommand(session!, 'message');
      await openAnswer(question.body);
      press(delivery === 'typed' ? '実施した' : '\x1b[200~実施した\x1b[201~');
      press(ENTER);
      await new Promise<void>((resolve) => setImmediate(resolve));
      await waitFor(() => expect(frame()).not.toContain('Working'));
      expect(conversation).not.toHaveBeenCalled();
      expect(await savedQuestion()).toMatchObject({ status: 'pending' });
      expect((await savedQuestion()).answer).toBeUndefined();
      await waitFor(() => {
        expect(frame()).toMatch(/\bCompleted\b|\bDone\b/u);
        expect(frame()).toMatch(/\bUnable\b|\bCannot complete\b/u);
      });
    });

    it('lists and answers an inquiry stored only in the second assigned repository', async () => {
      const second = join(cwd, 'second');
      mkdirSync(second);
      await putWorkspace([cwd, second]);
      const firstStore = new GoalStore(cwd);
      await firstStore.create({ ...goalRecord(), objective: 'First repository goal' });
      const firstPath = join(cwd, '.takt', 'goals', goalId, 'goal.json');
      const firstBefore = readFileSync(firstPath, 'utf8');
      const question = createInquiry({ body: 'Choose output format' });
      const secondStore = new GoalStore(second);
      await secondStore.create({ ...goalRecord(), objective: 'Second repository goal', questions: [question] });
      await mount('en', true);
      await waitFor(() => expect(frame()).not.toMatch(/処理中|Working/u));
      press('\x12');
      await waitFor(() => {
        const rows = frame().split('\n').filter((row) => row.includes(question.body));
        expect(rows).toHaveLength(1);
        expect(rows[0]).toContain('Question');
        expect(rows[0]).toContain('Second repository goal');
      });
      expect((await secondStore.get(goalId)).questions![0]).toMatchObject({ status: 'pending' });
      press(ENTER);
      await waitFor(() => expect(vi.mocked(PromptInput).mock.calls.at(-1)![0].placeholder).toBe('Enter your answer'));
      press('CSV with headers');
      await waitFor(() => expect(vi.mocked(PromptInput).mock.calls.at(-1)![0].text).toBe('CSV with headers'));
      press(ENTER);
      await waitFor(async () => {
        expect((await secondStore.get(goalId)).questions![0]).toMatchObject({
          id: question.id, status: 'answered', answer: { text: 'CSV with headers', source: 'tui' },
        });
        expect(frame()).not.toContain(question.body);
        expect(vi.mocked(PromptInput).mock.calls.at(-1)![0]).toMatchObject({ text: '', placeholder: 'Discuss your goal' });
      });
      expect(readFileSync(firstPath, 'utf8')).toBe(firstBefore);
      expect((await firstStore.get(goalId)).questions).toBeUndefined();
      expect(saveManagerEvent).toHaveBeenCalledExactlyOnceWith(second, expect.objectContaining({ kind: 'answer', questionId: question.id }));
      expect(ensureManagerRun).toHaveBeenCalledExactlyOnceWith(second);
    });

    it('lists goal and standalone inquiries once per row and reveals details only after selection', async () => {
      const goalQuestion = await putGoal({ body: 'Goal summary\nGOAL_DETAIL', options: ['OPTION_DETAIL'], recommendation: 'RECOMMENDATION_DETAIL' });
      await putWorkspace([cwd, join(cwd, 'second')]);
      mkdirSync(join(cwd, 'second'));
      const standalone = await new StandaloneInquiryStore(configDirectory, { kind: 'workspace', workspaceId }).create({
        kind: 'question', body: 'Standalone summary\nSTANDALONE_DETAIL', options: ['STANDALONE_OPTION'], recommendation: 'STANDALONE_RECOMMENDATION',
      });
      await mount('en', true);
      await waitFor(() => expect(frame()).not.toMatch(/処理中|Working/u));
      press('\x12');
      await waitFor(() => {
        const list = boxes().find((box) => /↑|↓/u.test(box) && box.includes('Standalone summary'))!;
        expect(list).toBeDefined();
        const rows = list.split('\n').filter((row) => /^(?:│\s*)(?:Question|Operation request):/u.test(row));
        expect(rows).toHaveLength(2);
        expect(rows.filter((row) => row.includes('Standalone summary'))).toHaveLength(1);
        expect(rows.find((row) => row.includes('Standalone summary'))).toMatch(/no goal|standalone|goal-less/iu);
        expect(list).not.toContain('OPTION_DETAIL');
        expect(list).not.toContain('RECOMMENDATION_DETAIL');
        expect(list).not.toContain('STANDALONE_OPTION');
        expect(list).not.toContain('STANDALONE_RECOMMENDATION');
      });
      await choose(/^Question: .*Standalone summary/u);
      await waitFor(() => {
        expect(frame()).toContain('STANDALONE_DETAIL');
        expect(frame()).toContain(standalone.recommendation!);
      });
      expect((await savedQuestion()).id).toBe(goalQuestion.id);
      expect((await savedQuestion()).status).toBe('pending');
      press(ESC);
    });
  });
}

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachWorkflowOpaqueRef } from '../../../src/infra/config/loaders/workflowSourceMetadata.js';
import { loadGlobalConfig, saveGlobalConfig } from '../../../src/infra/config/index.js';
import { getProvider } from '../../../src/infra/providers/index.js';
import { managedProviderFor } from '../../../src/infra/managed-providers/definitions.js';
import { resolveEvalProvider } from './eval-provider.js';
import type { SessionContext } from '../../../src/features/interactive/aiCaller.js';
import { runAssistantRetryCommand } from '../../../src/features/interactive/assistantRetryCommand.js';
import type { TaskListItem } from '../../../src/infra/task/index.js';

const doubles = vi.hoisted(() => ({
  listTasks: vi.fn(), requeueTask: vi.fn(), requeueExceededTask: vi.fn(), confirmWithCancel: vi.fn(),
  selectOption: vi.fn<typeof import('../../../src/shared/prompt/index.js').selectOption>(),
  loadWorkflow: vi.fn(), selections: [] as Array<{
    prompt: string; content: string | undefined; success: boolean | undefined; error: string | undefined;
  }>,
}));

vi.mock('../../../src/infra/task/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/infra/task/index.js')>()),
  TaskRunner: class {
    listAllTaskItems() { return doubles.listTasks(); }
    requeueTask(...args: unknown[]) { return doubles.requeueTask(...args); }
    requeueExceededTask(...args: unknown[]) { doubles.requeueExceededTask(...args); }
  },
}));
vi.mock('../../../src/infra/config/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/infra/config/index.js')>()),
  loadWorkflowByIdentifier: doubles.loadWorkflow,
}));
vi.mock('../../../src/shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/shared/utils/index.js')>()),
  hasInteractiveTerminal: () => true,
}));
vi.mock('../../../src/shared/prompt/tty.js', () => ({ resolveTtyPolicy: () => ({ useTty: true, forceTouchTty: false }) }));
vi.mock('../../../src/shared/prompt/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/shared/prompt/index.js')>()),
  confirmWithCancel: doubles.confirmWithCancel, selectOption: doubles.selectOption,
}));
vi.mock('../../../src/features/interactive/aiCaller.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/features/interactive/aiCaller.js')>();
  return {
    ...actual,
    callAIWithRetry: async (...args: Parameters<typeof actual.callAIWithRetry>) => {
      const response = await actual.callAIWithRetry(...args);
      doubles.selections.push({
        prompt: args[0], content: response.result?.content, success: response.result?.success, error: response.error,
      });
      return response;
    },
  };
});

let cwd: string;
beforeAll(() => {
  cwd = mkdtempSync(join(process.cwd(), '.takt', 'exceeded-start-eval-'));
  mkdirSync(join(cwd, 'config'));
  mkdirSync(join(cwd, '.takt', 'worktrees', 'audit-logs'), { recursive: true });
  const { providerType } = resolveEvalProvider(
    process.env.TAKT_INLINE_UTTERANCE_EVAL_PROVIDER ?? process.env.TAKT_TELL_EVAL_PROVIDER,
    process.env.TAKT_INLINE_UTTERANCE_EVAL_MODEL ?? process.env.TAKT_TELL_EVAL_MODEL,
  );
  const managed = managedProviderFor(providerType);
  if (managed !== undefined) {
    execFileSync(process.execPath, [fileURLToPath(new URL('../../../bin/takt', import.meta.url)), 'install', managed], {
      env: { ...process.env, TAKT_CONFIG_DIR: join(cwd, 'config') },
      stdio: 'inherit',
      timeout: 300_000,
    });
  }
}, 300_000);
beforeEach(() => {
  vi.clearAllMocks();
  doubles.selections.length = 0;
  vi.stubEnv('TAKT_CONFIG_DIR', join(cwd, 'config'));
  doubles.confirmWithCancel.mockResolvedValue({ kind: 'value', value: true });
  doubles.selectOption.mockReset().mockResolvedValue(null);
  doubles.loadWorkflow.mockReturnValue(attachWorkflowOpaqueRef({
    name: 'development', initialStep: 'implement', maxSteps: 10,
    steps: ['implement', 'review'].map((name) => ({ name, personaDisplayName: name, instruction: name })),
  }, 'project:development'));
  const task: TaskListItem = {
    kind: 'exceeded', name: 'audit-logs', createdAt: '2026-10-08T00:00:00Z',
    worktreePath: join(cwd, '.takt', 'worktrees', 'audit-logs'),
    filePath: join(cwd, '.takt/tasks.yaml'), content: 'Implement audit logs.', exceededCurrentIteration: 3,
    data: { task: 'Implement audit logs.', workflow: 'development', start_step: 'review', exceeded_current_iteration: 3, exceeded_max_steps: 5 },
  };
  doubles.listTasks.mockReturnValue([task]);
});
afterEach(() => vi.unstubAllEnvs());
afterAll(() => rmSync(cwd, { recursive: true, force: true }));

describe.each(['en', 'ja'] as const)('real exceeded start selection in %s', (lang) => {
  it.each([
    ['implement から再実行して', 'Restart from implement.', 'restart', 'implement'],
    ['implement は説明用に挙げただけ。保存された review の停止位置から続行して', 'implement is only an example. Continue from the saved review stopping position.', 'continue', 'review'],
    ['保存された review の続行ではなく review を最初から再実行して', 'Restart review from the beginning instead of continuing the saved review execution.', 'restart', 'review'],
    ['存在しない deploy から再実行して。保存位置で代替しないで', 'Restart from deploy, which is unavailable. Do not substitute the saved position.', 'unresolved', null],
  ] as const)('interprets %s', async (ja, en, operation, step) => {
    const { providerType, model } = resolveEvalProvider(
      process.env.TAKT_INLINE_UTTERANCE_EVAL_PROVIDER ?? process.env.TAKT_TELL_EVAL_PROVIDER,
      process.env.TAKT_INLINE_UTTERANCE_EVAL_MODEL ?? process.env.TAKT_TELL_EVAL_MODEL,
    );
    const context: SessionContext = { provider: getProvider(providerType), providerType, model,
      lang, personaName: 'exceeded-start-evaluation', sessionId: undefined, disableSessionRetry: true };
    const input = lang === 'ja' ? ja : en;
    const history = [{ role: 'assistant' as const, content: 'The audit-logs task stopped at review. implement and review can be restarted, or the saved execution can be continued.' }];
    const notice = await runAssistantRetryCommand({ cwd, lang, command: 'requeue', inlineText: input, history, sessionContext: context, formalSpec: false });
    const selected = doubles.selections[0];
    console.log(JSON.stringify({ provider: providerType, model, language: lang, input, history,
      candidates: selected ? JSON.parse(selected.prompt).startOptions : undefined,
      result: selected?.content, expectedOperation: operation, expectedStep: step, notice,
      confirmation: doubles.confirmWithCancel.mock.calls[0]?.[0], requeue: doubles.requeueTask.mock.calls[0] }));
    expect(doubles.selections).toHaveLength(1);
    if (operation === 'unresolved') {
      expect(JSON.parse(selected!.content!)).toEqual({ startOptionId: null });
      expect(doubles.selectOption).toHaveBeenCalledOnce();
      expect(doubles.confirmWithCancel).not.toHaveBeenCalled();
      expect(doubles.requeueTask).not.toHaveBeenCalled();
      expect(doubles.requeueExceededTask).not.toHaveBeenCalled();
    } else if (operation === 'continue') {
      expect(doubles.requeueExceededTask).toHaveBeenCalledWith('audit-logs');
      expect(doubles.requeueTask).not.toHaveBeenCalled();
      expect(doubles.confirmWithCancel.mock.calls[0]?.[0]).toContain('review');
    } else {
      expect(doubles.requeueTask).toHaveBeenCalledWith('audit-logs', ['exceeded'], expect.objectContaining({
        restartPoint: { stack: [{ workflow: 'development', workflow_ref: 'project:development', step, kind: 'agent' }] },
      }));
      expect(doubles.requeueExceededTask).not.toHaveBeenCalled();
      expect(doubles.confirmWithCancel.mock.calls[0]?.[0]).toContain(step);
    }
  });
});

describe.each([
  {
    name: 'two exceeded candidates', kind: 'exceeded',
    tasks: [['audit-logs', 'Implement audit logging.'], ['email-delivery', 'Implement email delivery.']],
    history: 'Both audit-logs (audit logging) and email-delivery (email delivery) stopped at review. For either task, implement and review can be restarted, or the saved execution can be continued.',
    scenarios: [
      ['監査ログの作業を implement から再実行して', 'Restart the audit logging work from implement.', 'audit-logs'],
      ['メール配信の作業を implement から再実行して', 'Restart the email delivery work from implement.', 'email-delivery'],
      ['どちらの作業かはまだ決めていない。implement から再実行して', 'I have not decided which task to requeue. Restart from implement.', null],
    ],
  },
  {
    name: 'three exceeded candidates', kind: 'exceeded',
    tasks: [['audit-logs', 'Implement audit logging.'], ['email-delivery', 'Implement email delivery.'], ['search-index', 'Implement search indexing.']],
    history: 'The audit-logs (audit logging), email-delivery (email delivery), and search-index (search indexing) tasks all stopped at review. For each task, implement and review can be restarted, or the saved execution can be continued.',
    scenarios: [
      ['監査ログの作業を implement から再実行して', 'Restart the audit logging work from implement.', 'audit-logs'],
      ['検索インデックスの作業を implement から再実行して', 'Restart the search indexing work from implement.', 'search-index'],
      ['どの作業かはまだ決めていない。implement から再実行して', 'I have not decided which task to requeue. Restart from implement.', null],
    ],
  },
  {
    name: 'two failed candidates', kind: 'failed',
    tasks: [['audit-logs', 'Implement audit logging.'], ['email-delivery', 'Implement email delivery.']],
    history: 'Both audit-logs (audit logging) and email-delivery (email delivery) failed at review. For either task, implement and review can be restarted.',
    scenarios: [
      ['監査ログの作業を implement から再実行して', 'Restart the audit logging work from implement.', 'audit-logs'],
      ['メール配信の作業を implement から再実行して', 'Restart the email delivery work from implement.', 'email-delivery'],
      ['どちらの作業かはまだ決めていない。implement から再実行して', 'I have not decided which task to requeue. Restart from implement.', null],
    ],
  },
] as const)('real requeue task selection with $name', (fixture) => {
  describe.each(['en', 'ja'] as const)('in %s', (lang) => {
    let previousConfig: ReturnType<typeof loadGlobalConfig> | undefined;

    beforeEach(() => {
      if (fixture.kind === 'failed') {
        const { providerType, model } = resolveEvalProvider(
          process.env.TAKT_INLINE_UTTERANCE_EVAL_PROVIDER ?? process.env.TAKT_TELL_EVAL_PROVIDER,
          process.env.TAKT_INLINE_UTTERANCE_EVAL_MODEL ?? process.env.TAKT_TELL_EVAL_MODEL,
        );
        previousConfig = loadGlobalConfig();
        saveGlobalConfig({ ...previousConfig, provider: providerType, model });
      }
      const tasks = fixture.tasks.map<TaskListItem>(([name, summary]) => {
        const worktreePath = join(cwd, '.takt', 'worktrees', name);
        mkdirSync(worktreePath, { recursive: true });
        if (fixture.kind === 'failed') {
          const taskDir = `.takt/tasks/${name}`;
          mkdirSync(join(cwd, taskDir), { recursive: true });
          writeFileSync(join(cwd, taskDir, 'order.md'), summary, 'utf-8');
          return {
            kind: 'failed', name, summary, content: summary, worktreePath, taskDir,
            createdAt: '2026-10-08T00:00:00Z', filePath: join(cwd, '.takt/tasks.yaml'),
            failure: { step: 'review', error: 'Review failed.' },
            data: { task: summary, workflow: 'development', start_step: 'review', task_dir: taskDir, worktree: true },
          };
        }
        return {
          kind: 'exceeded', name, summary, content: summary, worktreePath,
          createdAt: '2026-10-08T00:00:00Z', filePath: join(cwd, '.takt/tasks.yaml'), exceededCurrentIteration: 3,
          data: { task: summary, workflow: 'development', start_step: 'review', exceeded_current_iteration: 3, exceeded_max_steps: 5 },
        };
      });
      doubles.listTasks.mockReturnValue(tasks);
    });

    afterEach(() => {
      if (previousConfig !== undefined) {
        saveGlobalConfig(previousConfig);
        previousConfig = undefined;
      }
    });

    it.each<readonly [string, string, string | null]>(fixture.scenarios)('selects the task for %s', async (ja, en, taskName) => {
      const { providerType, model } = resolveEvalProvider(
        process.env.TAKT_INLINE_UTTERANCE_EVAL_PROVIDER ?? process.env.TAKT_TELL_EVAL_PROVIDER,
        process.env.TAKT_INLINE_UTTERANCE_EVAL_MODEL ?? process.env.TAKT_TELL_EVAL_MODEL,
      );
      const context: SessionContext = { provider: getProvider(providerType), providerType, model,
        lang, personaName: 'requeue-task-evaluation', sessionId: undefined, disableSessionRetry: true };
      const input = lang === 'ja' ? ja : en;
      const history = [{ role: 'assistant' as const, content: fixture.history }];
      const notice = await runAssistantRetryCommand({ cwd, lang, command: 'requeue', inlineText: input, history, sessionContext: context, formalSpec: false });
      console.log(JSON.stringify({ fixture: fixture.name, provider: providerType, model: model ?? null, language: lang, input, history, expectedTask: taskName,
        selections: doubles.selections.map(({ prompt, ...response }) => ({ request: JSON.parse(prompt), ...response })),
        humanSelection: doubles.selectOption.mock.calls, confirmation: doubles.confirmWithCancel.mock.calls,
        requeue: doubles.requeueTask.mock.calls, continueSaved: doubles.requeueExceededTask.mock.calls, notice }));

      const selected = doubles.selections[0]!;
      const request = JSON.parse(selected.prompt);
      expect(request.stage).toBe('task');
      expect(request.candidates).toEqual(fixture.tasks.map(([name, summary]) => expect.objectContaining({
        name, status: fixture.kind, summary,
        ...(fixture.kind === 'failed' ? { failure: { step: 'review', error: 'Review failed.', lastMessage: null } } : {}),
      })));
      expect(request.conversation).toEqual([...history, { role: 'user', content: input }]);
      expect(selected.success).toBe(true);
      expect(JSON.parse(selected.content!)).toEqual({ taskName });
      if (taskName === null) {
        expect(doubles.selections).toHaveLength(1);
        expect(doubles.selectOption).toHaveBeenCalledOnce();
        expect(doubles.selectOption.mock.calls[0]![1].map(({ value }) => value)).toEqual(fixture.tasks.map(([name]) => name));
        expect(doubles.confirmWithCancel).not.toHaveBeenCalled();
        expect(doubles.requeueTask).not.toHaveBeenCalled();
        expect(doubles.requeueExceededTask).not.toHaveBeenCalled();
        expect(notice).toContain(lang === 'ja' ? 'タスクは変更していません' : 'not changed');
      } else {
        expect(doubles.selections).toHaveLength(2);
        const start = doubles.selections[1]!;
        expect(start.success).toBe(true);
        expect(JSON.parse(start.prompt)).toEqual(expect.objectContaining({
          stage: 'start', task: expect.objectContaining({ name: taskName }),
          conversation: [...history, { role: 'user', content: input }],
        }));
        const { startOptionId } = JSON.parse(start.content!);
        expect(JSON.parse(start.prompt).startOptions).toContainEqual(expect.objectContaining({
          id: startOptionId,
          ...(fixture.kind === 'exceeded' ? { operation: 'restart' } : {}),
        }));
        expect(doubles.selectOption).not.toHaveBeenCalled();
        expect(doubles.confirmWithCancel).toHaveBeenCalledOnce();
        expect(doubles.confirmWithCancel.mock.calls[0]![0]).toContain(taskName);
        expect(doubles.confirmWithCancel.mock.calls[0]![0]).toContain('implement');
        expect(doubles.requeueTask).toHaveBeenCalledExactlyOnceWith(taskName, [fixture.kind], expect.objectContaining({
          restartPoint: { stack: [{ workflow: 'development', workflow_ref: 'project:development', step: 'implement', kind: 'agent' }] },
        }));
        expect(doubles.requeueExceededTask).not.toHaveBeenCalled();
        expect(notice).toContain(taskName);
        expect(notice).toContain('pending');
      }
    });
  });
});

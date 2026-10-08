import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachWorkflowOpaqueRef } from '../../../src/infra/config/loaders/workflowSourceMetadata.js';
import { getProvider } from '../../../src/infra/providers/index.js';
import { resolveEvalProvider } from './eval-provider.js';
import type { SessionContext } from '../../../src/features/interactive/aiCaller.js';
import { runAssistantRetryCommand } from '../../../src/features/interactive/assistantRetryCommand.js';
import type { TaskListItem } from '../../../src/infra/task/index.js';

const doubles = vi.hoisted(() => ({
  listTasks: vi.fn(), requeueTask: vi.fn(), requeueExceededTask: vi.fn(), confirm: vi.fn(),
  loadWorkflow: vi.fn(), selections: [] as Array<{ prompt: string; content: string | undefined }>,
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
  ...(await importOriginal<typeof import('../../../src/shared/prompt/index.js')>()), confirm: doubles.confirm,
}));
vi.mock('../../../src/features/interactive/aiCaller.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/features/interactive/aiCaller.js')>();
  return {
    ...actual,
    callAIWithRetry: async (...args: Parameters<typeof actual.callAIWithRetry>) => {
      const response = await actual.callAIWithRetry(...args);
      doubles.selections.push({ prompt: args[0], content: response.result?.content });
      return response;
    },
  };
});

let cwd: string;
beforeAll(() => {
  cwd = mkdtempSync(join(process.cwd(), '.takt', 'exceeded-start-eval-'));
  mkdirSync(join(cwd, 'config'));
});
beforeEach(() => {
  vi.clearAllMocks();
  doubles.selections.length = 0;
  vi.stubEnv('TAKT_CONFIG_DIR', join(cwd, 'config'));
  doubles.confirm.mockResolvedValue(true);
  doubles.loadWorkflow.mockReturnValue(attachWorkflowOpaqueRef({
    name: 'development', initialStep: 'implement', maxSteps: 10,
    steps: ['implement', 'review'].map((name) => ({ name, personaDisplayName: name, instruction: name })),
  }, 'project:development'));
  const task: TaskListItem = {
    kind: 'exceeded', name: 'audit-logs', createdAt: '2026-10-08T00:00:00Z',
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
      confirmation: doubles.confirm.mock.calls[0]?.[0], requeue: doubles.requeueTask.mock.calls[0] }));
    expect(doubles.selections).toHaveLength(1);
    if (operation === 'unresolved') {
      expect(JSON.parse(selected!.content!)).toEqual({ startOptionId: null });
      expect(doubles.confirm).not.toHaveBeenCalled();
      expect(doubles.requeueTask).not.toHaveBeenCalled();
      expect(doubles.requeueExceededTask).not.toHaveBeenCalled();
    } else if (operation === 'continue') {
      expect(doubles.requeueExceededTask).toHaveBeenCalledWith('audit-logs');
      expect(doubles.requeueTask).not.toHaveBeenCalled();
      expect(doubles.confirm.mock.calls[0]?.[0]).toContain('review');
    } else {
      expect(doubles.requeueTask).toHaveBeenCalledWith('audit-logs', ['exceeded'], expect.objectContaining({
        restartPoint: { stack: [{ workflow: 'development', workflow_ref: 'project:development', step, kind: 'agent' }] },
      }));
      expect(doubles.requeueExceededTask).not.toHaveBeenCalled();
      expect(doubles.confirm.mock.calls[0]?.[0]).toContain(step);
    }
  });
});

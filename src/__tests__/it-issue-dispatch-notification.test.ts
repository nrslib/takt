import { createEscMenuFixture, menuMocks } from './helpers/escMenuFixtures.js';
import { createEscMenuTerminal, type EscMenuTerminal } from './helpers/escMenuTerminal.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as git from '../infra/git/index.js';
import { executeDefaultAction } from '../app/cli/routing.js';
import { listTasks } from '../features/tasks/list/index.js';
import { getLabel } from '../shared/i18n/index.js';
import type { CreateIssueResult } from '../infra/git/types.js';

const doubles = vi.hoisted(() => ({
  cwd: '', createIssue: vi.fn(), save: vi.fn(), issueAndSave: vi.fn(), execute: vi.fn(),
  renders: [] as { unmount(): void }[],
  runs: [] as Promise<unknown>[],
}));

vi.mock('ink', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ink')>();
  return {
    ...actual,
    render: (...args: Parameters<typeof actual.render>) => {
      const [element, options] = args;
      if (options === undefined || !('stdout' in options) || options.stdout === undefined) {
        throw new Error('Notification test requires the production terminal output');
      }
      const output = options.stdout;
      const write = output.write.bind(output);
      const stdout = new Proxy(output, {
        get(target, property) {
          if (property === 'write') {
            return (chunk: string, encodingOrCallback?: BufferEncoding | (() => void), callback?: () => void) => {
              const accepted = write(chunk);
              const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
              done?.();
              return accepted;
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const instance = actual.render(element, { ...options, stdout });
      doubles.renders.push(instance);
      return instance;
    },
  };
});

vi.mock('../app/cli/initialization.js', () => ({
  getCliExecutionContext: () => ({ cwd: doubles.cwd, pipelineMode: false }),
}));
vi.mock('../app/cli/program.js', () => ({ program: { opts: () => ({ workflow: 'menu-workflow' }) } }));
vi.mock('../app/cli/taskHistory.js', () => ({ loadTaskHistory: () => [] }));
vi.mock('../app/cli/routing-inputs.js', () => ({ resolveIssueInput: async () => null }));
vi.mock('../features/tasks/add/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../features/tasks/add/index.js')>()),
  promptLabelSelection: async () => ['enhancement'],
  saveTaskFromInteractive: doubles.save,
  createIssueAndSaveTask: doubles.issueAndSave,
}));
vi.mock('../features/tasks/execute/selectAndExecute.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../features/tasks/execute/selectAndExecute.js')>()),
  selectAndExecuteTask: doubles.execute,
}));

let fixture: ReturnType<typeof createEscMenuFixture>;
let terminal: EscMenuTerminal;
let beforeExitListeners: NodeJS.BeforeExitListener[];
beforeEach(() => {
  beforeExitListeners = process.listeners('beforeExit');
  fixture = createEscMenuFixture();
  doubles.cwd = fixture.cwd;
  terminal = createEscMenuTerminal();
  Object.defineProperty(terminal.input, 'unref', { value: () => terminal.input });
  vi.spyOn(git, 'getGitProvider').mockReturnValue({
    ...git.getGitProvider(), createIssue: doubles.createIssue,
  });
});
afterEach(async () => {
  menuMocks.listAllTaskItems.mockReturnValue([]);
  for (const instance of doubles.renders.splice(0)) instance.unmount();
  await Promise.allSettled(doubles.runs.splice(0));
  for (const listener of process.listeners('beforeExit')) {
    if (!beforeExitListeners.includes(listener)) process.removeListener('beforeExit', listener);
  }
  terminal.restore();
  fixture.cleanup();
  vi.restoreAllMocks();
});

const outcomes: { name: string; task: string; result: CreateIssueResult; created: boolean }[] = [
  { name: 'success', task: 'Issue instruction', result: { success: true, issueNumber: 123 }, created: true },
  { name: 'provider failure', task: 'Issue instruction', result: { success: false, error: 'creation failed' }, created: false },
  { name: 'title failure', task: '## Summary', result: { success: true, issueNumber: 123 }, created: false },
  { name: 'created without number', task: 'Issue instruction', result: { success: false, issueCreated: true, error: 'number unavailable' }, created: true },
];

async function waitForTui(since: number): Promise<void> {
  await vi.waitFor(() => {
    expect(terminal.output().slice(since)).toContain(getLabel('tui.ui.placeholder', 'en'));
    expect(terminal.input.isRaw).toBe(true);
    expect(terminal.input.listenerCount('readable')).toBeGreaterThan(0);
  });
}

describe.each(['CLI', 'list'] as const)('%s Issue dispatch to the displayed TUI notice', (route) => {
  it.each(outcomes)('$name', async ({ task, result, created }) => {
    fixture.provider([{ content: task }, { content: 'Continued answer' }]);
    doubles.createIssue.mockReturnValue(result);
    menuMocks.listAllTaskItems.mockReturnValue([{
      ...fixture.task('running'), runSlug: 'running-run',
    }]);
    const run = route === 'CLI' ? executeDefaultAction() : listTasks(fixture.cwd);
    doubles.runs.push(run);
    void run.catch(() => undefined);
    if (route === 'list') {
      await terminal.waitForPrompt('List Tasks', 0);
      await terminal.send('\r');
      await terminal.waitForPrompt('Action for menu-task:', 0);
      await terminal.send('\x1B[B\r');
      await terminal.waitForPrompt('Select workflow:', 0);
      await terminal.send('\r');
      await terminal.waitForPrompt('Select workflow category:', 0);
      await terminal.send('\r');
    }
    await terminal.waitForPrompt(getLabel('interactive.modeSelection.prompt', 'en'), 0);
    await terminal.send('\r');
    await waitForTui(0);
    let mark = terminal.mark();
    await terminal.send('/go build the task');
    await vi.waitFor(() => expect(terminal.output().slice(mark)).toContain('/go build the task'));
    await terminal.send('\r');
    await terminal.waitForPrompt(getLabel('interactive.ui.actionPrompt', 'en'), mark);
    mark = terminal.mark();
    await terminal.send('\x1B[B\r');
    await terminal.waitForPrompt('[Y/n]:', mark);
    expect(doubles.createIssue).not.toHaveBeenCalled();
    mark = terminal.mark();
    await terminal.send('n\r');
    await waitForTui(mark);
    const notice = terminal.output().slice(mark);
    if (created) {
      expect(notice).toContain(getLabel('tui.ui.issueCreated', 'en'));
    } else {
      expect(notice).not.toContain(getLabel('tui.ui.issueCreated', 'en'));
      if (task !== '## Summary') expect(notice).toContain('creation failed');
    }
    if (task === '## Summary') expect(doubles.createIssue).not.toHaveBeenCalled();
    else expect(doubles.createIssue).toHaveBeenCalledExactlyOnceWith({
      title: 'Issue instruction', body: task, labels: ['enhancement'],
    }, fixture.cwd);
    expect(doubles.save).not.toHaveBeenCalled();
    expect(doubles.issueAndSave).not.toHaveBeenCalled();
    expect(doubles.execute).not.toHaveBeenCalled();
    await terminal.send('\x04');
    if (route === 'list') {
      await terminal.waitForPrompt('List Tasks', mark);
      await terminal.send('\x1B');
    }
    let completed = false;
    void run.then(() => { completed = true; }, () => undefined);
    await vi.waitFor(() => expect(completed, terminal.output().slice(mark)).toBe(true));
    await run;
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEscMenuFixture, menuMocks } from './helpers/escMenuFixtures.js';
import { inkFrames } from './helpers/escMenuInk.js';
import { confirmWithCancel, promptInput } from '../shared/prompt/confirm.js';
import { createEscMenuTerminal, type EscMenuTerminal } from './helpers/escMenuTerminal.js';
import { getLabel } from '../shared/i18n/index.js';
import { listTasks } from '../features/tasks/list/index.js';
import type { TaskListItem } from '../infra/task/index.js';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runTui } from '../features/tui/index.js';
import { TaskRunner } from '../infra/task/runner.js';
import { createSharedClone } from '../infra/task/clone.js';
import * as worktreeSettings from '../features/tasks/add/worktree-settings.js';
import * as taskSummarize from '../infra/task/summarize.js';
import * as taskInfrastructure from '../infra/task/index.js';
import * as taskGit from '../infra/task/git.js';
import * as gitInfrastructure from '../infra/git/index.js';
import { resolveTaskExecution, resolveTaskIssue } from '../features/tasks/execute/resolveTask.js';
import { postExecutionFlow } from '../features/tasks/execute/postExecution.js';

vi.mock('../features/tui/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../features/tui/index.js')>()),
  runTui: vi.fn(),
}));

let terminal: EscMenuTerminal;
let fixture: ReturnType<typeof createEscMenuFixture>;

beforeEach(() => {
  fixture = createEscMenuFixture();
  fixture.provider([]);
  inkFrames.frames = [];
  terminal = createEscMenuTerminal();
});

afterEach(() => {
  terminal.restore();
  fixture.cleanup();
  vi.restoreAllMocks();
});

const workflowPrompt = () => getLabel('retry.usePreviousWorkflowConfirm', 'en', { workflow: 'menu-workflow' });
const runPrompt = () => getLabel('interactive.runSelector.confirm', 'en');

function startList(kind: TaskListItem['kind']) {
  const task = fixture.task(kind);
  const nextTask = { ...fixture.task('exceeded'), name: 'next-operation' };
  menuMocks.listAllTaskItems.mockReturnValue([task, nextTask]);
  const run = listTasks(fixture.cwd);
  void run.catch(() => undefined);
  return { run, task };
}

async function openAction(kind: TaskListItem['kind'], actionIndex: number, since: number): Promise<number> {
  await terminal.waitForPrompt('List Tasks', since);
  const mark = terminal.mark();
  await terminal.send('\r');
  await terminal.waitForPrompt(`Action for ${kind === 'failed' || kind === 'running' ? 'menu-task' : 'takt/menu-task'}:`, mark);
  const actionMark = terminal.mark();
  await terminal.send('\x1B[B'.repeat(actionIndex) + '\r');
  return actionMark;
}

function expectNoOperationStarted(): void {
  expect(menuMocks.persistFailedTaskRetry).not.toHaveBeenCalled();
  expect(menuMocks.requeueTask).not.toHaveBeenCalled();
  expect(menuMocks.startReExecution).not.toHaveBeenCalled();
  expect(menuMocks.stageAndCommit).not.toHaveBeenCalled();
  expect(menuMocks.publishTaskBranch).not.toHaveBeenCalled();
  expect(menuMocks.findExistingPr).not.toHaveBeenCalled();
  expect(menuMocks.createPullRequestSafely).not.toHaveBeenCalled();
  expect(menuMocks.completePublishedTask).not.toHaveBeenCalled();
  expect(menuMocks.loadRunSessionContext).not.toHaveBeenCalled();
  expect(inkFrames.frames).toHaveLength(0);
}

async function executeNextListOperation(run: Promise<void>, returnedSince: number): Promise<void> {
  await terminal.waitForPrompt('List Tasks', returnedSince);
  const mark = terminal.mark();
  await terminal.send('\x1B[B\r');
  await terminal.waitForPrompt('Action for next-operation:', mark);
  const actionMark = terminal.mark();
  await terminal.send('\r');
  await terminal.waitForPrompt('List Tasks', actionMark);
  expect(menuMocks.requeueExceededTask).toHaveBeenCalledExactlyOnceWith('next-operation');
  await terminal.send('\x1B');
  await run;
}

describe('task list confirmation to menu routes', () => {
  it.each([
    { kind: 'failed', action: 'Requeue', actionIndex: 0 },
    { kind: 'failed', action: 'Retry', actionIndex: 1 },
    { kind: 'completed', action: 'Instruct', actionIndex: 1 },
    { kind: 'pr_failed', action: 'Instruct', actionIndex: 1 },
  ] as const)('$kind / $action returns after workflow ESC and continues after Yes', async ({ kind, actionIndex }) => {
    for (const answer of ['\x1B', 'y\r']) {
      menuMocks.loadWorkflow.mockClear();
      menuMocks.requeueExceededTask.mockClear();
      const startMark = terminal.mark();
      const { run } = startList(kind);
      const actionMark = await openAction(kind, actionIndex, startMark);
      await terminal.waitForPrompt(workflowPrompt(), actionMark);
      const confirmationMark = terminal.mark();
      await terminal.send(answer);
      if (answer === '\x1B') {
        await terminal.waitForPrompt('List Tasks', confirmationMark);
        expectNoOperationStarted();
        expect(menuMocks.loadWorkflow).not.toHaveBeenCalled();
        expect(terminal.output().slice(startMark)).not.toContain(runPrompt());
        expect(terminal.output().slice(startMark)).not.toContain('Start position');
      } else {
        await terminal.waitForPrompt(kind === 'failed' ? 'Start position' : runPrompt(), confirmationMark);
        expect(terminal.output().slice(confirmationMark)).not.toContain('List Tasks');
        await terminal.send('\x1B');
      }
      await executeNextListOperation(run, confirmationMark);
    }
  });

  it.each(['completed', 'pr_failed'] as const)('%s / Instruct discards the first answer when run confirmation receives ESC', async (kind) => {
    for (const answer of ['\x1B', 'n\r']) {
      inkFrames.frames = [];
      menuMocks.requeueExceededTask.mockClear();
      const startMark = terminal.mark();
      const { run } = startList(kind);
      const actionMark = await openAction(kind, 1, startMark);
      await terminal.waitForPrompt(workflowPrompt(), actionMark);
      const workflowMark = terminal.mark();
      await terminal.send('y\r');
      await terminal.waitForPrompt(runPrompt(), workflowMark);
      const runMark = terminal.mark();
      await terminal.send(answer);
      if (answer === '\x1B') {
        await terminal.waitForPrompt('List Tasks', runMark);
        expectNoOperationStarted();
        expect(terminal.output().slice(runMark)).not.toContain(workflowPrompt());
        expect(terminal.output().slice(runMark)).not.toContain(getLabel('interactive.runSelector.prompt', 'en'));
      } else {
        await vi.waitFor(() => expect(inkFrames.frames).toHaveLength(1));
        expect(inkFrames.frames[0]!.props.conversation.snapshotHistory?.()).toEqual([]);
        expect(menuMocks.loadRunSessionContext).not.toHaveBeenCalled();
        await terminal.send('/cancel\r');
      }
      await executeNextListOperation(run, runMark);
    }
  });

  it.each(['completed', 'failed', 'pr_failed'] as const)('%s / Create PR returns without publishing on ESC and publishes on Yes', async (kind) => {
    for (const answer of ['\x1B', 'y\r']) {
      menuMocks.requeueExceededTask.mockClear();
      const startMark = terminal.mark();
      const { run, task } = startList(kind);
      const actionMark = await openAction(kind, 2, startMark);
      await terminal.waitForPrompt('PR を作成しますか: menu-task?', actionMark);
      const confirmationMark = terminal.mark();
      await terminal.send(answer);
      await terminal.waitForPrompt('List Tasks', confirmationMark);
      if (answer === '\x1B') {
        expectNoOperationStarted();
      } else {
        expect(menuMocks.stageAndCommit).toHaveBeenCalledWith(fixture.worktreePath, 'takt: menu-task', expect.any(Object));
        expect(menuMocks.publishTaskBranch).toHaveBeenCalledWith(fixture.worktreePath, fixture.cwd, task.branch);
        expect(menuMocks.createPullRequestSafely).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ branch: task.branch }), fixture.cwd);
        if (kind === 'pr_failed') {
          expect(menuMocks.findExistingPr).toHaveBeenCalledWith(task.branch, fixture.cwd);
          expect(menuMocks.completePublishedTask).toHaveBeenCalledWith(task.name, 'https://example.com/pr/1');
        }
      }
      await executeNextListOperation(run, confirmationMark);
    }
  });
});

describe('real terminal input for ESC menu routes', () => {
  it.each([
    { input: '\x1B', result: { kind: 'cancelled' } },
    { input: 'y\r', result: { kind: 'value', value: true } },
    { input: 'n\r', result: { kind: 'value', value: false } },
  ])('delivers $input to every listener and accepts the next input on the same stream', async ({ input, result }) => {
    const confirmation = confirmWithCancel('Continue operation?', false);
    await terminal.waitForPrompt('Continue operation?', 0);
    await terminal.send(input);
    await expect(confirmation).resolves.toEqual(result);

    const nextMark = terminal.mark();
    const nextInput = promptInput('Next operation');
    await terminal.waitForPrompt('Next operation', nextMark);
    await terminal.send('after cancellation\r');
    await expect(nextInput).resolves.toBe('after cancellation');
    expect(terminal.input.isRaw).toBe(false);
  });
});

describe('instruction Issue binding from the task list to a pull request', () => {
  const examples = [
    '# Update logs', '', '```text', 'Issue: #1465', '```', '',
    '~~~text', 'Issue: #1465', '~~~', '',
    '````text', '```text', 'Issue: #1465', '```', '````', '',
    '> Issue: #1465', '<!-- Issue: #1465 -->', '',
    'Example: `Issue: #1465`', '```text', 'Issue: #1465',
  ].join('\n');

  it.each([
    { label: 'a header binding', instruction: '# Fix login\n\nIssue: #1465\n\nFix authentication.', issue: 1465 },
    { label: 'body examples without a binding', instruction: examples, issue: undefined },
  ])('transfers $label through storage, generated branch and PR body', async ({ instruction, issue }) => {
    vi.spyOn(worktreeSettings, 'promptWorktreeSettings').mockResolvedValue({
      worktree: true, autoPr: true, draftPr: false, baseBranch: 'main',
    });
    vi.spyOn(taskSummarize, 'summarizeTaskName').mockResolvedValue('fix-login-bug');
    vi.mocked(runTui).mockImplementation(async (options) => {
      await options.dispatch?.('menu-workflow', {
        action: 'save_task', task: instruction,
        issueContextReplacement: { issueNumber: 1465 },
      });
      return { kind: 'cancelled' };
    });
    const running = { ...fixture.task('running'), runSlug: 'running-run' };
    menuMocks.listAllTaskItems.mockReturnValue([running]);
    const startMark = terminal.mark();
    const run = listTasks(fixture.cwd);
    void run.catch(() => undefined);
    const actionMark = await openAction('running', 1, startMark);
    await terminal.waitForPrompt('List Tasks', actionMark);
    await terminal.send('\x1B');
    await run;

    const [saved] = new TaskRunner(fixture.cwd).listTasks();
    expect(saved).toBeDefined();
    if (!saved?.data || !saved.taskDir || !saved.slug) throw new Error('Expected a saved task specification');
    const orderContent = readFileSync(join(fixture.cwd, saved.taskDir, 'order.md'), 'utf8');
    expect(orderContent).toBe(instruction);
    vi.mocked(execFileSync).mockImplementation((_file, args) => {
      if (args?.[0] === 'fetch') throw Object.assign(new Error('No origin'), { status: 128 });
      if (args?.[0] === 'remote' && args[1] === 'get-url') {
        throw Object.assign(new Error('No origin'), { status: 2 });
      }
      if (args?.[0] === 'show-ref' && args.at(-1) !== 'refs/heads/main') {
        throw Object.assign(new Error('Ref does not exist'), { status: 1 });
      }
      return Buffer.from('');
    });
    vi.spyOn(taskInfrastructure, 'createSharedCloneAbortable').mockImplementation(async (projectDir, options) =>
      createSharedClone(projectDir, {
        ...options, worktree: fixture.worktreePath, skipProjectLocalTaktSync: true,
      }),
    );
    const execution = await resolveTaskExecution(saved, fixture.cwd, undefined, { outputMode: 'silent' });
    if (!execution.branch) throw new Error('Expected a generated task branch');
    const provider = {
      ...gitInfrastructure.getGitProvider(),
      checkCliStatus: vi.fn(() => ({ available: true as const })),
      fetchIssue: vi.fn((number: number) => ({
        number, title: 'Login bug', body: 'Fix authentication.', labels: [], comments: [],
        url: `https://example.com/issues/${number}`,
      })),
    };
    const issues = resolveTaskIssue(execution.issueNumber, fixture.cwd, provider);
    vi.spyOn(taskInfrastructure, 'autoCommitAndPush').mockResolvedValue({
      success: true, commitHash: 'new-commit', message: 'Committed for the PR fixture',
    });
    vi.spyOn(taskGit, 'pushBranch').mockImplementation(() => undefined);
    menuMocks.createPullRequestSafely.mockReturnValue({ success: true });
    const result = await postExecutionFlow({
      execCwd: execution.execCwd, projectCwd: fixture.cwd, task: saved.content,
      branch: execution.branch, baseBranch: execution.baseBranch,
      shouldCreatePr: execution.autoPr, draftPr: execution.draftPr,
      issues, orderContent, gitProvider: provider, outputMode: 'silent',
    });
    expect(result.prFailed).not.toBe(true);
    expect(menuMocks.createPullRequestSafely).toHaveBeenCalledTimes(1);
    const prOptions = menuMocks.createPullRequestSafely.mock.calls[0]![1];
    expect({
      issue: saved.data.issue,
      executionIssue: execution.issueNumber,
      issueBranchPrefix: execution.branch.startsWith('takt/1465/'),
      closes: prOptions.body.match(/^Closes #\d+$/gm) ?? [],
      prBranch: prOptions.branch,
    }).toEqual({
      issue, executionIssue: issue, issueBranchPrefix: issue !== undefined,
      closes: issue === undefined ? [] : ['Closes #1465'],
      prBranch: execution.branch,
    });
    expect(provider.fetchIssue).toHaveBeenCalledTimes(issue === undefined ? 0 : 1);
  });
});

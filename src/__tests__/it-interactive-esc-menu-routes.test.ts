import { createEscMenuFixture, menuMocks } from './helpers/escMenuFixtures.js';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEscMenuTerminal, type EscMenuTerminal } from './helpers/escMenuTerminal.js';
import { interactiveMode } from '../features/interactive/interactive.js';
import { buildTaskRetryStartOptions } from '../features/tasks/list/taskRetryStartSelection.js';
import { getLabel } from '../shared/i18n/index.js';
import { personaMode } from '../features/interactive/personaMode.js';
import { confirm } from '../shared/prompt/confirm.js';

let fixture: ReturnType<typeof createEscMenuFixture>;
let terminal: EscMenuTerminal;

beforeEach(() => {
  fixture = createEscMenuFixture();
  terminal = createEscMenuTerminal();
});

afterEach(() => {
  terminal.restore();
  fixture.cleanup();
  vi.restoreAllMocks();
});

const routes = [
  { route: 'resume', command: '/resume', normalAnswer: 'n\r' },
  { route: 'failed requeue', command: '/requeue', normalAnswer: 'y\r' },
  { route: 'exceeded requeue', command: '/requeue', normalAnswer: 'y\r' },
  { route: 'tell', command: '/tell keep scope', normalAnswer: 'y\r' },
] as const;

describe('readline conversation confirmation to menu routes', () => {
  for (const { route, command, normalAnswer } of routes) {
    it.each(['escape', 'answer'] as const)(`${route} / %s keeps accepting input in the same conversation`, async (inputKind) => {
      const escaped = inputKind === 'escape';
      menuMocks.formalSpec = route === 'resume' ? 'Y/n' : false;
      menuMocks.listAllTaskItems.mockReturnValue([fixture.task(route === 'exceeded requeue' ? 'exceeded' : 'failed')]);
      const startId = buildTaskRetryStartOptions(fixture.workflow, {
        projectCwd: fixture.cwd, lookupCwd: fixture.worktreePath, preferredRootStep: 'implement',
      }).defaultId;
      const tellInstruction = 'Keep the agreed scope.';
      const capture = fixture.provider([
        { content: 'Initial answer.' },
        ...(route === 'failed requeue' ? [{ content: JSON.stringify({ startOptionId: startId }) }] : []),
        ...(route === 'tell' ? [{ content: tellInstruction }] : []),
        { content: 'Continued answer.' },
      ]);
      const run = interactiveMode(fixture.cwd, undefined, undefined, 'original-session');
      void run.catch(() => undefined);
      let mark = 0;
      if (route === 'resume') {
        await terminal.waitForPrompt(getLabel('interactive.formalSpecPrompt', 'en'), mark);
        mark = terminal.mark();
        await terminal.send('y\r');
      }
      await terminal.waitForPrompt('> ', mark);
      mark = terminal.mark();
      await terminal.send('before command\r');
      await terminal.waitForPrompt('> ', mark);
      expect(capture.callCount).toBe(1);

      mark = terminal.mark();
      await terminal.send(command + '\r');
      if (route === 'resume') {
        await terminal.waitForPrompt(getLabel('interactive.sessionSelector.prompt', 'en'), mark);
        mark = terminal.mark();
        await terminal.send('\x1B[B\r');
        await terminal.waitForPrompt(getLabel('interactive.formalSpecPrompt', 'en'), mark);
      } else if (route === 'tell') {
        await terminal.waitForPrompt(getLabel('tui.tell.selectPrompt', 'en'), mark);
        mark = terminal.mark();
        await terminal.send('\r');
        await terminal.waitForPrompt(tellInstruction, mark);
        await terminal.waitForPrompt('[Y/n]:', mark);
      } else {
        await terminal.waitForPrompt('[y/N]:', mark);
      }
      const confirmationMark = terminal.mark();
      await terminal.send(escaped ? '\x1B' : normalAnswer);
      await terminal.waitForPrompt('> ', confirmationMark);

      if (escaped) {
        expect(menuMocks.persistFailedTaskRetry).not.toHaveBeenCalled();
        expect(menuMocks.requeueExceededTask).not.toHaveBeenCalled();
        expect(menuMocks.issueTellableRunningTask).not.toHaveBeenCalled();
        expect(menuMocks.updatePersonaSession).not.toHaveBeenCalledWith(
          expect.anything(), expect.anything(), 'selected-session', expect.anything(),
        );
      } else if (route === 'failed requeue') {
        expect(menuMocks.persistFailedTaskRetry).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
          projectDir: fixture.cwd, task: expect.objectContaining({ kind: 'failed' }),
          restartPoint: { stack: [{ kind: 'agent', step: 'implement', workflow: 'menu-workflow', workflow_ref: 'project:menu-workflow' }] },
        }));
      } else if (route === 'exceeded requeue') {
        expect(menuMocks.requeueExceededTask).toHaveBeenCalledExactlyOnceWith('menu-task');
      } else if (route === 'tell') {
        expect(menuMocks.issueTellableRunningTask).toHaveBeenCalledExactlyOnceWith(fixture.cwd, 'running-run', tellInstruction);
      }

      const callsBeforeNextInput = capture.callCount;
      mark = terminal.mark();
      await terminal.send('after cancellation\r');
      await terminal.waitForPrompt('> ', mark);
      expect(capture.callCount).toBe(callsBeforeNextInput + 1);
      expect(capture.prompts.at(-1)).toContain('after cancellation');
      expect(capture.sessionIds.at(-1)).toBe(route === 'resume' && !escaped ? 'selected-session' : 'original-session');
      if (route === 'resume') {
        if (escaped) {
          expect(capture.systemPrompts.at(-1)).toBe(capture.systemPrompts[0]);
        } else {
          expect(capture.systemPrompts.at(-1)).not.toBe(capture.systemPrompts[0]);
        }
      }
      await terminal.send('/cancel\r');
      await expect(run).resolves.toMatchObject({ action: 'cancel', task: '' });
    });
  }
});

describe('readline /go action menu through the real selector', () => {
  const pipedCases = [
    { name: 'initial empty line saves', answers: '\n', action: 'save_task' },
    { name: 'Issue Y saves', answers: '2\nY\n', action: 'create_issue' },
    { name: 'Issue Enter saves', answers: '2\n\n', action: 'create_issue' },
    { name: 'Issue n only creates', answers: '2\nn\n', action: 'create_issue_only' },
    { name: 'Issue Escape returns to the same proposal', answers: '2\n\x1B\n1\n', action: 'save_task' },
    { name: 'Issue selection remains after Escape', answers: '2\n\x1B\n\nn\n', action: 'create_issue_only' },
    { name: 'execute y proceeds', answers: '3\ny\n', action: 'execute' },
    { name: 'execute N returns', answers: '3\nN\n1\n', action: 'save_task' },
    { name: 'execute Enter returns', answers: '3\n\n1\n', action: 'save_task' },
    { name: 'execute Escape returns', answers: '3\n\x1B\n1\n', action: 'save_task' },
    { name: 'execute selection remains after cancellation', answers: '3\nn\n\ny\n', action: 'execute' },
    { name: 'continue returns to conversation', answers: '4\nnext message\n/cancel\n', action: 'cancel' },
    { name: 'menu Escape returns to conversation', answers: '\x1B\nnext message\n/cancel\n', action: 'cancel' },
    { name: 'confirmation Escape then menu Escape returns to conversation', answers: '2\n\x1B\n\x1B\nnext message\n/cancel\n', action: 'cancel' },
    { name: 'menu EOF cancels', answers: '', action: 'cancel' },
    { name: 'Issue confirmation EOF cancels', answers: '2\n', action: 'cancel' },
    { name: 'execute confirmation EOF cancels', answers: '3\n', action: 'cancel' },
    { name: 'invalid numbers do not dispatch', answers: '0\n5\n2x\n1\n', action: 'save_task' },
  ] as const;

  describe.each(['assistant', 'grill-me', 'persona'] as const)('non-TTY %s input', (mode) => {
    function startPipedConversation(dispatch: NonNullable<Parameters<typeof interactiveMode>[5]>['dispatch'], exclude = false) {
      const options = { dispatch, ...(exclude ? { excludeActions: ['create_issue'] as const } : {}) };
      return mode === 'persona'
        ? personaMode(fixture.cwd, {
          personaContent: 'Write the task', personaDisplayName: 'Writer', allowedTools: ['Read'],
        }, undefined, undefined, options)
        : interactiveMode(fixture.cwd, undefined, undefined, undefined, undefined, {
          ...options, assistantMode: mode,
        });
    }

    function pipe() {
      const input = new PassThrough();
      Object.defineProperty(input, 'isTTY', { value: false });
      vi.spyOn(process, 'stdin', 'get').mockReturnValue(input as unknown as typeof process.stdin);
      Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });
      vi.stubEnv('TAKT_NO_TTY', '1');
      vi.stubEnv('TAKT_TEST_FLG_TOUCH_TTY', '0');
      return input;
    }

    it.each(pipedCases)('$name', async ({ answers, action }) => {
      const input = pipe();
      const capture = fixture.provider([{ content: 'Agreed task' }, { content: 'Continued answer' }]);
      const dispatch = vi.fn().mockResolvedValue({ kind: 'dispatched' });
      input.end('/go build the task\n' + answers);
      try {
        const result = await startPipedConversation(dispatch);
        result.cleanupAttachments?.();
        expect(result.action).toBe(action);
        if (action === 'cancel') {
          expect(dispatch).not.toHaveBeenCalled();
          if (answers.includes('next message')) {
            expect(capture.callCount).toBe(2);
            expect(capture.prompts.at(-1)).toContain('next message');
          }
        } else {
          expect(dispatch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ action, task: 'Agreed task' }));
          expect(capture.callCount).toBe(1);
        }
      } finally {
        input.destroy();
      }
    });

    it('reads staged answers before EOF and dispatches only after confirmation', async () => {
      const input = pipe();
      fixture.provider([{ content: 'Agreed task' }]);
      const dispatch = vi.fn().mockResolvedValue({ kind: 'dispatched' });
      const run = startPipedConversation(dispatch);
      input.write('/go build the task\n');
      await vi.waitFor(() => expect(terminal.output()).toContain('2. ' + getLabel('interactive.ui.actions.createIssue', 'en')));
      expect(dispatch).not.toHaveBeenCalled();
      input.write('2\n');
      await vi.waitFor(() => expect(terminal.output()).toContain('[Y/n]:'));
      expect(dispatch).not.toHaveBeenCalled();
      input.write('n\n');
      try {
        const result = await run;
        result.cleanupAttachments?.();
        expect(result.action).toBe('create_issue_only');
        expect(dispatch).toHaveBeenCalledOnce();
      } finally {
        input.end();
      }
    });

    it('treats a number in conversation as a message', async () => {
      const input = pipe();
      const capture = fixture.provider([{ content: 'Answer to the number' }]);
      const dispatch = vi.fn();
      input.end('2\n/cancel\n');
      const result = await startPipedConversation(dispatch);
      result.cleanupAttachments?.();
      expect(result.action).toBe('cancel');
      expect(capture.prompts[0]).toContain('2');
      expect(capture.callCount).toBe(1);
      expect(dispatch).not.toHaveBeenCalled();
    });

    it.each(['Y', 'n'])('passes later worktree answer %s to the existing confirmation', async (answer) => {
      const input = pipe();
      fixture.provider([{ content: 'Agreed task' }]);
      const worktree = vi.fn();
      const dispatch = vi.fn(async () => {
        worktree(await confirm('Create worktree?', false));
        return { kind: 'dispatched' as const };
      });
      input.end(`/go build the task\n2\nY\n${answer}\n`);
      const result = await startPipedConversation(dispatch);
      result.cleanupAttachments?.();
      expect(result.action).toBe('create_issue');
      expect(worktree).toHaveBeenCalledExactlyOnceWith(answer === 'Y');
    });

    it.each([
      { answers: '2\ny\n', action: 'execute' },
      { answers: '1\n', action: 'save_task' },
    ])('uses the displayed PR menu order for $action', async ({ answers, action }) => {
      const input = pipe();
      fixture.provider([{ content: 'PR task' }]);
      const dispatch = vi.fn().mockResolvedValue({ kind: 'dispatched' });
      input.end('/go review the PR\n' + answers);
      const result = await startPipedConversation(dispatch, true);
      result.cleanupAttachments?.();
      expect(result.action).toBe(action);
      expect(dispatch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ action, task: 'PR task' }));
      expect(terminal.output()).toContain('2. ' + getLabel('interactive.ui.actions.execute', 'en'));
    });
  });

  it('saves the task as the default action with actual non-TTY piped input', async () => {
    fixture.provider([{ content: 'Piped task' }]);
    const input = new PassThrough();
    Object.defineProperty(input, 'isTTY', { value: false });
    const stdinSpy = vi.spyOn(process, 'stdin', 'get').mockReturnValue(input as unknown as typeof process.stdin);
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });
    vi.stubEnv('TAKT_NO_TTY', '1');
    vi.stubEnv('TAKT_TEST_FLG_TOUCH_TTY', '0');
    input.end('/go build the task\n\n');

    try {
      const result = await interactiveMode(fixture.cwd);
      result.cleanupAttachments?.();
      expect(result).toMatchObject({ action: 'save_task', task: 'Piped task' });
    } finally {
      input.destroy();
      stdinSpy.mockRestore();
    }
  });

  it('chooses task saving on initial Enter without confirming immediate execution', async () => {
    const capture = fixture.provider([{ content: 'Agreed task' }]);
    const dispatch = vi.fn().mockResolvedValue({ kind: 'dispatched' });
    const run = interactiveMode(fixture.cwd, undefined, undefined, undefined, undefined, { dispatch });
    void run.catch(() => undefined);
    await terminal.waitForPrompt('> ', 0);
    const mark = terminal.mark();
    await terminal.send('/go build the task\r');
    await terminal.waitForPrompt(getLabel('interactive.ui.actionPrompt', 'en'), mark);
    await terminal.send('\r');

    const result = await run;
    try {
      expect(result).toMatchObject({ action: 'save_task', task: 'Agreed task' });
      expect(dispatch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ action: 'save_task', task: 'Agreed task' }));
      expect(capture.callCount).toBe(1);
    } finally {
      result.cleanupAttachments?.();
    }
  });

  it.each([
    { action: 'create_issue', arrows: 1, hint: '[Y/n]:', answer: 'y\r', outcome: 'create_issue' },
    { action: 'create_issue', arrows: 1, hint: '[Y/n]:', answer: '\r', outcome: 'create_issue' },
    { action: 'create_issue', arrows: 1, hint: '[Y/n]:', answer: 'n\r', outcome: 'create_issue_only' },
    { action: 'create_issue', arrows: 1, hint: '[Y/n]:', answer: '\x1B', outcome: 'save_task' },
    { action: 'execute', arrows: 2, hint: '[y/N]:', answer: 'y\r', outcome: 'execute' },
    { action: 'execute', arrows: 2, hint: '[y/N]:', answer: '\r', outcome: 'save_task' },
    { action: 'execute', arrows: 2, hint: '[y/N]:', answer: 'N\r', outcome: 'save_task' },
    { action: 'execute', arrows: 2, hint: '[y/N]:', answer: '\x1B', outcome: 'save_task' },
  ])('handles $action answer=$answer without dispatching before confirmation', async ({ arrows, hint, answer, outcome }) => {
    const capture = fixture.provider([{ content: 'Agreed task' }]);
    const dispatch = vi.fn().mockResolvedValue({ kind: 'dispatched' });
    const run = interactiveMode(fixture.cwd, undefined, undefined, undefined, undefined, { dispatch });
    void run.catch(() => undefined);
    await terminal.waitForPrompt('> ', 0);
    let mark = terminal.mark();
    await terminal.send('/go build the task\r');
    await terminal.waitForPrompt(getLabel('interactive.ui.actionPrompt', 'en'), mark);
    mark = terminal.mark();
    await terminal.send('\x1B[B'.repeat(arrows) + '\r');
    await terminal.waitForPrompt(hint, mark);
    expect(dispatch).not.toHaveBeenCalled();
    mark = terminal.mark();
    await terminal.send(answer);
    if (outcome === 'save_task') {
      await terminal.waitForPrompt(getLabel('interactive.ui.actionPrompt', 'en'), mark);
      expect(dispatch).not.toHaveBeenCalled();
      // 直前の項目に戻る契約を、そこから保存まで戻る実キー入力で観測する。
      await terminal.send('\x1B[A'.repeat(arrows) + '\r');
    }

    const result = await run;
    try {
      expect(result).toMatchObject({ action: outcome, task: 'Agreed task' });
      expect(dispatch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ action: outcome, task: 'Agreed task' }));
      expect(capture.callCount).toBe(1);
    } finally {
      result.cleanupAttachments?.();
    }
  });

  it('returns from confirmation Escape to menu Escape and accepts the next conversation input', async () => {
    const capture = fixture.provider([{ content: 'Agreed task' }, { content: 'Continued answer' }]);
    const dispatch = vi.fn();
    const run = interactiveMode(fixture.cwd, undefined, undefined, 'original-session', undefined, { dispatch });
    void run.catch(() => undefined);
    await terminal.waitForPrompt('> ', 0);
    let mark = terminal.mark();
    await terminal.send('/go build the task\r');
    await terminal.waitForPrompt(getLabel('interactive.ui.actionPrompt', 'en'), mark);
    mark = terminal.mark();
    await terminal.send('\x1B[B\r');
    await terminal.waitForPrompt('[Y/n]:', mark);
    mark = terminal.mark();
    await terminal.send('\x1B');
    await terminal.waitForPrompt(getLabel('interactive.ui.actionPrompt', 'en'), mark);
    mark = terminal.mark();
    await terminal.send('\x1B');
    await terminal.waitForPrompt('> ', mark);
    mark = terminal.mark();
    await terminal.send('continue this conversation\r');
    await terminal.waitForPrompt('> ', mark);
    expect(capture.prompts.at(-1)).toContain('continue this conversation');
    expect(capture.callCount).toBe(2);
    expect(dispatch).not.toHaveBeenCalled();
    await terminal.send('/cancel\r');
    const result = await run;
    result.cleanupAttachments?.();
  });

  it('withholds Issue creation in the persona conversation menu for a PR session', async () => {
    fixture.provider([{ content: 'PR task' }]);
    const run = personaMode(fixture.cwd, {
      personaContent: 'Review the PR', personaDisplayName: 'Reviewer', allowedTools: ['Read'],
    }, undefined, undefined, {
      excludeActions: ['create_issue'],
    } as NonNullable<Parameters<typeof personaMode>[4]>);
    void run.catch(() => undefined);
    await terminal.waitForPrompt('> ', 0);
    const mark = terminal.mark();
    await terminal.send('/go review the PR\r');
    await terminal.waitForPrompt(getLabel('interactive.ui.actionPrompt', 'en'), mark);
    const menu = terminal.output().slice(mark);
    const inputMark = terminal.mark();
    await terminal.send('\x1B');
    await terminal.waitForPrompt('> ', inputMark);
    await terminal.send('/cancel\r');
    const result = await run;
    result.cleanupAttachments?.();
    expect(menu).toContain(getLabel('interactive.ui.actions.saveTask', 'en'));
    expect(menu).not.toContain(getLabel('interactive.ui.actions.createIssue', 'en'));
  });
});

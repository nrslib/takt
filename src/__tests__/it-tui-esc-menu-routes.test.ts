import { createEscMenuFixture, menuMocks } from './helpers/escMenuFixtures.js';
import { inkFrames } from './helpers/escMenuInk.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEscMenuTerminal, type EscMenuTerminal } from './helpers/escMenuTerminal.js';
import { runTui } from '../features/tui/runTui.js';
import { buildTaskRetryStartOptions } from '../features/tasks/list/taskRetryStartSelection.js';
import { filterSlashCommands } from '../features/interactive/slashCommandRegistry.js';
import { buildInteractiveSystemPrompt } from '../features/interactive/conversationPlan.js';
import { getLabel } from '../shared/i18n/index.js';

let fixture: ReturnType<typeof createEscMenuFixture>;
let terminal: EscMenuTerminal;

beforeEach(() => {
  fixture = createEscMenuFixture();
  inkFrames.frames.length = 0;
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

describe('TUI confirmation to conversation routes through the real runner', () => {
  for (const mode of ['assistant', 'grill-me'] as const) {
    it.each([
      { inputKind: 'escape', input: '\x1B', formalSpec: false },
      { inputKind: 'Yes', input: 'y\r', formalSpec: true },
      { inputKind: 'No', input: 'n\r', formalSpec: false },
    ])(`persona to ${mode} / $inputKind handles the next input with the retained or selected mode`, async ({ inputKind, input, formalSpec }) => {
      const escaped = inputKind === 'escape';
      menuMocks.firstStep = {
        personaDisplayName: 'Reviewer', personaContent: 'Review the task.', allowedTools: ['Read'],
      };
      menuMocks.formalSpec = 'Y/n';
      const capture = fixture.provider([
        { content: 'Initial answer.', sessionId: 'persona-session' },
        { content: 'Continued answer.' },
      ]);
      const dispatch = vi.fn();
      const run = runTui({
        cwd: fixture.cwd, lang: 'en', workflowId: 'menu-workflow',
        previewCount: 1, taskHistory: [], continueSession: true, dispatch,
      });
      void run.catch(() => undefined);
      await terminal.waitForPrompt(getLabel('interactive.modeSelection.prompt', 'en'), 0);
      await terminal.send('\x1B[B\x1B[B\r');
      await vi.waitFor(() => expect(inkFrames.frames).toHaveLength(1));
      const first = inkFrames.frames[0]!;
      expect(terminal.output()).not.toContain(getLabel('interactive.formalSpecPrompt', 'en'));
      await terminal.send('before command\r');
      await vi.waitFor(() => expect(first.submissions).toHaveLength(1));
      expect(capture.callCount).toBe(1);
      expect(capture.systemPrompts[0]).toContain(menuMocks.firstStep.personaContent);
      expect(capture.allowedTools[0]).toEqual(['Read']);
      expect(first.props.conversation.getSessionId()).toBe('persona-session');

      let mark = terminal.mark();
      await terminal.send('/interaction\r');
      await terminal.waitForPrompt(getLabel('interactive.modeSelection.prompt', 'en'), mark);
      mark = terminal.mark();
      await terminal.send(mode === 'assistant' ? '\r' : '\x1B[B\r');
      await terminal.waitForPrompt(getLabel('interactive.formalSpecPrompt', 'en'), mark);
      expect(first.unmounted).toBe(true);
      await terminal.send(input);
      await vi.waitFor(() => expect(inkFrames.frames).toHaveLength(2), { timeout: 2000 });
      const continued = inkFrames.frames[1]!;
      expect(capture.callCount).toBe(1);
      expect(dispatch).not.toHaveBeenCalled();
      expect(continued.props.conversation.getSessionId()).toBe('persona-session');

      await terminal.send('after cancellation\r');
      await vi.waitFor(() => expect(continued.submissions).toHaveLength(1));
      expect(continued.submissions[0]).toMatchObject({ text: 'after cancellation', result: { kind: 'assistant_response' } });
      expect(capture.callCount).toBe(2);
      expect(capture.prompts.at(-1)).toContain('after cancellation');
      expect(capture.sessionIds.at(-1)).toBe(escaped ? 'persona-session' : undefined);
      if (escaped) {
        expect(capture.systemPrompts.at(-1)).toBe(capture.systemPrompts[0]);
        expect(capture.allowedTools.at(-1)).toEqual(['Read']);
      } else {
        expect(capture.systemPrompts.at(-1)).toBe(buildInteractiveSystemPrompt('en', {
          grillMe: mode === 'grill-me', formalSpec,
          workflowContext: {
            name: 'menu-workflow', description: 'Menu workflow', workflowStructure: 'implement', stepPreviews: [], taskHistory: [],
          },
        }));
      }
      expect(filterSlashCommands('/verify', continued.props.conversation.commandAvailability).length > 0).toBe(formalSpec);
      await terminal.send('/cancel\r');
      await expect(run).resolves.toMatchObject({ kind: 'selected', result: { action: 'cancel', task: '' } });
      expect(dispatch).not.toHaveBeenCalled();
      expect(continued.unmounted).toBe(true);
    });
  }

  for (const { route, command, normalAnswer } of routes) {
    it.each(['escape', 'answer'] as const)(`${route} / %s redisplays the conversation and handles its next input`, async (inputKind) => {
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
      const dispatch = vi.fn();
      const run = runTui({
        cwd: fixture.cwd, lang: 'en', workflowId: 'menu-workflow',
        previewCount: 1, taskHistory: [], continueSession: true, dispatch,
      });
      void run.catch(() => undefined);
      await terminal.waitForPrompt(getLabel('interactive.modeSelection.prompt', 'en'), 0);
      let mark = terminal.mark();
      await terminal.send('\r');
      if (route === 'resume') {
        await terminal.waitForPrompt(getLabel('interactive.formalSpecPrompt', 'en'), mark);
        await terminal.send('y\r');
      }
      await vi.waitFor(() => expect(inkFrames.frames).toHaveLength(1));
      const first = inkFrames.frames[0]!;
      await terminal.send('before command\r');
      await vi.waitFor(() => expect(first.submissions).toHaveLength(1));
      expect(capture.callCount).toBe(1);
      expect(capture.sessionIds[0]).toBe('original-session');

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
      expect(first.unmounted).toBe(true);
      await terminal.send(escaped ? '\x1B' : normalAnswer);
      await vi.waitFor(() => expect(inkFrames.frames).toHaveLength(2), { timeout: 2000 });
      const continued = inkFrames.frames[1]!;
      expect(continued.props.conversation.getSessionId()).toBe(
        route === 'resume' && !escaped ? 'selected-session' : 'original-session',
      );

      if (escaped) {
        expect(menuMocks.persistFailedTaskRetry).not.toHaveBeenCalled();
        expect(menuMocks.requeueExceededTask).not.toHaveBeenCalled();
        expect(menuMocks.issueTellableRunningTask).not.toHaveBeenCalled();
        const noticeKey = route === 'resume' ? 'interactive.ui.cancelled'
          : route === 'tell' ? 'tui.errors.tellCancelled' : 'tui.errors.assistantRetryCancelled';
        expect(continued.props.initialEntries).toEqual([{ role: 'system', content: getLabel(noticeKey, 'en') }]);
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
      if (route === 'resume') {
        expect(filterSlashCommands('/verify', continued.props.conversation.commandAvailability).length > 0).toBe(escaped);
      }

      const callsBeforeNextInput = capture.callCount;
      await terminal.send('after cancellation\r');
      await vi.waitFor(() => expect(continued.submissions).toHaveLength(1));
      expect(continued.submissions[0]).toMatchObject({ text: 'after cancellation', result: { kind: 'assistant_response' } });
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
      await expect(run).resolves.toMatchObject({ kind: 'selected', result: { action: 'cancel', task: '' } });
      expect(dispatch).not.toHaveBeenCalled();
      expect(continued.unmounted).toBe(true);
    });
  }
});

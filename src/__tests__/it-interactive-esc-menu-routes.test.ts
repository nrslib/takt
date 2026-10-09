import { createEscMenuFixture, menuMocks } from './helpers/escMenuFixtures.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEscMenuTerminal, type EscMenuTerminal } from './helpers/escMenuTerminal.js';
import { interactiveMode } from '../features/interactive/interactive.js';
import { buildTaskRetryStartOptions } from '../features/tasks/list/taskRetryStartSelection.js';
import { getLabel } from '../shared/i18n/index.js';

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

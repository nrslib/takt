import { failureNotice, startupDoubles, memory, inbox, cwd, summaryA, ENTER, response, mount, deferred, promptFrame, queuedFrame, waitFor, typeAndSubmit, send } from './manager-tui-fixtures.js';
import { stripVTControlCharacters } from 'node:util';
import chalk from 'chalk';
import { createElement } from 'react';
import stringWidth from 'string-width';
import { describe, expect, it, vi } from 'vitest';
import { ManagerView } from '../../features/manager/ManagerView.js';
import * as savedEvents from '../../features/manager/savedEvents.js';
import * as workspaceRegistry from '../../infra/config/global/workspaceRegistry.js';
import { getLabel } from '../../shared/i18n/index.js';
import { goalRecord } from './goal-fixtures.js';

describe('manager TUI startup and polling', () => {
  it('continues startup after the initial assignment read fails and suppresses historical records in the same screen', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const startedAt = Date.parse('2026-10-21T10:00:00Z');
    vi.setSystemTime(startedAt);
    const goals = ['First goal', 'Second goal'].map((objective, goalIndex) => ({
      ...goalRecord(), id: `750e8400-e29b-41d4-a716-44665544000${goalIndex}`, objective,
      workLog: Array.from({ length: 30 }, (_, index) => ({
        id: `850e8400-e29b-41d4-a716-${String(goalIndex * 30 + index).padStart(12, '0')}`,
        recordedAt: '2026-10-14T00:00:00Z', summary: `Historical record ${goalIndex}-${index}`,
      })),
      questions: [{ id: `650e8400-e29b-41d4-a716-44665544000${goalIndex}`,
        recipient: 'human' as const, status: 'pending' as const, body: 'Which format?' }],
    }));
    memory.goals.mockReturnValue(goals);
    const repository = { kind: 'repository' as const, repositoryDirectory: cwd, repositoryDirectories: [cwd] };
    const lookup = vi.spyOn(workspaceRegistry, 'findWorkspaceForRepository')
      .mockResolvedValue(undefined).mockRejectedValueOnce(new Error('initial assignment read failed'));
    const read = vi.spyOn(savedEvents, 'readManagerDisplayEvents');
    const recovery = deferred<readonly string[]>();
    const newRecord = { id: '950e8400-e29b-41d4-a716-446655440001',
      recordedAt: new Date(startedAt + 1000).toISOString(), summary: 'New work record' };
    const startup = {
      run: vi.fn(async () => {
        await recovery.promise;
        vi.setSystemTime(startedAt + 1000);
        memory.goals.mockReturnValue(goals.map((goal, index) => index === 0
          ? { ...goal, workLog: [...goal.workLog, newRecord] } : goal));
        return [] as string[];
      }),
      fail: vi.fn(),
    };
    const context = mount('en', startup, repository);
    try {
      await waitFor(() => {
        expect(startup.run).toHaveBeenCalledOnce();
        expect(context.app.lastFrame()).toContain('initial assignment read failed');
      });
      expect(lookup).toHaveBeenCalledOnce();
      expect(read).not.toHaveBeenCalled();
      recovery.resolve([]);
      await waitFor(() => {
        expect(read).toHaveBeenCalled();
        expect(context.app.lastFrame()).toContain(newRecord.summary);
        expect(context.app.lastFrame()).not.toContain('Working');
      });
      expect(startup.run).toHaveBeenCalledOnce();
      expect(startup.fail).not.toHaveBeenCalled();
      expect(startup.run.mock.invocationCallOrder[0]).toBeLessThan(read.mock.invocationCallOrder[0]!);
      expect(read.mock.calls[0]).toEqual([cwd, 'en', repository, new Map([[cwd, startedAt]]), startedAt]);
      const initial: Awaited<ReturnType<typeof savedEvents.readManagerDisplayEvents>> = await read.mock.results[0]!.value;
      expect(initial.events).toHaveLength(61);
      expect(initial.events.filter((event) => event.suppressInitialDisplay).map((event) => event.id))
        .toEqual(goals.flatMap((goal) => goal.workLog.map((record) => JSON.stringify([goal.id, 'work-log', record.id]))));
      expect(initial.events.filter((event) => !event.suppressInitialDisplay).map((event) => event.message))
        .toEqual([`${goals[0]!.id}: ${newRecord.summary}`]);
      const frame = context.app.lastFrame()!;
      const rows = frame.split('\n');
      const countIndex = rows.findIndex((row) => /^(?:in progress|ongoing|active)\b/iu.test(row));
      const counts = rows[countIndex];
      expect(rows[countIndex - 1]).toMatch(/manager-repository/u);
      expect(counts).toBeDefined();
      expect(counts).toMatch(/(?:in progress|ongoing|active)\s*:?\s*2/iu);
      expect(counts).toMatch(/(?:pending|unanswered)\s*:?\s*2/iu);
      expect(counts).not.toMatch(/\^|Enter|Esc|Ctrl/u);
      for (const rendered of context.app.frames) expect(rendered).not.toContain('Historical record');
      expect(frame).toContain('initial assignment read failed');
      expect(context.call).not.toHaveBeenCalled();
    } finally {
      context.app.unmount();
      recovery.resolve([]);
      await context.session.close();
    }
  });

  it('suppresses history in every initial workspace repository after the initial assignment read fails', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const startedAt = Date.parse('2026-10-21T10:00:00Z');
    vi.setSystemTime(startedAt);
    const repositoryB = '/test/repository-b';
    const workspace = { id: '650e8400-e29b-41d4-a716-446655440001', name: 'A + B', repositoryDirectories: [cwd, repositoryB] };
    const assignment = { kind: 'workspace' as const, workspaceId: workspace.id,
      name: workspace.name, repositoryDirectories: workspace.repositoryDirectories };
    const goal = { ...goalRecord(), workLog: Array.from({ length: 30 }, (_, index) => ({
      id: `850e8400-e29b-41d4-a716-${String(index).padStart(12, '0')}`,
      recordedAt: '2026-10-14T00:00:00Z', summary: `Historical workspace record ${index}`,
    })) };
    memory.goals.mockReturnValue([goal]);
    const lookup = vi.spyOn(workspaceRegistry, 'readWorkspace')
      .mockResolvedValue(workspace).mockRejectedValueOnce(new Error('initial workspace assignment read failed'));
    const read = vi.spyOn(savedEvents, 'readManagerDisplayEvents');
    const recovery = deferred<readonly string[]>();
    const newRecord = { id: '950e8400-e29b-41d4-a716-446655440001',
      recordedAt: new Date(startedAt + 1000).toISOString(), summary: 'New workspace work record' };
    const startup = {
      run: vi.fn(async () => {
        await recovery.promise;
        vi.setSystemTime(startedAt + 1000);
        memory.goals.mockReturnValue([{ ...goal, workLog: [...goal.workLog, newRecord] }]);
        return [] as string[];
      }),
      fail: vi.fn(),
    };
    const context = mount('en', startup, assignment);
    try {
      await waitFor(() => {
        expect(startup.run).toHaveBeenCalledOnce();
        expect(context.app.lastFrame()).toContain('initial workspace assignment read failed');
      });
      expect(lookup).toHaveBeenCalledOnce();
      expect(read).not.toHaveBeenCalled();
      recovery.resolve([]);
      await waitFor(() => {
        expect(read).toHaveBeenCalled();
        expect(context.app.lastFrame()).toContain(newRecord.summary);
        expect(context.app.lastFrame()).not.toContain('Working');
      });
      expect(startup.run).toHaveBeenCalledOnce();
      expect(startup.fail).not.toHaveBeenCalled();
      expect(startup.run.mock.invocationCallOrder[0]).toBeLessThan(read.mock.invocationCallOrder[0]!);
      expect(read.mock.calls[0]).toEqual([cwd, 'en', assignment,
        new Map([[cwd, startedAt], [repositoryB, startedAt]]), startedAt]);
      const initial: Awaited<ReturnType<typeof savedEvents.readManagerDisplayEvents>> = await read.mock.results[0]!.value;
      expect(initial.events).toHaveLength(62);
      expect(initial.events.filter((event) => event.suppressInitialDisplay).map((event) => event.id))
        .toEqual(workspace.repositoryDirectories.flatMap(() => goal.workLog.map((record) => JSON.stringify([goal.id, 'work-log', record.id]))));
      expect(initial.events.filter((event) => !event.suppressInitialDisplay).map((event) => event.message))
        .toEqual(workspace.repositoryDirectories.map(() => `${goal.id}: ${newRecord.summary}`));
      for (const rendered of context.app.frames) expect(rendered).not.toContain('Historical workspace record');
      expect(context.app.lastFrame()).toContain('initial workspace assignment read failed');
      expect(context.call).not.toHaveBeenCalled();
    } finally {
      context.app.unmount();
      recovery.resolve([]);
      await context.session.close();
    }
  });

  it.each([false, true])('waits for the initial display snapshot before submitting queued input with startup=%s', async (withStartup) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const startedAt = Date.parse('2026-10-21T10:00:00Z');
    vi.setSystemTime(startedAt);
    const snapshot = { events: [], diagnostics: [], notices: [], questions: [], goals: [] };
    const initial = deferred<Awaited<ReturnType<typeof savedEvents.readManagerDisplayEvents>>>();
    const read = vi.spyOn(savedEvents, 'readManagerDisplayEvents')
      .mockResolvedValue(snapshot).mockReturnValueOnce(initial.promise);
    const startup = { run: vi.fn(async () => [] as string[]), fail: vi.fn() };
    const context = mount('en', withStartup ? startup : undefined);
    context.call.mockResolvedValue(response(null));
    try {
      await waitFor(() => expect(read).toHaveBeenCalledOnce());
      const startupBoundary = read.mock.calls[0]![3];
      expect(startupBoundary).toEqual(new Map([[cwd, startedAt]]));
      await typeAndSubmit(context, 'request during initial display read');
      await waitFor(() => expect(queuedFrame(context)).toContain('request during initial display read'));
      expect(context.call).not.toHaveBeenCalled();
      expect(read).toHaveBeenCalledOnce();
      initial.resolve(snapshot);
      await waitFor(() => expect(context.call).toHaveBeenCalledExactlyOnceWith('request during initial display read', expect.any(Object)));
      for (const call of read.mock.calls.slice(1)) expect(call[3]).toEqual(startupBoundary);
      expect(startup.fail).not.toHaveBeenCalled();
    } finally {
      initial.resolve(snapshot);
      context.app.unmount();
      await context.session.close();
    }
  });

  it('shows the draft and its cursor during startup recovery and keeps the draft after completion', async () => {
    const recovery = deferred<readonly string[]>();
    const startup = { run: vi.fn(() => recovery.promise), fail: vi.fn() };
    const originalChalkLevel = chalk.level;
    chalk.level = 1;
    try {
      const context = mount('en', startup);
      try {
        await waitFor(() => expect(startup.run).toHaveBeenCalledOnce());
        context.app.stdin.write('recovery draft');
        await waitFor(() => {
          const frame = context.app.lastFrame()!;
          const prompt = frame.slice(frame.lastIndexOf('╭'));
          expect(stripVTControlCharacters(frame)).toContain('Working');
          expect(stripVTControlCharacters(prompt)).toContain('recovery draft');
          expect(prompt).toContain('recovery draft\x1b[7m \x1b[27m');
        });
        context.app.stdin.write('\x1b[D');
        await waitFor(() => {
          const frame = context.app.lastFrame()!;
          const prompt = frame.slice(frame.lastIndexOf('╭'));
          expect(stripVTControlCharacters(frame)).toContain('Working');
          expect(stripVTControlCharacters(prompt)).toContain('recovery draft');
          expect(prompt).toContain('recovery draf\x1b[7mt\x1b[27m');
        });
        expect(context.call).not.toHaveBeenCalled();
        recovery.resolve(['recovery complete']);
        await waitFor(() => {
          const frame = context.app.lastFrame()!;
          expect(stripVTControlCharacters(frame)).toContain('recovery complete');
          expect(stripVTControlCharacters(frame)).not.toContain('Working');
          expect(stripVTControlCharacters(frame.slice(frame.lastIndexOf('╭')))).toContain('recovery draft');
        });
        context.app.stdin.write(ENTER);
        await waitFor(() => expect(context.call).toHaveBeenCalledExactlyOnceWith('recovery draft', expect.any(Object)));
      } finally {
        context.app.unmount();
        recovery.resolve([]);
        await context.session.close();
      }
    } finally {
      chalk.level = originalChalkLevel;
    }
  });

  it('queues consecutive submissions before a redraw and sends them after startup in FIFO order', async () => {
    const recovery = deferred<readonly string[]>();
    const turn = deferred<ReturnType<typeof response>>();
    const startup = { run: vi.fn(() => recovery.promise), fail: vi.fn() };
    const context = mount('en', startup);
    context.call.mockReturnValueOnce(turn.promise).mockResolvedValue(response(null));
    try {
      await waitFor(() => expect(startup.run).toHaveBeenCalledOnce());
      context.app.stdin.write('first startup request');
      context.app.stdin.write(ENTER);
      context.app.stdin.write('second startup request');
      context.app.stdin.write(ENTER);
      context.app.stdin.write('startup draft');
      await waitFor(() => {
        expect(queuedFrame(context)).toContain('first startup request');
        expect(queuedFrame(context)).toContain('second startup request');
        expect(queuedFrame(context)).toMatch(/Queued messages: 2/u);
        expect(promptFrame(context)).toContain('startup draft');
      });
      expect(context.call).not.toHaveBeenCalled();
      recovery.resolve([]);
      await waitFor(() => expect(context.call).toHaveBeenCalledExactlyOnceWith('first startup request', expect.any(Object)));
      turn.resolve(response(null));
      await waitFor(() => {
        expect(context.call).toHaveBeenCalledTimes(2);
        expect(context.call.mock.calls.map(([text]) => text)).toEqual(['first startup request', 'second startup request']);
        expect(context.app.lastFrame()).not.toContain('Working');
        expect(promptFrame(context)).toContain('startup draft');
        expect(queuedFrame(context)).toBeUndefined();
      });
    } finally {
      context.app.unmount();
      recovery.resolve([]);
      turn.resolve(response(null));
      await context.session.close();
    }
  });

  it('does not send queued startup input after recovery fails', async () => {
    const recovery = deferred<readonly string[]>();
    const failure = new Error('recovery failed');
    const startup = { run: vi.fn(async () => { await recovery.promise; throw failure; }), fail: vi.fn() };
    const context = mount('en', startup);
    try {
      await waitFor(() => expect(startup.run).toHaveBeenCalledOnce());
      await typeAndSubmit(context, 'queued before startup failure');
      await waitFor(() => expect(queuedFrame(context)).toContain('queued before startup failure'));
      recovery.resolve([]);
      await waitFor(() => expect(startup.fail).toHaveBeenCalledExactlyOnceWith(failure));
      await waitFor(() => expect(queuedFrame(context)).toBeUndefined());
      context.app.stdin.write('after failure');
      context.app.stdin.write(ENTER);
      await context.session.close();
      expect(context.call).not.toHaveBeenCalled();
    } finally {
      context.app.unmount();
      recovery.resolve([]);
      await context.session.close();
    }
  });

  it.each([false, true])('handles queued input while stdout is flushing with Esc=%s', async (interrupt) => {
    const flush = deferred<void>();
    startupDoubles.flush.mockReturnValueOnce(flush.promise);
    const startup = { run: vi.fn(async (_signal: AbortSignal) => [] as string[]), fail: vi.fn() };
    const context = mount('en', startup);
    context.call.mockResolvedValue(response(null));
    try {
      await waitFor(() => expect(startupDoubles.flush).toHaveBeenCalledOnce());
      for (const text of ['first startup request', 'second startup request']) {
        await typeAndSubmit(context, text);
        await waitFor(() => expect(queuedFrame(context)).toContain(text));
      }
      expect(queuedFrame(context)).toContain('Queued messages: 2');
      expect(startup.run).not.toHaveBeenCalled();
      expect(context.call).not.toHaveBeenCalled();

      if (interrupt) {
        context.app.stdin.write('\x1b[27u');
        await waitFor(() => expect(queuedFrame(context)).toBeUndefined());
        expect(context.app.lastFrame()).toContain('Working');
      }
      expect(context.onExit).not.toHaveBeenCalled();
      flush.resolve();
      await waitFor(() => {
        expect(startup.run).toHaveBeenCalledTimes(interrupt ? 0 : 1);
        expect(context.call.mock.calls.map(([text]) => text)).toEqual(interrupt
          ? [] : ['first startup request', 'second startup request']);
        expect(queuedFrame(context)).toBeUndefined();
        expect(context.app.lastFrame()).not.toContain('Working');
      });
      expect(startup.fail).not.toHaveBeenCalled();
      expect(context.onExit).not.toHaveBeenCalled();
    } finally {
      context.app.unmount();
      flush.resolve();
      await context.session.close();
    }
  });

  it.each([false, true])('handles queued input and late startup success with Esc=%s', async (interrupt) => {
    const recovery = deferred<readonly string[]>();
    const startup = { run: vi.fn((_signal: AbortSignal) => recovery.promise), fail: vi.fn() };
    const context = mount('en', startup);
    context.call.mockResolvedValue(response(null));
    try {
      await waitFor(() => expect(startup.run).toHaveBeenCalledOnce());
      const signal = startup.run.mock.calls[0]![0];
      for (const text of ['first startup request', 'second startup request']) {
        await typeAndSubmit(context, text);
        await waitFor(() => expect(queuedFrame(context)).toContain(text));
      }
      expect(queuedFrame(context)).toContain('Queued messages: 2');
      expect(context.call).not.toHaveBeenCalled();

      if (interrupt) {
        context.app.stdin.write('\x1b[27u');
        await waitFor(() => {
          expect(signal.aborted).toBe(true);
          expect(queuedFrame(context)).toBeUndefined();
        });
        expect(context.app.lastFrame()).toContain('Working');
      } else expect(signal.aborted).toBe(false);
      expect(context.onExit).not.toHaveBeenCalled();
      recovery.resolve(['late recovery diagnostic']);
      await waitFor(() => {
        expect(context.call.mock.calls.map(([text]) => text)).toEqual(interrupt
          ? [] : ['first startup request', 'second startup request']);
        expect(queuedFrame(context)).toBeUndefined();
        expect(context.app.lastFrame()).not.toContain('Working');
      });
      if (interrupt) expect(context.app.lastFrame()).not.toContain('late recovery diagnostic');
      else expect(context.app.lastFrame()).toContain('late recovery diagnostic');
      expect(startup.fail).not.toHaveBeenCalled();
      expect(context.onExit).not.toHaveBeenCalled();

      if (interrupt) {
        await typeAndSubmit(context, 'fresh request');
        await waitFor(() => {
          expect(context.call.mock.calls.map(([text]) => text)).toEqual(['fresh request']);
          expect(context.app.lastFrame()).not.toContain('Working');
          expect(queuedFrame(context)).toBeUndefined();
        });
      }
    } finally {
      context.app.unmount();
      recovery.resolve([]);
      await context.session.close();
    }
  });

  it.each([false, true])('handles queued input and late startup rejection with Esc=%s', async (interrupt) => {
    const recovery = deferred<readonly string[]>();
    const failure = new Error('recovery failed');
    const startup = { run: vi.fn((_signal: AbortSignal) => recovery.promise), fail: vi.fn() };
    const context = mount('en', startup);
    try {
      await waitFor(() => expect(startup.run).toHaveBeenCalledOnce());
      const signal = startup.run.mock.calls[0]![0];
      await typeAndSubmit(context, 'queued before startup failure');
      await waitFor(() => expect(queuedFrame(context)).toContain('queued before startup failure'));
      expect(context.call).not.toHaveBeenCalled();

      if (interrupt) {
        context.app.stdin.write('\x1b[27u');
        await waitFor(() => {
          expect(signal.aborted).toBe(true);
          expect(queuedFrame(context)).toBeUndefined();
        });
        expect(context.app.lastFrame()).toContain('Working');
      } else expect(signal.aborted).toBe(false);
      expect(context.onExit).not.toHaveBeenCalled();
      recovery.reject(failure);
      await waitFor(() => expect(context.app.lastFrame()).not.toContain('Working'));

      if (interrupt) expect(startup.fail).not.toHaveBeenCalled();
      else expect(startup.fail).toHaveBeenCalledExactlyOnceWith(failure);
      expect(context.call).not.toHaveBeenCalled();
      expect(queuedFrame(context)).toBeUndefined();
      expect(context.onExit).not.toHaveBeenCalled();
    } finally {
      context.app.unmount();
      recovery.resolve([]);
      await context.session.close();
    }
  });

  it.each(['assignment', 'questions', 'goals'] as const)('preserves unchanged polling displays and updates changed %s in the same screen', async (field) => {
    let assignment = { kind: 'workspace' as const, workspaceId: '650e8400-e29b-41d4-a716-446655440002', name: 'Original workspace', repositoryDirectories: [cwd] };
    let snapshot = { events: [], diagnostics: [], notices: [], questions: [{ goalId: goalRecord().id, repositoryDirectory: cwd, objective: 'Question fixture', question: {
      id: '650e8400-e29b-41d4-a716-446655440001', recipient: 'human' as const,
      status: 'pending' as const, body: 'Original question',
    } }], goals: [{ id: goalRecord().id, objective: 'Original paused goal', status: 'created' as const, executionStatus: 'paused' as const }] };
    const readEvents = vi.spyOn(savedEvents, 'readManagerDisplayEvents').mockImplementation(async () => structuredClone(snapshot));
    const context = mount();
    vi.spyOn(context.session, 'getAssignment').mockImplementation(async () => structuredClone(assignment));
    try {
      await waitFor(() => {
        expect(context.app.lastFrame()!.split('\n')[0]).toMatch(/manager-repository/u);
        expect(context.app.lastFrame()).toMatch(/(?:pending|unanswered)\s*:?\s*1/iu);
        expect(context.app.lastFrame()).toMatch(/(?:in progress|ongoing|active)\s*:?\s*1/iu);
      });
      const beforePolls = readEvents.mock.calls.length;
      await waitFor(() => {
        expect(readEvents.mock.calls.length).toBeGreaterThanOrEqual(beforePolls + 2);
        expect(context.app.lastFrame()!.split('\n')[0]).toMatch(/manager-repository/u);
        expect(context.app.lastFrame()).toMatch(/(?:pending|unanswered)\s*:?\s*1/iu);
        expect(context.app.lastFrame()).toMatch(/(?:in progress|ongoing|active)\s*:?\s*1/iu);
      });

      if (field === 'assignment') assignment = { ...assignment, repositoryDirectories: [cwd, '/test/added-repository'] };
      else if (field === 'questions') snapshot = { ...snapshot, questions: [] };
      else snapshot = { ...snapshot, goals: [] };
      const changed = field === 'assignment' ? /manager-repository.*1/u : field === 'questions'
        ? /(?:pending|unanswered)\s*:?\s*0/iu : /(?:in progress|ongoing|active)\s*:?\s*0/iu;
      const original = field === 'assignment' ? /^.*manager-repository\s*$/mu : field === 'questions'
        ? /(?:pending|unanswered)\s*:?\s*1/iu : /(?:in progress|ongoing|active)\s*:?\s*1/iu;
      await waitFor(() => {
        expect(context.app.lastFrame()).toMatch(changed);
        expect(context.app.lastFrame()).not.toMatch(original);
      });
      const afterPolls = readEvents.mock.calls.length;
      await waitFor(() => {
        expect(readEvents.mock.calls.length).toBeGreaterThanOrEqual(afterPolls + 2);
        expect(context.app.lastFrame()).toMatch(changed);
        expect(context.app.lastFrame()).not.toMatch(original);
      });
      expect(context.call).not.toHaveBeenCalled();
    } finally { context.app.unmount(); await context.session.close(); }
  });

  it('shows consecutive refresh errors once and reports changes or failures after recovery', async () => {
    const readEvents = vi.spyOn(savedEvents, 'readManagerDisplayEvents').mockRejectedValue(new Error('refresh error A'));
    const context = mount();
    try {
      await waitFor(() => {
        expect(readEvents.mock.calls.length).toBeGreaterThanOrEqual(3);
        expect(context.app.lastFrame()?.match(/refresh error A/gu)).toHaveLength(1);
      });

      readEvents.mockRejectedValue(new Error('refresh error B'));
      const beforeChange = readEvents.mock.calls.length;
      await waitFor(() => {
        expect(readEvents.mock.calls.length).toBeGreaterThanOrEqual(beforeChange + 2);
        expect(context.app.lastFrame()?.match(/refresh error B/gu)).toHaveLength(1);
      });

      readEvents.mockResolvedValue({ events: [], diagnostics: [], notices: [], questions: [], goals: [] });
      const beforeRecovery = readEvents.mock.calls.length;
      await waitFor(() => expect(readEvents.mock.calls.length).toBeGreaterThan(beforeRecovery));
      readEvents.mockRejectedValue(new Error('refresh error A'));
      await waitFor(() => expect(context.app.lastFrame()?.match(/refresh error A/gu)).toHaveLength(2));
      expect(context.call).not.toHaveBeenCalled();
      expect(failureNotice).not.toHaveBeenCalled();
    } finally { context.app.unmount(); await context.session.close(); }
  });

  it('keeps displaying and reading workspace B after A is removed in the turn that adds B', async () => {
    const repositoryB = '/test/repository-b';
    const repository = { kind: 'repository' as const, repositoryDirectory: cwd, repositoryDirectories: [cwd] };
    const workspace = { id: '650e8400-e29b-41d4-a716-446655440001', name: 'A + B', repositoryDirectories: [cwd, repositoryB] };
    let savedWorkspace: workspaceRegistry.Workspace | undefined;
    vi.spyOn(workspaceRegistry, 'findWorkspaceForRepository').mockImplementation(async (_globalConfigDirectory, directory) =>
      savedWorkspace?.repositoryDirectories.includes(directory) ? savedWorkspace : undefined);
    vi.spyOn(workspaceRegistry, 'readWorkspace').mockImplementation(async (_globalConfigDirectory, id) =>
      savedWorkspace?.id === id ? savedWorkspace : undefined);
    const readEvents = vi.spyOn(savedEvents, 'readManagerDisplayEvents').mockResolvedValue({ events: [], diagnostics: [], notices: [], questions: [], goals: [] });
    const context = mount('en', undefined, repository);
    try {
      await waitFor(() => expect(readEvents.mock.calls.map((call) => call.slice(0, 3))).toContainEqual([cwd, 'en', repository]));
      context.call.mockImplementationOnce(async (_prompt, options) => {
        options.onStream?.({ type: 'tool_use', data: { id: 'add-b', tool: 'takt_add_workspace_repository', input: { repositoryDirectory: repositoryB } } });
        savedWorkspace = workspace;
        options.onStream?.({ type: 'tool_result', data: { id: 'add-b', isError: false, content: JSON.stringify({ workspace }) } });
        savedWorkspace = { ...workspace, repositoryDirectories: [repositoryB] };
        readEvents.mockClear();
        return response(null);
      });
      context.app.stdin.write('add B and remove A');
      await waitFor(() => expect(promptFrame(context)).toContain('add B and remove A'));
      context.app.stdin.write(ENTER);
      await waitFor(() => expect(context.app.lastFrame()).toMatch(/^[A-Za-z][^:\n]*: repository-b$/mu));
      expect(readEvents.mock.calls.map((call) => call.slice(0, 3))).toContainEqual([
        cwd, 'en', expect.objectContaining({ repositoryDirectories: [repositoryB] }),
      ]);
      expect(readEvents.mock.calls.every(([directory, language, assignment]) =>
        directory === cwd && language === 'en' && assignment?.repositoryDirectories.length === 1
        && assignment.repositoryDirectories[0] === repositoryB)).toBe(true);
      expect(await context.session.getAssignment()).toMatchObject({ kind: 'workspace', workspaceId: workspace.id, repositoryDirectories: [repositoryB] });
    } finally { context.app.unmount(); await context.session.close(); }
  });

  describe.each([
    { lang: 'ja' as const, changes: /manager は実験的機能.*動作・設定・保存するデータの形式.*予告なく/u },
    { lang: 'en' as const, changes: /manager is experimental.*behavior, settings, and saved data formats.*without notice/iu },
  ])('experimental notices in $lang', ({ lang, changes }) => {
    function expectNotices(frame: string | undefined, summary = false): void {
      const text = frame?.replace(/\s+/gu, ' ');
      expect(text).toMatch(changes);
      const hint = summary ? (lang === 'ja' ? 'Enter 決定' : 'Enter Confirm') : (lang === 'ja' ? 'Enter 送信' : 'Enter Send');
      expect(text).toContain(hint);
      expect(text!.search(changes)).toBeLessThan(text!.lastIndexOf(hint));
      const rows = frame!.split('\n');
      const promptEnd = rows.map((row) => row.startsWith('╰')).lastIndexOf(true);
      expect(rows.slice(promptEnd + 1).join(' ')).toContain(hint);
    }

    it('shows the experimental notice on every startup without calling the provider', async () => {
      for (let startup = 0; startup < 2; startup++) {
        const context = mount(lang);
        await waitFor(() => expectNotices(context.app.lastFrame()));
        expect(context.call).not.toHaveBeenCalled();
        expect(context.register).not.toHaveBeenCalled();
        context.app.unmount();
        await context.session.close();
      }
    });

    it('displays the experimental notice and waits for stdout before running startup recovery and automatic execution', async () => {
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
      try {
        await waitFor(() => {
          expectNotices(context.app.lastFrame());
          expect(startupDoubles.flush).toHaveBeenCalledTimes(1);
        });
        expect(startup.run).not.toHaveBeenCalled();
        context.app.stdin.write('startup draft');
        await waitFor(() => expect(promptFrame(context)).toContain('startup draft'));
        expect(context.call).not.toHaveBeenCalled();

        finishFlush();
        await waitFor(() => {
          expect(context.app.lastFrame()).toContain('startup diagnostic');
          expect(context.app.lastFrame()).not.toContain(lang === 'ja' ? '処理中' : 'Working');
          expect(promptFrame(context)).toContain('startup draft');
        });
        expect(startup.run).toHaveBeenCalledTimes(1);
        expect(startup.fail).not.toHaveBeenCalled();
        expect(context.call).not.toHaveBeenCalled();
        expect(promptFrame(context)).toContain('startup draft');
        context.app.stdin.write(ENTER);
        await waitFor(() => expect(context.session.getPendingSummary()?.summary).toEqual(summaryA));
        expect(context.call).toHaveBeenCalledExactlyOnceWith('startup draft', expect.any(Object));
        expectNotices(context.app.lastFrame(), true);
        expect(startup.run).toHaveBeenCalledTimes(1);
      } finally {
        context.app.unmount();
        finishFlush();
        await context.session.close();
      }
    });

    it.each(['flush', 'startup'] as const)('reports a %s failure to the mount', async (source) => {
      const failure = new Error(`${source} failed`);
      const startup = { run: vi.fn(async () => [] as string[]), fail: vi.fn() };
      if (source === 'flush') startupDoubles.flush.mockRejectedValueOnce(failure);
      else startup.run.mockRejectedValueOnce(failure);
      const context = mount(lang, startup);

      await waitFor(() => expect(startup.fail).toHaveBeenCalledExactlyOnceWith(failure));
      expect(startup.run).toHaveBeenCalledTimes(source === 'flush' ? 0 : 1);
      expect(context.call).not.toHaveBeenCalled();
      await context.session.close();
    });

    it('accepts Ctrl+C while stdout is flushing and skips recovery', async () => {
      let finishFlush!: () => void;
      startupDoubles.flush.mockReturnValueOnce(new Promise<void>((resolve) => { finishFlush = resolve; }));
      const startup = { run: vi.fn(async (_signal: AbortSignal) => [] as string[]), fail: vi.fn() };
      const context = mount(lang, startup);
      await waitFor(() => expect(startupDoubles.flush).toHaveBeenCalledTimes(1));

      context.app.stdin.write('ignored');
      context.app.stdin.write(ENTER);
      context.app.stdin.write('\x03');
      await waitFor(() => expect(context.onExit).toHaveBeenCalledTimes(1));
      finishFlush();
      await startupDoubles.flush.mock.results[0]!.value;

      expect(startup.run).not.toHaveBeenCalled();
      expect(startup.fail).not.toHaveBeenCalled();
      expect(context.call).not.toHaveBeenCalled();
      await context.session.close();
    });

    it.each([false, true])('aborts recovery on Ctrl+C without submitting further input when recovery rejects=%s', async (rejects) => {
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
      await waitFor(() => expect(startup.run).toHaveBeenCalledTimes(1));
      const signal = startup.run.mock.calls[0]![0];

      context.app.stdin.write('ignored');
      context.app.stdin.write(ENTER);
      const beforeExit = promptFrame(context);
      context.app.stdin.write('\x03');
      await waitFor(() => {
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
      expect(promptFrame(context)).toBe(beforeExit);
      expect(context.call).not.toHaveBeenCalled();
      await context.session.close();
    });

    it('does not start recovery when the TUI unmounts before stdout is flushed', async () => {
      let finishFlush!: () => void;
      startupDoubles.flush.mockReturnValueOnce(new Promise<void>((resolve) => { finishFlush = resolve; }));
      const startup = { run: vi.fn(async () => [] as string[]), fail: vi.fn() };
      const context = mount(lang, startup);
      await waitFor(() => expect(startupDoubles.flush).toHaveBeenCalledTimes(1));
      context.app.unmount();

      finishFlush();
      await startupDoubles.flush.mock.results[0]!.value;
      expect(startup.run).not.toHaveBeenCalled();
      expect(startup.fail).not.toHaveBeenCalled();
      await context.session.close();
    });

    it('keeps the experimental notice above the input after a conversation redraw and a summary', async () => {
      const context = mount(lang);
      await waitFor(() => expectNotices(context.app.lastFrame()));
      await send(context, 'CSV出力を追加したい', summaryA);
      expectNotices(context.app.lastFrame(), true);
    });

    it.each([40, 80])('wraps the experimental notice within a %i-column terminal', async (columns) => {
      const context = mount(lang);
      vi.spyOn(context.app.stdout, 'columns', 'get').mockReturnValue(columns);
      context.app.rerender(createElement(ManagerView, {
        cwd, lang, session: context.session, initialDiagnostics: [], onExit: vi.fn(),
      }));

      await waitFor(() => {
        const frame = context.app.lastFrame()!;
        const text = frame.replace(/\s+/gu, '');
        const notice = getLabel('manager.experimentalNotice', lang).replace(/\s+/gu, '');
        const start = text.indexOf(notice.slice(0, 12));
        expect(start).toBeGreaterThanOrEqual(0);
        const visibleNotice = text.slice(start, start + notice.length);
        expect(visibleNotice).toBe(notice);
        expect(visibleNotice).not.toContain('…');
        for (const line of frame.split('\n')) expect(stringWidth(line)).toBeLessThanOrEqual(columns);
      });
      expect(context.call).not.toHaveBeenCalled();
    });
  });

});
it('displays run manager work records without processing inbox events and informs the next human turn', async () => {
  const readEvents = vi.spyOn(savedEvents, 'readManagerDisplayEvents');
  const context = mount('ja');
  context.call.mockResolvedValue(response(null));
  try {
    await waitFor(() => expect(readEvents).toHaveBeenCalled());
    await readEvents.mock.results[0]!.value;
    await waitFor(() => expect(context.app.lastFrame()).not.toContain('処理中'));
    inbox.read.mockReturnValue([{ filePath: '/inbox/1.json', event: { kind: 'registered', goalId: goalRecord().id, createdAt: '2026-10-14T00:00:00Z' } }]);
    const record = { id: '550e8400-e29b-41d4-a716-446655440005', recordedAt: new Date().toISOString(), summary: 'task-X を取り込み、task-Y を投入しました' };
    memory.goals.mockReturnValue([{ ...goalRecord(), workLog: [record] }]);
    await waitFor(() => expect(context.app.lastFrame()).toContain(record.summary));
    expect(context.call).not.toHaveBeenCalled();
    expect(inbox.read).not.toHaveBeenCalled();
    expect(inbox.remove).not.toHaveBeenCalled();
    context.app.stdin.write('進捗を教えてください');
    await waitFor(() => expect(promptFrame(context)).toContain('進捗を教えてください'));
    context.app.stdin.write(ENTER);
    await waitFor(() => expect(context.call).toHaveBeenCalledOnce());
    expect(context.call.mock.calls[0]![0]).toContain(record.summary);
  } finally { context.app.unmount(); await context.session.close(); }
});

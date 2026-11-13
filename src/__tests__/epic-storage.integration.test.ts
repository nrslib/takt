import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EpicStore } from '../infra/epics/store.js';
import { listEpics } from '../infra/epics/index.js';
import { applyEpicVerificationResult, beginEpicVerification, epicVerificationRecovery, epicView, finishEpic } from '../infra/epics/state.js';
import { DaemonEpicFiles } from '../infra/daemon/epicFiles.js';
import { epicEvents } from '../features/daemon/epicEvents.js';
import { createWorkspace } from '../infra/config/global/workspaceRegistry.js';
import { DaemonConversations } from '../features/daemon/conversationState.js';
import { DaemonRouting } from '../features/daemon/routing.js';
import { ConversationStateStore } from '../infra/daemon/conversationStateStore.js';
import { DaemonNotifications } from '../infra/daemon/notifications.js';
import { createDaemonStateRequests } from '../features/daemon/stateRequests.js';
import { conversationId } from '../infra/conversations/identity.js';
import { FileEventStore } from '../infra/daemon/eventStore.js';
import { createDaemonDispatcher } from '../features/daemon/dispatcher.js';
import { ControlledTurnRunner, accepted } from './helpers/controlledDaemon.js';
import type { DaemonIngress } from '../core/daemon/ports.js';
import {
  epicId, epicRecord, epicVerificationResult, epicWorkspaceId, secondGoalId,
  verificationResultFor, verificationRunId, verificationStartedAt,
} from './helpers/epic-fixtures.js';

function completedRecord(requiresApply: boolean | undefined) {
  const record = epicRecord();
  const targets = epicVerificationResult().targets;
  const started = beginEpicVerification({
    ...record, targets, members: targets.map(({ repositoryDirectory, goalId }) => ({ repositoryDirectory, goalId })),
    verificationProcedure: { ...record.verificationProcedure,
      ...(requiresApply === undefined ? {} : { terraform: { requiresApply } }),
    },
  }, verificationRunId, verificationStartedAt);
  const terraform = requiresApply === true
    ? { phase: 'post_apply' as const, applyStatus: 'applied' as const, artifactReferences: ['artifact://terraform/state'] }
    : { phase: 'plan' as const, applyStatus: 'not_applied' as const, artifactReferences: ['artifact://terraform/plan'] };
  return finishEpic(applyEpicVerificationResult(started.epic, {
    ...verificationResultFor(started.run), ...(requiresApply === undefined ? {} : { terraform }),
  }));
}

describe('workspace Epic storage', () => {
  let configDirectory: string;
  let filePath: string;

  beforeEach(() => {
    const assignedDirectory = process.env.TAKT_CONFIG_DIR;
    if (assignedDirectory === undefined) throw new Error('Isolated test configuration is required');
    configDirectory = assignedDirectory;
    filePath = join(configDirectory, 'workspaces', epicWorkspaceId, 'epics', epicId, 'epic.json');
  });

  it('returns globally ordered pages with exact totals and validates records outside the page', async () => {
    const owner = { globalConfigDirectory: configDirectory, workspaceId: epicWorkspaceId };
    const records = [epicId, secondGoalId, verificationRunId].sort((a, b) => a.localeCompare(b))
      .map((id, index) => ({ ...epicRecord(), id, objective: `Epic ${index}` }));
    const store = new EpicStore(configDirectory, epicWorkspaceId);
    for (const record of records) await store.create(record);
    expect(await listEpics(owner)).toEqual(records);
    expect(await listEpics(owner, { offset: 0, limit: 1 })).toEqual({ epics: [records[0]], totalCount: 3, offset: 0 });
    expect(await listEpics(owner, { offset: 1, limit: 1 })).toEqual({ epics: [records[1]], totalCount: 3, offset: 1 });
    expect(await listEpics(owner, { offset: 4, limit: 1 })).toEqual({ epics: [], totalCount: 3, offset: 4 });
    const outside = join(configDirectory, 'workspaces', epicWorkspaceId, 'epics', records[2]!.id, 'epic.json');
    for (const content of ['{', JSON.stringify({ ...records[2], workspaceId: secondGoalId })]) {
      writeFileSync(outside, content);
      await expect(listEpics(owner, { offset: 0, limit: 1 })).rejects.toBeInstanceOf(AggregateError);
    }
  });

  it('creates, reloads and lists the same workspace-owned record', async () => {
    const record = epicRecord();
    await new EpicStore(configDirectory, epicWorkspaceId).create(record);
    const restored = new EpicStore(configDirectory, epicWorkspaceId);
    expect(await restored.get(record.id)).toEqual(record);
    expect(await restored.list()).toEqual({ epics: [record], totalCount: 1, errors: [] });
    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual(record);
  });

  it.each(['running', 'completed'] as const)('restores %s verification and event identity from Epic histories larger than 16 MiB', async (status) => {
    const workspace = await createWorkspace({ globalConfigDirectory: configDirectory, name: 'Verification recovery', repositoryDirectories: [] });
    const completed = completedRecord(undefined);
    const state = status === 'running'
      ? beginEpicVerification({ ...completed, status: 'active' }, secondGoalId, verificationStartedAt).epic
      : completed;
    const record = { ...state, workspaceId: workspace.id, changes: state.changes.map((change, index) => index === 0
      ? { ...change, reason: 'x'.repeat(16 * 1024 * 1024) } : change) };
    const store = new EpicStore(configDirectory, workspace.id);
    await store.create(record);
    const path = join(configDirectory, 'workspaces', workspace.id, 'epics', epicId, 'epic.json');
    expect(statSync(path).size).toBeGreaterThan(16 * 1024 * 1024);
    const files = new DaemonEpicFiles(configDirectory);
    const restored = await files.get(workspace.id, epicId);
    expect(restored).toEqual(epicView(await store.get(epicId)));
    expect(epicVerificationRecovery(restored)).toEqual(status === 'running' ? [state.verificationRuns.at(-1)] : []);
    expect(epicEvents(restored)).toEqual(epicEvents(record));
    if (status === 'completed') expect(epicEvents(restored).map(({ event }) => event.kind))
      .toEqual(['epic_verification_result', 'epic_completed']);
    const listed = [];
    for await (const epic of files.list(workspace.id)) listed.push(epic);
    expect(listed).toEqual([restored]);
    const errors = vi.fn();
    const notifications = new DaemonNotifications(configDirectory);
    const conversations = new DaemonConversations(new ConversationStateStore(configDirectory), new DaemonRouting(configDirectory),
      notifications, async () => {}, errors);
    const owner = { kind: 'workspace' as const, workspaceId: workspace.id };
    const turn = { conversationId: conversationId(owner), operationId: verificationRunId, generation: 1 };
    const accept = vi.fn<DaemonIngress['accept']>(async (event) => ({ kind: 'accepted', eventId: event.eventId,
      operationId: event.eventId, acceptedSequence: 1 }));
    try {
      await conversations.ensure(owner);
      const requests = createDaemonStateRequests({ conversations, ingress: { accept }, connectedPorts: () => [] });
      expect(await requests.handle(turn, { kind: 'publish_epic_events', workspaceId: workspace.id, epicId,
        reason: 'Publish saved verification' }, new AbortController().signal)).toEqual({ kind: 'epic_events_published' });
      const expectedEvents = epicEvents(record);
      const events = accept.mock.calls.map(([event]) => event);
      expect(events.map((event) => event.eventId)).toEqual(expectedEvents.map((event) => event.eventId));
      const notificationError = new Error('Notification storage unavailable');
      vi.spyOn(notifications, 'save').mockRejectedValueOnce(notificationError);
      const send = vi.spyOn(conversations, 'send');
      for (const [index, event] of events.entries()) {
        const result = { ...turn, event: { ...event, operationId: turn.operationId, acceptedSequence: 1, lane: 'other' as const },
          outcome: { kind: 'completed' as const, result: { kind: 'notice' as const, message: '' } } };
        if (index === 0) {
          await expect(conversations.apply(result)).rejects.toBe(notificationError);
          expect(send).not.toHaveBeenCalled();
        }
        await conversations.apply(result);
        await conversations.apply(result);
      }
      expect(errors).not.toHaveBeenCalled();
      expect(send.mock.calls.slice(0, 2).map(([, output]) => output.kind)).toEqual(['pending', 'result']);
      const saved = [];
      for await (const notice of notifications.iterate()) saved.push(notice);
      expect(saved.map(({ id }) => id).sort()).toEqual(events.map(({ eventId }) => eventId).sort());
      expect(saved.every((notice) => notice.conversationId === turn.conversationId)).toBe(true);
    } finally { await conversations.close(); }
    expect(await store.get(epicId)).toEqual(record);
  });

  it.each([
    ['epic_verification_result', false], ['epic_completed', false],
    ['epic_verification_result', true], ['epic_completed', true],
  ] as const)('recovers failed %s notification storage with restart=%s without executing the turn again', async (kind, restart) => {
    const workspace = await createWorkspace({ globalConfigDirectory: configDirectory, name: 'Notification recovery', repositoryDirectories: [] });
    const record = { ...completedRecord(undefined), workspaceId: workspace.id };
    const epics = new EpicStore(configDirectory, workspace.id);
    await epics.create(record);
    const owner = { kind: 'workspace' as const, workspaceId: workspace.id };
    const id = conversationId(owner);
    const event = epicEvents(record).find(({ event }) => event.kind === kind)!;
    const create = async () => {
      const notifications = new DaemonNotifications(configDirectory);
      const conversations = new DaemonConversations(new ConversationStateStore(configDirectory), new DaemonRouting(configDirectory),
        notifications, async () => {}, vi.fn());
      await conversations.ensure(owner);
      const store = new FileEventStore(configDirectory);
      const runner = new ControlledTurnRunner();
      const failures = vi.fn();
      const dispatcher = await createDaemonDispatcher({ store, conversations, runner,
        stateRequests: createDaemonStateRequests({ conversations, ingress: { accept: (event) => dispatcher.accept(event) }, connectedPorts: () => [] }),
        resources: { close: () => conversations.close() }, limits: { maxPendingEvents: 32, maxPendingBytes: 1024 * 1024 }, onFailure: failures });
      runner.bus = dispatcher;
      return { dispatcher, store, runner, failures, notifications };
    };
    let context = await create();
    try {
      const failure = new Error('Notification storage unavailable');
      vi.spyOn(context.notifications, 'save').mockRejectedValueOnce(failure);
      const admission = await context.dispatcher.accept(event);
      accepted(admission);
      const call = await context.runner.started(1);
      await context.runner.finish(call, { kind: 'completed', result: { kind: 'notice', message: '' } });
      await context.dispatcher.drain();
      expect(context.failures).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ phase: 'settle', error: failure }));
      expect(context.runner.committed).toEqual([]);
      const pending = [];
      for await (const stored of (await context.store.restore()).pending) pending.push(stored);
      expect(pending).toEqual([expect.objectContaining({ state: 'settling', event: call.input.event })]);
      const unsaved = [];
      for await (const notice of context.notifications.iterate()) unsaved.push(notice);
      expect(unsaved).toEqual([]);
      if (restart) {
        await expect(context.dispatcher.control({ kind: 'stop' })).rejects.toBeInstanceOf(AggregateError);
        context = await create();
        await context.dispatcher.drain();
      } else await context.dispatcher.retryStorage();
      expect(context.runner.calls).toHaveLength(restart ? 0 : 1);
      expect(context.runner.committed).toEqual([expect.objectContaining(call.turn)]);
      const settled = await context.store.accept(call.input.event);
      expect(settled).toMatchObject({ kind: 'duplicate', state: 'settled' });
      expect(await context.dispatcher.accept(event)).toEqual(admission);
      await context.dispatcher.drain();
      expect(context.runner.calls).toHaveLength(restart ? 0 : 1);
      const saved = [];
      for await (const notice of context.notifications.iterate()) saved.push(notice);
      expect(saved).toEqual([{ id: event.eventId, conversationId: id, message: expect.stringContaining(kind === 'epic_completed' ? 'completed' : 'verification succeeded') }]);
      const snapshot = await context.dispatcher.snapshot(id);
      const displayed = [];
      try {
        for await (const item of snapshot.items) if (item.kind === 'display_event') displayed.push(item.event);
      } finally { snapshot.complete(); }
      expect(displayed).toEqual(saved.map(({ id, message }) => ({ id, message })));
      expect(await epics.get(epicId)).toEqual(record);
    } finally { await context.dispatcher.control({ kind: 'stop' }); }
  });

  it('keeps records from different workspaces separate', async () => {
    const first = epicRecord();
    const second = { ...first, workspaceId: '750e8400-e29b-41d4-a716-446655440000', objective: '別担当の目的' };
    await new EpicStore(configDirectory, first.workspaceId).create(first);
    await new EpicStore(configDirectory, second.workspaceId).create(second);
    expect(await new EpicStore(configDirectory, first.workspaceId).get(epicId)).toEqual(first);
    expect(await new EpicStore(configDirectory, second.workspaceId).get(epicId)).toEqual(second);
  });

  it('rejects duplicate creation without overwriting the previous definition or history', async () => {
    const store = new EpicStore(configDirectory, epicWorkspaceId);
    const original = epicRecord();
    await store.create(original);
    const before = readFileSync(filePath);
    await expect(store.create({ ...original, objective: '上書きされてはいけない目的' })).rejects.toThrow();
    expect(readFileSync(filePath)).toEqual(before);
    expect(await store.get(epicId)).toEqual(original);
  });

  it('rejects a record whose workspace differs from the store owner', async () => {
    const store = new EpicStore(configDirectory, epicWorkspaceId);
    await expect(store.create({ ...epicRecord(), workspaceId: '750e8400-e29b-41d4-a716-446655440000' })).rejects.toThrow();
    expect(await store.list()).toEqual({ epics: [], totalCount: 0, errors: [] });
  });

  it('rejects persisted completion without verification evidence instead of trusting a status field', async () => {
    const store = new EpicStore(configDirectory, epicWorkspaceId);
    await store.create(epicRecord());
    const corrupted = JSON.stringify({ ...epicRecord(), status: 'completed' });
    writeFileSync(filePath, corrupted);
    await expect(store.get(epicId)).rejects.toThrow();
    expect((await store.list()).errors).toHaveLength(1);
    expect(readFileSync(filePath, 'utf8')).toBe(corrupted);
  });

  it.each([
    { requiresApply: true, status: 'active' as const },
    { requiresApply: true, status: 'completed' as const },
    { requiresApply: false, status: 'active' as const },
    { requiresApply: false, status: 'completed' as const },
  ])('rejects missing Terraform records at create, save and restore with requiresApply=$requiresApply status=$status', async ({ requiresApply, status }) => {
    const original = { ...completedRecord(requiresApply), status };
    const store = new EpicStore(configDirectory, epicWorkspaceId);
    await store.create(original);
    expect(await store.get(epicId)).toEqual(original);
    const before = readFileSync(filePath);
    const invalid = { ...original, verificationRuns: original.verificationRuns.map((run) => ({
      ...run, result: { ...run.result!, terraform: undefined },
    })) };
    const newPath = join(configDirectory, 'workspaces', epicWorkspaceId, 'epics', secondGoalId, 'epic.json');
    expect(existsSync(newPath)).toBe(false);
    await expect(store.create({ ...invalid, id: secondGoalId })).rejects.toThrow();
    expect(existsSync(newPath)).toBe(false);
    expect(() => store.save(invalid)).toThrow();
    expect(readFileSync(filePath)).toEqual(before);
    expect(await store.get(epicId)).toEqual(original);
    expect(await store.list()).toEqual({ epics: [original], totalCount: 1, errors: [] });

    const corrupted = JSON.stringify(invalid);
    writeFileSync(filePath, corrupted);
    await expect(new EpicStore(configDirectory, epicWorkspaceId).get(epicId)).rejects.toThrow();
    const listed = await store.list();
    expect(listed.epics).toEqual([]);
    expect(listed.errors).toHaveLength(1);
    expect(readFileSync(filePath, 'utf8')).toBe(corrupted);
    writeFileSync(filePath, before);
    expect(await store.get(epicId)).toEqual(original);
  });

  it('roundtrips non-Terraform completion without a Terraform result', async () => {
    const record = completedRecord(undefined);
    const store = new EpicStore(configDirectory, epicWorkspaceId);
    await store.create(record);
    expect(store.save(record)).toEqual(record);
    expect(await new EpicStore(configDirectory, epicWorkspaceId).get(epicId)).toEqual(record);
    expect(await store.list()).toEqual({ epics: [record], totalCount: 1, errors: [] });
  });

  it.each([
    { content: '{' },
    { content: 'null' },
    { content: JSON.stringify({ ...epicRecord(), id: '750e8400-e29b-41d4-a716-446655440000' }) },
    { content: JSON.stringify({ ...epicRecord(), workspaceId: '750e8400-e29b-41d4-a716-446655440000' }) },
  ])('reports corrupt or misplaced persisted state without silently losing history %#', async ({ content }) => {
    const store = new EpicStore(configDirectory, epicWorkspaceId);
    await store.create(epicRecord());
    writeFileSync(filePath, content);
    await expect(store.get(epicId)).rejects.toThrow();
    const listed = await store.list();
    expect(listed.epics).toEqual([]);
    expect(listed.errors).toHaveLength(1);
    expect(readFileSync(filePath, 'utf8')).toBe(content);
  });
});

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createDaemonStateRequests } from '../features/daemon/stateRequests.js';
import { DaemonConversations } from '../features/daemon/conversationState.js';
import { DaemonRouting } from '../features/daemon/routing.js';
import { ConversationStateStore } from '../infra/daemon/conversationStateStore.js';
import { DaemonNotifications } from '../infra/daemon/notifications.js';
import type { DaemonIngress } from '../core/daemon/ports.js';
import { conversationRecord, directorConversationRecord } from './helpers/conversation-fixtures.js';
import { deferred, turnStart } from './helpers/daemon-turn.js';

const doubles = vi.hoisted(() => ({ add: vi.fn(), fire: vi.fn(), isFired: vi.fn() }));
vi.mock('../features/director/managerLifecycle.js', () => ({ addDirectorManager: doubles.add, fireDirectorManager: doubles.fire }));
vi.mock('../infra/director/managerState.js', () => ({ DirectorManagerStateStore: class { isFired = doubles.isFired; } }));
beforeEach(() => { vi.resetAllMocks(); doubles.isFired.mockResolvedValue(false); });
afterEach(() => vi.restoreAllMocks());

function fixture() {
  const director = directorConversationRecord();
  const manager = conversationRecord('/repo');
  const store = new ConversationStateStore('/config');
  vi.spyOn(store, 'read').mockImplementation(async (id) => {
    const record = id === director.id ? director : id === manager.id ? manager : undefined;
    return record === undefined ? undefined : { record, state: { ...turnStart().state, assignment: record.assignment } };
  });
  const routing = new DaemonRouting('/config');
  vi.spyOn(routing, 'permits').mockResolvedValue(true);
  const conversations = new DaemonConversations(store, routing, new DaemonNotifications('/config'),
    async () => {}, (error) => { throw error; }, { readTurns: async () => [] });
  const accept = vi.fn<DaemonIngress['accept']>(async (event) => ({ kind: 'accepted', eventId: event.eventId, operationId: 'message', acceptedSequence: 1 }));
  const owner = createDaemonStateRequests({ conversations, ingress: { accept }, connectedPorts: () => [] });
  const turn = { ...turnStart().turn, conversationId: director.id };
  const signal = new AbortController().signal;
  return { owner, turn, signal, accept, routing, managerId: manager.id };
}

it('orders delivery and message admission after an in-flight fire and rejects both afterward', async () => {
  const f = fixture();
  const started = deferred<void>();
  const release = deferred<void>();
  doubles.fire.mockImplementation(async () => {
    started.resolve();
    await release.promise;
    doubles.isFired.mockResolvedValue(true);
    return { managerId: f.managerId };
  });
  const fire = f.owner.handle(f.turn, { kind: 'fire_director_manager', managerId: f.managerId }, f.signal);
  await started.promise;
  const delivery = f.owner.handle(f.turn, { kind: 'get_delivery', conversationId: f.managerId }, f.signal);
  const message = f.owner.handle(f.turn, { kind: 'accept_director_message', conversationId: f.managerId,
    eventId: 'late', requestId: 'late', occurredAt: '2026-11-18T00:00:00.000Z', text: 'late', origin: 'human' }, f.signal);
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(doubles.isFired).not.toHaveBeenCalled();
    expect(f.accept).not.toHaveBeenCalled();
  } finally { release.resolve(); }
  await expect(fire).resolves.toMatchObject({ kind: 'director_manager_fired' });
  expect(doubles.fire).toHaveBeenCalledWith(f.routing, f.managerId, f.signal);
  await expect(delivery).resolves.toMatchObject({ kind: 'error', code: 'forbidden' });
  await expect(message).resolves.toMatchObject({ kind: 'error', code: 'forbidden' });
  expect(f.accept).not.toHaveBeenCalled();
});

it('preserves the lifecycle refusal reason and allows a later operation after failure', async () => {
  const f = fixture();
  doubles.fire.mockRejectedValueOnce(new Error('unfinished goal'));
  await expect(f.owner.handle(f.turn, { kind: 'fire_director_manager', managerId: f.managerId }, f.signal))
    .resolves.toMatchObject({ kind: 'error', message: 'unfinished goal' });
  await expect(f.owner.handle(f.turn, { kind: 'get_delivery', conversationId: f.managerId }, f.signal))
    .resolves.toMatchObject({ kind: 'delivery', conversationId: f.managerId });
});

it('rechecks cancellation when a queued lifecycle request starts', async () => {
  const f = fixture();
  const started = deferred<void>();
  const release = deferred<void>();
  doubles.fire.mockImplementation(async () => { started.resolve(); await release.promise; return { managerId: f.managerId }; });
  const fire = f.owner.handle(f.turn, { kind: 'fire_director_manager', managerId: f.managerId }, f.signal);
  await started.promise;
  const controller = new AbortController();
  const reason = new Error('interrupted');
  const pending = expect(f.owner.handle(f.turn, { kind: 'add_director_manager', repositoryDirectory: '/repo' }, controller.signal)).rejects.toBe(reason);
  controller.abort(reason);
  release.resolve();
  await fire;
  await pending;
  expect(doubles.add).not.toHaveBeenCalled();
});

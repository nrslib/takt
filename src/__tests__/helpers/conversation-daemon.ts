import type { DaemonBus, TurnRunner } from '../../core/daemon/ports.js';
import type { ConversationRuntime } from '../../features/manager/conversationRuntime.js';
import type { ConversationAssignment } from '../../infra/conversations/schema.js';
import { createConversationTurnService } from '../../features/manager/conversationService.js';
import { createDaemonConversationInput } from '../../features/manager/daemonConversationPort.js';
import { DaemonConversations } from '../../features/daemon/conversationState.js';
import { DaemonRouting } from '../../features/daemon/routing.js';
import { createDaemonStateRequests } from '../../features/daemon/stateRequests.js';
import { DaemonDispatcher } from '../../features/daemon/dispatcher.js';
import { FileEventStore } from '../../infra/daemon/eventStore.js';
import { ConversationStateStore } from '../../infra/daemon/conversationStateStore.js';
import { DaemonNotifications } from '../../infra/daemon/notifications.js';
import { resolveCurrentManagerAssignment } from '../../features/manager/assignment.js';

/** 実プロセス境界を使わない UI/保存試験用。業務、保存、受付、配送は本実装を使う。 */
export async function conversationDaemon(directory: string, runtime: ConversationRuntime) {
  class TestRouting extends DaemonRouting {
    override async resolve(selected: ConversationAssignment): Promise<ConversationAssignment> {
      if (selected.kind === 'daemon') return selected;
      const resolved = await resolveCurrentManagerAssignment(selected, directory);
      return resolved.kind === 'repository' ? { kind: 'repository', repositoryDirectory: resolved.repositoryDirectory }
        : { kind: 'workspace', workspaceId: resolved.workspaceId };
    }
    override async display(assignment: ConversationAssignment) {
      return assignment.kind === 'daemon' ? { kind: 'daemon' as const, repositoryDirectories: [] }
        : resolveCurrentManagerAssignment(assignment, directory);
    }
  }
  const routing = new TestRouting(directory);
  const store = new ConversationStateStore(directory);
  const events = new FileEventStore(directory);
  const failures: unknown[] = [];
  const onError = (error: unknown): void => { failures.push(error); };
  const conversations = new DaemonConversations(store, routing, new DaemonNotifications(directory),
    (id, output, version) => input.deliver(id, output, version), onError);
  let executions = 0;
  const executionWaiters = new Map<number, Array<() => void>>();
  const business = createConversationTurnService(directory, { ...runtime, async resolve(...args) {
    const resolved = await runtime.resolve(...args);
    return { ...resolved, executor: { execute(input) {
      const result = resolved.executor.execute(input);
      executions++;
      for (const [count, waiters] of executionWaiters) {
        if (count > executions) continue;
        executionWaiters.delete(count);
        for (const resolve of waiters) resolve();
      }
      return result;
    } } };
  } });
  const pending = new Set<Promise<void>>();
  const bus: DaemonBus = { post: (message) => dispatcher.post(message), request: (turn, request, signal) => dispatcher.request(turn, request, signal) };
  const runner: TurnRunner = {
    start(value, signal) {
      conversations.started(value);
      const execute = business.execute(value, { signal, request: (request) => bus.request(value.turn, request, signal),
        progress(message) { void bus.post({ kind: 'turn_progress', turn: value.turn, message }).catch(onError); } });
      const operation = execute.catch((error: unknown) => signal.aborted ? { kind: 'interrupted' as const }
        : { kind: 'failed' as const, message: error instanceof Error ? error.message : String(error) })
        .then((outcome) => bus.post({ kind: 'turn_finished', turn: value.turn, outcome }));
      pending.add(operation);
      void operation.then(() => { pending.delete(operation); }, (error: unknown) => { pending.delete(operation); onError(error); });
    },
    interrupt() {}, resultCommitted() {},
    async close() { await Promise.all([...pending]); await runtime.close(); },
  };
  const dispatcher: DaemonDispatcher = new DaemonDispatcher({ store: events, conversations, runner,
    stateRequests: createDaemonStateRequests({ conversations, ingress: { accept: (event) => dispatcher.accept(event) }, connectedPorts: (id) => input.connectedPorts(id) }),
    resources: { close: () => conversations.close() }, limits: { maxPendingEvents: 32, maxPendingBytes: 1024 * 1024 },
    onFailure: ({ error }) => onError(error) });
  const input = createDaemonConversationInput({ ingress: dispatcher, async resolveAssignment(selected) {
    const assignment = await routing.resolve(selected);
    await conversations.ensure(assignment); return assignment;
  } });
  const restored = await events.restore();
  await dispatcher.restore(restored.lastAcceptedSequence, restored.pending);
  async function settled(): Promise<void> {
    do {
      await dispatcher.drain();
      await Promise.all([...pending]);
      if (failures.length > 0) throw new AggregateError(failures, 'Conversation fixture failed');
    } while (dispatcher.activeTurnCount > 0);
  }
  const executing = (count: number): Promise<void> => executions >= count ? Promise.resolve() : new Promise((resolve) => {
    const waiters = executionWaiters.get(count) ?? [];
    waiters.push(resolve); executionWaiters.set(count, waiters);
  });
  return { settled, executing, get activeOperationCount() { return dispatcher.activeTurnCount; }, input, dispatcher, conversations, store, events, failures, async close() { await dispatcher.control({ kind: 'stop' }); input.close(); } };
}

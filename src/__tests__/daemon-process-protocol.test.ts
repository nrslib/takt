import { describe, expect, it } from 'vitest';
import {
  TURN_PROTOCOL_VERSION, MAX_PROCESS_MESSAGE_BYTES, MAX_PROCESS_PENDING_REQUESTS,
  MAX_PROCESS_PENDING_BYTES, MAX_PROCESS_PROGRESS_BYTES, MAX_PROCESS_DELIVERY_PORTS,
  parseDaemonProcessMessage, parseTurnProcessMessage, processRequestBytes,
  type DaemonProcessMessage, type TurnProcessMessage,
} from '../core/daemon/processProtocol.js';
import { input, turnState } from './helpers/controlledDaemon.js';
import { StoredResultSchema } from '../infra/daemon/eventRecord.js';

const common = { protocolVersion: TURN_PROTOCOL_VERSION, launchId: 'launch-1' } as const;
const turn = { conversationId: 'conversation', operationId: 'operation', generation: 1 };
const acceptedEvent = { ...input('event'), operationId: turn.operationId, acceptedSequence: 1, lane: 'human' as const };
const change = { operationId: 'save-1', expectedVersion: 0, session: turnState().session };
const request: TurnProcessMessage = { ...common, kind: 'daemon_request', turn, requestId: 'rpc-1', request: { kind: 'save_conversation', change } };

describe('daemon turn process protocol', () => {
  it.each(['reply', 'notice'] as const)('preserves %s results through process messages and stored results', (kind) => {
    const outcome = { kind: 'completed' as const, result: { kind, message: 'Same text' } };
    const message = { ...common, kind: 'turn_finished', turn, outcome };
    expect(parseTurnProcessMessage(JSON.parse(JSON.stringify(message)), common.launchId)).toEqual(message);
    const stored = { ...turn, event: acceptedEvent, outcome };
    expect(StoredResultSchema.parse(JSON.parse(JSON.stringify(stored)))).toEqual(stored);
  });

  it.each<DaemonProcessMessage>([
    { ...common, kind: 'initialize', conversationId: turn.conversationId, assignment: turnState().assignment, configDirectory: '/config' },
    { ...common, kind: 'start_turn', input: { event: acceptedEvent, turn, state: turnState() } },
    { ...common, kind: 'interrupt', turn },
    { ...common, kind: 'result_committed', turn },
    { ...common, kind: 'shutdown' },
    { ...common, kind: 'daemon_reply', turn, requestId: 'rpc-1', reply: { kind: 'state_saved', version: 1, duplicate: false } },
  ])('validates daemon message $kind', (value) => {
    expect(parseDaemonProcessMessage(value, common.launchId)).toEqual(value);
    expect(() => parseTurnProcessMessage(value, common.launchId)).toThrow();
  });

  it('delivers a PR retry event to the manager turn', () => {
    const event = { ...acceptedEvent, lane: 'other' as const, source: 'watcher' as const,
      event: { kind: 'watch_observation' as const, observation: {
        kind: 'goal_pr_retry' as const, targetId: 'goal', generation: 'failure', observedAt: '2026-11-06T00:00:00Z',
        repositoryDirectory: '/repo', goalId: 'goal', failureId: 'failure', expectedSha: 'a'.repeat(40),
        reason: 'commit_refs', attempt: 1, maxAttempts: 6,
      } },
    };
    const message = { ...common, kind: 'start_turn', input: { event, turn, state: turnState() } };
    expect(parseDaemonProcessMessage(message, common.launchId)).toEqual(message);
  });

  it.each<TurnProcessMessage>([
    { ...common, kind: 'ready' },
    { ...common, kind: 'turn_progress', turn, message: 'progress' },
    { ...common, kind: 'turn_finished', turn, outcome: { kind: 'completed', result: { kind: 'reply', message: 'done' }, change } },
    { ...common, kind: 'turn_finished', turn, outcome: { kind: 'failed', message: 'failed' } },
    { ...common, kind: 'turn_finished', turn, outcome: { kind: 'interrupted' } },
    { ...common, kind: 'shutdown_complete' },
    request,
  ])('validates child message $kind', (value) => {
    expect(parseTurnProcessMessage(value, common.launchId)).toEqual(value);
    expect(() => parseDaemonProcessMessage(value, common.launchId)).toThrow();
  });

  it.each([
    { kind: 'accept_director_message', eventId: 'event-2', requestId: 'admission-1', conversationId: 'target', occurredAt: '2026-11-03T00:00:00Z', text: 'message' },
    { kind: 'notify_director', notificationId: 'notice-1', message: 'notice', subject: { key: 'goal', state: 'done' } },
    { kind: 'get_delivery', conversationId: 'target' },
  ])('accepts the limited state operation $kind', (stateRequest) => {
    expect(parseTurnProcessMessage({ ...request, request: stateRequest }, common.launchId)).toMatchObject({ request: stateRequest });
  });

  it.each([
    { ...common, kind: 'daemon_reply', turn, requestId: 'rpc', reply: { kind: 'event_accepted', admission: { kind: 'accepted', eventId: 'event', operationId: 'operation', acceptedSequence: 1 } } },
    { ...common, kind: 'daemon_reply', turn, requestId: 'rpc', reply: { kind: 'notification_saved', notificationId: 'notice' } },
    { ...common, kind: 'daemon_reply', turn, requestId: 'rpc', reply: { kind: 'delivery', conversationId: 'conversation', assignment: turnState().assignment, connectedPorts: ['tui'] } },
    { ...common, kind: 'daemon_reply', turn, requestId: 'rpc', reply: { kind: 'error', code: 'version_conflict', message: 'conflict' } },
  ])('validates reply $reply.kind', (value) => {
    expect(parseDaemonProcessMessage(value, common.launchId)).toEqual(value);
  });

  it.each([
    { ...request, protocolVersion: 2 },
    { ...request, launchId: 'old-launch' },
    { ...request, launchId: undefined },
    { ...request, requestId: '' },
    { ...request, requestId: 'r'.repeat(129) },
    { ...request, turn: { ...turn, generation: 0 } },
    { ...request, turn: { ...turn, generation: 1.5 } },
    { ...request, turn: { ...turn, operationId: '' } },
    { ...request, request: { kind: 'execute_tool', tool: 'git' } },
    { ...request, request: { kind: 'save_conversation', path: '/arbitrary', change } },
    { ...request, request: { kind: 'save_conversation', change: { ...change, expectedVersion: -1 } } },
    { ...request, request: { kind: 'save_conversation', change: { operationId: 'empty', expectedVersion: 0 } } },
    { ...request, request: { kind: 'save_conversation', change: { ...change, assignment: { kind: 'daemon' } } } },
  ])('rejects invalid identity and unauthorized state shapes %#', (value) => {
    expect(() => parseTurnProcessMessage(value, common.launchId)).toThrow();
  });

  it('checks event identity and lane before starting a turn', () => {
    const value = { ...common, kind: 'start_turn', input: { event: acceptedEvent, turn, state: turnState() } };
    for (const event of [
      { ...acceptedEvent, operationId: 'another-operation' },
      { ...acceptedEvent, conversationId: 'another-conversation' },
      { ...acceptedEvent, lane: 'other' },
      { ...acceptedEvent, event: { kind: 'human_command', command: { kind: 'abort_turn', operationId: 'operation' }, speaker: { namespace: 'test', id: 'person' } } },
    ]) expect(() => parseDaemonProcessMessage({ ...value, input: { ...value.input, event } }, common.launchId)).toThrow();
  });

  it.each([
    {}, { provider: 'codex' }, { model: 'custom-model' }, { provider: 'claude-sdk', model: 'other-model' },
  ])('preserves per-message and saved session agent overrides in start_turn: %j', (agentOverrides) => {
    const state = turnState();
    const value = { ...common, kind: 'start_turn', input: {
      event: { ...acceptedEvent, event: { ...acceptedEvent.event, agentOverrides } }, turn,
      state: { ...state, session: { ...state.session, agentOverrides } },
    } };
    expect(parseDaemonProcessMessage(JSON.parse(JSON.stringify(value)), common.launchId)).toEqual(value);
  });

  it('accepts a process loss before run slug assignment in start_turn', () => {
    const value = { ...common, kind: 'start_turn', input: { turn, state: turnState(), event: {
      ...acceptedEvent, lane: 'other', source: 'watcher', event: { kind: 'watch_observation', observation: {
        kind: 'run_process_lost', targetId: 'target', generation: 'generation', observedAt: '2026-11-03T00:00:00.000Z',
        task: { repositoryDirectory: '/repository', goalId: 'goal', taskName: 'task', executionId: 'execution' },
        pid: 12345, startTime: null,
      } },
    } } };
    expect(parseDaemonProcessMessage(JSON.parse(JSON.stringify(value)), common.launchId)).toEqual(value);
  });

  it.each([
    null, 'codex', { provider: 'unknown' }, { provider: null }, { model: '' }, { model: 123 },
    { provider: 'codex', extra: true },
  ])('rejects invalid per-message agent overrides in start_turn: %j', (agentOverrides) => {
    const value = { ...common, kind: 'start_turn', input: {
      event: { ...acceptedEvent, event: { ...acceptedEvent.event, agentOverrides } }, turn, state: turnState(),
    } };
    expect(() => parseDaemonProcessMessage(value, common.launchId)).toThrow();
  });

  it('enforces UTF-8 and serialized byte limits, including JSON escaping', () => {
    const progress = { ...common, kind: 'turn_progress', turn, message: 'a'.repeat(MAX_PROCESS_PROGRESS_BYTES) };
    expect(parseTurnProcessMessage(progress, common.launchId)).toEqual(progress);
    expect(() => parseTurnProcessMessage({ ...progress, message: 'あ'.repeat(MAX_PROCESS_PROGRESS_BYTES) }, common.launchId)).toThrow();
    expect(() => parseTurnProcessMessage({ ...request, request: { kind: 'notify_director', notificationId: 'n', message: 'a'.repeat(MAX_PROCESS_MESSAGE_BYTES) } }, common.launchId)).toThrow();
    expect(() => parseTurnProcessMessage({ ...request, request: { kind: 'notify_director', notificationId: 'n', message: '\u0000'.repeat(MAX_PROCESS_MESSAGE_BYTES / 4) } }, common.launchId)).toThrow();
  });

  it('bounds pending request counts and aggregate bytes before reservation', () => {
    const size = processRequestBytes(0, 0, request);
    expect(size).toBe(Buffer.byteLength(JSON.stringify(request)));
    expect(processRequestBytes(MAX_PROCESS_PENDING_REQUESTS - 1, MAX_PROCESS_PENDING_BYTES - size, request)).toBe(size);
    expect(() => processRequestBytes(MAX_PROCESS_PENDING_REQUESTS, 0, request)).toThrow();
    expect(() => processRequestBytes(0, MAX_PROCESS_PENDING_BYTES - size + 1, request)).toThrow();
    expect(() => processRequestBytes(-1, 0, request)).toThrow();
    expect(() => processRequestBytes(0, 0, { ...common, kind: 'ready' })).toThrow();
  });

  it('bounds delivery information and rejects non-JSON values', () => {
    expect(() => parseDaemonProcessMessage({ ...common, kind: 'daemon_reply', turn, requestId: 'rpc', reply: {
      kind: 'delivery', conversationId: 'target', assignment: turnState().assignment,
      connectedPorts: Array.from({ length: MAX_PROCESS_DELIVERY_PORTS + 1 }, () => 'tui'),
    } }, common.launchId)).toThrow();
    for (const extra of [new AbortController().signal, () => {}, (async function* () {})(), { complete() {} }]) {
      expect(() => parseTurnProcessMessage({ ...request, extra }, common.launchId)).toThrow();
    }
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => parseTurnProcessMessage(cyclic, common.launchId)).toThrow();
  });
});

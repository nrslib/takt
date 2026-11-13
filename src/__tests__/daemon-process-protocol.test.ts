import { describe, expect, it } from 'vitest';
import {
  TURN_PROTOCOL_VERSION, MAX_PROCESS_MESSAGE_BYTES, MAX_PROCESS_PENDING_REQUESTS,
  MAX_PROCESS_PENDING_BYTES, MAX_PROCESS_PROGRESS_BYTES, MAX_PROCESS_DELIVERY_PORTS,
  parseDaemonProcessMessage, parseTurnProcessMessage, processRequestBytes,
  type DaemonProcessMessage, type TurnProcessMessage,
} from '../core/daemon/processProtocol.js';
import { input, turnState } from './helpers/controlledDaemon.js';
import { AcceptedEventSchema, EventRecordSchema, EventRecordWriteSchema, StoredResultSchema } from '../infra/daemon/eventRecord.js';
import { conversationId } from '../infra/conversations/identity.js';
import { ManagerEventSchema } from '../infra/goals/events.js';
import { managerInboxTurnEvent } from '../features/daemon/inboxEvent.js';

const common = { protocolVersion: TURN_PROTOCOL_VERSION, launchId: 'launch-1' } as const;
const turn = { conversationId: 'conversation', operationId: 'operation', generation: 1 };
const acceptedEvent = { ...input('event'), operationId: turn.operationId, acceptedSequence: 1, lane: 'human' as const };
const change = { operationId: 'save-1', expectedVersion: 0, session: turnState().session };
const request: TurnProcessMessage = { ...common, kind: 'daemon_request', turn, requestId: 'rpc-1', request: { kind: 'save_conversation', change } };

describe('daemon turn process protocol', () => {
  it('roundtrips tool identities, batched completions and results larger than the intermediate text limit', () => {
    const toolActivity = { callId: 'call', operationId: turn.operationId, generation: turn.generation };
    const toolId = 'provider-tool-'.repeat(30);
    for (const event of [
      { type: 'tool_use', data: { id: toolId, tool: 'Read', input: { file_path: 'a.ts' } }, toolActivity },
      { type: 'tool_output', data: { id: toolId, tool: 'Read', output: 'stream' }, toolActivity },
      { type: 'tool_result', data: { completedToolIds: [toolId, 'second'], content: '日'.repeat(MAX_PROCESS_PROGRESS_BYTES), isError: true }, toolActivity },
    ]) {
      const message = { ...common, kind: 'turn_progress', turn, message: { kind: 'tool_event', eventId: 'event', event } };
      expect(parseTurnProcessMessage(JSON.parse(JSON.stringify(message)), common.launchId)).toEqual(message);
    }
  });
  it.each(['human', 'manager', undefined] as const)('preserves resumed origin %s through inbox, storage and IPC', (origin) => {
    const saved = ManagerEventSchema.parse({ kind: 'resumed', goalId: '650e8400-e29b-41d4-a716-446655440000',
      createdAt: '2026-11-10T00:00:00Z', ...(origin === undefined ? {} : { origin }) });
    const event = { ...acceptedEvent, lane: 'other', event: managerInboxTurnEvent('/repo', saved) };
    const record = { state: 'queued', event };
    expect(EventRecordSchema.parse(JSON.parse(JSON.stringify(record)))).toEqual(record);
    const message = { ...common, kind: 'start_turn', input: { event, turn, state: turnState() } };
    expect(parseDaemonProcessMessage(JSON.parse(JSON.stringify(message)), common.launchId)).toEqual(message);
    expect(event.event).toEqual({ kind: 'goal_resumed', repositoryDirectory: '/repo', goalId: saved.goalId,
      ...(origin === undefined ? {} : { origin }) });
  });

  it.each(['human', 'director', undefined] as const)('preserves director origin %s without inferring authorship from text', (origin) => {
    const event = { ...acceptedEvent, lane: 'other', source: 'director', event: {
      kind: 'director_message', directorConversationId: 'director', text: 'The human says stop.',
      ...(origin === undefined ? {} : { origin }),
    } };
    const record = { state: 'queued', event };
    expect(EventRecordSchema.parse(JSON.parse(JSON.stringify(record)))).toEqual(record);
    const message = { ...common, kind: 'start_turn', input: { event, turn, state: turnState() } };
    expect(parseDaemonProcessMessage(JSON.parse(JSON.stringify(message)), common.launchId)).toEqual(message);
  });

  it('requires a known origin for a new director state request', () => {
    const value = { kind: 'accept_director_message', eventId: 'new', requestId: 'new', conversationId: 'target',
      occurredAt: '2026-11-10T00:00:00Z', text: 'message' };
    for (const origin of [undefined, 'unknown', 'manager']) {
      expect(() => parseTurnProcessMessage({ ...request, request: { ...value, origin } }, common.launchId)).toThrow();
    }
    for (const origin of ['human', 'director']) {
      const message = { ...request, request: { ...value, origin } };
      expect(parseTurnProcessMessage(message, common.launchId)).toEqual(message);
    }
  });

  it('preserves the session context key in start_turn, save_conversation and turn results through JSON', () => {
    const state = turnState();
    const session = { ...state.session, contextKey: 'system-prompt-fingerprint' };
    const start: DaemonProcessMessage = { ...common, kind: 'start_turn', input: {
      event: acceptedEvent, turn, state: { ...state, session },
    } };
    expect(parseDaemonProcessMessage(JSON.parse(JSON.stringify(start)), common.launchId)).toEqual(start);
    const savedChange = { ...change, session };
    const save: TurnProcessMessage = { ...request, request: { kind: 'save_conversation', change: savedChange } };
    expect(parseTurnProcessMessage(JSON.parse(JSON.stringify(save)), common.launchId)).toEqual(save);
    for (const outcome of [
      { kind: 'completed', result: { kind: 'reply', message: 'done' }, change: savedChange },
      { kind: 'failed', message: 'failed', change: savedChange },
      { kind: 'interrupted', change: savedChange },
    ] as const) {
      const finished: TurnProcessMessage = { ...common, kind: 'turn_finished', turn, outcome };
      expect(parseTurnProcessMessage(JSON.parse(JSON.stringify(finished)), common.launchId)).toEqual(finished);
    }
  });

  it('accepts bounded intermediate text and rejects extra fields and UTF-8 overflow', () => {
    const value = { ...common, kind: 'turn_progress', turn,
      message: { kind: 'turn_text', message: 'a'.repeat(MAX_PROCESS_PROGRESS_BYTES) } };
    expect(parseTurnProcessMessage(value, common.launchId)).toEqual(value);
    for (const message of [
      { kind: 'turn_text', message: 'あ'.repeat(Math.ceil(MAX_PROCESS_PROGRESS_BYTES / 3)) },
      { kind: 'turn_text', message: 'safe', input: { command: 'private' } },
    ]) expect(() => parseTurnProcessMessage({ ...value, message }, common.launchId)).toThrow();
  });

  it.each(['コードを読む', 'あ'.repeat(256)])('accepts a bounded Bash description: %s', (description) => {
    const value = { ...common, kind: 'turn_progress', turn, message: { kind: 'tool', tool: 'Bash', description } };
    expect(parseTurnProcessMessage(JSON.parse(JSON.stringify(value)), common.launchId)).toEqual(value);
  });

  it.each([
    { kind: 'tool', tool: 'Bash', description: 'あ'.repeat(257) },
    { kind: 'tool', tool: 'Bash', description: 'line\nline' },
    { kind: 'tool', tool: 'Bash', description: '\u001b[31mred' },
    { kind: 'tool', tool: 'Bash', description: 'line\u2028line' },
    { kind: 'tool', tool: 'Bash', description: 42 },
    { kind: 'tool', tool: 'Bash', description: 'safe', command: 'private command' },
    { kind: 'tool', tool: 'Read', description: 'private input' },
  ])('rejects invalid descriptions and unauthorized input fields: %#', (message) => {
    expect(() => parseTurnProcessMessage({ ...common, kind: 'turn_progress', turn, message }, common.launchId)).toThrow();
  });

  it('transfers a standalone answer through the existing director message event shape', () => {
    const event = { ...acceptedEvent, lane: 'other', source: 'director', event: {
      kind: 'director_message', directorConversationId: 'director', text: 'A person answered a standalone inquiry.',
      inquiryAnswer: { questionId: 'question-1', question: 'Which format?', answer: { text: 'CSV', source: 'tui', answeredAt: '2026-11-06T00:00:00Z' } },
    } };
    const message = { ...common, kind: 'start_turn', input: { event, turn, state: turnState() } };
    expect(parseDaemonProcessMessage(JSON.parse(JSON.stringify(message)), common.launchId)).toEqual(message);
    expect(AcceptedEventSchema.parse(JSON.parse(JSON.stringify(event)))).toEqual(event);
  });

  it('restores persisted standalone answer event kinds by normalizing them to director messages', () => {
    for (const event of [
      { kind: 'workspace_inquiry_answered', questionId: '650e8400-e29b-41d4-a716-446655440001',
        answer: { text: 'Export', source: 'tui', answeredAt: '2026-11-06T00:00:00Z' } },
      { kind: 'inquiry_answered', repositoryDirectory: '/repo', goalId: null,
        questionId: '650e8400-e29b-41d4-a716-446655440002',
        answer: { text: 'CSV', source: 'slack', answeredAt: '2026-11-06T00:00:00Z' } },
    ]) {
      const record = EventRecordSchema.parse({ state: 'queued', event: {
        ...acceptedEvent, lane: 'other', event,
      } });
      expect(record.event.event).toMatchObject({ kind: 'director_message', inquiryAnswer: { questionId: event.questionId, answer: event.answer } });
    }
  });

  it.each(['queued', 'running', 'settling', 'settled'] as const)(
    'migrates a producer-identified legacy answer only when reading a %s record', (state) => {
      const workspaceId = '650e8400-e29b-41d4-a716-446655440001';
      const inquiryAnswer = { questionId: '650e8400-e29b-41d4-a716-446655440002',
        answer: { text: 'CSV', source: 'tui', answeredAt: '2026-11-06T00:00:00Z' } };
      const eventId = `workspace-answer-${workspaceId}-${inquiryAnswer.questionId}`;
      const saved = { ...acceptedEvent, eventId, requestId: eventId,
        conversationId: conversationId({ kind: 'workspace', workspaceId }), source: 'director', lane: 'other',
        occurredAt: inquiryAnswer.answer.answeredAt, event: { kind: 'director_message',
          directorConversationId: conversationId({ kind: 'daemon' }),
          text: `A person answered a standalone inquiry. ${JSON.stringify(inquiryAnswer)}` } };
      const identity = { ...turn, conversationId: saved.conversationId };
      const record = { state, event: saved,
        ...(state === 'running' ? { turn: identity } : {}),
        ...(['settling', 'settled'].includes(state) ? { result: { ...identity, event: saved, outcome: { kind: 'interrupted' } } } : {}) };
      expect(EventRecordWriteSchema.parse(JSON.parse(JSON.stringify(record)))).toEqual(record);
      const restored = EventRecordSchema.parse(JSON.parse(JSON.stringify(record)));
      const normalized = { ...saved, event: { ...saved.event, inquiryAnswer } };
      expect(restored.event).toEqual(normalized);
      if (restored.state === 'settling' || restored.state === 'settled') expect(restored.result.event).toEqual(normalized);
      const authored = { ...saved, event: { ...saved.event, origin: 'director' } };
      expect(EventRecordSchema.parse({ state: 'queued', event: authored }).event).toEqual(authored);
    },
  );

  it('limits workspace answer publication to a question ID', () => {
    const publication = { kind: 'publish_workspace_inquiry_answer', questionId: '650e8400-e29b-41d4-a716-446655440001' };
    expect(parseTurnProcessMessage({ ...request, request: publication }, common.launchId)).toMatchObject({ request: publication });
    for (const extra of [{ workspaceId: 'other' }, { conversationId: 'other' }, { answer: { text: 'forged' } }]) {
      expect(() => parseTurnProcessMessage({ ...request, request: { ...publication, ...extra } }, common.launchId)).toThrow();
    }
    expect(() => parseTurnProcessMessage({ ...request, request: { ...publication, questionId: 'invalid' } }, common.launchId)).toThrow();
  });
  it('rejects a nullable goal reference in a goal inquiry answer event', () => {
    const event = { ...acceptedEvent, lane: 'other', source: 'run', event: {
      kind: 'inquiry_answered', repositoryDirectory: '/repo', goalId: null,
      questionId: '650e8400-e29b-41d4-a716-446655440002',
      answer: { text: 'CSV', source: 'slack', answeredAt: '2026-11-06T00:00:00Z' },
    } };
    const message = { ...common, kind: 'start_turn', input: { event, turn, state: turnState() } };
    expect(() => parseDaemonProcessMessage(JSON.parse(JSON.stringify(message)), common.launchId)).toThrow();
  });

  it.each(['goal_registered', 'goal_resumed'] as const)('keeps a goal ID mandatory for %s events', (kind) => {
    const event = { ...acceptedEvent, lane: 'other', source: 'run', event: { kind, repositoryDirectory: '/repo', goalId: null } };
    expect(() => parseDaemonProcessMessage({ ...common, kind: 'start_turn', input: { event, turn, state: turnState() } }, common.launchId)).toThrow();
  });

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

  it('delivers a PR publication failure to the manager turn', () => {
    const event = { ...acceptedEvent, lane: 'other' as const, source: 'run' as const,
      event: { kind: 'goal_pr_failed' as const, repositoryDirectory: '/repo', goalId: 'goal',
        expectedSha: 'a'.repeat(40), reason: 'commit_refs' },
    };
    const message = { ...common, kind: 'start_turn', input: { event, turn, state: turnState() } };
    expect(parseDaemonProcessMessage(message, common.launchId)).toEqual(message);
  });

  it.each<TurnProcessMessage>([
    { ...common, kind: 'ready' },
    { ...common, kind: 'turn_progress', turn, message: 'progress' },
    { ...common, kind: 'turn_progress', turn, message: { kind: 'thinking' } },
    { ...common, kind: 'turn_progress', turn, message: { kind: 'tool', tool: 'mcp__takt__read' } },
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
    { kind: 'accept_director_message', eventId: 'event-2', requestId: 'admission-1', conversationId: 'target', occurredAt: '2026-11-03T00:00:00Z', text: 'message', origin: 'human' },
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

  it('transfers a legacy interrupted message larger than one MiB in start_turn', () => {
    const interruptedMessage = 'legacy'.repeat(256 * 1024);
    const value = { ...common, kind: 'start_turn', input: {
      event: acceptedEvent, turn, state: { ...turnState(), interruptedMessage },
    } };
    expect(Buffer.byteLength(JSON.stringify(value))).toBeGreaterThan(1024 * 1024);
    expect(parseDaemonProcessMessage(value, common.launchId)).toEqual(value);
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

  it.each([
    { kind: 'tool', tool: 'Bash', input: { command: 'private' } },
    { kind: 'thinking', thinking: 'private' },
    { kind: 'tool', tool: 'Bash\nprivate' },
    { kind: 'tool', tool: 'B'.repeat(129) },
    { kind: 'unknown' },
  ])('rejects activity containing extra data or invalid labels: %#', (message) => {
    expect(() => parseTurnProcessMessage({ ...common, kind: 'turn_progress', turn, message }, common.launchId)).toThrow();
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

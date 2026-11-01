import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it, vi } from 'vitest';
import { Client } from './helpers/conversation-ipc-client.js';
import { getGlobalConfigDir } from '../infra/config/paths.js';
import { readDaemonOwner, isDaemonOwnerRunning } from '../infra/daemon/owner.js';
import { readDaemonIpcState } from '../infra/daemon/ipcEndpoint.js';
import { createTuiConversationPort } from '../features/manager/tuiConversationPort.js';
import { ConversationStore } from '../infra/conversations/store.js';
import { conversationRecord } from './helpers/conversation-fixtures.js';
import { captureOwnedProcess, terminateOwnedProcess } from './helpers/owned-process.js';
import { managerDaemonFixture, submitManagerText, waitForManager, type ManagerTuiProcess } from './helpers/manager-daemon-tui.js';
import { getLabel } from '../shared/i18n/index.js';
import { GoalStore } from '../infra/goals/store.js';
import { stripVTControlCharacters } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { concurrentTuiFixture, type ConcurrentTui, type IpcObservation } from './helpers/concurrent-tui-ipc.js';
import { goalRecord } from './helpers/goal-fixtures.js';
import { saveManagerToolPermissionInquiry } from '../features/manager/toolPermissionInquiry.js';
import { StandaloneInquiryStore } from '../infra/goals/standalone-inquiries.js';

const lifecycle = await import(pathToFileURL(join(process.cwd(), 'dist/features/daemon/lifecycle.js')).href) as typeof import('../features/daemon/lifecycle.js');

function ipcMeasurements(observations: IpcObservation[], pids: number[], concurrentAt: number) {
  const observedAt = Date.now();
  const requests = observations.filter((row) => row.event === 'request' && row.requestId !== 'readiness' && pids.includes(row.pid));
  const responses = new Map(observations.filter((row) => row.event === 'response')
    .map((row) => [`${row.pid}:${row.requestId}`, row]));
  const serviceEnds = new Map(observations.filter((row) => row.event === 'service_end')
    .map((row) => [`${row.pid}:${row.callId}`, row]));
  return {
    requests: ['single', 'concurrent'].flatMap((phase) => ['hello', 'open', 'snapshot', 'submit'].map((method) => {
      const selected = requests.filter((row) => row.method === method && (row.at < concurrentAt ? 'single' : 'concurrent') === phase);
      const elapsed = selected.flatMap((row) => {
        const response = responses.get(`${row.pid}:${row.requestId}`);
        return response === undefined ? [] : [response.at - row.at];
      });
      return { phase, method, count: selected.length, responses: elapsed.length, maxMs: elapsed.length === 0 ? null : Math.max(...elapsed),
        unanswered: selected.filter((row) => !responses.has(`${row.pid}:${row.requestId}`)).map((row) => ({ ...row, ageMs: observedAt - row.at })) };
    })),
    service: ['open', 'snapshot', 'submit'].map((method) => {
      const starts = observations.filter((row) => row.event === 'service_start' && row.method === method);
      const elapsed = starts.flatMap((row) => {
        const end = serviceEnds.get(`${row.pid}:${row.callId}`);
        return end === undefined ? [] : [end.at - row.at];
      });
      return { method, calls: starts.length, completed: elapsed.length, maxMs: elapsed.length === 0 ? null : Math.max(...elapsed),
        active: starts.filter((row) => !serviceEnds.has(`${row.pid}:${row.callId}`)).map((row) => ({ ...row, ageMs: observedAt - row.at })) };
    }),
    connections: observations.filter((row) => row.event === 'connection'),
    eventLoop: [...new Set(observations.map((row) => row.pid))].map((pid) => ({ pid,
      maxDelayMs: Math.max(0, ...observations.filter((row) => row.pid === pid && row.event === 'event_loop').map((row) => row.delayMs!)),
    })),
    polling: pids.map((pid) => {
      const calls = observations.filter((row) => row.pid === pid && row.event === 'refresh' && row.intervalMs !== undefined);
      return { pid, count: calls.length, intervals: [...new Set(calls.map((row) => row.intervalMs))],
        firstAt: calls[0]?.at, lastAt: calls.at(-1)?.at };
    }),
    transfers: pids.map((pid) => {
      const frames = observations.filter((row) => row.pid === pid && row.event === 'transfer');
      const starts = frames.filter((row) => row.frameKind === 'transfer_start');
      const ends = new Map(frames.filter((row) => row.frameKind === 'transfer_end').map((row) => [row.transferId, row]));
      return { pid, started: starts.length, ended: ends.size,
        incomplete: starts.filter((row) => !ends.has(row.transferId)),
        maxMs: Math.max(0, ...starts.flatMap((row) => {
          const end = ends.get(row.transferId); return end === undefined ? [] : [end.at - row.at];
        })) };
    }),
  };
}

it.each(['manager', 'director'] as const)('keeps two %s screens connected to the same live conversation for thirty seconds after a reply', async (kind) => {
  const fixture = concurrentTuiFixture(kind);
  const log = fixture.log;
  const clients: ConcurrentTui[] = [];
  let concurrentAt = Number.POSITIVE_INFINITY;
  try {
    log('start-first:before');
    const first = await fixture.start(); clients.push(first);
    log('start-first:after', first.child.pid);
    log('ready-first:before', first.child.pid);
    await first.ready();
    log('ready-first:after', first.child.pid);
    log('inspect-first:before', first.child.pid);
    const initial = (await first.inspect()).snapshot.state!;
    log('inspect-first:after', first.child.pid);
    log('initial-snapshots:before', first.child.pid);
    await vi.waitFor(() => expect(fixture.readObservations().filter((row) => row.event === 'request'
      && row.pid === first.child.pid && row.method === 'snapshot').length).toBeGreaterThanOrEqual(3), { timeout: 5000 });
    log('initial-snapshots:after', first.child.pid);
    concurrentAt = Date.now();
    log('start-second:before');
    const second = await fixture.start(); clients.push(second);
    log('start-second:after', second.child.pid);
    log('ready-second:before', second.child.pid);
    await second.ready();
    log('ready-second:after', second.child.pid);
    log('inspect-second:before', second.child.pid);
    const secondScreen = await second.inspect();
    log('inspect-second:after', second.child.pid);
    expect(secondScreen.snapshot.state?.conversationId).toBe(initial.conversationId);
    const owner = readDaemonOwner(fixture.directory)!;
    expect(owner).toBeDefined();
    const text = 'Share this message with both open screens';
    log('submit:before', first.child.pid);
    await first.submit(text);
    log('submit:after', first.child.pid);
    log('provider-start:before', owner.pid);
    await vi.waitFor(() => expect(fixture.readObservations()).toContainEqual(expect.objectContaining({
      event: 'provider_start', agent: kind, pid: owner.pid,
    })), { timeout: 10000 });
    log('provider-start:after', owner.pid);
    log('release:before', owner.pid);
    fixture.release();
    log('release:after', owner.pid);
    log('reply:before', first.child.pid);
    await vi.waitFor(async () => {
      const screen = await first.inspect();
      expect(screen.frame).toContain(fixture.reply);
      expect(screen.snapshot.state?.running).toBeNull();
    }, { timeout: 10000 });
    log('reply:after', first.child.pid);
    const repliedAt = Date.now();
    log('wait-30s:before', owner.pid);
    await delay(30000);
    log('wait-30s:after', owner.pid);
    log('final-inspect:before');
    const screens = await Promise.all(clients.map((client) => client.inspect()));
    log('final-inspect:after');
    const observations = fixture.readObservations();
    const measurements = ipcMeasurements(observations, clients.map((client) => client.child.pid!), concurrentAt);
    expect(Date.now() - repliedAt).toBeGreaterThanOrEqual(30000);
    expect(readDaemonOwner(fixture.directory)).toEqual(owner);
    for (const [index, client] of clients.entries()) {
      const screen = screens[index]!;
      const own = observations.filter((row) => row.pid === client.child.pid);
      const transitions = own.filter((row) => row.event === 'connection');
      const connected = transitions.findIndex((row) => row.connection === 'connected');
      expect(connected).toBeGreaterThanOrEqual(0);
      expect(transitions.slice(connected).map((row) => row.connection)).toEqual(
        transitions.slice(connected).map(() => 'connected'));
      expect(transitions.filter((row) => row.error != null)).toEqual([]);
      expect(own.filter((row) => row.event === 'request' && row.method === 'open')).toHaveLength(1);
      expect(screen.snapshot).toMatchObject({ connection: 'connected', readStatus: 'complete', error: null,
        state: { conversationId: initial.conversationId, running: null } });
      for (const frame of screen.frames) {
        for (const line of stripVTControlCharacters(frame).split('\n')) {
          expect.soft(line).not.toMatch(/IPC request timed out|Daemon disconnected|Daemon IPC readiness was not confirmed/u);
        }
      }
      const polls = own.filter((row) => row.event === 'refresh' && row.intervalMs !== undefined && row.at >= repliedAt);
      expect(new Set(polls.map((row) => row.intervalMs))).toEqual(new Set([500]));
      const reads = own.filter((row) => row.event === 'request' && row.method === 'snapshot' && row.at >= repliedAt);
      // 応答待ち中の refresh は共有されるため、要求数をタイマーの発火数と同一視しない。
      for (const offset of [0, 10000, 20000]) {
        const during = (row: IpcObservation): boolean => row.at >= repliedAt + offset && row.at < repliedAt + offset + 10000;
        expect(polls.some(during)).toBe(true);
        expect(reads.some(during)).toBe(true);
      }
      const body = stripVTControlCharacters(screen.frame);
      expect.soft(body.split(text).length - 1).toBe(1);
      expect.soft(body.split(fixture.reply).length - 1).toBe(1);
    }
    expect(screens[0]!.snapshot.state).toEqual(screens[1]!.snapshot.state);
    for (const request of measurements.requests) {
      if (request.maxMs !== null) expect(request.maxMs).toBeLessThan(5000);
    }
  } finally {
    log('cleanup:before');
    const observations = fixture.readObservations();
    console.info(JSON.stringify({ kind, ...ipcMeasurements(observations, clients.map((client) => client.child.pid!), concurrentAt),
      timeline: observations.filter((row) => row.event !== 'refresh' && row.event !== 'event_loop'),
      owner: readDaemonOwner(fixture.directory) }));
    await fixture.cleanup();
    log('cleanup:after');
  }
}, 180_000);

it('keeps make-goal instructions hidden on both connected manager screens', async () => {
  const fixture = concurrentTuiFixture('manager');
  try {
    const first = await fixture.start(); const second = await fixture.start();
    await first.ready(); await second.ready();
    await first.submit('/make-goal');
    await vi.waitFor(() => expect(fixture.readObservations()).toContainEqual(expect.objectContaining({
      event: 'provider_start', agent: 'manager',
    })), { timeout: 10000 });
    const assertHidden = async (): Promise<void> => {
      for (const client of [first, second]) {
        const screen = await client.inspect();
        for (const frame of screen.frames) {
          const body = stripVTControlCharacters(frame).replace(/[│\s]+/gu, '').toLowerCase();
          for (const instruction of getLabel('manager.goSummaryRequest', 'en').split(/[\n。.!?]+/u).filter((line) => line.trim().length > 20)) {
            expect(body).not.toContain(instruction.replace(/\s+/gu, '').toLowerCase());
          }
        }
      }
    };
    await assertHidden();
    fixture.release();
    await vi.waitFor(async () => {
      for (const client of [first, second]) expect((await client.inspect()).frame).toContain(fixture.reply);
    }, { timeout: 10000 });
    await assertHidden();
  } finally { await fixture.cleanup(); }
});

async function expectCompletedFrames(tui: ManagerTuiProcess, expected: readonly string[]) {
  const samples = await tui.observeFrames();
  expect(samples).toHaveLength(30);
  const failures = samples.flatMap((sample, index) => {
    const screen = stripVTControlCharacters(sample.frame).replace(/\s+/gu, '');
    const readingVisible = screen.includes('会話の情報を読み出しています。');
    const missing = expected.filter((text) => !screen.includes(text.replace(/\s+/gu, '')));
    return sample.readStatus !== 'complete' || readingVisible || missing.length > 0
      ? [{ index, readStatus: sample.readStatus, readingVisible, missing }] : [];
  });
  expect(failures).toEqual([]);
}

it('keeps one daemon across two attachments, last detach and accepted work, then exits with only saved pending', async () => {
  const directory = getGlobalConfigDir(); const repository = join(directory, 'repository'); mkdirSync(repository);
  execFileSync('git', ['init', '-b', 'main'], { cwd: repository, stdio: 'pipe' });
  writeFileSync(join(directory, 'config.yaml'), 'provider: mock\nlanguage: en\n');
  const scenario = join(directory, 'scenario.json');
  const summary = { objective: 'CSV export', outOfScope: [], acceptanceCriteria: ['CSV exists'], constraints: [] };
  writeFileSync(scenario, JSON.stringify([{ persona: 'manager', delay_ms: 2500, content: '',
    structured_output: { message: 'finished without an attachment', summary: { ...summary, repositoryDirectory: repository } } }]));
  vi.stubEnv('TAKT_MOCK_SCENARIO', scenario);
  const selected = await createTuiConversationPort(directory, { deliver: async () => ({ kind: 'delivered' }) })
    .resolve({ kind: 'repository', repositoryDirectory: repository });
  const record = conversationRecord(repository); record.bindings = [selected.binding];
  new ConversationStore(directory).write(record);
  const clients: Client[] = [];
  await lifecycle.ensureDaemon();
  const owner = readDaemonOwner(directory)!;
  const processOwner = captureOwnedProcess(owner.pid);
  try {
    const ipc = readDaemonIpcState(directory)!;
    const opened = [];
    for (let index = 0; index < 2; index++) {
      const client = new Client(ipc.endpoint); clients.push(client);
      await client.request('hello', { capability: ipc.capability });
      opened.push((await client.request('open', selected)).result!);
    }
    const [first, second] = opened;
    await clients[0]!.items(first!.read.transferId); await clients[1]!.items(second!.read.transferId);
    const log = join(directory, 'logs', 'daemon.log');
    const polls = () => readFileSync(log, 'utf8').split('Daemon projects').length - 1;
    const initialPolls = polls();
    await vi.waitFor(() => expect(polls()).toBeGreaterThanOrEqual(initialPolls + 3), { timeout: 30000 });
    expect(readDaemonOwner(directory)).toEqual(owner); expect(isDaemonOwnerRunning(owner)).toBe(true);
    clients[0]!.socket.destroy();
    expect((await clients[1]!.request('submit', { attachmentId: second!.attachmentId, speaker: selected.speaker,
      command: { kind: 'message', text: 'あいことばキリン' } })).result).toMatchObject({ kind: 'accepted' });
    clients[1]!.socket.destroy();
    const store = new ConversationStore(directory);
    await vi.waitFor(() => expect(store.read(record.id, record.assignment)!.running).not.toBeNull(), { timeout: 30000 });
    const duringPolls = polls();
    await vi.waitFor(() => expect(polls()).toBeGreaterThanOrEqual(duringPolls + 2), { timeout: 30000 });
    expect(readDaemonOwner(directory)).toEqual(owner); expect(isDaemonOwnerRunning(owner)).toBe(true);
    await vi.waitFor(() => {
      expect(store.read(record.id, record.assignment)).toMatchObject({ revision: 5, pending: { revision: 5, summary }, running: null });
      expect(readDaemonOwner(directory)).toBeUndefined();
    }, { timeout: 30000 });
    expect(existsSync(join(directory, 'daemon-ipc.json'))).toBe(false);
    const persisted = readFileSync(join(directory, 'conversations', `${record.id}.json`), 'utf8');
    expect(persisted).not.toContain('あいことばキリン');
    expect(persisted).not.toContain('finished without an attachment');
    expect(readFileSync(log, 'utf8')).not.toContain('あいことばキリン');
  } finally {
    for (const client of clients) client.socket.destroy();
    await terminateOwnedProcess(processOwner, () => false); vi.unstubAllEnvs();
  }
});

it('executes provider calls and conversation writes only in the daemon process after TUI input', async () => {
  const fixture = managerDaemonFixture('en');
  fixture.release();
  try {
    const tui = await fixture.start(fixture.repository, undefined);
    await waitForManager(tui, 'Discuss your goal');
    await submitManagerText(tui, 'Prepare a CSV export');
    const owner = readDaemonOwner(fixture.directory)!;
    expect(owner).toBeDefined();
    await vi.waitFor(() => expect(fixture.readObservations()).toContainEqual(expect.objectContaining({
      event: 'provider_complete', agent: 'manager', pid: owner.pid,
    })), { timeout: 10000 });
    await waitForManager(tui, fixture.summary.objective);
    await vi.waitFor(() => expect(fixture.readObservations()).toContainEqual(expect.objectContaining({
      event: 'provider_complete', agent: 'director', pid: owner.pid,
    })), { timeout: 30000 });
    const calls = fixture.readObservations().filter(({ event }) => event === 'provider_start');
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.filter(({ pid }) => pid === tui.child.pid)).toEqual([]);
    expect([...new Set(calls.map(({ pid }) => pid))]).toEqual([owner.pid]);
    expect(calls.filter(({ agent }) => agent === 'manager').map(({ pid }) => pid)).toEqual([owner.pid]);
    expect(calls.filter(({ agent }) => agent === 'director').map(({ pid }) => pid)).toEqual([owner.pid]);
    await vi.waitFor(async () => expect((await fixture.state())).toMatchObject({ pending: { summary: fixture.summary }, running: null }), { timeout: 30000 });
    const writes = fixture.readObservations().filter(({ event }) => event === 'write');
    expect(writes.some(({ pid, running }) => pid === owner.pid && !running)).toBe(true);
    expect(writes.filter(({ pid }) => pid === tui.child.pid)).toEqual([]);
    expect(fixture.readObservations().filter(({ event, pid }) => event === 'provider_start' && pid === tui.child.pid)).toEqual([]);
    await tui.exit();
  } finally { await fixture.cleanup(); }
});

it('finishes an accepted turn after Ctrl+C has exited the TUI process', async () => {
  const fixture = managerDaemonFixture('en');
  try {
    const tui = await fixture.start(fixture.repository, undefined);
    await waitForManager(tui, 'Discuss your goal');
    await submitManagerText(tui, 'Continue after I close this screen');
    await vi.waitFor(async () => expect((await fixture.state())?.running?.kind).toBe('message'), { timeout: 30000 });
    const owner = readDaemonOwner(fixture.directory)!;
    await vi.waitFor(() => expect(fixture.readObservations()).toContainEqual(expect.objectContaining({ event: 'provider_start', agent: 'manager', pid: owner.pid })), { timeout: 30000 });
    await tui.exit();
    expect((await fixture.state())?.running).toMatchObject({ kind: 'message' });
    fixture.release();
    await vi.waitFor(async () => expect((await fixture.state())).toMatchObject({ pending: { summary: fixture.summary }, running: null }), { timeout: 30000 });
    expect(fixture.readObservations()).toContainEqual(expect.objectContaining({ event: 'provider_complete', agent: 'manager', pid: owner.pid }));
  } finally { await fixture.cleanup(); }
});

it('reopens the same conversation and approves its restored summary with Up and Enter', async () => {
  const fixture = managerDaemonFixture('en');
  fixture.release();
  try {
    const first = await fixture.start(fixture.repository, undefined);
    await waitForManager(first, 'Discuss your goal');
    await submitManagerText(first, 'Remember this proposal');
    await waitForManager(first, fixture.summary.objective);
    await vi.waitFor(async () => expect((await fixture.state())?.pending?.summary).toEqual(fixture.summary), { timeout: 30000 });
    const saved = (await fixture.state())!;
    await first.exit();
    const second = await fixture.start(fixture.repository, undefined);
    await waitForManager(second, fixture.summary.objective);
    const opens = fixture.readObservations().filter(({ event, method }) => event === 'request' && method === 'open');
    expect(opens.filter(({ pid }) => pid === first.child.pid).map(({ conversationId }) => conversationId)).toEqual([saved.id]);
    expect(opens.filter(({ pid }) => pid === second.child.pid).map(({ conversationId }) => conversationId)).toEqual([saved.id]);
    await second.approveSummary(saved.pending!.revision);
    await vi.waitFor(async () => expect((await fixture.state())?.approval?.state).toBe('registered'), { timeout: 30000 });
    const receipt = (await fixture.state())!.approval!;
    expect(receipt.revision).toBe(saved.pending!.revision);
    expect((await new GoalStore(fixture.repository).get(receipt.goalId)).objective).toBe(fixture.summary.objective);
    expect(fixture.readObservations()).toContainEqual(expect.objectContaining({ event: 'request', pid: second.child.pid,
      command: 'approve_summary', revision: saved.pending!.revision }));
    await second.exit();
  } finally { await fixture.cleanup(); }
});

it('connects two TUI processes for the same canonical assignment to the same saved conversation', async () => {
  const fixture = managerDaemonFixture('ja');
  const saved = conversationRecord(fixture.repository);
  new ConversationStore(fixture.directory).write(saved);
  fixture.release();
  try {
    const first = await fixture.start(fixture.repository, undefined);
    await waitForManager(first, saved.pending!.summary.objective);
    await first.ready(null);
    const second = await fixture.start(fixture.repository, undefined);
    await waitForManager(second, saved.pending!.summary.objective);
    await second.ready(null);
    const opens = fixture.readObservations().filter(({ event, method }) => event === 'request' && method === 'open');
    for (const tui of [first, second]) {
      expect(opens.filter(({ pid }) => pid === tui.child.pid).map(({ conversationId }) => conversationId)).toEqual([saved.id]);
    }
    expect((await fixture.state())?.pending).toEqual(saved.pending);
    expect(fixture.readObservations().filter(({ event, agent }) => event === 'provider_start' && agent === 'manager')).toEqual([]);
    await expectCompletedFrames(second, [saved.pending!.summary.objective]);
    await first.exit();
    await waitForManager(second, saved.pending!.summary.objective);
    const reopened = await fixture.start(fixture.repository, undefined);
    await waitForManager(reopened, saved.pending!.summary.objective);
    expect((await fixture.state())).toMatchObject({ id: saved.id, revision: 4, pending: saved.pending });
    expect(fixture.readObservations().filter(({ event, method, pid }) => event === 'request' && method === 'open' && pid === reopened.child.pid)
      .map(({ conversationId }) => conversationId)).toEqual([saved.id]);
    await second.exit(); await reopened.exit();
  } finally { await fixture.cleanup(); }
});

it('finishes reading on the same Japanese screen after a /make-goal request with no prior conversation and a greeting reply', async () => {
  const insufficient = '要約を作るには会話の材料が足りません。';
  const greeting = 'こんにちは。ゴールについて相談できます。';
  const fixture = managerDaemonFixture('ja', [insufficient, greeting]);
  fixture.release();
  try {
    const tui = await fixture.start(fixture.repository, undefined);
    await waitForManager(tui, 'ゴールを相談してください');
    await tui.ready(null);
    expect((await fixture.state())?.pending).toBeNull();
    await submitManagerText(tui, '/make-goal');
    await waitForManager(tui, insufficient);
    await vi.waitFor(async () => expect((await fixture.state())?.running).toBeNull(), { timeout: 30000 });
    expect((await fixture.state())?.pending).toBeNull();

    tui.key('こんにちは');
    await waitForManager(tui, 'こんにちは');
    tui.key('\r');
    await waitForManager(tui, greeting);
    await tui.ready(null);
    await expectCompletedFrames(tui, [insufficient, greeting]);
    expect(fixture.readObservations().filter(({ event, agent, pid }) => event === 'provider_complete' && agent === 'manager' && pid !== tui.child.pid)).toHaveLength(2);
    await tui.exit();
  } finally { await fixture.cleanup(); }
});

it('keeps every sampled Japanese screen complete during periodic refresh and accepts one Up and Enter approval', async () => {
  const fixture = managerDaemonFixture('ja');
  const saved = conversationRecord(fixture.repository);
  new ConversationStore(fixture.directory).write(saved);
  fixture.release();
  try {
    const tui = await fixture.start(fixture.repository, undefined);
    await tui.ready(null);
    await waitForManager(tui, saved.pending!.summary.objective);
    await expectCompletedFrames(tui, [saved.pending!.summary.objective, getLabel('manager.summaryInputHint', 'ja')]);
    await tui.approveSummary(saved.pending!.revision);
    await vi.waitFor(async () => expect((await fixture.state())?.approval).toMatchObject({ revision: 4, state: 'registered' }), { timeout: 30000 });
    expect(fixture.readObservations().filter(({ event, command, pid }) => event === 'request' && command === 'approve_summary' && pid === tui.child.pid))
      .toEqual([expect.objectContaining({ revision: saved.pending!.revision })]);
    const receipt = (await fixture.state())!.approval!;
    expect((await new GoalStore(fixture.repository).get(receipt.goalId)).objective).toBe(saved.pending!.summary.objective);
    await tui.exit();
  } finally { await fixture.cleanup(); }
});

it('keeps repositories with the same basename in separate conversations', async () => {
  const fixture = managerDaemonFixture('en');
  const other = fixture.createRepository(join(fixture.directory, 'team-b', 'takt3'));
  const saved = conversationRecord(fixture.repository);
  new ConversationStore(fixture.directory).write(saved);
  fixture.release();
  try {
    const first = await fixture.start(fixture.repository, undefined);
    const second = await fixture.start(other, undefined);
    await waitForManager(first, saved.pending!.summary.objective);
    await waitForManager(second, 'Discuss your goal');
    const opens = fixture.readObservations().filter(({ event, method, pid }) => event === 'request' && method === 'open' && pid === second.child.pid);
    expect(opens).toHaveLength(1);
    expect(opens[0]!.conversationId).not.toBe(saved.id);
    expect((await fixture.state(other))?.pending).toBeNull();
    expect(await second.frame()).not.toContain(saved.pending!.summary.objective);
    await first.exit(); await second.exit();
  } finally { await fixture.cleanup(); }
});

it('opens the same conversation after daemon stop and restart and accepts a new message', async () => {
  const fixture = managerDaemonFixture('en');
  try {
    const first = await fixture.start(fixture.repository, undefined);
    await waitForManager(first, 'Discuss your goal');
    await submitManagerText(first, 'This turn will be interrupted');
    await vi.waitFor(async () => expect((await fixture.state())?.running?.kind).toBe('message'), { timeout: 30000 });
    const before = (await fixture.state())!;
    const owner = readDaemonOwner(fixture.directory)!;
    await lifecycle.stopDaemon();
    await first.exit();
    fixture.release();
    const second = await fixture.start(fixture.repository, undefined);
    await waitForManager(second, 'Discuss your goal');
    expect(readDaemonOwner(fixture.directory)!.pid).not.toBe(owner.pid);
    expect((await fixture.state())).toMatchObject({ id: before.id, running: null });
    await submitManagerText(second, 'A new request after restart');
    await waitForManager(second, fixture.summary.objective);
    await vi.waitFor(async () => expect((await fixture.state())).toMatchObject({ id: before.id, pending: { summary: fixture.summary }, running: null }), { timeout: 30000 });
    expect(fixture.readObservations().filter(({ event, pid }) => event === 'request' && pid === second.child.pid)
      .filter(({ command }) => command === 'message')).toHaveLength(1);
    expect(fixture.readObservations().filter(({ event, command }) => event === 'request' && command === 'message')).toHaveLength(2);
    await second.exit();
  } finally { await fixture.cleanup(); }
});

it.each(['ja', 'en'] as const)('shows a short summary status without displaying internal instructions in %s', async (language) => {
  const fixture = managerDaemonFixture(language);
  try {
    const tui = await fixture.start(fixture.repository, undefined);
    await waitForManager(tui, language === 'ja' ? 'ゴールを相談してください' : 'Discuss your goal');
    await submitManagerText(tui, '/make-goal');
    await vi.waitFor(() => expect(fixture.readObservations()).toContainEqual(expect.objectContaining({
      event: 'provider_start', summaryRequest: true,
    })), { timeout: 30000 });
    const frame = stripVTControlCharacters(await tui.frame());
    const screen = frame.replace(/[│\s]+/gu, '').toLowerCase();
    const instructions = getLabel('manager.goSummaryRequest', language);
    for (const line of instructions.split(/[\n。.!?]+/u).filter((line) => line.trim().length > 20)) {
      expect(screen).not.toContain(line.replace(/\s+/gu, '').toLowerCase());
    }
    const status = frame.split('\n').filter((line) => !/Enter|↑|↓/u.test(line)).join('\n');
    expect(status).toMatch(language === 'ja' ? /要約.*(?:作成|作って)/u : /(?:creat|prepar|generat|summariz).*summar|summarizing/iu);
    fixture.release();
    await waitForManager(tui, fixture.summary.objective);
    await tui.exit();
  } finally { await fixture.cleanup(); }
});

it('rejects a busy TUI message and never sends it after the active turn completes', async () => {
  const fixture = managerDaemonFixture('en');
  try {
    const tui = await fixture.start(fixture.repository, undefined);
    await waitForManager(tui, 'Discuss your goal');
    await submitManagerText(tui, 'The accepted request');
    await vi.waitFor(async () => expect((await fixture.state())?.running?.kind).toBe('message'), { timeout: 30000 });
    await submitManagerText(tui, 'The rejected request');
    await waitForManager(tui, getLabel('manager.conversation.busy', 'en'));
    fixture.release();
    await waitForManager(tui, fixture.summary.objective);
    await vi.waitFor(async () => expect((await fixture.state())?.running).toBeNull(), { timeout: 30000 });
    expect(fixture.readObservations().filter(({ event, agent }) => event === 'provider_start' && agent === 'manager')).toHaveLength(1);
    await tui.exit();
    expect(fixture.readObservations().filter(({ event, agent }) => event === 'provider_start' && agent === 'manager')).toHaveLength(1);
  } finally { await fixture.cleanup(); }
});

it('keeps a proposal arriving after busy /make-goal unregistered until a new explicit approval on the same screen', async () => {
  const fixture = managerDaemonFixture('en');
  try {
    const tui = await fixture.start(fixture.repository, undefined);
    await waitForManager(tui, 'Discuss your goal');
    await submitManagerText(tui, 'Prepare the proposal while this turn is active');
    await vi.waitFor(async () => expect((await fixture.state())?.running?.kind).toBe('message'), { timeout: 30000 });
    const operationId = (await fixture.state())!.running!.operationId;
    await tui.ready(operationId);
    expect((await fixture.state())?.pending).toBeNull();
    await submitManagerText(tui, '/make-goal');
    await waitForManager(tui, getLabel('manager.conversation.busy', 'en'));
    fixture.release();
    await waitForManager(tui, fixture.summary.objective);
    await tui.ready(null);
    const requests = () => fixture.readObservations().filter(({ event, pid }) => event === 'request' && pid === tui.child.pid);
    const proposal = (await fixture.state())!.pending!;
    expect(proposal.summary).toEqual(fixture.summary);
    expect((await fixture.state())?.approval).toBeNull();
    expect(requests().filter(({ command }) => command === 'message')).toHaveLength(2);
    expect(requests().filter(({ command }) => command === 'approve_summary')).toEqual([]);
    expect(fixture.readObservations().filter(({ event, agent }) => event === 'provider_start' && agent === 'manager')).toHaveLength(1);
    expect(fixture.readObservations().filter(({ event, approvalState }) => event === 'write' && approvalState != null)).toEqual([]);
    const goals = new GoalStore(fixture.repository);
    expect((await goals.list()).goals).toEqual([]);
    await tui.approveSummary(proposal.revision);
    await vi.waitFor(async () => expect((await fixture.state())?.approval).toMatchObject({ state: 'registered', revision: proposal.revision }), { timeout: 30000 });
    const receipt = (await fixture.state())!.approval!;
    expect((await goals.get(receipt.goalId)).objective).toBe(fixture.summary.objective);
    expect((await goals.list()).goals.map(({ id }) => id)).toEqual([receipt.goalId]);
    expect(requests().filter(({ command }) => command === 'approve_summary'))
      .toEqual([expect.objectContaining({ revision: proposal.revision })]);
    expect(requests().filter(({ command }) => command === 'message')).toHaveLength(2);
    await tui.exit();
  } finally { await fixture.cleanup(); }
});

it('passes CLI provider and model overrides to the daemon provider call even when the configured provider differs', async () => {
  const fixture = managerDaemonFixture('en');
  writeFileSync(join(fixture.directory, 'config.yaml'), 'provider: codex\nlanguage: en\nmanager:\n  auto_run: false\n');
  fixture.release();
  try {
    const tui = await fixture.start(fixture.repository, 'selected-manager-model');
    await waitForManager(tui, 'Discuss your goal');
    await submitManagerText(tui, 'Use my selected model');
    await waitForManager(tui, fixture.summary.objective);
    const owner = readDaemonOwner(fixture.directory)!;
    expect(owner).toBeDefined();
    expect(fixture.readObservations().filter(({ event, agent }) => event === 'provider_start' && agent === 'manager'))
      .toEqual([expect.objectContaining({ pid: owner.pid, model: 'selected-manager-model' })]);
    await tui.exit();
  } finally { await fixture.cleanup(); }
});

it('updates the restored proposal on the same mounted screen and approves only the new revision', async () => {
  const fixture = managerDaemonFixture('en');
  const saved = conversationRecord(fixture.repository);
  new ConversationStore(fixture.directory).write(saved);
  fixture.release();
  let observer: Client | undefined;
  try {
    const tui = await fixture.start(fixture.repository, undefined);
    await waitForManager(tui, saved.pending!.summary.objective);
    const ipc = readDaemonIpcState(fixture.directory)!;
    observer = new Client(ipc.endpoint);
    await observer.request('hello', { capability: ipc.capability });
    const selected = await createTuiConversationPort(fixture.directory, { deliver: async () => ({ kind: 'delivered' }) }).resolve(saved.assignment);
    const opened = (await observer.request('open', selected)).result!;
    await observer.items(opened.read.transferId);
    expect((await observer.request('submit', { attachmentId: opened.attachmentId, speaker: selected.speaker,
      command: { kind: 'message', text: 'Replace the restored proposal' } })).result?.kind).toBe('accepted');
    await waitForManager(tui, fixture.summary.objective);
    expect(await tui.frame()).not.toContain(saved.pending!.summary.objective);
    await vi.waitFor(async () => expect((await fixture.state())).toMatchObject({ revision: 5, running: null }), { timeout: 30000 });
    await tui.approveSummary(5);
    await vi.waitFor(() => expect(fixture.readObservations()).toContainEqual(expect.objectContaining({
      event: 'request', pid: tui.child.pid, command: 'approve_summary', revision: 5,
    })), { timeout: 30000 });
    await vi.waitFor(async () => expect((await fixture.state())?.approval).toMatchObject({ revision: 5, state: 'registered' }), { timeout: 30000 });
    await tui.exit();
  } finally { observer?.socket.destroy(); await fixture.cleanup(); }
});

it('reauthenticates and restores the proposal on the same mounted screen after a daemon restart', async () => {
  const fixture = managerDaemonFixture('en');
  const saved = conversationRecord(fixture.repository);
  new ConversationStore(fixture.directory).write(saved);
  fixture.release();
  try {
    const tui = await fixture.start(fixture.repository, undefined);
    await waitForManager(tui, saved.pending!.summary.objective);
    const oldCapability = readDaemonIpcState(fixture.directory)!.capability;
    await lifecycle.stopDaemon();
    await vi.waitFor(async () => expect(await tui.frame()).toMatch(/disconnect|reconnect|incomplete|shutting down/iu), { timeout: 30000 });
    await tui.ready();
    const second = await fixture.start(fixture.repository, undefined);
    await waitForManager(second, saved.pending!.summary.objective);
    expect(readDaemonIpcState(fixture.directory)!.capability).not.toBe(oldCapability);
    await vi.waitFor(() => {
      const opens = fixture.readObservations().filter(({ event, method, pid }) => event === 'request' && method === 'open' && pid === tui.child.pid);
      expect(opens.length).toBeGreaterThanOrEqual(2);
      expect(opens.every(({ conversationId }) => conversationId === saved.id)).toBe(true);
    }, { timeout: 30000 });
    await waitForManager(tui, saved.pending!.summary.objective);
    await tui.continueSummary(saved.pending!.revision, 'Continue from the same screen');
    await waitForManager(tui, 'Continue from the same screen');
    const dismissals = () => fixture.readObservations().filter(({ command, pid }) => command === 'dismiss_summary' && pid === tui.child.pid);
    await vi.waitFor(() => {
      const observations = dismissals();
      expect(observations.filter(({ event }) => event === 'submit'), JSON.stringify(observations))
        .toEqual([expect.objectContaining({ revision: saved.pending!.revision,
          connection: 'connected', readStatus: 'complete', running: false })]);
    }, { timeout: 30000 });
    await vi.waitFor(() => {
      const observations = dismissals();
      expect(observations.filter(({ event }) => event === 'request'), JSON.stringify(observations))
        .toEqual([expect.objectContaining({ method: 'submit', revision: saved.pending!.revision })]);
      expect(observations.filter(({ event }) => event === 'submit_result'), JSON.stringify(fixture.readObservations()))
        .toEqual([expect.objectContaining({ kind: 'accepted', revision: saved.pending!.revision })]);
      expect(observations.filter(({ event }) => event === 'submit_error')).toEqual([]);
    }, { timeout: 30000 });
    await vi.waitFor(async () => {
      expect((await fixture.state())).toMatchObject({ pending: null, running: null });
      expect(await tui.frame()).not.toContain('Working');
    }, { timeout: 30000 });
    expect(fixture.readObservations().filter(({ event, command, pid }) => event === 'request' && command === 'message' && pid === tui.child.pid)).toEqual([]);
    tui.key('\r');
    await waitForManager(tui, fixture.summary.objective);
    expect(fixture.readObservations().filter(({ event, command, pid }) => event === 'request' && command === 'message' && pid === tui.child.pid)).toHaveLength(1);
    await tui.exit(); await second.exit();
  } finally { await fixture.cleanup(); }
});

it('disables summary approval after an incomplete read and restores it after the same screen refreshes', async () => {
  const fixture = managerDaemonFixture('en');
  const saved = conversationRecord(fixture.repository);
  new ConversationStore(fixture.directory).write(saved);
  // 読込の復帰を観測し、復元直後の巡回と承認を競合させない。
  const goal = { ...goalRecord(), createdAt: new Date().toISOString() };
  const goalDirectory = join(fixture.repository, '.takt', 'goals', goal.id);
  mkdirSync(goalDirectory, { recursive: true });
  const path = join(goalDirectory, 'goal.json');
  writeFileSync(path, '{broken');
  fixture.release();
  try {
    const tui = await fixture.start(fixture.repository, undefined);
    await vi.waitFor(async () => {
      const frame = stripVTControlCharacters(await tui.frame()).replace(/\s+/gu, ' ');
      expect(frame).toContain(getLabel('manager.conversation.incomplete', 'en'));
      expect(frame).toContain(saved.pending!.summary.objective);
    }, { timeout: 30000 });
    tui.key('\x1b[A');
    tui.key('\r');
    await tui.frame();
    expect(fixture.readObservations().filter(({ event, command }) => event === 'request' && command === 'approve_summary')).toEqual([]);
    expect((await fixture.state())?.approval).toBeNull();
    writeFileSync(path, JSON.stringify(goal));
    await waitForManager(tui, saved.pending!.summary.objective);
    await tui.approveSummary(saved.pending!.revision);
    await vi.waitFor(async () => expect((await fixture.state())?.approval).toMatchObject({ revision: 4, state: 'registered' }), { timeout: 30000 });
    expect(fixture.readObservations().filter(({ event, command }) => event === 'request' && command === 'approve_summary')).toHaveLength(1);
    await tui.exit();
  } finally { await fixture.cleanup(); }
});

it('interrupts only the named turn with Escape and keeps the TUI available for a new message', async () => {
  const fixture = managerDaemonFixture('en');
  try {
    const tui = await fixture.start(fixture.repository, undefined);
    await waitForManager(tui, 'Discuss your goal');
    await submitManagerText(tui, 'Interrupt this turn explicitly');
    await vi.waitFor(async () => expect((await fixture.state())?.running?.kind).toBe('message'), { timeout: 30000 });
    const operationId = (await fixture.state())!.running!.operationId;
    await tui.ready(operationId);
    await waitForManager(tui, 'Working');
    tui.key('\x1b[27u');
    await vi.waitFor(() => expect(fixture.readObservations()).toContainEqual(expect.objectContaining({
      event: 'request', pid: tui.child.pid, command: 'abort_turn', operationId,
    })), { timeout: 30000 });
    await vi.waitFor(async () => expect((await fixture.state())?.running).toBeNull(), { timeout: 30000 });
    expect(tui.child.exitCode).toBeNull();
    expect(fixture.readObservations().filter(({ event, agent }) => event === 'provider_complete' && agent === 'manager')).toEqual([]);
    fixture.release();
    await waitForManager(tui, 'Discuss your goal');
    await submitManagerText(tui, 'A new turn after Escape');
    await waitForManager(tui, fixture.summary.objective);
    await tui.exit();
  } finally { await fixture.cleanup(); }
});

it('removes a withdrawn standalone permission inquiry from the open menu on the same screen', async () => {
  const fixture = managerDaemonFixture('en');
  const owner = { kind: 'repository' as const, repositoryDirectory: fixture.repository };
  const inquiry = await saveManagerToolPermissionInquiry({ configDirectory: fixture.directory, owner,
    request: { toolName: 'Bash', toolInput: { command: 'git status' }, cwd: fixture.repository }, reason: 'Allow inspection of this repository?' });
  fixture.release();
  try {
    const tui = await fixture.start(fixture.repository, undefined);
    await waitForManager(tui, 'Discuss your goal');
    tui.key('\x12');
    await waitForManager(tui, inquiry.body);
    await new StandaloneInquiryStore(fixture.directory, owner).withdraw(inquiry.id, 'The operation is no longer needed');
    await vi.waitFor(async () => expect(await tui.frame()).not.toContain(inquiry.body), { timeout: 30000 });
    tui.key('\r');
    await tui.frame();
    expect(fixture.readObservations().filter(({ event, command }) => event === 'request' && command === 'answer_question')).toEqual([]);
    expect((await new StandaloneInquiryStore(fixture.directory, owner).get(inquiry.id)).status).toBe('withdrawn');
    await tui.exit();
  } finally { await fixture.cleanup(); }
});

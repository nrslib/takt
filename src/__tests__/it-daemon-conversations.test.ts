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
import { managerDaemonFixture, submitManagerText, waitForManager } from './helpers/manager-daemon-tui.js';
import { getLabel } from '../shared/i18n/index.js';
import { GoalStore } from '../infra/goals/store.js';
import { stripVTControlCharacters } from 'node:util';
import { goalRecord } from './helpers/goal-fixtures.js';
import { saveManagerToolPermissionInquiry } from '../features/manager/toolPermissionInquiry.js';
import { StandaloneInquiryStore } from '../infra/goals/standalone-inquiries.js';

const lifecycle = await import(pathToFileURL(join(process.cwd(), 'dist/features/daemon/lifecycle.js')).href) as typeof import('../features/daemon/lifecycle.js');

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
    await vi.waitFor(() => expect(polls()).toBeGreaterThanOrEqual(initialPolls + 3), { timeout: 5_000 });
    expect(readDaemonOwner(directory)).toEqual(owner); expect(isDaemonOwnerRunning(owner)).toBe(true);
    clients[0]!.socket.destroy();
    expect((await clients[1]!.request('submit', { attachmentId: second!.attachmentId, speaker: selected.speaker,
      command: { kind: 'message', text: 'あいことばキリン' } })).result).toMatchObject({ kind: 'accepted' });
    clients[1]!.socket.destroy();
    const store = new ConversationStore(directory);
    await vi.waitFor(() => expect(store.read(record.id, record.assignment)!.running).not.toBeNull());
    const duringPolls = polls();
    await vi.waitFor(() => expect(polls()).toBeGreaterThanOrEqual(duringPolls + 2), { timeout: 3_000 });
    expect(readDaemonOwner(directory)).toEqual(owner); expect(isDaemonOwnerRunning(owner)).toBe(true);
    await vi.waitFor(() => {
      expect(store.read(record.id, record.assignment)).toMatchObject({ revision: 5, pending: { revision: 5, summary }, running: null });
      expect(readDaemonOwner(directory)).toBeUndefined();
    }, { timeout: 12_000 });
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
    await waitForManager(tui, fixture.summary.objective);
    const owner = readDaemonOwner(fixture.directory)!;
    const calls = fixture.readObservations().filter(({ event }) => event === 'provider_start');
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.filter(({ pid }) => pid === tui.child.pid)).toEqual([]);
    expect(owner).toBeDefined();
    expect(calls.map(({ pid }) => pid)).toEqual([owner.pid]);
    await vi.waitFor(() => expect(fixture.state()).toMatchObject({ pending: { summary: fixture.summary }, running: null }));
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
    await vi.waitFor(() => expect(fixture.state()?.running?.kind).toBe('message'));
    const owner = readDaemonOwner(fixture.directory)!;
    await vi.waitFor(() => expect(fixture.readObservations()).toContainEqual(expect.objectContaining({ event: 'provider_start', pid: owner.pid })));
    await tui.exit();
    expect(fixture.state()?.running).toMatchObject({ kind: 'message' });
    fixture.release();
    await vi.waitFor(() => expect(fixture.state()).toMatchObject({ pending: { summary: fixture.summary }, running: null }), { timeout: 10000 });
    expect(fixture.readObservations()).toContainEqual(expect.objectContaining({ event: 'provider_complete', pid: owner.pid }));
  } finally { await fixture.cleanup(); }
});

it('reopens the same conversation and approves its restored summary with Ctrl+O', async () => {
  const fixture = managerDaemonFixture('en');
  fixture.release();
  try {
    const first = await fixture.start(fixture.repository, undefined);
    await waitForManager(first, 'Discuss your goal');
    await submitManagerText(first, 'Remember this proposal');
    await waitForManager(first, fixture.summary.objective);
    await vi.waitFor(() => expect(fixture.state()?.pending?.summary).toEqual(fixture.summary));
    const saved = fixture.state()!;
    await first.exit();
    const second = await fixture.start(fixture.repository, undefined);
    await waitForManager(second, fixture.summary.objective);
    const opens = fixture.readObservations().filter(({ event, method }) => event === 'request' && method === 'open');
    expect(opens.filter(({ pid }) => pid === first.child.pid).map(({ conversationId }) => conversationId)).toEqual([saved.id]);
    expect(opens.filter(({ pid }) => pid === second.child.pid).map(({ conversationId }) => conversationId)).toEqual([saved.id]);
    second.key('\x0f');
    await vi.waitFor(() => expect(fixture.state()?.approval?.state).toBe('registered'), { timeout: 10000 });
    const receipt = fixture.state()!.approval!;
    expect(receipt.revision).toBe(saved.pending!.revision);
    expect((await new GoalStore(fixture.repository).get(receipt.goalId)).objective).toBe(fixture.summary.objective);
    expect(fixture.readObservations()).toContainEqual(expect.objectContaining({ event: 'request', pid: second.child.pid,
      command: 'approve_summary', revision: saved.pending!.revision }));
    await second.exit();
  } finally { await fixture.cleanup(); }
});

it('connects two TUI processes for the same canonical assignment to the same saved conversation', async () => {
  const fixture = managerDaemonFixture('en');
  const saved = conversationRecord(fixture.repository);
  new ConversationStore(fixture.directory).write(saved);
  fixture.release();
  try {
    const first = await fixture.start(fixture.repository, undefined);
    const second = await fixture.start(fixture.repository, undefined);
    await waitForManager(first, saved.pending!.summary.objective);
    await waitForManager(second, saved.pending!.summary.objective);
    const opens = fixture.readObservations().filter(({ event, method }) => event === 'request' && method === 'open');
    for (const tui of [first, second]) {
      expect(opens.filter(({ pid }) => pid === tui.child.pid).map(({ conversationId }) => conversationId)).toEqual([saved.id]);
    }
    expect(fixture.state()?.pending).toEqual(saved.pending);
    expect(fixture.readObservations().filter(({ event }) => event === 'provider_start')).toEqual([]);
    await first.exit();
    await waitForManager(second, saved.pending!.summary.objective);
    const reopened = await fixture.start(fixture.repository, undefined);
    await waitForManager(reopened, saved.pending!.summary.objective);
    expect(fixture.state()).toMatchObject({ id: saved.id, revision: 4, pending: saved.pending });
    expect(fixture.readObservations().filter(({ event, method, pid }) => event === 'request' && method === 'open' && pid === reopened.child.pid)
      .map(({ conversationId }) => conversationId)).toEqual([saved.id]);
    await second.exit(); await reopened.exit();
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
    expect(fixture.state(other)?.pending).toBeNull();
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
    await vi.waitFor(() => expect(fixture.state()?.running?.kind).toBe('message'));
    const before = fixture.state()!;
    const owner = readDaemonOwner(fixture.directory)!;
    await lifecycle.stopDaemon();
    await first.exit();
    fixture.release();
    const second = await fixture.start(fixture.repository, undefined);
    await waitForManager(second, 'Discuss your goal');
    expect(readDaemonOwner(fixture.directory)!.pid).not.toBe(owner.pid);
    expect(fixture.state()).toMatchObject({ id: before.id, running: null });
    await submitManagerText(second, 'A new request after restart');
    await waitForManager(second, fixture.summary.objective);
    await vi.waitFor(() => expect(fixture.state()).toMatchObject({ id: before.id, pending: { summary: fixture.summary }, running: null }));
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
    tui.key('\x0f');
    await vi.waitFor(() => expect(fixture.readObservations()).toContainEqual(expect.objectContaining({
      event: 'provider_start', summaryRequest: true,
    })), { timeout: 5000 });
    const frame = stripVTControlCharacters(await tui.frame());
    const screen = frame.replace(/[│\s]+/gu, '').toLowerCase();
    const instructions = getLabel('manager.goSummaryRequest', language);
    for (const line of instructions.split(/[\n。.!?]+/u).filter((line) => line.trim().length > 20)) {
      expect(screen).not.toContain(line.replace(/\s+/gu, '').toLowerCase());
    }
    const status = frame.split('\n').filter((line) => !/\^O|Ctrl\+O|Enter|↑|↓/u.test(line)).join('\n');
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
    await vi.waitFor(() => expect(fixture.state()?.running?.kind).toBe('message'));
    await submitManagerText(tui, 'The rejected request');
    await waitForManager(tui, getLabel('manager.conversation.busy', 'en'));
    fixture.release();
    await waitForManager(tui, fixture.summary.objective);
    await vi.waitFor(() => expect(fixture.state()?.running).toBeNull());
    expect(fixture.readObservations().filter(({ event }) => event === 'provider_start')).toHaveLength(1);
    await tui.exit();
    expect(fixture.readObservations().filter(({ event }) => event === 'provider_start')).toHaveLength(1);
  } finally { await fixture.cleanup(); }
});

it('keeps a proposal arriving after busy Ctrl+O unregistered until a new explicit approval on the same screen', async () => {
  const fixture = managerDaemonFixture('en');
  try {
    const tui = await fixture.start(fixture.repository, undefined);
    await waitForManager(tui, 'Discuss your goal');
    await submitManagerText(tui, 'Prepare the proposal while this turn is active');
    await vi.waitFor(() => expect(fixture.state()?.running?.kind).toBe('message'));
    const operationId = fixture.state()!.running!.operationId;
    await tui.ready(operationId);
    expect(fixture.state()?.pending).toBeNull();
    tui.key('\x0f');
    await waitForManager(tui, getLabel('manager.conversation.busy', 'en'));
    fixture.release();
    await waitForManager(tui, fixture.summary.objective);
    await tui.ready(null);
    const requests = () => fixture.readObservations().filter(({ event, pid }) => event === 'request' && pid === tui.child.pid);
    const previousReads = requests().filter(({ method }) => method === 'snapshot').length;
    tui.key('\x0e');
    await vi.waitFor(() => expect(requests().filter(({ method }) => method === 'snapshot').length).toBeGreaterThan(previousReads));
    await tui.ready(null);
    const proposal = fixture.state()!.pending!;
    expect(proposal.summary).toEqual(fixture.summary);
    expect(fixture.state()?.approval).toBeNull();
    expect(requests().filter(({ command }) => command === 'message')).toHaveLength(2);
    expect(requests().filter(({ command }) => command === 'approve_summary')).toEqual([]);
    expect(fixture.readObservations().filter(({ event }) => event === 'provider_start')).toHaveLength(1);
    expect(fixture.readObservations().filter(({ event, approvalState }) => event === 'write' && approvalState != null)).toEqual([]);
    const goals = new GoalStore(fixture.repository);
    expect((await goals.list()).goals).toEqual([]);
    await vi.waitFor(async () => expect(await tui.frame()).not.toContain('Working'));
    tui.key('\x0f');
    await vi.waitFor(() => expect(fixture.state()?.approval).toMatchObject({ state: 'registered', revision: proposal.revision }), { timeout: 10000 });
    const receipt = fixture.state()!.approval!;
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
    expect(fixture.readObservations().filter(({ event }) => event === 'provider_start'))
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
    await vi.waitFor(() => expect(fixture.state()).toMatchObject({ revision: 5, running: null }));
    await tui.ready(null);
    await vi.waitFor(async () => expect(await tui.frame()).not.toContain('Working'));
    tui.key('\x0f');
    await vi.waitFor(() => expect(fixture.readObservations()).toContainEqual(expect.objectContaining({
      event: 'request', pid: tui.child.pid, command: 'approve_summary', revision: 5,
    })));
    await vi.waitFor(() => expect(fixture.state()?.approval).toMatchObject({ revision: 5, state: 'registered' }), { timeout: 10000 });
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
    await vi.waitFor(async () => expect(await tui.frame()).toMatch(/disconnect|reconnect|incomplete|shutting down/iu));
    await tui.ready();
    const second = await fixture.start(fixture.repository, undefined);
    await waitForManager(second, saved.pending!.summary.objective);
    expect(readDaemonIpcState(fixture.directory)!.capability).not.toBe(oldCapability);
    await vi.waitFor(() => {
      const opens = fixture.readObservations().filter(({ event, method, pid }) => event === 'request' && method === 'open' && pid === tui.child.pid);
      expect(opens.length).toBeGreaterThanOrEqual(2);
      expect(opens.every(({ conversationId }) => conversationId === saved.id)).toBe(true);
    }, { timeout: 10000 });
    await waitForManager(tui, saved.pending!.summary.objective);
    await tui.ready();
    tui.key('Continue from the same screen');
    await waitForManager(tui, 'Continue from the same screen');
    await vi.waitFor(async () => {
      expect(fixture.state()).toMatchObject({ pending: null, running: null });
      expect(await tui.frame()).not.toContain('Working');
    });
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
  const goal = goalRecord();
  const goalDirectory = join(fixture.repository, '.takt', 'goals', goal.id);
  mkdirSync(goalDirectory, { recursive: true });
  const path = join(goalDirectory, 'goal.json');
  writeFileSync(path, '{broken');
  fixture.release();
  try {
    const tui = await fixture.start(fixture.repository, undefined);
    await vi.waitFor(async () => expect(await tui.frame()).toMatch(/incomplete|refresh|read.*fail|fail.*read/iu));
    tui.key('\x0f');
    await tui.frame();
    expect(fixture.readObservations().filter(({ event, command }) => event === 'request' && command === 'approve_summary')).toEqual([]);
    expect(fixture.state()?.approval).toBeNull();
    writeFileSync(path, JSON.stringify(goal));
    await waitForManager(tui, saved.pending!.summary.objective);
    await tui.ready();
    tui.key('\x0f');
    await vi.waitFor(() => expect(fixture.state()?.approval).toMatchObject({ revision: 4, state: 'registered' }), { timeout: 10000 });
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
    await vi.waitFor(() => expect(fixture.state()?.running?.kind).toBe('message'));
    const operationId = fixture.state()!.running!.operationId;
    await tui.ready(operationId);
    await waitForManager(tui, 'Working');
    tui.key('\x1b[27u');
    await vi.waitFor(() => expect(fixture.readObservations()).toContainEqual(expect.objectContaining({
      event: 'request', pid: tui.child.pid, command: 'abort_turn', operationId,
    })));
    await vi.waitFor(() => expect(fixture.state()?.running).toBeNull());
    expect(tui.child.exitCode).toBeNull();
    expect(fixture.readObservations().filter(({ event }) => event === 'provider_complete')).toEqual([]);
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
    await vi.waitFor(async () => expect(await tui.frame()).not.toContain(inquiry.body), { timeout: 5000 });
    tui.key('\r');
    await tui.frame();
    expect(fixture.readObservations().filter(({ event, command }) => event === 'request' && command === 'answer_question')).toEqual([]);
    expect((await new StandaloneInquiryStore(fixture.directory, owner).get(inquiry.id)).status).toBe('withdrawn');
    await tui.exit();
  } finally { await fixture.cleanup(); }
});

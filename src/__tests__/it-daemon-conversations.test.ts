import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it, vi } from 'vitest';
import { Client } from './helpers/conversation-ipc-client.js';
import { getGlobalConfigDir } from '../infra/config/paths.js';
import { readDaemonOwner, isDaemonOwnerRunning } from '../infra/daemon/owner.js';
import { readDaemonIpcState } from '../infra/daemon/ipcEndpoint.js';
import { createTuiConversationPort } from '../features/manager/tuiConversationPort.js';
import { writeLegacyConversation, conversationRecord } from './helpers/conversation-fixtures.js';
import { captureOwnedProcess, terminateOwnedProcess } from './helpers/owned-process.js';
import { managerDaemonFixture, submitManagerText, waitForManager, type ManagerTuiProcess } from './helpers/manager-daemon-tui.js';
import { concurrentTuiFixture } from './helpers/concurrent-tui-ipc.js';
import { getLabel } from '../shared/i18n/index.js';
import { GoalStore } from '../infra/goals/store.js';
import { ConversationStateStore } from '../infra/daemon/conversationStateStore.js';
import { stripVTControlCharacters } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { goalRecord } from './helpers/goal-fixtures.js';
import { StandaloneInquiryStore } from '../infra/goals/standalone-inquiries.js';
import { randomUUID } from 'node:crypto';

const lifecycle = await import(pathToFileURL(join(process.cwd(), 'dist/features/daemon/lifecycle.js')).href) as typeof import('../features/daemon/lifecycle.js');

async function waitForQueuedMessage(tui: ManagerTuiProcess): Promise<void> {
  const message = getLabel('manager.conversation.queued', 'en', { count: '1' }).replace(/\s+/gu, '');
  await vi.waitFor(async () => expect((await tui.frame()).replace(/\s+/gu, '')).toContain(message), { timeout: 30000 });
}

async function waitForManagerNormalized(tui: ManagerTuiProcess, text: string): Promise<void> {
  await vi.waitFor(async () => expect((await tui.frame()).replace(/\s+/gu, ' ')).toContain(text), { timeout: 30000 });
}

function addRemoteTrackingMain(repository: string): void {
  const commit = execFileSync('git', ['rev-parse', 'refs/heads/main'], { cwd: repository, encoding: 'utf8', stdio: 'pipe' }).trim();
  execFileSync('git', ['update-ref', 'refs/remotes/origin/main', commit], { cwd: repository, stdio: 'pipe' });
  expect(execFileSync('git', ['rev-parse', '--verify', 'refs/remotes/origin/main^{commit}'],
    { cwd: repository, encoding: 'utf8', stdio: 'pipe' }).trim()).toBe(commit);
  expect(execFileSync('git', ['for-each-ref', '--format=%(refname)', 'refs/heads/origin/main'],
    { cwd: repository, encoding: 'utf8', stdio: 'pipe' }).trim()).toBe('');
}

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

it('executes provider calls in a conversation child and saves its result in the daemon after TUI input', async () => {
  const fixture = managerDaemonFixture('en');
  fixture.release();
  try {
    const tui = await fixture.start(fixture.repository, undefined);
    await waitForManager(tui, 'Discuss your goal');
    await submitManagerText(tui, 'Prepare a CSV export');
    const owner = (await readDaemonOwner(fixture.directory))!;
    expect(owner).toBeDefined();
    await vi.waitFor(() => expect(fixture.readObservations()).toContainEqual(expect.objectContaining({
      event: 'provider_complete', agent: 'manager', pid: expect.any(Number),
    })), { timeout: 10000 });
    await waitForManager(tui, fixture.summary.objective);
    const calls = fixture.readObservations().filter(({ event }) => event === 'provider_start');
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.filter(({ pid }) => pid === tui.child.pid)).toEqual([]);
    expect(calls.every(({ pid }) => pid !== owner.pid && pid !== tui.child.pid)).toBe(true);
    expect(calls.filter(({ agent }) => agent === 'manager')).toHaveLength(1);
    expect(calls.filter(({ agent }) => agent === 'director')).toEqual([]);
    await vi.waitFor(async () => expect((await fixture.state())).toMatchObject({ pending: { summary: fixture.summary }, running: null }), { timeout: 30000 });
    const writes = fixture.readObservations().filter(({ event }) => event === 'write');
    expect(writes.some(({ pid, running }) => pid === owner.pid && !running)).toBe(true);
    expect(writes.filter(({ pid }) => pid === tui.child.pid)).toEqual([]);
    expect(fixture.readObservations().filter(({ event, pid }) => event === 'provider_start' && pid === tui.child.pid)).toEqual([]);
    await tui.exit();
  } finally { await fixture.cleanup(); }
});

it.each(['ja', 'en'] as const)('delivers descriptions and ordered text from the real turn child without replaying or saving text (%s)', async (lang) => {
  const fixture = managerDaemonFixture(lang, ['Activity completed'], true);
  try {
    const tui = await fixture.start(fixture.repository, undefined);
    await tui.ready();
    await submitManagerText(tui, 'Show current activity');
    await waitForManager(tui, getLabel('tui.ui.extendedThinking', lang));
    fixture.useTool();
    await waitForManager(tui, '見回りの予定のコードを読む');
    const beforeReconnect = await tui.frame();
    expect(beforeReconnect).toContain('コードを読んでいるところです。');
    expect(beforeReconnect.indexOf('コードを読んでいるところです。')).toBeLessThan(beforeReconnect.indexOf('見回りの予定のコードを読む'));
    expect(await tui.frame()).not.toContain('private-');
    await tui.exit();
    const reconnected = await fixture.start(fixture.repository, undefined);
    await waitForManager(reconnected, '見回りの予定のコードを読む');
    const during = await reconnected.frame();
    expect(during).not.toContain('private-');
    expect(during).not.toContain('コードを読んでいるところです。');
    expect(during.split('\n').find((row) => row.includes('見回りの予定のコードを読む'))).toMatch(/\b\d+(?:m\d{2})?s\b/u);
    const owner = (await readDaemonOwner(fixture.directory))!;
    const calls = fixture.readObservations().filter(({ event, agent }) => event === 'provider_start' && agent === 'manager');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.pid).not.toBe(owner.pid);
    expect(calls[0]!.pid).not.toBe(tui.child.pid);
    fixture.release();
    await waitForManager(reconnected, 'Activity completed');
    await vi.waitFor(async () => expect((await fixture.state())?.turn).toBeNull(), { timeout: 10000 });
    const frame = await reconnected.frame();
    expect(frame).not.toContain('見回りの予定のコードを読む');
    expect(frame).not.toContain('調べがつきました。');
    expect(frame.split('Activity completed')).toHaveLength(2);
    expect(frame).not.toContain(getLabel('tui.ui.extendedThinking', lang));
    expect(frame).not.toContain('private-');
    const saved = JSON.stringify(await fixture.state());
    for (const transient of ['見回りの予定のコードを読む', 'コードを読んでいるところです。', '調べがつきました。']) expect(saved).not.toContain(transient);
    expect(saved).not.toContain('private-');
    await reconnected.exit();
  } finally { fixture.release(); await fixture.cleanup(); }
});

it('finishes an accepted turn after Ctrl+C has exited the TUI process', async () => {
  const fixture = managerDaemonFixture('en');
  try {
    const tui = await fixture.start(fixture.repository, undefined);
    await waitForManager(tui, 'Discuss your goal');
    await submitManagerText(tui, 'Continue after I close this screen');
    await vi.waitFor(async () => expect((await fixture.state())?.turn).toMatchObject({ operationId: expect.any(String) }), { timeout: 30000 });
    const owner = (await readDaemonOwner(fixture.directory))!;
    await vi.waitFor(() => expect(fixture.readObservations()).toContainEqual(expect.objectContaining({ event: 'provider_start', agent: 'manager', pid: expect.any(Number) })), { timeout: 30000 });
    await tui.exit();
    expect((await fixture.state())?.turn).toMatchObject({ operationId: expect.any(String) });
    fixture.release();
    await vi.waitFor(async () => expect((await fixture.state())).toMatchObject({ pending: { summary: fixture.summary }, running: null }), { timeout: 30000 });
    expect(fixture.readObservations()).toContainEqual(expect.objectContaining({ event: 'provider_complete', agent: 'manager', pid: expect.any(Number) }));
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
    const firstFrame = await first.frame();
    await first.exit();
    const second = await fixture.start(fixture.repository, undefined);
    await waitForManager(second, fixture.summary.objective);
    const notice = getLabel('manager.experimentalNotice', 'en').replace(/\s+/gu, '');
    for (const frame of [firstFrame, await second.frame()]) {
      const text = stripVTControlCharacters(frame).replace(/\s+/gu, '');
      expect(text.startsWith(notice)).toBe(true);
      expect(text.split(notice)).toHaveLength(2);
      expect(text.indexOf(notice)).toBeLessThan(text.indexOf(fixture.summary.objective.replace(/\s+/gu, '')));
    }
    expect(JSON.stringify(await fixture.state()).replace(/\s+/gu, '')).not.toContain(notice);
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

it('rejects an invalid branch proposal without saving it, then accepts a message and /make-goal', async () => {
  const fixture = managerDaemonFixture('en');
  const saved = conversationRecord(fixture.repository);
  addRemoteTrackingMain(fixture.repository);
  fixture.setResponses([
    { message: 'The proposal uses an unavailable local branch.', summary: { ...fixture.summary, startBranch: 'origin/main' } },
    { message: 'The conversation can continue.', summary: null },
    { message: 'A fresh proposal is ready.', summary: fixture.summary },
  ]);
  fixture.release();
  const conversations = new ConversationStateStore(fixture.directory);
  try {
    const tui = await fixture.start(fixture.repository, undefined);
    await waitForManager(tui, 'Discuss your goal');
    await submitManagerText(tui, 'Prepare a CSV export');
    await waitForManager(tui, 'Unable to resolve local branch');
    await vi.waitFor(async () => expect((await conversations.read(saved.id))?.record)
      .toMatchObject({ pending: null, approval: null, running: null }), { timeout: 30000 });

    await submitManagerText(tui, 'Continue after the rejected proposal');
    await waitForManager(tui, 'The conversation can continue.');
    await vi.waitFor(async () => expect((await conversations.read(saved.id))?.record)
      .toMatchObject({ pending: null, approval: null, running: null }), { timeout: 30000 });

    await submitManagerText(tui, '/make-goal');
    await waitForManager(tui, fixture.summary.objective);
    await vi.waitFor(async () => expect((await conversations.read(saved.id))?.record)
      .toMatchObject({ pending: { summary: fixture.summary }, approval: null, running: null }), { timeout: 30000 });
    const observations = fixture.readObservations();
    expect(observations.filter(({ event, summaryRequest }) => event === 'provider_start' && summaryRequest)).toHaveLength(1);
    const submissions = observations.filter(({ event }) => event === 'submit_result');
    expect(submissions.map(({ command }) => command)).toEqual(['message', 'message', 'message']);
    expect(submissions.map(({ kind }) => kind)).toEqual(['accepted', 'accepted', 'accepted']);
    expect(await tui.frame()).not.toContain(getLabel('manager.conversation.registration_recovery', 'en'));
    expect((await new GoalStore(fixture.repository).list()).goals).toEqual([]);
    await tui.exit();
  } finally { await fixture.cleanup(); }
});

it('releases a persisted same-revision reservation and accepts dismissal, messages, and /make-goal', async () => {
  const fixture = managerDaemonFixture('en');
  const saved = conversationRecord(fixture.repository);
  addRemoteTrackingMain(fixture.repository);
  const originalPending = saved.pending!;
  saved.pending = { ...originalPending, summary: { ...originalPending.summary, startBranch: 'origin/main' } };
  const goalId = randomUUID();
  saved.approval = { state: 'reserved', revision: originalPending.revision, goalId, repositoryDirectory: fixture.repository };
  writeLegacyConversation(fixture.directory, saved);
  fixture.setResponses([
    { message: 'The conversation has recovered.', summary: null },
    { message: 'A fresh proposal is ready.', summary: fixture.summary },
  ]);
  fixture.release();
  const conversations = new ConversationStateStore(fixture.directory);
  try {
    const tui = await fixture.start(fixture.repository, undefined);
    await waitForManager(tui, originalPending.summary.objective);
    await tui.approveSummary(originalPending.revision);
    await waitForManagerNormalized(tui, 'Unable to resolve local branch "origin/main" to a commit');
    await vi.waitFor(async () => expect((await conversations.read(saved.id))?.record).toMatchObject({
      revision: originalPending.revision,
      pending: { revision: originalPending.revision, summary: { startBranch: 'origin/main' } },
      approval: null,
      running: null,
    }), { timeout: 30000 });
    expect((await conversations.read(saved.id))?.state.version).toBeGreaterThan(0);
    expect(execFileSync('git', ['for-each-ref', '--format=%(refname)', `refs/heads/takt/*-goal-${goalId.slice(0, 8)}`],
      { cwd: fixture.repository, encoding: 'utf8', stdio: 'pipe' }).trim()).toBe('');

    await tui.ready(null);
    tui.key('\x1b');
    await vi.waitFor(async () => expect((await conversations.read(saved.id))?.record)
      .toMatchObject({ pending: null, approval: null, running: null }), { timeout: 30000 });
    expect(fixture.readObservations().filter(({ event, command, kind }) => event === 'submit_result'
      && command === 'dismiss_summary').map(({ kind }) => kind)).toEqual(['accepted']);

    await submitManagerText(tui, 'Continue after clearing the reservation');
    await waitForManager(tui, 'The conversation has recovered.');
    await vi.waitFor(async () => expect((await conversations.read(saved.id))?.record)
      .toMatchObject({ pending: null, approval: null, running: null }), { timeout: 30000 });

    await submitManagerText(tui, '/make-goal');
    await waitForManager(tui, fixture.summary.objective);
    await vi.waitFor(async () => expect((await conversations.read(saved.id))?.record)
      .toMatchObject({ pending: { summary: fixture.summary }, approval: null, running: null }), { timeout: 30000 });
    const observations = fixture.readObservations();
    expect(observations.filter(({ event, summaryRequest }) => event === 'provider_start' && summaryRequest)).toHaveLength(1);
    const submissions = observations.filter(({ event }) => event === 'submit_result');
    expect(submissions.map(({ command }) => command)).toEqual(['approve_summary', 'dismiss_summary', 'message', 'message']);
    expect(submissions.map(({ kind }) => kind)).toEqual(['accepted', 'accepted', 'accepted', 'accepted']);
    expect(await tui.frame()).not.toContain(getLabel('manager.conversation.registration_recovery', 'en'));
    await tui.exit();
  } finally { await fixture.cleanup(); }
});

it('connects two TUI processes for the same canonical assignment to the same saved conversation', async () => {
  const fixture = managerDaemonFixture('ja');
  const saved = conversationRecord(fixture.repository);
  writeLegacyConversation(fixture.directory, saved);
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
    await vi.waitFor(async () => expect((await fixture.state())?.turn).toBeNull(), { timeout: 30000 });
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
  writeLegacyConversation(fixture.directory, saved);
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
  writeLegacyConversation(fixture.directory, saved);
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
    await vi.waitFor(async () => expect((await fixture.state())?.turn).toMatchObject({ operationId: expect.any(String) }), { timeout: 30000 });
    const before = (await fixture.state())!;
    const owner = (await readDaemonOwner(fixture.directory))!;
    await lifecycle.stopDaemon();
    await first.exit();
    fixture.release();
    const second = await fixture.start(fixture.repository, undefined);
    await waitForManager(second, 'Discuss your goal');
    expect((await readDaemonOwner(fixture.directory))!.pid).not.toBe(owner.pid);
    expect((await fixture.state())).toMatchObject({ id: before.id, running: null,
      interruptedMessage: 'This turn will be interrupted' });
    await submitManagerText(second, 'A new request after restart');
    await waitForManager(second, fixture.summary.objective);
    await vi.waitFor(async () => expect((await fixture.state())).toMatchObject({ id: before.id, pending: { summary: fixture.summary },
      running: null, interruptedMessage: null }), { timeout: 30000 });
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
    expect(status).toContain(getLabel('manager.summaryWorking', language));
    fixture.release();
    await waitForManager(tui, fixture.summary.objective);
    await tui.exit();
  } finally { await fixture.cleanup(); }
});

it('accepts a busy TUI message and executes it after the active turn completes', async () => {
  const fixture = managerDaemonFixture('en');
  try {
    const tui = await fixture.start(fixture.repository, undefined);
    await waitForManager(tui, 'Discuss your goal');
    await submitManagerText(tui, 'The accepted request');
    await vi.waitFor(async () => expect((await fixture.state())?.turn).toMatchObject({ operationId: expect.any(String) }), { timeout: 30000 });
    await submitManagerText(tui, 'The queued request');
    await waitForQueuedMessage(tui);
    fixture.release();
    await waitForManager(tui, fixture.summary.objective);
    await vi.waitFor(async () => expect((await fixture.state())?.turn).toBeNull(), { timeout: 30000 });
    await vi.waitFor(() => expect(fixture.readObservations().filter(({ event, agent }) => event === 'provider_start' && agent === 'manager')).toHaveLength(2));
    await tui.exit();
    expect(fixture.readObservations().filter(({ event, agent }) => event === 'provider_start' && agent === 'manager')).toHaveLength(2);
  } finally { await fixture.cleanup(); }
});

it('keeps the queued /make-goal proposal unregistered until explicit approval on the same screen', async () => {
  const fixture = managerDaemonFixture('en');
  try {
    const tui = await fixture.start(fixture.repository, undefined);
    await waitForManager(tui, 'Discuss your goal');
    await submitManagerText(tui, 'Prepare the proposal while this turn is active');
    await vi.waitFor(async () => expect((await fixture.state())?.turn).toMatchObject({ operationId: expect.any(String) }), { timeout: 30000 });
    await vi.waitFor(() => expect(fixture.readObservations().filter(({ event, agent }) => event === 'provider_start' && agent === 'manager')).toHaveLength(1), { timeout: 30000 });
    const current = (await fixture.state())!;
    const operationId = current.turn!.operationId;
    await tui.ready(operationId);
    expect((await fixture.state())?.pending).toBeNull();
    await submitManagerText(tui, '/make-goal');
    await waitForQueuedMessage(tui);
    fixture.release();
    await waitForManager(tui, fixture.summary.objective);
    await vi.waitFor(async () => expect(await fixture.state()).toMatchObject({
      revision: current.revision + 1, pending: { revision: current.revision + 1 }, running: null,
    }), { timeout: 30000 });
    await tui.ready(null);
    const requests = () => fixture.readObservations().filter(({ event, pid }) => event === 'request' && pid === tui.child.pid);
    const proposal = (await fixture.state())!.pending!;
    expect(proposal.summary).toEqual(fixture.summary);
    expect((await fixture.state())?.approval).toBeNull();
    expect(requests().filter(({ command }) => command === 'message')).toHaveLength(2);
    expect(requests().filter(({ command }) => command === 'approve_summary')).toEqual([]);
    expect(fixture.readObservations().filter(({ event, agent }) => event === 'provider_start' && agent === 'manager')).toHaveLength(2);
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

it('passes CLI provider and model overrides to the turn process even when the configured provider differs', async () => {
  const fixture = managerDaemonFixture('en');
  writeFileSync(join(fixture.directory, 'config.yaml'), 'provider: codex\nlanguage: en\nmanager:\n  auto_run: false\n');
  fixture.release();
  try {
    const tui = await fixture.start(fixture.repository, 'selected-manager-model');
    await waitForManager(tui, 'Discuss your goal');
    await submitManagerText(tui, 'Use my selected model');
    await waitForManager(tui, fixture.summary.objective);
    const owner = (await readDaemonOwner(fixture.directory))!;
    expect(owner).toBeDefined();
    const calls = fixture.readObservations().filter(({ event, agent }) => event === 'provider_start' && agent === 'manager');
    expect(calls).toEqual([expect.objectContaining({ model: 'selected-manager-model' })]);
    expect(calls[0]!.pid).not.toBe(owner.pid);
    expect(calls[0]!.pid).not.toBe(tui.child.pid);
    await tui.exit();
  } finally { await fixture.cleanup(); }
});

it.each(['ja', 'en'] as const)('updates the restored proposal on the same mounted screen and approves only the new revision in %s', async (language) => {
  const fixture = managerDaemonFixture(language);
  const saved = conversationRecord(fixture.repository);
  const normalize = (text: string): string => text.replace(/\s+/gu, '').toLowerCase();
  const summaryValues = (summary: typeof fixture.summary): string[] => [
    summary.objective, ...summary.outOfScope, ...summary.acceptanceCriteria, ...summary.constraints,
  ];
  const previousValues = summaryValues(saved.pending!.summary);
  const nextValues = summaryValues(fixture.summary);
  const expectProposalFrame = (frame: string, updated: boolean): void => {
    const rows = stripVTControlCharacters(frame).split('\n');
    const heading = getLabel('manager.assignmentHeading', language, { name: basename(fixture.repository) });
    const status = [heading, getLabel('manager.counts', language, { goals: '0', awaiting: '0', questions: '0' })].join(' | ');
    expect(rows.filter((row) => row.trim() === status)).toHaveLength(1);
    expect(rows.filter((row) => row.trim() !== '').at(-1)?.trim()).toBe(status);
    const confirmation = getLabel('manager.summary.confirmation', language);
    const confirmationRow = rows.map((row) => row.includes(confirmation)).lastIndexOf(true);
    expect(confirmationRow).toBeGreaterThan(0);
    const start = rows.slice(0, confirmationRow).map((row) => row.startsWith('╭')).lastIndexOf(true);
    expect(start).toBeGreaterThanOrEqual(0);
    const history = normalize(rows.slice(0, start).join('\n'));
    const liveRows = rows.slice(start);
    const live = liveRows.join('\n');
    const normalizedLive = normalize(live);
    for (const value of previousValues) expect(history.split(normalize(value))).toHaveLength(2);
    for (const value of nextValues) expect(history.split(normalize(value))).toHaveLength(updated ? 2 : 1);
    for (const value of [fixture.repository, getLabel('manager.summary.title', language)]) {
      expect(history.split(normalize(value))).toHaveLength(updated ? 3 : 2);
    }
    if (updated) expect(history.indexOf(normalize(previousValues[0]!))).toBeLessThan(history.indexOf(normalize(nextValues[0]!)));
    for (const value of [fixture.repository, ...previousValues, ...nextValues]) {
      expect(normalizedLive).not.toContain(normalize(value));
    }
    expect(liveRows.length).toBeLessThanOrEqual(24);
    expect(normalizedLive.split(normalize(confirmation))).toHaveLength(2);
    const dialogs = live.match(/╭[^\n]*\n[\s\S]*?╰[^\n]*/gu);
    expect(dialogs).not.toBeNull();
    const summaryDialogs = dialogs!.filter((dialog) => dialog.includes(confirmation));
    expect(summaryDialogs).toHaveLength(1);
    const contents = summaryDialogs[0]!.split('\n').slice(1, -1).map((row) => row.replace(/^│\s*|\s*│$/gu, ''));
    expect(contents.slice(0, 3)).toEqual([confirmation, getLabel('manager.summary.approve', language), getLabel('manager.summary.continue', language)]);
    expect(normalize(contents.slice(3).join(''))).toBe(normalize(getLabel('manager.summary.dismissHint', language)));
  };
  writeLegacyConversation(fixture.directory, saved);
  fixture.release();
  let observer: Client | undefined;
  try {
    const tui = await fixture.start(fixture.repository, undefined);
    await waitForManager(tui, saved.pending!.summary.objective);
    await vi.waitFor(async () => expectProposalFrame(await tui.frame(), false), { timeout: 30000 });
    const requests = () => fixture.readObservations().filter(({ event, pid }) => event === 'request' && pid === tui.child.pid);
    const goals = new GoalStore(fixture.repository);
    const ipc = (await readDaemonIpcState(fixture.directory))!;
    observer = new Client(ipc.endpoint);
    await observer.request('hello', { capability: ipc.capability });
    const selected = await createTuiConversationPort(fixture.directory, { deliver: async () => ({ kind: 'delivered' }) }).resolve(saved.assignment);
    const opened = (await observer.request('open', selected)).result!;
    await observer.items(opened.read.transferId);
    expect((await observer.request('submit', { attachmentId: opened.attachmentId, speaker: selected.speaker,
      command: { kind: 'message', text: 'Replace the restored proposal' } })).result?.kind).toBe('accepted');
    await waitForManager(tui, fixture.summary.objective);
    await vi.waitFor(async () => expectProposalFrame(await tui.frame(), true), { timeout: 30000 });
    await vi.waitFor(async () => expect((await fixture.state())).toMatchObject({ revision: 5, running: null, approval: null,
      pending: { revision: 5, repositoryDirectory: fixture.repository, summary: fixture.summary } }), { timeout: 30000 });
    const snapshotsBefore = requests().filter(({ method }) => method === 'snapshot').length;
    await vi.waitFor(() => expect(requests().filter(({ method }) => method === 'snapshot').length)
      .toBeGreaterThanOrEqual(snapshotsBefore + 2), { timeout: 30000 });
    const samples = await tui.observeFrames();
    expect(samples).toHaveLength(30);
    for (const sample of samples) {
      expect(sample.readStatus).toBe('complete');
      expectProposalFrame(sample.frame, true);
    }
    expect(requests().filter(({ command }) => command === 'approve_summary')).toEqual([]);
    expect((await goals.list()).goals).toEqual([]);
    await tui.approveSummary(5);
    await vi.waitFor(async () => expect((await fixture.state())?.approval).toMatchObject({ revision: 5, state: 'registered' }), { timeout: 30000 });
    const receipt = (await fixture.state())!.approval!;
    expect((await goals.get(receipt.goalId))).toMatchObject(fixture.summary);
    expect((await goals.list()).goals.map(({ id }) => id)).toEqual([receipt.goalId]);
    await tui.exit();
    expect(requests().filter(({ command }) => command === 'approve_summary'))
      .toEqual([expect.objectContaining({ revision: 5 })]);
  } finally { observer?.socket.destroy(); await fixture.cleanup(); }
});

it('reauthenticates and restores the proposal on the same mounted screen after a daemon restart', async () => {
  const fixture = managerDaemonFixture('en');
  const saved = conversationRecord(fixture.repository);
  writeLegacyConversation(fixture.directory, saved);
  fixture.release();
  try {
    const tui = await fixture.start(fixture.repository, undefined);
    await waitForManager(tui, saved.pending!.summary.objective);
    const oldCapability = (await readDaemonIpcState(fixture.directory))!.capability;
    await lifecycle.stopDaemon();
    await vi.waitFor(async () => expect(await tui.frame()).toMatch(/disconnect|reconnect|incomplete|shutting down/iu), { timeout: 30000 });
    await tui.ready();
    const second = await fixture.start(fixture.repository, undefined);
    await waitForManager(second, saved.pending!.summary.objective);
    expect((await readDaemonIpcState(fixture.directory))!.capability).not.toBe(oldCapability);
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
  writeLegacyConversation(fixture.directory, saved);
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
    await vi.waitFor(async () => expect((await fixture.state())?.turn).toMatchObject({ operationId: expect.any(String) }), { timeout: 30000 });
    const operationId = (await fixture.state())!.turn!.operationId;
    await tui.ready(operationId);
    await waitForManager(tui, getLabel('tui.ui.thinking', 'en'));
    tui.key('\x1b[27u');
    await vi.waitFor(() => expect(fixture.readObservations()).toContainEqual(expect.objectContaining({
      event: 'request', pid: tui.child.pid, command: 'abort_turn', operationId,
    })), { timeout: 30000 });
    await vi.waitFor(async () => expect((await fixture.state())?.turn).toBeNull(), { timeout: 30000 });
    await vi.waitFor(async () => expect((await fixture.state())?.interruptedMessage).toBe('Interrupt this turn explicitly'), { timeout: 30000 });
    expect(tui.child.exitCode).toBeNull();
    expect(fixture.readObservations().filter(({ event, agent }) => event === 'provider_complete' && agent === 'manager')).toEqual([]);
    fixture.release();
    await waitForManager(tui, 'Discuss your goal');
    await submitManagerText(tui, 'A new turn after Escape');
    await waitForManager(tui, fixture.summary.objective);
    expect((await fixture.state())?.interruptedMessage).toBeNull();
    await tui.exit();
  } finally { await fixture.cleanup(); }
});

it('removes a withdrawn standalone permission inquiry from the open menu on the same screen', async () => {
  const fixture = managerDaemonFixture('en');
  const owner = { kind: 'repository' as const, repositoryDirectory: fixture.repository };
  const inquiry = await new StandaloneInquiryStore(fixture.directory, owner).create({ body: 'Allow inspection of this repository?' });
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

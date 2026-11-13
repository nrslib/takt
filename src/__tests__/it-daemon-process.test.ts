import { Client } from './helpers/conversation-ipc-client.js';
import { snapshotItemKey } from '../features/manager/snapshotChanges.js';
import type { SnapshotItem } from '../features/manager/conversationPort.js';
import { createTuiConversationPort } from '../features/manager/tuiConversationPort.js';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { getGlobalConfigDir } from '../infra/config/paths.js';
import { readDaemonOwner, isDaemonOwnerRunning, writeDaemonOwner } from '../infra/daemon/owner.js';
import { readDaemonIpcState } from '../infra/daemon/ipcEndpoint.js';
import { isConversationIpcReady } from '../features/daemon/conversationReadiness.js';
import { packageVersion } from '../shared/package-info.js';
import { createWorkspace } from '../infra/config/global/workspaceRegistry.js';
import { EpicStore } from '../infra/epics/store.js';
import { getEpic } from '../infra/epics/index.js';
import { applyEpicVerificationResult, beginEpicVerification, finishEpic, reviseEpic } from '../infra/epics/state.js';
import { DaemonNotifications } from '../infra/daemon/notifications.js';
import { EventRecordSchema } from '../infra/daemon/eventRecord.js';
import { EpicSchema } from '../infra/epics/schema.js';
import { completedEpicGoal, epicRecord, verificationResultFor, verificationRunId, verificationStartedAt } from './helpers/epic-fixtures.js';

const lifecycle = await import(pathToFileURL(join(process.cwd(), 'dist/features/daemon/lifecycle.js')).href) as typeof import('../features/daemon/lifecycle.js');
const io = () => ({ signal: new AbortController().signal, timeoutMs: 5000 });
afterEach(async () => { await lifecycle.stopDaemon(); });

it('starts the dedicated daemon entry, confirms authenticated IPC, reuses the owner and stops it', async () => {
  await lifecycle.ensureDaemon();
  const directory = getGlobalConfigDir();
  const owner = (await readDaemonOwner(directory))!;
  expect(owner).toMatchObject({ version: packageVersion, cliPath: lifecycle.daemonEntryPath() });
  expect(owner.pid).not.toBe(process.pid);
  expect(await isDaemonOwnerRunning(owner, io())).toBe(true);
  expect(await isConversationIpcReady(directory, owner)).toBe(true);
  await lifecycle.ensureDaemon();
  expect(await readDaemonOwner(directory)).toEqual(owner);
  await lifecycle.stopDaemon();
  expect(await readDaemonOwner(directory)).toBeUndefined();
  expect(await readDaemonIpcState(directory)).toBeUndefined();
  expect(await isDaemonOwnerRunning(owner, io())).toBe(false);
});

it('lets concurrent starters reuse the single daemon owner', async () => {
  await Promise.all([lifecycle.ensureDaemon(), lifecycle.ensureDaemon()]);
  const owner = (await readDaemonOwner(getGlobalConfigDir()))!;
  expect(await isDaemonOwnerRunning(owner, io())).toBe(true);
  expect(await isConversationIpcReady(getGlobalConfigDir(), owner)).toBe(true);
});

it('replaces an owner from another executable before admitting new connections', async () => {
  await lifecycle.ensureDaemon();
  const directory = getGlobalConfigDir(); const previous = (await readDaemonOwner(directory))!;
  await writeDaemonOwner(directory, { ...previous, version: 'old-version' });
  await lifecycle.ensureDaemon();
  const current = (await readDaemonOwner(directory))!;
  expect(current.pid).not.toBe(previous.pid);
  expect(current.version).toBe(packageVersion);
  expect(await isDaemonOwnerRunning(previous, io())).toBe(false);
  expect(await isConversationIpcReady(directory, current)).toBe(true);
});

it('forwards manual CLI startup and termination to the dedicated daemon process', async () => {
  const cli = spawn(process.execPath, [join(process.cwd(), 'dist/app/cli/index.js'), 'daemon'], {
    cwd: getGlobalConfigDir(), env: { ...process.env, TAKT_CONFIG_DIR: getGlobalConfigDir() }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  cli.stdout!.resume(); cli.stderr!.resume();
  const exit = new Promise<number | null>((resolve, reject) => { cli.once('error', reject); cli.once('close', resolve); });
  try {
    await vi.waitFor(async () => {
      const started = await readDaemonOwner(getGlobalConfigDir());
      expect(started).toBeDefined();
      expect(await isConversationIpcReady(getGlobalConfigDir(), started!)).toBe(true);
    }, { timeout: 30_000 });
    const owner = (await readDaemonOwner(getGlobalConfigDir()))!;
    expect(owner.cliPath).toBe(lifecycle.daemonEntryPath());
    expect(owner.pid).not.toBe(cli.pid);
    cli.kill('SIGTERM');
    const code = await exit;
    expect(code).toBe(0);
  } finally { if (cli.exitCode === null && cli.signalCode === null) cli.kill('SIGTERM'); await exit; }
});

it('hands new, concurrent and already-ready daemon connections through delayed opens and returns to idle after detach', async () => {
  const sockets: import('node:net').Socket[] = [];
  try {
    const results = await Promise.allSettled([
      lifecycle.ensureDaemon({ retainConnection: true }), lifecycle.ensureDaemon({ retainConnection: true }),
    ]);
    for (const result of results) if (result.status === 'fulfilled') sockets.push(result.value);
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length > 0) throw new AggregateError(failures.map((result) => result.reason), 'Daemon startup failed');
    const directory = getGlobalConfigDir();
    const owner = (await readDaemonOwner(directory))!;
    const survivesIdle = async () => {
      const readyAt = Date.now();
      // 最初の open を送らず、実子プロセスの複数回の idle 判定をまたぐ。
      await vi.waitFor(async () => {
        expect(await isDaemonOwnerRunning(owner, io())).toBe(true);
        expect(await readDaemonOwner(directory)).toEqual(owner);
        expect(Date.now() - readyAt).toBeGreaterThanOrEqual(1500);
      }, { timeout: 5000 });
    };
    await survivesIdle();
    const selected = await createTuiConversationPort(directory, { async deliver() { return { kind: 'delivered' }; } }).resolve({ kind: 'daemon' });
    const existing = await lifecycle.ensureDaemon({ retainConnection: true });
    sockets.push(existing);
    const openAndDetach = async (socket: import('node:net').Socket) => {
      const client = new Client(socket);
      const opened = (await client.request('open', selected)).result!;
      expect(await client.items(opened.read.transferId)).toContainEqual(expect.objectContaining({ kind: 'state' }));
      await client.request('detach', { attachmentId: opened.attachmentId });
    };
    await openAndDetach(sockets[0]!);
    await openAndDetach(sockets[1]!);
    // 既存 daemon から受け取った接続だけで待機する状態へ移す。
    await survivesIdle();
    await openAndDetach(existing);
    await vi.waitFor(async () => {
      expect(await isDaemonOwnerRunning(owner, io())).toBe(false);
      expect(await readDaemonOwner(directory)).toBeUndefined();
      expect(await readDaemonIpcState(directory)).toBeUndefined();
    }, { timeout: 10_000 });
  } finally { for (const socket of sockets) socket.destroy(); }
});

async function persistedEpic(phase: 'running' | 'succeeded' | 'completed') {
  const directory = getGlobalConfigDir();
  const repositoryDirectory = join(directory, 'epic-repository');
  await mkdir(join(repositoryDirectory, '.takt'), { recursive: true });
  await writeFile(join(directory, 'config.yaml'), 'provider: mock\nmanager:\n  auto_run: false\n  patrol_interval: 86400\n');
  const workspace = await createWorkspace({ globalConfigDirectory: directory, name: '結合確認', repositoryDirectories: [] });
  await writeFile(join(directory, 'workspaces', workspace.id, 'workspace.json'), JSON.stringify({
    ...workspace, repositoryDirectories: [repositoryDirectory],
  }));
  const goal = completedEpicGoal('b'.repeat(40), 'a'.repeat(40));
  const goalDirectory = join(repositoryDirectory, '.takt', 'goals', goal.id);
  await mkdir(goalDirectory, { recursive: true });
  await writeFile(join(goalDirectory, 'goal.json'), JSON.stringify(goal));
  const member = { repositoryDirectory, goalId: goal.id };
  const marker = join(directory, 'verification-executed');
  const started = beginEpicVerification({ ...epicRecord(), revision: 3, workspaceId: workspace.id, members: [member],
    targets: [{ ...member, targetSha: goal.completion!.targetSha! }],
    verificationProcedure: { version: 1, steps: [`printf executed >> '${marker}'`] },
  }, verificationRunId, verificationStartedAt);
  const verified = phase === 'running' ? started.epic : applyEpicVerificationResult(started.epic, verificationResultFor(started.run));
  const epic = phase === 'completed' ? finishEpic(verified) : verified;
  const store = new EpicStore(directory, workspace.id);
  await store.create(epic);
  return { directory, workspace, store, epic, run: started.run, marker,
    context: { globalConfigDirectory: directory, workspaceId: workspace.id, epicId: epic.id } };
}

async function openEpicSnapshot(workspaceId: string, expectedNotices?: number) {
  const socket = await lifecycle.ensureDaemon({ retainConnection: true });
  const client = new Client(socket);
  try {
    if (expectedNotices !== undefined) await waitForNotificationCount(expectedNotices);
    const selected = await createTuiConversationPort(getGlobalConfigDir(), { async deliver() { return { kind: 'delivered' }; } })
      .resolve({ kind: 'workspace', workspaceId });
    const opened = (await client.request('open', selected)).result!;
    // 通知の反映が初回転送を置き換える場合も、完了した最新の転送まで復元する。
    await vi.waitFor(() => {
      const latest = client.frames.filter(({ output }) => output?.kind === 'transfer_start' && output.purpose === 'snapshot').at(-1)?.output;
      expect(latest).toBeDefined();
      expect(client.frames.some(({ output }) => output?.transferId === latest!.transferId && output.kind === 'transfer_end')).toBe(true);
    }, { timeout: 5_000 });
    const items = new Map<string, SnapshotItem>();
    for (const frame of [...client.frames]) {
      const start = frame.output;
      if (start?.kind !== 'transfer_start' || start.purpose !== 'snapshot'
        || !client.frames.some(({ output }) => output?.transferId === start.transferId && output.kind === 'transfer_end')) continue;
      if ((start as typeof start & { mode: string }).mode === 'initial') items.clear();
      for (const item of await client.items(start.transferId) as SnapshotItem[]) {
        if (item.kind === 'remove') items.delete(item.key);
        else items.set(snapshotItemKey(item), item);
      }
    }
    return { client, opened, items: [...items.values()] };
  } catch (error) { socket.destroy(); throw error; }
}

async function notificationIds() {
  const ids: string[] = [];
  for await (const notice of new DaemonNotifications(getGlobalConfigDir()).iterate()) ids.push(notice.id);
  return ids.sort();
}

async function waitForNotificationCount(count: number) {
  await vi.waitFor(async () => expect(await notificationIds()).toHaveLength(count), { timeout: 5_000 });
  return notificationIds();
}

function snapshotNotices(items: unknown[]) {
  return items.filter((item): item is { kind: 'display_event'; event: { id: string; message: string } } =>
    typeof item === 'object' && item !== null && 'kind' in item && item.kind === 'display_event');
}

async function requeueSavedEpicEvents(directory: string, epicId: string) {
  const root = join(directory, 'daemon-events');
  let requeued = 0;
  for (const name of (await readdir(root)).filter((name) => name.endsWith('.json'))) {
    const path = join(root, name);
    const record = EventRecordSchema.parse(JSON.parse(await readFile(path, 'utf8')));
    if (record.event.event.kind === 'patrol' || !JSON.stringify(record.event.event).includes(epicId)) continue;
    expect(record.state).toBe('settled');
    await writeFile(path, JSON.stringify({ state: 'queued', event: record.event }));
    requeued++;
  }
  expect(requeued).toBeGreaterThan(0);
}

it('retains one verification notification after repeated reads and daemon restart', async () => {
  const f = await persistedEpic('succeeded');
  const before = await getEpic(f.context);
  const first = await openEpicSnapshot(f.workspace.id, 1);
  try {
    const ids = await waitForNotificationCount(1);
    for (const _attempt of [1, 2]) {
      f.store.save(f.epic);
      const response = (await first.client.request('snapshot', { attachmentId: first.opened.attachmentId })).result!;
      await first.client.items(response.read.transferId);
    }
    first.client.socket.destroy();
    await lifecycle.stopDaemon();
    await requeueSavedEpicEvents(f.directory, f.epic.id);
    const restarted = await openEpicSnapshot(f.workspace.id, 1);
    try {
      expect(await waitForNotificationCount(1)).toEqual(ids);
      expect(snapshotNotices(restarted.items).map(({ event }) => event.id).sort()).toEqual(ids);
      expect(await getEpic(f.context)).toEqual(before);
      expect((await getEpic(f.context)).verificationRuns).toHaveLength(1);
      expect((await getEpic(f.context)).status).toBe('active');
    } finally { restarted.client.socket.destroy(); }
  } finally { first.client.socket.destroy(); }
});

it('preserves separate notifications for different Epics with the same revision and run ID', async () => {
  const f = await persistedEpic('succeeded');
  const second = EpicSchema.parse({ ...f.epic, id: randomUUID() });
  await f.store.create(second);
  const port = await openEpicSnapshot(f.workspace.id, 2);
  try {
    const ids = await waitForNotificationCount(2);
    expect(new Set(ids).size).toBe(2);
    const notices = snapshotNotices(port.items);
    expect(notices.map(({ event }) => event.id).sort()).toEqual(ids);
  } finally { port.client.socket.destroy(); }
});

it('retains one completion notification alongside verification after rereading and reconnecting', async () => {
  const f = await persistedEpic('completed');
  const before = await getEpic(f.context);
  const first = await openEpicSnapshot(f.workspace.id, 2);
  try {
    const ids = await waitForNotificationCount(2);
    f.store.save(f.epic);
    first.client.socket.destroy();
    await lifecycle.stopDaemon();
    await requeueSavedEpicEvents(f.directory, f.epic.id);
    const restarted = await openEpicSnapshot(f.workspace.id, 2);
    try {
      expect(await waitForNotificationCount(2)).toEqual(ids);
      expect(snapshotNotices(restarted.items).map(({ event }) => event.id).sort()).toEqual(ids);
      expect(await getEpic(f.context)).toEqual(before);
    } finally { restarted.client.socket.destroy(); }
  } finally { first.client.socket.destroy(); }
});

it('retains previous notifications and adds distinct notifications after the same Epic is verified and completed again', async () => {
  const f = await persistedEpic('completed');
  const first = await openEpicSnapshot(f.workspace.id, 2);
  try {
    const previousIds = await waitForNotificationCount(2);
    first.client.socket.destroy();
    await lifecycle.stopDaemon();
    const changed = reviseEpic(f.epic, { objective: '改訂した結合確認' }, {
      kind: 'definition', reason: '追加修正を確認する', recordedAt: new Date().toISOString(),
    });
    const started = beginEpicVerification(changed, randomUUID(), new Date().toISOString());
    const completed = finishEpic(applyEpicVerificationResult(started.epic, verificationResultFor(started.run)));
    f.store.save(completed);
    const restarted = await openEpicSnapshot(f.workspace.id, 4);
    try {
      const ids = await waitForNotificationCount(4);
      expect(ids).toEqual(expect.arrayContaining(previousIds));
      expect(new Set(ids).size).toBe(4);
      expect(snapshotNotices(restarted.items).map(({ event }) => event.id).sort()).toEqual(ids);
      expect((await getEpic(f.context)).verificationRuns).toHaveLength(2);
    } finally { restarted.client.socket.destroy(); }
  } finally { first.client.socket.destroy(); }
});

it('exposes the original running verification after daemon restart without executing it and patrols the pending Epic', async () => {
  const f = await persistedEpic('running');
  const before = await getEpic(f.context);
  const first = await openEpicSnapshot(f.workspace.id);
  first.client.socket.destroy();
  await lifecycle.stopDaemon();
  const restarted = await openEpicSnapshot(f.workspace.id);
  try {
    expect(restarted.items).toContainEqual(expect.objectContaining({ kind: 'epic', epic: expect.objectContaining({
      id: f.epic.id, status: 'active', runningVerification: f.run,
    }), recovery: [f.run] }));
    const savedEvents = async () => {
      const root = join(f.directory, 'daemon-events');
      return Promise.all((await readdir(root)).filter((name) => name.endsWith('.json'))
        .map(async (name) => JSON.parse(await readFile(join(root, name), 'utf8')) as { event: { event: { kind: string } } }));
    };
    await vi.waitFor(async () => {
      const patrols = (await savedEvents()).filter(({ event }) => event.event.kind === 'patrol');
      expect(patrols.length).toBeGreaterThan(0);
      expect(patrols.some((record) => JSON.stringify(record.event.event).includes(f.epic.id))).toBe(true);
    }, { timeout: 5_000 });
    expect(await getEpic(f.context)).toEqual(before);
    await expect(access(f.marker)).rejects.toThrow();
    expect(await notificationIds()).toEqual([]);
  } finally { restarted.client.socket.destroy(); }
});

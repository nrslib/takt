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

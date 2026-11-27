import { ManagerServiceClient, submitAndWait } from './helpers/manager-service-client.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startLocalMcpConnection } from '../features/mcp/localConnection.js';
import { cleanup,render } from 'ink-testing-library';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ServerResponse } from 'node:http';
import { existsSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,symlinkSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename,join } from 'node:path';
import { createElement } from 'react';
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { resolveAssignedProjectRoot,resolveCurrentManagerAssignment } from '../features/manager/assignment.js';
import { createManagerTurnExecutor, type ManagerTurnInput } from '../features/manager/turnExecutor.js';
import { connectTestManagerMcp } from './helpers/manager-mcp.js';
import {TAKT_MANAGER_MCP_SERVER_NAME } from '../features/manager/managerMcp.js';
import { ManagerView } from '../features/manager/ManagerView.js';
import { createWorkspaceManagerContext,resolveManagerStartup,type ManagerAssignment } from '../features/manager/startupResolution.js';
import { addManagerRepository,removeManagerRepository,renameManagerWorkspace } from '../features/manager/workspaceOperations.js';
import { createTaktMcpServer,type TaktMcpServerOptions } from '../features/mcp/server.js';
import { MCP_RESPONSE_MAX_BYTES } from '../features/mcp/response.js';
import { ensureManagerRun } from '../features/manager/autoRun.js';
import { createWorkspace,findWorkspaceForRepository,readWorkspace,readWorkspaceRegistry } from '../infra/config/global/workspaceRegistry.js';
import { GoalStore } from '../infra/goals/store.js';
import { resetScenario,setMockScenario } from '../infra/mock/index.js';
import { MockProvider } from '../infra/providers/mock.js';
import { getLabel } from '../shared/i18n/index.js';
import { goalInput,goalRecord } from './helpers/goal-fixtures.js';
import { firstTextContent } from './helpers/mcp-content.js';
import { createDirectorMcpServer, type DirectorStateActions } from '../features/director/mcp.js';
import { listDirectorManagers } from '../features/director/managers.js';
import { createTurnBusiness } from '../features/daemonTurn/turnBusiness.js';
import * as directorRuntime from '../features/director/conversationRuntime.js';
import * as conversationService from '../features/manager/conversationService.js';
import { createDaemonStateRequests } from '../features/daemon/stateRequests.js';
import { DaemonConversations } from '../features/daemon/conversationState.js';
import { DaemonRouting } from '../features/daemon/routing.js';
import { ConversationStateStore } from '../infra/daemon/conversationStateStore.js';
import { FileEventStore } from '../infra/daemon/eventStore.js';
import { DaemonNotifications } from '../infra/daemon/notifications.js';
import { conversationId } from '../infra/conversations/identity.js';
import { registerProject, readProjectRegistry } from '../infra/config/global/projectRegistry.js';
import { parseDaemonProcessMessage, parseTurnProcessMessage, TURN_PROTOCOL_VERSION, type DaemonStateRequest } from '../core/daemon/processProtocol.js';
import type { DaemonIngress } from '../core/daemon/ports.js';
import type { TurnEvent } from '../core/daemon/events.js';
import type { Goal } from '../infra/goals/schema.js';
import { conversationRecord } from './helpers/conversation-fixtures.js';
import * as managerGoals from '../infra/director/managerGoals.js';
import { DirectorManagerStateStore } from '../infra/director/managerState.js';
import { deferred, turnStart } from './helpers/daemon-turn.js';
import * as assignmentLocks from '../infra/conversations/assignmentLock.js';
import { createDaemonDispatcher } from '../features/daemon/dispatcher.js';
import { ControlledTurnRunner, input } from './helpers/controlledDaemon.js';
import { StandaloneInquiryStore } from '../infra/goals/standalone-inquiries.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { HttpResponseResources } from '../features/mcp/responseResources.js';
import { FileAsyncLock } from '../infra/daemon/lock.js';
import * as gitRepositories from '../infra/task/gitRepositoryDirectory.js';
import * as asyncFiles from 'node:fs/promises';
import { makeProvider } from './test-helpers.js';
import type { ProviderAgent, ProviderCallOptions } from '../infra/providers/types.js';
vi.mock('node:fs/promises', async (original) => ({ ...await original<typeof import('node:fs/promises')>() }));
vi.mock('../features/manager/autoRun.js', () => ({ ensureManagerRun: vi.fn(async () => {}) }));
vi.mock('../features/daemon/lifecycle.js', () => ({ ensureDaemon: vi.fn(async () => {}) }));

describe('manager workspace storage and repository boundaries', () => {
  let root: string;
  let globalDirectory: string;
  let repositoryA: string;
  let repositoryB: string;
  let repositoryC: string;

  function repository(name: string): string {
    const directory = join(root, name);
    mkdirSync(directory, { recursive: true });
    execFileSync('git', ['init', '-b', 'main', directory], { stdio: 'pipe' });
    execFileSync('git', ['-C', directory, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-m', 'fixture'], { stdio: 'pipe' });
    mkdirSync(join(directory, '.takt'));
    writeFileSync(join(directory, '.takt', 'config.yaml'), 'provider: mock\nlanguage: ja\nmanager:\n  auto_run: false\n');
    return directory;
  }

  function single(): ManagerAssignment {
    return { kind: 'repository', repositoryDirectory: repositoryA, repositoryDirectories: [repositoryA] };
  }

  async function withClient(options: TaktMcpServerOptions, action: (client: Client) => Promise<void>): Promise<void> {
    const server = createTaktMcpServer({}, { allowedProjectRoot: repositoryA, toolSet: 'manager', ...options });
    const client = new Client({ name: 'workspace-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    try { await action(client); }
    finally { await client.close(); await server.close(); }
  }

  async function call(client: Client, name: string, args: Record<string, unknown>) {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError, firstTextContent(result.content)).not.toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(MCP_RESPONSE_MAX_BYTES);
    return JSON.parse(firstTextContent(result.content));
  }

  function workspaceRepositories(count: number): string[] {
    return Array.from({ length: count }, (_, index) => {
      const directory = join(root, 'repositories', 'r'.repeat(180), 's'.repeat(180), `開発-${index}-${'作業'.repeat(30)}`);
      mkdirSync(directory, { recursive: true });
      execFileSync('git', ['init', '-b', 'main', directory], { stdio: 'pipe' });
      return directory;
    });
  }

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'takt-workspaces-')));
    globalDirectory = join(root, 'global');
    mkdirSync(globalDirectory);
    vi.stubEnv('TAKT_CONFIG_DIR', globalDirectory);
    repositoryA = repository('a'); repositoryB = repository('b'); repositoryC = repository('c');
  });
  afterEach(() => { cleanup(); resetScenario(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

  describe('director manager lifecycle', () => {
    const cleanups: Array<() => Promise<void>> = [];
    afterEach(async () => {
      try {
        for (const close of cleanups.splice(0).reverse()) await close();
      } finally { vi.restoreAllMocks(); }
    });

    function humanMessage(text: string): Extract<TurnEvent, { kind: 'human_command' }> {
      return { kind: 'human_command', command: { kind: 'message', text }, speaker: { namespace: 'test', id: 'operator' } };
    }

    async function director(event?: Extract<TurnEvent, { kind: 'human_command' | 'watch_observation' }>) {
      const signal = new AbortController().signal;
      const store = new ConversationStateStore(globalDirectory);
      const routing = new DaemonRouting(globalDirectory);
      const conversations = new DaemonConversations(store, routing, new DaemonNotifications(globalDirectory),
        async () => {}, (error) => { throw error; }, new FileEventStore(globalDirectory));
      cleanups.push(() => conversations.close());
      await conversations.ensure({ kind: 'daemon' });
      const id = conversationId({ kind: 'daemon' });
      const current = (await store.read(id))!;
      const base = turnStart();
      const currentEvent = event ?? { kind: 'human_command' as const, command: { kind: 'message' as const, text: 'manager を用意して' },
        speaker: { namespace: 'test', id: 'operator' } };
      const active = { ...base, turn: { ...base.turn, conversationId: id },
        event: { ...base.event, conversationId: id, event: currentEvent,
          source: currentEvent.kind === 'human_command' ? 'tui' as const : 'watcher' as const,
          lane: currentEvent.kind === 'human_command' ? 'human' as const : 'other' as const }, state: current.state };
      const accept = vi.fn<DaemonIngress['accept']>(async (event) => ({ kind: 'accepted', eventId: event.eventId,
        operationId: 'manager-message', acceptedSequence: 1 }));
      const owner = createDaemonStateRequests({ conversations, ingress: { accept }, connectedPorts: () => [] });
      let actions: DirectorStateActions | undefined;
      vi.spyOn(directorRuntime, 'createDaemonConversationRuntime').mockImplementationOnce((_directory, stateActions) => {
        actions = stateActions;
        return { resolve: async () => { throw new Error('Provider execution is outside this test'); }, close: async () => {} };
      });
      const finish = deferred<void>();
      vi.spyOn(conversationService, 'createConversationTurnService').mockReturnValueOnce({ execute: async () => {
        await finish.promise;
        return { kind: 'completed', result: { kind: 'reply', message: 'done' } };
      } });
      const business = await createTurnBusiness(globalDirectory, { kind: 'daemon' });
      const envelope = { protocolVersion: TURN_PROTOCOL_VERSION, launchId: 'manager-lifecycle' };
      const requests: DaemonStateRequest[] = [];
      const request = async (value: DaemonStateRequest, requestSignal?: AbortSignal) => {
        requests.push(value);
        const requestId = String(requests.length);
        const message = parseTurnProcessMessage({ ...envelope, kind: 'daemon_request', turn: active.turn,
          requestId, request: value }, envelope.launchId);
        if (message.kind !== 'daemon_request') throw new Error('Expected state request');
        const reply = await owner.handle(active.turn, message.request, requestSignal === undefined ? signal : AbortSignal.any([signal, requestSignal]));
        const response = parseDaemonProcessMessage({ ...envelope, kind: 'daemon_reply', turn: active.turn,
          requestId, reply }, envelope.launchId);
        if (response.kind !== 'daemon_reply') throw new Error('Expected state reply');
        return response.reply;
      };
      const executing = business.execute(active, { signal, request, progress() {} });
      cleanups.push(async () => { finish.resolve(); await executing; await business.close(); });
      if (actions === undefined) throw new Error('Director state actions were not supplied');
      const connection = await startLocalMcpConnection((_request, _connection, responses) => createDirectorMcpServer(globalDirectory, actions!, signal, responses));
      const client = new Client({ name: 'director-lifecycle', version: '1' });
      cleanups.push(async () => { await client.close(); await connection.dispose(); });
      const transport = new StreamableHTTPClientTransport(new URL(connection.config.url), {
        requestInit: { headers: connection.config.headers },
        fetch: async (url, options) => {
          if (typeof options?.body === 'string') {
            const message = JSON.parse(options.body) as { method: string; params: Record<string, unknown> };
            if (message.method === 'initialize') return fetch(url, { ...options,
              body: JSON.stringify({ ...message, params: { ...message.params, protocolVersion: '2025-03-26' } }) });
          }
          return fetch(url, options);
        },
      });
      await client.connect(transport);
      expect(transport.protocolVersion).toBe('2025-03-26');
      const post = (body: unknown, label?: string) => fetch(connection.config.url, { method: 'POST', headers: {
          ...connection.config.headers, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
          'Mcp-Session-Id': transport.sessionId!, 'MCP-Protocol-Version': '2025-03-26',
          ...(label === undefined ? {} : { 'X-Test-Batch': label }),
        }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
      const batch = async (directories: string[], baseId = 100, label?: string) => {
        const result = await post(directories.map((repositoryDirectory, index) => ({ jsonrpc: '2.0', id: index + baseId,
          method: 'tools/call', params: { name: 'takt_add_manager', arguments: { repositoryDirectory } } })), label);
        expect(result.status).toBe(200);
        type Reply = { id: number; result: { content: Array<{ type: string; text: string }>; isError?: boolean } };
        const body = await result.json() as Reply | Reply[];
        return Array.isArray(body) ? body : [body];
      };
      const call = async (name: string, args: Record<string, unknown>) => {
        const result = await client.callTool({ name, arguments: args });
        expect(result.isError, firstTextContent(result.content)).not.toBe(true);
        return JSON.parse(firstTextContent(result.content)) as Record<string, unknown>;
      };
      const add = (repositoryDirectory: string) => call('takt_add_manager', { repositoryDirectory });
      const fire = (managerId: string) => call('takt_fire_manager', { managerId });
      const list = async (args: Record<string, unknown> = {}) => {
        const result = await call('takt_list_managers', args);
        return { ...result, managers: result.managers as Array<{ id: string }> };
      };
      return { client, call, add, fire, list, batch, post, store, routing, accept, request, requests, owner, active, signal, conversations };
    }

    it.each(['supplied', 'quoted-message', 'sentence-period', 'different-git-path', 'human-without-path', 'watcher'] as const)('prepares a valid repository over HTTP during a human message turn (%s)', async (origin) => {
      await seed(repositoryA);
      const existing = managerId(repositoryA);
      const inquiry = await new StandaloneInquiryStore(globalDirectory, single()).create({ body: `${repositoryC} でやって`, recipient: 'human' });
      const quotedMessage = `「${repositoryC} でやって」`;
      const f = await director(origin === 'watcher'
        ? { kind: 'watch_observation', observation: { kind: 'director_state_changed', managerConversationId: existing, repositoryDirectory: repositoryA,
          goalId: null, state: JSON.stringify({ pendingInquiries: [inquiry.id], text: quotedMessage }), targetId: 'inquiry', generation: '1', observedAt: new Date().toISOString() } }
        : { kind: 'human_command', command: { kind: 'message', text: origin === 'supplied' ? `${repositoryC} でやって`
          : origin === 'quoted-message' ? quotedMessage : origin === 'sentence-period' ? `Do this in ${repositoryC}.`
            : origin === 'different-git-path' ? `Do this in ${repositoryC}.git.` : '問い合わせの状況を教えて' },
          speaker: { namespace: 'test', id: 'operator' } });
      await f.call('takt_list_manager_inquiries', { managerId: existing });
      const before = await readProjectRegistry(globalDirectory);
      const resolve = vi.spyOn(gitRepositories, 'resolveGitRepositoryDirectory');
      const acquire = vi.spyOn(assignmentLocks, 'acquireRepositoryAssignmentLocks');
      const result = await f.client.callTool({ name: 'takt_add_manager', arguments: { repositoryDirectory: repositoryC } });
      if (origin !== 'watcher') {
        expect(result.isError).not.toBe(true);
        expect(JSON.parse(firstTextContent(result.content))).toEqual({ managerId: managerId(repositoryC) });
        expect(resolve).toHaveBeenCalledWith(repositoryC);
        expect(acquire).toHaveBeenCalledExactlyOnceWith(globalDirectory, [repositoryC], expect.any(AbortSignal));
        expect((await f.list()).managers.map(({ id }) => id)).toContain(managerId(repositoryC));
        expect((await new GoalStore(repositoryC).list()).goals).toEqual([]);
      } else {
        expect(result.isError).toBe(true);
        expect(resolve).not.toHaveBeenCalled(); expect(acquire).not.toHaveBeenCalled();
        expect(await readProjectRegistry(globalDirectory)).toEqual(before);
        expect(await f.store.read(managerId(repositoryC))).toBeUndefined();
        expect(existsSync(join(globalDirectory, 'director', 'managers', `${managerId(repositoryC)}.json`))).toBe(false);
        expect((await f.list()).managers.map(({ id }) => id)).not.toContain(managerId(repositoryC));
      }
    });

    it.each([false, true])('accepts a supplied Git path containing spaces and Japanese text (quoted: %s)', async (quoted) => {
      const directory = repository('開発 作業'); const canonical = await asyncFiles.realpath(directory);
      const f = await director({ kind: 'human_command', command: { kind: 'message', text: `${quoted ? JSON.stringify(directory) : directory} でやって` },
        speaker: { namespace: 'test', id: 'operator' } });
      expect((await f.add(directory)).managerId).toBe(managerId(canonical));
      expect(f.requests).toContainEqual({ kind: 'add_director_manager', repositoryDirectory: directory });
      expect((await f.list()).managers.map(({ id }) => id)).toContain(managerId(canonical));
    });

    it.each([false, true])('authorizes each HTTP batch path during a human message turn (second path supplied: %s)', async (secondSupplied) => {
      const text = `${repositoryA}${secondSupplied ? ` と ${repositoryB}` : ''} のmanagerを用意して`;
      const f = await director(humanMessage(text));
      const resolve = vi.spyOn(gitRepositories, 'resolveGitRepositoryDirectory');
      const results = await f.batch([repositoryA, repositoryB]);
      expect(results.find(({ id }) => id === 100)?.result.isError).not.toBe(true);
      expect(results.find(({ id }) => id === 101)?.result.isError).not.toBe(true);
      expect(resolve).toHaveBeenCalledWith(repositoryB);
      expect((await f.list()).managers.map(({ id }) => id).sort()).toEqual(
        [managerId(repositoryA), managerId(repositoryB)].sort());
    });

    it.each(['conversation', 'registration', 'after-registration', 'restore', 'fire'].flatMap((stage) => [false, true].map((cancel) => ({ stage, cancel }))))(
      'stops only uncommitted manager updates at $stage (cancel: $cancel)', async ({ stage, cancel }) => {
        const f = await director(humanMessage(`${repositoryB} と ${repositoryC} のmanagerを用意して`)); const id = managerId(repositoryC);
        if (stage === 'registration' || stage === 'after-registration') await f.conversations.ensure({ kind: 'repository', repositoryDirectory: repositoryC });
        if (stage === 'restore' || stage === 'fire') await f.add(repositoryC);
        if (stage === 'restore') await f.fire(id);
        const before = await f.store.read(id);
        const entered = deferred<void>(); const finish = deferred<void>();
        cleanups.push(async () => { finish.resolve(); });
        if (stage === 'conversation') {
          const ensure = f.conversations.ensure.bind(f.conversations);
          vi.spyOn(f.conversations, 'ensure').mockImplementation(async (...args) => {
            if (args[0].kind === 'repository' && args[0].repositoryDirectory === repositoryC) { entered.resolve(); await finish.promise; }
            return ensure(...args);
          });
        } else if (stage === 'registration') {
          const write = asyncFiles.writeFile;
          vi.spyOn(asyncFiles, 'writeFile').mockImplementation(async (...args) => {
            await write(...args);
            if (String(args[0]).startsWith(join(globalDirectory, 'projects')) && String(args[1]).includes(repositoryC)) {
              entered.resolve(); await finish.promise;
            }
          });
        } else if (stage === 'after-registration') {
          const rename = asyncFiles.rename;
          vi.spyOn(asyncFiles, 'rename').mockImplementation(async (...args) => {
            await rename(...args);
            if (String(args[1]).startsWith(join(globalDirectory, 'projects')) && (await asyncFiles.readFile(String(args[1]), 'utf8')).includes(repositoryC)) {
              entered.resolve(); await finish.promise;
            }
          });
        } else {
          const save = DirectorManagerStateStore.prototype.setFired;
          vi.spyOn(DirectorManagerStateStore.prototype, 'setFired').mockImplementation(async function(this: DirectorManagerStateStore, ...args) {
            if (args[0] === id && args[1] === (stage === 'fire')) { entered.resolve(); await finish.promise; }
            return save.apply(this, args);
          });
        }
        const events: string[] = []; const acquire = assignmentLocks.acquireRepositoryAssignmentLocks;
        vi.spyOn(assignmentLocks, 'acquireRepositoryAssignmentLocks').mockImplementation(async (...args) => {
          const unlock = await acquire(...args);
          return async () => { events.push('release'); await unlock(); };
        });
        const handle = f.owner.handle.bind(f.owner);
        vi.spyOn(f.owner, 'handle').mockImplementation(async (...args) => {
          try { return await handle(...args); } finally { events.push('daemon-done'); }
        });
        const results = f.post([
          { jsonrpc: '2.0', id: 100, method: 'tools/call', params: stage === 'fire'
            ? { name: 'takt_fire_manager', arguments: { managerId: id } }
            : { name: 'takt_add_manager', arguments: { repositoryDirectory: repositoryC } } },
          { jsonrpc: '2.0', id: 101, method: 'tools/call', params: { name: 'takt_add_manager', arguments: { repositoryDirectory: repositoryB } } },
        ]).then(async (response) => response.json() as Promise<Array<{ id: number; result: { isError?: boolean } }>>);
        await entered.promise;
        await f.post({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 99, reason: 'cancel 100' } });
        if (cancel) await f.post({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 100 } });
        expect(events).not.toContain('release');
        finish.resolve(); const wire = await results;
        await vi.waitFor(() => expect(events.filter((event) => event === 'release')).toHaveLength(1));
        expect(events.lastIndexOf('daemon-done')).toBeLessThan(events.indexOf('release'));
        const states = new DirectorManagerStateStore(globalDirectory);
        const listed = (await f.list()).managers.map(({ id }) => id);
        const saved = await f.store.read(id);
        const registration = (await readProjectRegistry(globalDirectory)).projects.some((project) => project.canonicalDirectory === repositoryC);
        const fired = await states.isFired(id);
        console.log(JSON.stringify({ cancellationPersistence: stage, cancel, wire, conversation: saved !== undefined, registration, fired, listed: listed.includes(id), events }));
        expect(wire.find((value) => value.id === 101)?.result.isError).not.toBe(true);
        expect(wire.find((value) => value.id === 100)?.result.isError === true).toBe(cancel);
        expect(listed).toContain(managerId(repositoryB));
        if (stage === 'conversation') expect(saved !== undefined).toBe(!cancel);
        else expect(saved).toEqual(before);
        if (stage === 'conversation' || stage === 'registration') {
          expect(registration).toBe(!cancel); expect(listed.includes(id)).toBe(!cancel);
        } else if (stage === 'after-registration') {
          expect(registration).toBe(true); expect(listed).toContain(id);
          expect(existsSync(join(globalDirectory, 'director', 'managers', `${id}.json`))).toBe(!cancel);
        } else {
          expect(fired).toBe(stage === 'fire' ? !cancel : cancel);
          expect(listed.includes(id)).toBe(stage === 'fire' ? cancel : !cancel);
        }
        expect((await asyncFiles.readdir(join(globalDirectory, 'projects'))).some((name) => name.endsWith('.tmp'))).toBe(false);
      });

    it.each([1, 2, 3].flatMap((run) => [false, true].map((reverse) => ({ run, reverse }))))(
      'prepares simultaneous HTTP batches without circular lock waits (reverse: $reverse, run: $run)', async ({ run, reverse }) => {
        const f = await director(humanMessage(`${repositoryA} と ${repositoryB} のmanagerを用意して`));
        const context = new AsyncLocalStorage<string | undefined>();
        const events: Array<Record<string, unknown>> = [];
        const handle = HttpResponseResources.prototype.handle;
        vi.spyOn(HttpResponseResources.prototype, 'handle').mockImplementation(function<T>(this: HttpResponseResources, response: ServerResponse, action: () => Promise<T>): Promise<T> {
          const label = response.req.headers['x-test-batch'];
          if (typeof label === 'string') response.prependOnceListener('finish', () => { events.push({ label, kind: 'finish' }); });
          return context.run(typeof label === 'string' ? label : undefined, () => handle.call(this, response, action)) as Promise<T>;
        });
        const attempts = new Map<string, number>();
        const firstAcquired = new Map(['left', 'right'].map((label) => [label, deferred<void>()]));
        const bothAttempted = deferred<void>();
        const acquire = FileAsyncLock.prototype.acquire;
        vi.spyOn(FileAsyncLock.prototype, 'acquire').mockImplementation(async function(this: FileAsyncLock, path, options) {
          const label = context.getStore();
          if (label === undefined || !path.includes('/assignment-locks/')) return acquire.call(this, path, options);
          const ordinal = (attempts.get(label) ?? 0) + 1; attempts.set(label, ordinal);
          events.push({ label, kind: 'attempt', path, ordinal });
          if (attempts.size === 2) bothAttempted.resolve();
          if (ordinal > 1) { await firstAcquired.get(label)!.promise; await bothAttempted.promise; }
          const unlock = await acquire.call(this, path, options);
          events.push({ label, kind: 'acquired', path, ordinal });
          if (ordinal === 1) { firstAcquired.get(label)!.resolve(); await bothAttempted.promise; }
          return async () => { await unlock(); events.push({ label, kind: 'released', path, ordinal }); };
        });
        const results = await Promise.all([
          f.batch([repositoryA, repositoryB], 100, 'left'),
          f.batch(reverse ? [repositoryB, repositoryA] : [repositoryA, repositoryB], 200, 'right'),
        ]);
        await vi.waitFor(() => expect(events.filter(({ kind }) => kind === 'released')).toHaveLength(4));
        for (const label of ['left', 'right']) {
          const own = events.filter((event) => event.label === label);
          const paths = own.filter(({ kind }) => kind === 'acquired').map(({ path }) => path);
          expect(paths).toHaveLength(2);
          expect(paths).toEqual([...paths].sort());
          expect(own.findIndex(({ kind }) => kind === 'finish')).toBeGreaterThanOrEqual(0);
          expect(own.findIndex(({ kind }) => kind === 'released')).toBeGreaterThan(own.findIndex(({ kind }) => kind === 'finish'));
        }
        console.log(JSON.stringify({ lockOrderComparison: run, reverse, results, events }));
        for (const batch of results) for (const item of batch) expect(item.result.isError).not.toBe(true);
        expect(results.flat().map(({ result }) => JSON.parse(firstTextContent(result.content)).managerId).sort())
          .toEqual([managerId(repositoryA), managerId(repositoryA), managerId(repositoryB), managerId(repositoryB)].sort());
      });

    it('releases a partly acquired batch and permits a later retry without publishing failed preparations', async () => {
      const f = await director(humanMessage(`${repositoryA} と ${repositoryB} のmanagerを用意して`));
      const acquire = FileAsyncLock.prototype.acquire;
      const release = vi.fn(); let attempts = 0;
      const spy = vi.spyOn(FileAsyncLock.prototype, 'acquire').mockImplementation(async function(this: FileAsyncLock, path, options) {
        if (!path.includes('/assignment-locks/')) return acquire.call(this, path, options);
        if (++attempts === 2) throw new Error('second assignment acquisition failed');
        const unlock = await acquire.call(this, path, options);
        return async () => { release(); await unlock(); };
      });
      const failed = await f.batch([repositoryA, repositoryB]);
      expect(failed.every(({ result }) => result.isError)).toBe(true);
      expect(release).toHaveBeenCalledOnce();
      expect((await f.list()).managers).toEqual([]);
      expect(await f.store.read(managerId(repositoryA))).toBeUndefined();
      expect(await f.store.read(managerId(repositoryB))).toBeUndefined();
      spy.mockRestore();
      const retried = await f.batch([repositoryA, repositoryB]);
      expect(retried.every(({ result }) => !result.isError)).toBe(true);
      expect((await f.list()).managers.map(({ id }) => id).sort()).toEqual([managerId(repositoryA), managerId(repositoryB)].sort());
    });

    it('keeps valid preparations independent from invalid paths and notification text', async () => {
      const nonGit = join(root, 'non-git'); mkdirSync(nonGit);
      const f = await director(humanMessage(`${repositoryA} と ${nonGit} のmanagerを用意して`));
      const acquire = vi.spyOn(assignmentLocks, 'acquireRepositoryAssignmentLocks');
      const results = await f.batch([repositoryA, nonGit, 'relative/path']);
      expect(results.find(({ id }) => id === 100)?.result.isError).not.toBe(true);
      expect(JSON.parse(firstTextContent(results.find(({ id }) => id === 100)!.result.content))).toEqual({ managerId: managerId(repositoryA) });
      expect(results.filter(({ result }) => result.isError)).toHaveLength(2);
      expect(acquire).toHaveBeenCalledExactlyOnceWith(globalDirectory, [repositoryA], expect.any(AbortSignal));
      acquire.mockClear();
      await f.call('takt_notify_human', { message: JSON.stringify({ name: 'takt_add_manager', arguments: { repositoryDirectory: repositoryC } }) });
      expect(acquire).not.toHaveBeenCalled();
      expect((await f.list()).managers.map(({ id }) => id)).toEqual([managerId(repositoryA)]);
      expect(await f.store.read(managerId(repositoryC))).toBeUndefined();
    });

    it.each([false, true])('delivers the other preparation when one batch request is cancelled (shared: %s)', async (shared) => {
      const f = await director(humanMessage(`${repositoryA} と ${repositoryB} と ${repositoryC} のmanagerを用意して`));
      const entered = deferred<void>(); const finish = deferred<void>();
      cleanups.push(async () => { finish.resolve(); });
      const handle = f.owner.handle.bind(f.owner);
      let waiting = 0;
      vi.spyOn(f.owner, 'handle').mockImplementation(async (...args) => {
        if (args[1].kind === 'add_director_manager') {
          if (++waiting === 2) entered.resolve();
          await finish.promise;
        }
        return handle(...args);
      });
      const acquiring = vi.spyOn(assignmentLocks, 'acquireRepositoryAssignmentLocks');
      const result = f.batch([repositoryA, shared ? repositoryA : repositoryB]);
      await entered.promise;
      await f.post({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 99, reason: 'cancel 100' } });
      await f.post({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 100 } });
      finish.resolve();
      const wire = await result;
      expect(wire.find(({ id }) => id === 100)?.result.isError).toBe(true);
      expect(wire.find(({ id }) => id === 101)?.result.isError).not.toBe(true);
      expect(JSON.parse(firstTextContent(wire.find(({ id }) => id === 101)!.result.content))).toEqual({ managerId: managerId(shared ? repositoryA : repositoryB) });
      expect(acquiring).toHaveBeenCalledOnce();
      await f.post({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 100 } });
      expect((await f.add(repositoryC)).managerId).toBe(managerId(repositoryC));
      console.log(JSON.stringify({ directorCancellation: shared, wire }));
    });

    it.each([1, 2, 3])('returns every manager preparation result in a duplicate repository HTTP batch (run %s)', async (run) => {
      const acquire = assignmentLocks.acquireRepositoryAssignmentLocks;
      const events: string[] = [];
      vi.spyOn(assignmentLocks, 'acquireRepositoryAssignmentLocks').mockImplementation(async (...args) => {
        events.push('acquire-start');
        const release = await acquire(...args); events.push('acquired');
        return async () => { await release(); events.push('released'); };
      });
      const f = await director(humanMessage(`${repositoryB} のmanagerを用意して`));
      const handle = f.owner.handle.bind(f.owner);
      vi.spyOn(f.owner, 'handle').mockImplementation(async (...args) => {
        const result = await handle(...args);
        if (args[1].kind === 'add_director_manager') events.push('prepared');
        return result;
      });
      const end = ServerResponse.prototype.end;
      vi.spyOn(ServerResponse.prototype, 'end').mockImplementation(function(this: ServerResponse, ...args: Parameters<typeof end>) {
        this.prependOnceListener('finish', () => { events.push('http-finish'); });
        return end.apply(this, args);
      });
      const single = await f.batch([repositoryB]);
      const duplicate = await f.batch([repositoryB, repositoryB]);
      for (const results of [single, duplicate]) {
        for (const item of results) {
          expect(item.result.isError).not.toBe(true);
          expect(JSON.parse(firstTextContent(item.result.content))).toEqual({ managerId: managerId(repositoryB) });
        }
      }
      expect(duplicate.map(({ id }) => id).sort()).toEqual([100, 101]);
      await vi.waitFor(() => expect(events.filter((event) => event === 'released')).toHaveLength(2));
      expect(events.filter((event) => event === 'acquire-start')).toHaveLength(2);
      expect(events.filter((event) => event === 'prepared')).toHaveLength(3);
      console.log(JSON.stringify({ batchComparison: run, single, duplicate, events }));
      expect((await f.list()).managers.map(({ id }) => id)).toContain(managerId(repositoryB));
      expect((await f.store.read(managerId(repositoryB)))?.state.assignment).toEqual({ kind: 'repository', repositoryDirectory: repositoryB });
    });

    it('shares canonical roots, separates other repositories, and preserves each preparation result in a batch', async () => {
      const nested = join(repositoryB, 'subdirectory'); mkdirSync(nested);
      const f = await director(humanMessage(`${repositoryA} と ${repositoryB} と ${nested} と ${repositoryC} のmanagerを用意して`));
      const canonical = await f.batch([repositoryB, nested]);
      expect(canonical.map(({ result }) => JSON.parse(firstTextContent(result.content)))).toEqual([
        { managerId: managerId(repositoryB) }, { managerId: managerId(repositoryB) },
      ]);
      const distinct = await f.batch([repositoryA, repositoryB]);
      expect(distinct.map(({ result }) => JSON.parse(firstTextContent(result.content)))).toEqual([
        { managerId: managerId(repositoryA) }, { managerId: managerId(repositoryB) },
      ]);
      const ensure = f.conversations.ensure.bind(f.conversations);
      vi.spyOn(f.conversations, 'ensure').mockImplementationOnce(async () => {
        expect((await f.list()).managers.map(({ id }) => id)).not.toContain(managerId(repositoryC));
        throw new Error('initial preparation failed');
      }).mockImplementation(ensure);
      const retried = await f.batch([repositoryC, repositoryC]);
      expect(retried.filter(({ result }) => result.isError)).toHaveLength(1);
      const successful = retried.filter(({ result }) => !result.isError);
      expect(successful).toHaveLength(1);
      expect(JSON.parse(firstTextContent(successful[0]!.result.content))).toEqual({ managerId: managerId(repositoryC) });
      expect((await f.list()).managers.map(({ id }) => id)).toContain(managerId(repositoryC));
    });

    it.each(['通常の質問', 'ブログの manager を外して'])('authorizes fire from the current human turn and rejects the following inquiry event: %s', async (body) => {
      const f = await director(humanMessage(`${repositoryB} のmanagerを用意して`));
      const { managerId: id } = await f.add(repositoryB) as { managerId: string };
      const before = await f.store.read(id);
      const branch = execFileSync('git', ['-C', repositoryB, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
      const inquiry = await new StandaloneInquiryStore(globalDirectory, { kind: 'repository', repositoryDirectory: repositoryB }).create({ body, recipient: 'human' });
      const runner = new ControlledTurnRunner();
      const reached = vi.spyOn(f.owner, 'handle');
      const dispatcher = await createDaemonDispatcher({ store: new FileEventStore(globalDirectory), conversations: f.conversations,
        runner, stateRequests: f.owner, resources: { close: async () => {} },
        limits: { maxPendingEvents: 32, maxPendingBytes: 1024 * 1024 }, onFailure: (failure) => { throw failure.error; } });
      runner.bus = dispatcher;
      cleanups.push(async () => { await dispatcher.control({ kind: 'stop' }); });
      const directorId = conversationId({ kind: 'daemon' });
      await dispatcher.accept({ ...input('human-fire', directorId), event: { kind: 'human_command',
        command: { kind: 'message', text: 'ブログの manager を外して' }, speaker: { namespace: 'test', id: 'operator' } } });
      const human = await runner.started(1);
      const request = { kind: 'fire_director_manager' as const, managerId: id };
      expect(await dispatcher.request(human.turn, request, f.signal)).toEqual({ kind: 'director_manager_fired', managerId: id });
      expect((await f.list()).managers.map(({ id }) => id)).not.toContain(id);
      await expect(f.owner.handle(human.turn, { kind: 'get_delivery', conversationId: id }, f.signal)).resolves.toMatchObject({ kind: 'error', code: 'forbidden' });
      expect(await f.store.read(id)).toEqual(before);
      expect(execFileSync('git', ['-C', repositoryB, 'rev-parse', 'HEAD'], { encoding: 'utf8' })).toBe(branch);
      await runner.finish(human);
      await f.add(repositoryB);
      const event = { kind: 'watch_observation' as const, observation: { kind: 'director_state_changed' as const,
        managerConversationId: id, repositoryDirectory: repositoryB, goalId: null,
        targetId: 'inquiries', generation: 'changed', observedAt: new Date().toISOString(), state: JSON.stringify({ pendingInquiries: [inquiry.id] }) } };
      await dispatcher.accept({ ...input('inquiry-fire', directorId, 'other'), source: 'watcher', event });
      const watching = await runner.started(2);
      const listed = await f.call('takt_list_manager_inquiries', { managerId: id });
      expect(listed.inquiries).toEqual(expect.arrayContaining([expect.objectContaining({ question: expect.objectContaining({ body }) })]));
      reached.mockClear();
      const result = await dispatcher.request(watching.turn, request, f.signal);
      console.log(JSON.stringify({ fireOriginComparison: body, result, stateOwnerCalls: reached.mock.calls.length }));
      expect(result).toMatchObject({ kind: 'error', code: 'forbidden' });
      expect(reached).not.toHaveBeenCalled();
      expect(await new DirectorManagerStateStore(globalDirectory).isFired(id)).toBe(false);
      expect((await f.list()).managers.map(({ id }) => id)).toContain(id);
      expect(await dispatcher.request(watching.turn, { kind: 'get_delivery', conversationId: id }, f.signal)).toMatchObject({ kind: 'delivery', conversationId: id });
      expect(await f.store.read(id)).toEqual(before);
      await runner.finish(watching);
      const goal = { ...goalRecord(), status: 'created' as const, executionStatus: 'active' as const };
      const location = join(repositoryB, '.takt', 'goals', goal.id); mkdirSync(location, { recursive: true });
      const content = JSON.stringify(goal); writeFileSync(join(location, 'goal.json'), content);
      await dispatcher.accept({ ...input('human-fire-unfinished', directorId), event: human.input.event.event });
      const unfinished = await runner.started(3);
      expect(await dispatcher.request(unfinished.turn, request, f.signal)).toMatchObject({ kind: 'error', code: 'forbidden', message: expect.stringContaining(goal.id) });
      expect(await new DirectorManagerStateStore(globalDirectory).isFired(id)).toBe(false);
      expect((await f.list()).managers.map(({ id }) => id)).toContain(id);
      expect(readFileSync(join(location, 'goal.json'), 'utf8')).toBe(content);
      expect(await f.store.read(id)).toEqual(before);
      expect(execFileSync('git', ['-C', repositoryB, 'rev-parse', 'HEAD'], { encoding: 'utf8' })).toBe(branch);
      await runner.finish(unfinished);
    });

    function managerId(repositoryDirectory: string) {
      return conversationId({ kind: 'repository', repositoryDirectory });
    }

    it.each(['human', 'human-quoted', 'sentence-period', 'different-git-path', 'human-without-path', 'watcher'] as const)('prepares a new manager through the dispatcher during a human message turn (%s)', async (origin) => {
      const f = await director(humanMessage(`${repositoryA} のmanagerを用意して`)); await f.add(repositoryA);
      const text = `${repositoryC} でやって`;
      const inquiry = await new StandaloneInquiryStore(globalDirectory, { kind: 'repository', repositoryDirectory: repositoryA })
        .create({ body: text, recipient: 'human' });
      const runner = new ControlledTurnRunner(); const reached = vi.spyOn(f.owner, 'handle');
      const dispatcher = await createDaemonDispatcher({ store: new FileEventStore(globalDirectory), conversations: f.conversations,
        runner, stateRequests: f.owner, resources: { close: async () => {} },
        limits: { maxPendingEvents: 32, maxPendingBytes: 1024 * 1024 }, onFailure: (failure) => { throw failure.error; } });
      runner.bus = dispatcher; cleanups.push(async () => { await dispatcher.control({ kind: 'stop' }); });
      const directorId = conversationId({ kind: 'daemon' });
      const event = origin !== 'watcher'
        ? { kind: 'human_command' as const, command: { kind: 'message' as const, text: origin === 'human' ? text
          : origin === 'human-quoted' ? `「${text}」` : origin === 'sentence-period' ? `Do this in ${repositoryC}.`
            : origin === 'different-git-path' ? `Do this in ${repositoryC}.git.` : '問い合わせの状況を教えて' }, speaker: { namespace: 'test', id: 'operator' } }
        : { kind: 'watch_observation' as const, observation: { kind: 'director_state_changed' as const,
          managerConversationId: managerId(repositoryA), repositoryDirectory: repositoryA, goalId: null,
          targetId: 'inquiries', generation: 'changed', observedAt: new Date().toISOString(), state: JSON.stringify({ pendingInquiries: [inquiry.id] }) } };
      await dispatcher.accept({ ...input('prepare-manager', directorId, origin !== 'watcher' ? 'human' : 'other'), event });
      const turn = await runner.started(1);
      expect((await f.call('takt_list_manager_inquiries', { managerId: managerId(repositoryA) })).inquiries)
        .toEqual(expect.arrayContaining([expect.objectContaining({ question: expect.objectContaining({ body: text }) })]));
      reached.mockClear();
      const result = await dispatcher.request(turn.turn, { kind: 'add_director_manager', repositoryDirectory: repositoryC }, f.signal);
      const record = await f.store.read(managerId(repositoryC)); const listed = (await f.list()).managers.map(({ id }) => id);
      if (origin !== 'watcher') {
        expect(result).toEqual({ kind: 'director_manager_added', managerId: managerId(repositoryC) });
        expect(reached).toHaveBeenCalledOnce();
        expect(record?.state.assignment).toEqual({ kind: 'repository', repositoryDirectory: repositoryC });
        expect(listed).toContain(managerId(repositoryC));
      } else {
        expect(result).toMatchObject({ kind: 'error', code: 'forbidden' }); expect(reached).not.toHaveBeenCalled();
        expect(record).toBeUndefined(); expect(listed).not.toContain(managerId(repositoryC));
        expect((await readProjectRegistry(globalDirectory)).projects.some(({ canonicalDirectory }) => canonicalDirectory === repositoryC)).toBe(false);
        expect(existsSync(join(globalDirectory, 'director', 'managers', `${managerId(repositoryC)}.json`))).toBe(false);
      }
      await runner.finish(turn);
    });

    function savedManagerIds(): string[] {
      const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
        "import { listDirectorManagers } from './src/features/director/managers.ts'; import { conversationId } from './src/infra/conversations/identity.ts'; const result = await listDirectorManagers(process.argv[1]); process.stdout.write(JSON.stringify(result.managers.map(conversationId)));",
        globalDirectory], { encoding: 'utf8', timeout: 10_000 });
      return JSON.parse(output) as string[];
    }

    async function seed(repositoryDirectory: string) {
      await registerProject({ globalConfigDirectory: globalDirectory, projectDirectory: repositoryDirectory, command: 'manager', managerUsed: true });
      const store = new ConversationStateStore(globalDirectory);
      await store.create(conversationRecord(repositoryDirectory));
    }

    function membership(source: { kind: 'repository'; repositoryDirectory: string } | { kind: 'workspace'; workspaceId: string }, remove = false) {
      const messages: Array<Record<string, unknown>> = []; const updates = new Set<() => void>();
      const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./helpers/manager-lifecycle-child.ts', import.meta.url)),
        globalDirectory, JSON.stringify(source), repositoryB, remove ? 'remove-paused' : 'add-paused'], {
        env: { ...process.env, TAKT_CONFIG_DIR: globalDirectory }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], timeout: 20_000,
      });
      let stderr = ''; child.stdout!.resume(); child.stderr!.on('data', (value: Buffer) => { stderr += value.toString(); });
      child.on('message', (value: Record<string, unknown>) => { messages.push(value); for (const update of updates) update(); });
      const exited = new Promise<void>((resolve, reject) => {
        child.once('error', reject); child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`Membership child ${code}: ${stderr}`)));
      });
      void exited.catch(() => {});
      cleanups.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited.catch(() => {}); });
      const wait = async (match: (value: Record<string, unknown>) => boolean) => {
        while (true) {
          const found = messages.find(match); if (found !== undefined) return found;
          const changed = deferred<void>(); const update = () => changed.resolve(); updates.add(update);
          try { await Promise.race([changed.promise, exited.then(() => { throw new Error('Membership child exited before notification'); })]); }
          finally { updates.delete(update); }
        }
      };
      return { wait, messages,
        async finish() { await wait((value) => value.kind === 'assignment-ready'); child.send('continue');
          const result = await wait((value) => value.kind === 'result'); await exited;
          expect(result.failed).toBe(false); return result; } };
    }

    it.each([1, 2, 3].flatMap((run) => ['add', 'create'].flatMap((mutation) =>
      ['before', 'preparing', 'reply', 'http'].map((stage) => ({ run, mutation, stage }))))) (
      'keeps the returned identity consistent across workspace $mutation at $stage (run: $run)', async ({ run, mutation, stage }) => {
        const workspace = mutation === 'add' ? await createWorkspace({ globalConfigDirectory: globalDirectory,
          name: 'apps', repositoryDirectories: [repositoryA] }) : undefined;
        const source = workspace === undefined ? { kind: 'repository' as const, repositoryDirectory: repositoryA }
          : { kind: 'workspace' as const, workspaceId: workspace.id };
        const f = await director(humanMessage(`${repositoryB} のmanagerを用意して`)); const states = new DirectorManagerStateStore(globalDirectory);
        const entered = deferred<void>(); const resume = deferred<void>();
        if (stage === 'preparing') {
          const ensure = DaemonConversations.prototype.ensure;
          vi.spyOn(DaemonConversations.prototype, 'ensure').mockImplementationOnce(async function(this: DaemonConversations, ...args) {
            entered.resolve(); await resume.promise; await ensure.apply(this, args);
          });
        }
        if (stage === 'reply') {
          const handle = f.owner.handle;
          vi.spyOn(f.owner, 'handle').mockImplementation(async (...args) => {
            const result = await handle(...args);
            if (result.kind === 'director_manager_added') { entered.resolve(); await resume.promise; }
            return result;
          });
        }
        if (stage === 'http') {
          const end = ServerResponse.prototype.end;
          const write = ServerResponse.prototype.write;
          const writeHead = ServerResponse.prototype.writeHead;
          const jsonResponses = new WeakSet<ServerResponse>();
          const writes = new Map<ServerResponse, Array<Parameters<typeof write>>>();
          let gated = false;
          vi.spyOn(ServerResponse.prototype, 'writeHead').mockImplementation(function(this: ServerResponse, ...args: Parameters<typeof writeHead>) {
            const values: unknown[] = args;
            const headers = typeof values[1] === 'string' ? values[2] : values[1];
            if (headers !== null && typeof headers === 'object' && Object.entries(headers).some(([name, value]) =>
              name.toLowerCase() === 'content-type' && String(value).includes('application/json'))) jsonResponses.add(this);
            return writeHead.apply(this, args);
          });
          vi.spyOn(ServerResponse.prototype, 'write').mockImplementation(function(this: ServerResponse, ...args: Parameters<typeof write>) {
            if (jsonResponses.has(this)) {
              const queued = writes.get(this);
              if (queued === undefined) writes.set(this, [args]); else queued.push(args);
              return true;
            }
            return write.apply(this, args);
          });
          vi.spyOn(ServerResponse.prototype, 'end').mockImplementation(function(this: ServerResponse, ...args: Parameters<typeof end>) {
            let matches = false;
            const queued = writes.get(this); writes.delete(this);
            const chunks: unknown[] = [...(queued === undefined ? [] : queued.map(([chunk]) => chunk)), args[0]];
            const buffers = chunks.flatMap((chunk) => typeof chunk === 'string' ? [Buffer.from(chunk)]
              : ArrayBuffer.isView(chunk) ? [Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)] : []);
            if (buffers.length > 0) {
              try {
                const message = JSON.parse(Buffer.concat(buffers).toString('utf8')) as { result?: { content?: Array<{ text?: string }> } };
                matches = message.result?.content?.some(({ text }) => text !== undefined && typeof JSON.parse(text).managerId === 'string') === true;
              } catch { /* Unrelated HTTP responses need not contain a JSON tool result. */ }
            }
            console.info(JSON.stringify({ scenario: 'preparation-http-end', run, mutation, statusCode: this.statusCode, matches }));
            const flush = () => { if (queued !== undefined) for (const chunk of queued) write.apply(this, chunk); return end.apply(this, args); };
            if (!gated && matches) {
              gated = true; entered.resolve(); void resume.promise.then(flush); return this;
            }
            return flush();
          });
        }
        let changing: ReturnType<typeof membership>;
        if (stage === 'before') { changing = membership(source); await changing.finish(); }
        const preparing = f.add(repositoryB);
        cleanups.push(async () => { resume.resolve(); await preparing; });
        if (stage !== 'before') {
          await Promise.race([entered.promise, preparing.then(() => { throw new Error('Preparation replied before the controlled boundary'); })]);
          changing = membership(source);
          const waiting = await changing.wait((value) => value.kind === 'attempt' && String(value.path).includes('assignment-locks')
            && String(value.path).endsWith(`${managerId(repositoryB)}.lock`));
          expect(JSON.parse(readFileSync(String(waiting.path), 'utf8')).pid).toBe(process.pid);
          expect(changing.messages.some((value) => value.kind === 'assignment-ready')).toBe(false);
          resume.resolve();
        }
        const response = await preparing;
        const savedBeforeResponse = stage === 'before';
        const current = savedBeforeResponse ? (await readWorkspaceRegistry(globalDirectory)).find((value) => value.repositoryDirectories.includes(repositoryB))! : undefined;
        const expected = current === undefined ? managerId(repositoryB) : conversationId({ kind: 'workspace', workspaceId: current.id });
        expect(response.managerId).toBe(expected);
        expect((await f.list()).managers.map(({ id }) => id)).toContain(expected);
        expect((await f.store.read(expected))?.state.assignment.kind).toBe(savedBeforeResponse ? 'workspace' : 'repository');
        expect(await states.isFired(expected)).toBe(false);
        if (stage !== 'before') await changing!.finish();
        const finalWorkspace = (await readWorkspaceRegistry(globalDirectory)).find((value) => value.repositoryDirectories.includes(repositoryB))!;
        const finalId = conversationId({ kind: 'workspace', workspaceId: finalWorkspace.id });
        expect((await f.list()).managers.map(({ id }) => id)).toContain(finalId);
        console.info(JSON.stringify({ scenario: 'http-preparation-assignment', run, mutation, stage, response,
          listedAtResponse: expected, finalId, membershipMessages: changing!.messages }));
      },
    );

    it.each([true, false])('orders preparation with workspace removal (removal first: %s)', async (before) => {
      const workspace = await createWorkspace({ globalConfigDirectory: globalDirectory, name: 'apps', repositoryDirectories: [repositoryA, repositoryB] });
      const source = { kind: 'workspace' as const, workspaceId: workspace.id }; const f = await director(humanMessage(`${repositoryB} のmanagerを用意して`));
      let changing: ReturnType<typeof membership>;
      if (before) { changing = membership(source, true); await changing.finish(); }
      const entered = deferred<void>(); const resume = deferred<void>();
      if (!before) {
        const ensure = DaemonConversations.prototype.ensure;
        vi.spyOn(DaemonConversations.prototype, 'ensure').mockImplementationOnce(async function(this: DaemonConversations, ...args) {
          entered.resolve(); await resume.promise; await ensure.apply(this, args);
        });
      }
      const preparing = f.add(repositoryB); cleanups.push(async () => { resume.resolve(); await preparing; });
      if (!before) {
        await entered.promise; changing = membership(source, true);
        const waiting = await changing.wait((value) => value.kind === 'attempt' && String(value.path).includes('assignment-locks')
          && String(value.path).endsWith(`${managerId(repositoryB)}.lock`));
        expect(JSON.parse(readFileSync(String(waiting.path), 'utf8')).pid).toBe(process.pid);
        resume.resolve();
      }
      const response = await preparing;
      expect(response.managerId).toBe(before ? managerId(repositoryB) : conversationId(source));
      expect((await f.list()).managers.map(({ id }) => id)).toContain(response.managerId);
      if (!before) await changing!.finish();
      expect((await f.list()).managers.map(({ id }) => id)).toContain(managerId(repositoryB));
    });

    it('restores only the current fired workspace after successful preparation and preserves failure state', async () => {
      const workspace = await createWorkspace({ globalConfigDirectory: globalDirectory, name: 'apps', repositoryDirectories: [repositoryA, repositoryB] });
      const id = conversationId({ kind: 'workspace', workspaceId: workspace.id }); const f = await director(humanMessage(`${repositoryB} のmanagerを用意して`));
      await f.add(repositoryB); await f.fire(id);
      const states = new DirectorManagerStateStore(globalDirectory);
      await states.setFired(managerId(repositoryB), true, f.signal);
      vi.spyOn(DaemonConversations.prototype, 'ensure').mockRejectedValueOnce(new Error('Preparation failed'));
      expect((await f.client.callTool({ name: 'takt_add_manager', arguments: { repositoryDirectory: repositoryB } })).isError).toBe(true);
      expect(await states.isFired(id)).toBe(true);
      expect((await f.list()).managers.map(({ id }) => id)).not.toContain(id);
      expect((await f.add(repositoryB)).managerId).toBe(id);
      expect((await f.list()).managers.map(({ id }) => id)).toContain(id);
      expect(await states.isFired(id)).toBe(false);
      expect(await states.isFired(managerId(repositoryB))).toBe(true);
    });

    function finishedGoal(status: 'completed' | 'aborted'): Goal {
      const goal = goalRecord();
      if (status === 'aborted') return { ...goal, executionStatus: 'aborted' };
      return { ...goal, status: 'completed', completion: { goalBranch: goal.branch, goalSha: 'a'.repeat(40),
        targetBranch: 'main', targetSha: 'b'.repeat(40), summary: 'Done', instructions: [],
        changeSummary: { filesChanged: 0, additions: 0, deletions: 0, files: [], truncated: false, totalsTruncated: false } } };
    }

    it('adds a goal-free repository manager and immediately lists its returned identity', async () => {
      const f = await director(humanMessage(`${repositoryA} のmanagerを用意して`));
      expect((await f.list()).managers).toEqual([]);
      const added = await f.add(repositoryA);
      expect(added.managerId).toBe(managerId(repositoryA));
      expect((await f.list()).managers.map(({ id }) => id)).toEqual([added.managerId]);
      expect((await f.store.read(managerId(repositoryA)))?.state.assignment).toEqual({ kind: 'repository', repositoryDirectory: repositoryA });
      expect((await new GoalStore(repositoryA).list()).goals).toEqual([]);
      expect(f.accept).not.toHaveBeenCalled();
    });

    it('keeps a failed first preparation out of the list and delivery until retry succeeds with the same identity', async () => {
      const f = await director(humanMessage(`${repositoryA} のmanagerを用意して`));
      const id = managerId(repositoryA);
      vi.spyOn(DaemonConversations.prototype, 'ensure').mockRejectedValueOnce(new Error('Preparation failed'));
      expect((await f.client.callTool({ name: 'takt_add_manager', arguments: { repositoryDirectory: repositoryA } })).isError).toBe(true);
      expect(await f.store.read(id)).toBeUndefined();
      expect((await f.list()).managers).toEqual([]);
      expect((await readProjectRegistry(globalDirectory)).projects).toEqual([]);
      expect((await f.client.callTool({ name: 'takt_tell_manager', arguments: { managerId: id, text: 'work', origin: 'human' } })).isError).toBe(true);
      expect(await f.request({ kind: 'get_delivery', conversationId: id })).toMatchObject({ kind: 'error' });
      expect(await f.request({ kind: 'accept_director_message', conversationId: id, eventId: 'unprepared', requestId: 'unprepared',
        occurredAt: '2026-11-18T00:00:00.000Z', text: 'work', origin: 'human' })).toMatchObject({ kind: 'error' });
      expect(f.accept).not.toHaveBeenCalled();
      expect((await f.add(repositoryA)).managerId).toBe(id);
      expect((await f.list()).managers.map(({ id }) => id)).toEqual([id]);
      await f.call('takt_tell_manager', { managerId: id, text: 'retry succeeded', origin: 'human' });
      expect(f.accept).toHaveBeenCalledOnce();
    });

    it('preserves existing registrations and conversations when re-preparation fails', async () => {
      await seed(repositoryA); await seed(repositoryB);
      const f = await director(humanMessage(`${repositoryA} のmanagerを用意して`));
      const ids = [managerId(repositoryA), managerId(repositoryB)];
      const before = ids.map((id) => readFileSync(join(globalDirectory, 'conversations', `${id}.json`), 'utf8'));
      vi.spyOn(DaemonConversations.prototype, 'ensure').mockRejectedValueOnce(new Error('Preparation failed'));
      expect((await f.client.callTool({ name: 'takt_add_manager', arguments: { repositoryDirectory: repositoryA } })).isError).toBe(true);
      expect((await f.list()).managers.map(({ id }) => id).sort()).toEqual([...ids].sort());
      expect(ids.map((id) => readFileSync(join(globalDirectory, 'conversations', `${id}.json`), 'utf8'))).toEqual(before);
    });

    it('restores a fired manager only after re-preparation succeeds', async () => {
      await seed(repositoryA);
      const f = await director(humanMessage(`${repositoryA} のmanagerを用意して`)); const id = managerId(repositoryA);
      const path = join(globalDirectory, 'conversations', `${id}.json`);
      const before = readFileSync(path, 'utf8');
      await f.fire(id);
      const watcher = await director({ kind: 'watch_observation', observation: { kind: 'director_state_changed',
        managerConversationId: id, repositoryDirectory: repositoryA, goalId: null,
        targetId: 'manager', generation: '1', observedAt: new Date().toISOString(), state: '{}' } });
      const resolve = vi.spyOn(gitRepositories, 'resolveGitRepositoryDirectory');
      expect((await watcher.client.callTool({ name: 'takt_add_manager', arguments: { repositoryDirectory: repositoryA } })).isError).toBe(true);
      expect(resolve).not.toHaveBeenCalled();
      expect(await new DirectorManagerStateStore(globalDirectory).isFired(id)).toBe(true);
      expect((await watcher.list()).managers).toEqual([]);
      expect(readFileSync(path, 'utf8')).toBe(before);
      resolve.mockRestore();
      vi.spyOn(DaemonConversations.prototype, 'ensure').mockRejectedValueOnce(new Error('Preparation failed'));
      expect((await f.client.callTool({ name: 'takt_add_manager', arguments: { repositoryDirectory: repositoryA } })).isError).toBe(true);
      expect((await f.list()).managers).toEqual([]);
      expect(readFileSync(path, 'utf8')).toBe(before);
      expect((await f.add(repositoryA)).managerId).toBe(id);
      expect((await f.list()).managers.map(({ id }) => id)).toEqual([id]);
      expect(readFileSync(path, 'utf8')).toBe(before);
    });

    it('lists seeded managers and accepts messages through the production state action and protocol', async () => {
      await seed(repositoryA);
      const f = await director();
      const id = managerId(repositoryA);
      expect((await f.list()).managers.map((entry) => entry.id)).toEqual([id]);
      expect(savedManagerIds()).toEqual([id]);
      await f.call('takt_tell_manager', { managerId: id, text: 'work', origin: 'human' });
      expect(f.accept).toHaveBeenCalledWith(expect.objectContaining({ conversationId: id, source: 'director',
        event: { kind: 'director_message', directorConversationId: conversationId({ kind: 'daemon' }), text: 'work', origin: 'human' } }));
    });

    it('reuses the existing manager without duplicating it or overwriting either conversation', async () => {
      await seed(repositoryA); await seed(repositoryB);
      const f = await director(humanMessage(`${repositoryA} のmanagerを用意して`));
      const ids = [managerId(repositoryA), managerId(repositoryB)];
      const before = ids.map((id) => readFileSync(join(globalDirectory, 'conversations', `${id}.json`), 'utf8'));
      for (let count = 0; count < 2; count++) expect((await f.add(repositoryA)).managerId).toBe(ids[0]);
      expect((await f.list()).managers.map(({ id }) => id).sort()).toEqual([...ids].sort());
      expect(ids.map((id) => readFileSync(join(globalDirectory, 'conversations', `${id}.json`), 'utf8'))).toEqual(before);
    });

    it.each(['relative', 'missing', 'non-git'] as const)('rejects a %s repository without creating a registration or conversation', async (kind) => {
      const notGit = join(root, 'not-git');
      mkdirSync(notGit);
      const path = kind === 'relative' ? 'relative/repository' : kind === 'missing' ? join(root, 'missing') : notGit;
      const f = await director(humanMessage(`${path} のmanagerを用意して`));
      expect((await f.client.listTools()).tools.map(({ name }) => name)).toContain('takt_add_manager');
      const resolve = vi.spyOn(gitRepositories, 'resolveGitRepositoryDirectory');
      const result = await f.client.callTool({ name: 'takt_add_manager', arguments: { repositoryDirectory: path } });
      expect(result.isError).toBe(true);
      if (kind !== 'relative') expect(resolve).toHaveBeenCalledWith(path);
      expect((await readProjectRegistry(globalDirectory)).projects).toEqual([]);
      expect(await f.store.read(managerId(path))).toBeUndefined();
      expect((await f.list()).managers).toEqual([]);
      expect(f.accept).not.toHaveBeenCalled();
    });

    it('fires and restores the same manager on one connection while retaining records and branches', async () => {
      await seed(repositoryA); await seed(repositoryB);
      const goal = finishedGoal('completed');
      await new GoalStore(repositoryA).create(goal);
      const f = await director(humanMessage(`${repositoryA} のmanagerを用意して`));
      const id = managerId(repositoryA);
      const history = new FileEventStore(globalDirectory);
      await history.accept({ ...turnStart().event, conversationId: id });
      const savedTurns = await history.readTurns(id);
      expect(savedTurns).toHaveLength(1);
      const paths = [join(repositoryA, '.takt', 'goals', goal.id, 'goal.json'),
        ...[id, managerId(repositoryB)].map((value) => join(globalDirectory, 'conversations', `${value}.json`))];
      const before = paths.map((path) => readFileSync(path, 'utf8'));
      const refs = execFileSync('git', ['-C', repositoryA, 'show-ref'], { encoding: 'utf8' });
      expect((await f.list()).managers.map((entry) => entry.id)).toContain(id);
      await f.call('takt_tell_manager', { managerId: id, text: 'before fire', origin: 'human' });
      expect(f.accept).toHaveBeenCalledOnce();
      f.accept.mockClear();
      await f.fire(id);
      expect(await f.list({ limit: 1 })).toMatchObject({ totalCount: 1, returnedCount: 1, nextOffset: null,
        managers: [{ id: managerId(repositoryB) }] });
      expect((await listDirectorManagers(globalDirectory)).managers.map(conversationId)).not.toContain(id);
      expect(savedManagerIds()).toEqual([managerId(repositoryB)]);
      expect(paths.map((path) => readFileSync(path, 'utf8'))).toEqual(before);
      expect(execFileSync('git', ['-C', repositoryA, 'show-ref'], { encoding: 'utf8' })).toBe(refs);
      expect(await new FileEventStore(globalDirectory).readTurns(id)).toEqual(savedTurns);
      expect((await f.client.callTool({ name: 'takt_tell_manager', arguments: { managerId: id, text: 'after fire', origin: 'director' } })).isError).toBe(true);
      expect(await f.request({ kind: 'get_delivery', conversationId: id })).toMatchObject({ kind: 'error' });
      expect(await f.request({ kind: 'accept_director_message', conversationId: id, eventId: 'late', requestId: 'late',
        occurredAt: '2026-11-18T00:00:00.000Z', text: 'late message', origin: 'human' })).toMatchObject({ kind: 'error' });
      expect(f.accept).not.toHaveBeenCalled();
      expect(await new DaemonRouting(globalDirectory).permits({ kind: 'repository', repositoryDirectory: repositoryA }, id)).toBe(true);
      await registerProject({ globalConfigDirectory: globalDirectory, projectDirectory: repositoryA, command: 'manager', managerUsed: true });
      expect((await f.list()).managers.map((entry) => entry.id)).not.toContain(id);
      expect((await f.add(repositoryA)).managerId).toBe(id);
      expect((await f.list()).managers.map((entry) => entry.id).sort()).toEqual([id, managerId(repositoryB)].sort());
      expect(savedManagerIds().sort()).toEqual([id, managerId(repositoryB)].sort());
      await f.call('takt_tell_manager', { managerId: id, text: 'restored', origin: 'human' });
      expect(f.accept).toHaveBeenCalledOnce();
      expect(paths.map((path) => readFileSync(path, 'utf8'))).toEqual(before);
      expect(await new FileEventStore(globalDirectory).readTurns(id)).toEqual(savedTurns);
      expect(execFileSync('git', ['-C', repositoryA, 'show-ref'], { encoding: 'utf8' })).toBe(refs);
      expect(existsSync(join(repositoryA, '.git'))).toBe(true);
    });

    it.each([
      { status: 'created', executionStatus: 'active' },
      { status: 'created', executionStatus: 'paused' },
      { status: 'awaiting_merge', executionStatus: 'active' },
    ] as const)('refuses fire with a $status/$executionStatus goal and preserves the manager', async (state) => {
      await seed(repositoryA);
      const goal: Goal = { ...finishedGoal('completed'), ...state };
      await new GoalStore(repositoryA).create(goal);
      const f = await director();
      const path = join(repositoryA, '.takt', 'goals', goal.id, 'goal.json');
      const before = readFileSync(path, 'utf8');
      expect((await f.client.listTools()).tools.map(({ name }) => name)).toContain('takt_fire_manager');
      const result = await f.client.callTool({ name: 'takt_fire_manager', arguments: { managerId: managerId(repositoryA) } });
      expect(result.isError).toBe(true);
      expect(firstTextContent(result.content)).toMatch(/goal|ゴール/i);
      expect((await f.list()).managers.map(({ id }) => id)).toContain(managerId(repositoryA));
      expect(readFileSync(path, 'utf8')).toBe(before);
    });

    it.each(['completed', 'aborted'] as const)('allows fire when all goals are %s and preserves the goal record', async (status) => {
      await seed(repositoryA);
      const goal = finishedGoal(status);
      await new GoalStore(repositoryA).create(goal);
      const path = join(repositoryA, '.takt', 'goals', goal.id, 'goal.json');
      const before = readFileSync(path, 'utf8');
      const f = await director();
      await f.fire(managerId(repositoryA));
      expect((await f.list()).managers).toEqual([]);
      expect(readFileSync(path, 'utf8')).toBe(before);
    });

    it('rejects fire for an unfinished goal after a completed goal and allows it after only that goal is aborted', async () => {
      await seed(repositoryA);
      const completed = finishedGoal('completed');
      const active = { ...goalRecord(), id: '550e8400-e29b-41d4-a716-446655440001' };
      const store = new GoalStore(repositoryA);
      await store.create(completed); await store.create(active);
      const read = managerGoals.readDirectorManagerGoals;
      const orders: string[][] = [];
      vi.spyOn(managerGoals, 'readDirectorManagerGoals').mockImplementation(async function* (directory, signal) {
        const records: Goal[] = [];
        for await (const goal of read(directory, signal)) records.push(goal);
        const ordered = [completed.id, active.id].map((id) => {
          const goal = records.find((record) => record.id === id);
          if (goal === undefined) throw new Error('Expected both saved goals');
          return goal;
        });
        orders.push(ordered.map(({ id }) => id));
        yield* ordered;
      });
      const paths = [completed, active].map((goal) => join(repositoryA, '.takt', 'goals', goal.id, 'goal.json'));
      const before = paths.map((path) => readFileSync(path, 'utf8'));
      const refs = execFileSync('git', ['-C', repositoryA, 'show-ref'], { encoding: 'utf8' });
      const f = await director(); const id = managerId(repositoryA);
      const result = await f.client.callTool({ name: 'takt_fire_manager', arguments: { managerId: id } });
      expect(result.isError).toBe(true);
      expect(firstTextContent(result.content)).toContain(active.id);
      expect(await new DirectorManagerStateStore(globalDirectory).isFired(id)).toBe(false);
      expect((await f.list()).managers.map(({ id }) => id)).toContain(id);
      expect(paths.map((path) => readFileSync(path, 'utf8'))).toEqual(before);
      await store.update(active.id, (goal) => ({ ...goal, executionStatus: 'aborted' }));
      const afterAbort = paths.map((path) => readFileSync(path, 'utf8'));
      await f.fire(id);
      expect(await new DirectorManagerStateStore(globalDirectory).isFired(id)).toBe(true);
      expect((await f.list()).managers.map(({ id }) => id)).not.toContain(id);
      expect(orders).toEqual([[completed.id, active.id], [completed.id, active.id]]);
      expect(paths.map((path) => readFileSync(path, 'utf8'))).toEqual(afterAbort);
      expect(execFileSync('git', ['-C', repositoryA, 'show-ref'], { encoding: 'utf8' })).toBe(refs);
    });

    it('reuses a workspace manager and checks unfinished goals in every member before fire', async () => {
      const workspace = await createWorkspace({ globalConfigDirectory: globalDirectory, name: 'apps', repositoryDirectories: [repositoryA, repositoryB] });
      const f = await director(humanMessage(`${repositoryA} と ${repositoryB} のmanagerを用意して`));
      const id = conversationId({ kind: 'workspace', workspaceId: workspace.id });
      expect((await f.add(repositoryA)).managerId).toBe(id);
      expect((await f.list()).managers.map((entry) => entry.id)).toEqual([id]);
      const goal = { ...goalRecord(), executionStatus: 'paused' as const };
      await new GoalStore(repositoryB).create(goal);
      const result = await f.client.callTool({ name: 'takt_fire_manager', arguments: { managerId: id } });
      expect(result.isError).toBe(true);
      expect((await f.list()).managers.map((entry) => entry.id)).toEqual([id]);
      await new GoalStore(repositoryB).update(goal.id, (saved) => ({ ...saved, executionStatus: 'aborted' }));
      const savedWorkspace = readFileSync(join(globalDirectory, 'workspaces', workspace.id, 'workspace.json'), 'utf8');
      await f.fire(id);
      expect((await f.list()).managers).toEqual([]);
      expect(readFileSync(join(globalDirectory, 'workspaces', workspace.id, 'workspace.json'), 'utf8')).toBe(savedWorkspace);
      expect((await f.add(repositoryB)).managerId).toBe(id);
      expect((await f.list()).managers.map((entry) => entry.id)).toEqual([id]);
    });

    it('refuses fire when a goal record cannot be read', async () => {
      await seed(repositoryA);
      const path = join(repositoryA, '.takt', 'goals', goalRecord().id);
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, 'goal.json'), '{invalid');
      const f = await director();
      expect((await f.client.listTools()).tools.map(({ name }) => name)).toContain('takt_fire_manager');
      expect((await f.client.callTool({ name: 'takt_fire_manager', arguments: { managerId: managerId(repositoryA) } })).isError).toBe(true);
      expect((await f.list()).managers.map(({ id }) => id)).toContain(managerId(repositoryA));
      expect(readFileSync(join(path, 'goal.json'), 'utf8')).toBe('{invalid');
    });

    it('fires an empty workspace without deleting its registration', async () => {
      const workspace = await createWorkspace({ globalConfigDirectory: globalDirectory, name: 'empty', repositoryDirectories: [] });
      const f = await director();
      const id = conversationId({ kind: 'workspace', workspaceId: workspace.id });
      expect((await f.list()).managers.map((entry) => entry.id)).toEqual([id]);
      await f.fire(id);
      expect((await f.list()).managers).toEqual([]);
      expect(await readWorkspace(globalDirectory, workspace.id)).toEqual(workspace);
    });

    it('rejects lifecycle state requests from a manager conversation', async () => {
      const f = await director(humanMessage(`${repositoryA} のmanagerを用意して`));
      const id = managerId(repositoryA);
      await f.add(repositoryA);
      const add = f.requests.at(-1)!;
      const managerTurn = { ...f.active.turn, conversationId: id };
      expect(await f.owner.handle(managerTurn, add, f.signal)).toMatchObject({ kind: 'error', code: 'forbidden' });
      await f.fire(id);
      const fire = f.requests.at(-1)!;
      expect(await f.owner.handle(managerTurn, fire, f.signal)).toMatchObject({ kind: 'error', code: 'forbidden' });
    });
  });

  it('uses the selected repository workflow configuration for a workspace manager', async () => {
    writeFileSync(join(repositoryA, '.takt', 'config.yaml'), 'manager:\n  auto_run: false\n  workflows: [default]\n');
    writeFileSync(join(repositoryB, '.takt', 'config.yaml'), 'manager:\n  auto_run: false\n  workflows: [simple]\n');
    const workspace = await createWorkspace({ globalConfigDirectory: globalDirectory, name: 'Workflows', repositoryDirectories: [repositoryA, repositoryB] });
    await withClient({ managerAssignment: { kind: 'workspace', workspaceId: workspace.id } }, async (client) => {
      for (const [cwd, expected] of [[repositoryA, 'default'], [repositoryB, 'simple']]) {
        const result = await call(client, 'takt_list_workflows', { cwd });
        expect(result.workflows.map((entry: { name: string }) => entry.name)).toEqual([expected]);
      }
    });
  });

  it.each(['opencode', 'mock'] as const)('refreshes workspace access in the same manager conversation and notifies only OpenCode (provider=%s)', async (providerType) => {
    const workspace = await createWorkspace({ globalConfigDirectory: globalDirectory, name: '担当', repositoryDirectories: [repositoryA] });
    type WorkspaceOptions = ProviderCallOptions & { openCodeWorkspaceAccess?: { ownerId: string; directories: readonly string[] } };
    const callProvider = vi.fn<(prompt: string, options: WorkspaceOptions) => ReturnType<ProviderAgent['call']>>();
    await withClient({ managerAssignment: { kind: 'workspace', workspaceId: workspace.id } }, async (mcp) => {
      callProvider.mockImplementation(async () => ({ persona: 'manager', status: 'done', timestamp: new Date(),
        content: JSON.stringify({ message: '処理しました。', summary: null }), sessionId: 'same-provider-session' }));
      const client = new ManagerServiceClient({ cwd: repositoryA, assignment: { kind: 'workspace', workspaceId: workspace.id },
        plan: { ctx: { provider: makeProvider({ setup: () => ({ call: callProvider }) }), providerType, model: 'probe/model', lang: 'ja' },
          strategy: { systemPrompt: 'manager fixture' } } });
      const turn = (text: string) => submitAndWait(client, { kind: 'message', text });
      const additions: string[] = [];
      try {
        expect(await turn('追加前を確認')).toMatchObject({ kind: 'reply', message: '処理しました。' });
        const initialConversation = client.getSnapshot().state!.conversationId;
        callProvider.mockImplementationOnce(async () => {
          for (const repositoryDirectory of [repositoryB, repositoryC]) {
            await call(mcp, 'takt_add_workspace_repository', { repositoryDirectory });
            additions.push(repositoryDirectory);
          }
          return { persona: 'manager', status: 'done', timestamp: new Date(),
            content: JSON.stringify({ message: '処理しました。', summary: null }), sessionId: 'same-provider-session' };
        });
        const added = await turn('担当を追加');
        expect(added.kind).toBe('reply');
        if (added.kind !== 'reply') throw new Error('Expected manager reply');
        if (providerType === 'opencode') {
          for (const directory of [repositoryB, repositoryC]) expect(added.message).toContain(directory);
          expect(added.message).toMatch(/追加|登録/u);
          expect(added.message).toMatch(/次のターン/u);
        } else expect(added.message).toBe('処理しました。');

        const next = await turn('追加した担当を参照');
        expect(next).toMatchObject({ kind: 'reply', message: '処理しました。' });
        await call(mcp, 'takt_remove_workspace_repository', { repositoryDirectory: repositoryB });
        expect(await turn('削除後を確認')).toMatchObject({ kind: 'reply', message: '処理しました。' });
        expect(client.getSnapshot().state!.conversationId).toBe(initialConversation);
        expect(additions).toEqual([repositoryB, repositoryC]);
        expect(callProvider).toHaveBeenCalledTimes(4);
        if (providerType === 'opencode') {
          const access = callProvider.mock.calls.map(([, options]) => options.openCodeWorkspaceAccess);
          expect(access.every((value) => typeof value?.ownerId === 'string' && value.ownerId.length > 0)).toBe(true);
          expect(new Set(access.map((value) => value?.ownerId)).size).toBe(1);
          expect(access.map((value) => value?.directories.filter((directory) => directory !== repositoryA).sort()))
            .toEqual([[], [], [repositoryB, repositoryC].sort(), [repositoryC]]);
        } else for (const [, options] of callProvider.mock.calls) expect(options).not.toHaveProperty('openCodeWorkspaceAccess');
      } finally { await client.dispose(); }
    });
  });

  it('excludes a missing registered repository for one turn and rechecks it in the same manager conversation', async () => {
    const workspace = await createWorkspace({ globalConfigDirectory: globalDirectory, name: '担当', repositoryDirectories: [repositoryA, repositoryB, repositoryC] });
    rmSync(repositoryB, { recursive: true });
    type WorkspaceOptions = ProviderCallOptions & { openCodeWorkspaceAccess?: { directories: readonly string[] } };
    const callProvider = vi.fn<(prompt: string, options: WorkspaceOptions) => ReturnType<ProviderAgent['call']>>()
      .mockResolvedValue({ persona: 'manager', status: 'done', timestamp: new Date(), content: '確認しました。', sessionId: 'same-provider-session' });
    const client = new ManagerServiceClient({ cwd: repositoryA, assignment: { kind: 'workspace', workspaceId: workspace.id },
      plan: { ctx: { provider: makeProvider({ setup: () => ({ call: callProvider }) }), providerType: 'opencode', model: 'probe/model', lang: 'ja' },
        strategy: { systemPrompt: 'manager fixture' } } });
    try {
      const first = await submitAndWait(client, { kind: 'message', text: '担当を確認' });
      expect(first.kind).toBe('reply');
      if (first.kind !== 'reply') throw new Error('Expected manager reply');
      expect(first.message).toContain(repositoryB);
      expect(first.message).toMatch(/存在|見つか/u);
      expect(callProvider.mock.calls[0]![1].openCodeWorkspaceAccess?.directories.filter((directory) => directory !== repositoryA)).toEqual([repositoryC]);
      expect((await readWorkspace(globalDirectory, workspace.id))!.repositoryDirectories).toEqual([repositoryA, repositoryB, repositoryC]);

      execFileSync('git', ['init', '-b', 'main', repositoryB], { stdio: 'pipe' });
      expect(await submitAndWait(client, { kind: 'message', text: '復旧後を確認' })).toMatchObject({ kind: 'reply', message: '確認しました。' });
      expect(callProvider.mock.calls[1]![1].openCodeWorkspaceAccess?.directories.filter((directory) => directory !== repositoryA).sort())
        .toEqual([repositoryB, repositoryC].sort());
    } finally { await client.dispose(); }
  });

  it('does not announce next-turn access after a failed or redundant workspace addition', async () => {
    const workspace = await createWorkspace({ globalConfigDirectory: globalDirectory, name: '担当', repositoryDirectories: [repositoryA, repositoryB] });
    await withClient({ managerAssignment: { kind: 'workspace', workspaceId: workspace.id } }, async (mcp) => {
      const callProvider = vi.fn<ProviderAgent['call']>().mockImplementation(async () => {
        const failed = await mcp.callTool({ name: 'takt_add_workspace_repository', arguments: { repositoryDirectory: join(root, 'missing') } });
        expect(failed.isError).toBe(true);
        await call(mcp, 'takt_add_workspace_repository', { repositoryDirectory: repositoryB });
        return { persona: 'manager', status: 'done', timestamp: new Date(), content: '変更はありません。' };
      });
      const client = new ManagerServiceClient({ cwd: repositoryA, assignment: { kind: 'workspace', workspaceId: workspace.id },
        plan: { ctx: { provider: makeProvider({ setup: () => ({ call: callProvider }) }), providerType: 'opencode', model: 'probe/model', lang: 'ja' },
          strategy: { systemPrompt: 'manager fixture' } } });
      try {
        expect(await submitAndWait(client, { kind: 'message', text: '担当を追加' })).toMatchObject({ kind: 'reply', message: '変更はありません。' });
        expect((await readWorkspace(globalDirectory, workspace.id))!.repositoryDirectories).toEqual([repositoryA, repositoryB]);
      } finally { await client.dispose(); }
    });
  });

  it('retrieves every saved repository after bounded add, remove and rename responses without repeating the mutation', async () => {
    const directories = [repositoryA, ...workspaceRepositories(110)];
    const workspace = await createWorkspace({ globalConfigDirectory: globalDirectory, name: '開発担当', repositoryDirectories: directories });
    expect(Buffer.byteLength(JSON.stringify({ workspace }))).toBeGreaterThan(MCP_RESPONSE_MAX_BYTES);
    await withClient({ managerAssignment: { kind: 'workspace', workspaceId: workspace.id } }, async (client) => {
      const operations = [
        { name: 'takt_add_workspace_repository', args: { repositoryDirectory: repositoryB } },
        { name: 'takt_remove_workspace_repository', args: { repositoryDirectory: repositoryA } },
        { name: 'takt_rename_workspace', args: { name: '開発担当更新' } },
      ];
      for (const operation of operations) {
        const output = (await call(client, operation.name, operation.args)).workspace;
        const saved = (await readWorkspace(globalDirectory, workspace.id))!;
        expect(Buffer.byteLength(JSON.stringify({ workspace: saved }))).toBeGreaterThan(MCP_RESPONSE_MAX_BYTES);
        expect(output).toMatchObject({ id: saved.id, name: saved.name, totalCount: saved.repositoryDirectories.length,
          returnedCount: output.repositoryDirectories.length, omittedCount: saved.repositoryDirectories.length - output.repositoryDirectories.length,
          offset: 0, nextOffset: output.repositoryDirectories.length, truncated: true });
        const members: string[] = [...output.repositoryDirectories];
        let offset = output.nextOffset;
        while (offset !== null) {
          const page = (await call(client, 'takt_list_tasks', { cwd: repositoryA, view: 'workspace', offset, limit: 50 })).workspace;
          expect(page).toMatchObject({ offset, returnedCount: page.repositoryDirectories.length,
            omittedCount: saved.repositoryDirectories.length - page.repositoryDirectories.length });
          expect(page.nextOffset).toBe(offset + page.returnedCount < page.totalCount ? offset + page.returnedCount : null);
          members.push(...page.repositoryDirectories);
          offset = page.nextOffset;
        }
        expect(members).toEqual(saved.repositoryDirectories);
        expect(await readWorkspace(globalDirectory, workspace.id)).toEqual(saved);
      }
    });
  });

  it('pages 51 repositories and retrieves UTF-8 name and saved repository strings', async () => {
    const directories = [repositoryA, ...workspaceRepositories(50)];
    const workspace = await createWorkspace({ globalConfigDirectory: globalDirectory, name: '開発担当', repositoryDirectories: directories });
    await withClient({ managerAssignment: { kind: 'workspace', workspaceId: workspace.id } }, async (client) => {
      const { tools } = await client.listTools();
      for (const name of ['takt_add_workspace_repository', 'takt_remove_workspace_repository', 'takt_rename_workspace', 'takt_list_tasks']) {
        const description = tools.find((tool) => tool.name === name)!.description;
        for (const selector of ['64 KiB', 'truncation', 'takt_list_tasks view workspace', 'offset/limit', 'path name or repositoryDirectories.N', 'textOffset/maxBytes']) {
          expect(description, name).toContain(selector);
        }
      }
      const read = (args: Record<string, unknown>) => call(client, 'takt_list_tasks', { cwd: repositoryA, view: 'workspace', ...args });
      expect((await read({ limit: 1 })).workspace).toMatchObject({ totalCount: 51, returnedCount: 1, omittedCount: 50, nextOffset: 1 });
      const first = (await read({ limit: 50 })).workspace;
      const last = (await read({ offset: first.nextOffset, limit: 50 })).workspace;
      expect(first).toMatchObject({ returnedCount: 50, nextOffset: 50 });
      expect(last).toMatchObject({ returnedCount: 1, nextOffset: null });
      expect([...first.repositoryDirectories, ...last.repositoryDirectories]).toEqual(directories);
      for (const args of [{ limit: 0 }, { limit: 51 }, { offset: -1 }, { cwd: 'relative' }, { path: 'id' }]) {
        expect((await client.callTool({ name: 'takt_list_tasks', arguments: { cwd: repositoryA, view: 'workspace', ...args } })).isError).toBe(true);
      }
      expect((await read({ path: 'name' }))).toMatchObject({ content: workspace.name, truncated: false, nextOffset: null });
      for (const [path, original, maxBytes] of [
        ['name', workspace.name, 4], ['repositoryDirectories.50', directories[50]!, 64],
      ] as const) {
        let text = '';
        let textOffset = 0;
        for (;;) {
          const page = await read({ path, textOffset, maxBytes });
          expect(page).toMatchObject({ workspaceId: workspace.id, path, offset: textOffset, totalBytes: Buffer.byteLength(original),
            returnedBytes: Buffer.byteLength(page.content) });
          expect(page.returnedBytes).toBeLessThanOrEqual(maxBytes);
          text += page.content;
          if (page.nextOffset === null) break;
          expect(page.truncated).toBe(true);
          expect(page.nextOffset).toBe(textOffset + page.returnedBytes);
          textOffset = page.nextOffset;
        }
        expect(text).toBe(original);
      }
      const longName = '開発担当'.repeat(6000);
      const renamed = await call(client, 'takt_rename_workspace', { name: longName });
      expect(renamed.truncated).toBe(true);
      expect(renamed.omissions).toContainEqual(expect.objectContaining({ path: 'workspace.name', totalBytes: Buffer.byteLength(longName),
        returnedBytes: Buffer.byteLength(renamed.workspace.name) }));
      let restored = '';
      let textOffset = 0;
      for (;;) {
        const page = await read({ path: 'name', textOffset });
        restored += page.content;
        if (page.nextOffset === null) break;
        textOffset = page.nextOffset;
      }
      expect(restored).toBe(longName);
      expect((await client.callTool({ name: 'takt_list_tasks', arguments: { cwd: repositoryA, view: 'workspace', path: 'repositoryDirectories.51' } })).isError).toBe(true);
    });
  });

  it('keeps the created workspace identity after removing the session base and reads an empty workspace without launching work', async () => {
    await withClient({}, async (client) => {
      const workspace = (await call(client, 'takt_add_workspace_repository', { repositoryDirectory: repositoryB })).workspace;
      expect(workspace.repositoryDirectories).toEqual([repositoryA, repositoryB]);
      await call(client, 'takt_remove_workspace_repository', { repositoryDirectory: repositoryA });
      const read = () => call(client, 'takt_list_tasks', { cwd: join(root, 'missing'), view: 'workspace' });
      expect((await read()).workspace).toMatchObject({ id: workspace.id, repositoryDirectories: [repositoryB] });
      await call(client, 'takt_remove_workspace_repository', { repositoryDirectory: repositoryB });
      const saved = readFileSync(join(globalDirectory, 'workspaces', workspace.id, 'workspace.json'), 'utf8');
      vi.mocked(ensureManagerRun).mockClear();
      expect((await read()).workspace).toMatchObject({ id: workspace.id, repositoryDirectories: [],
        totalCount: 0, returnedCount: 0, omittedCount: 0, offset: 0, nextOffset: null, truncated: false });
      expect(ensureManagerRun).not.toHaveBeenCalled();
      expect(readFileSync(join(globalDirectory, 'workspaces', workspace.id, 'workspace.json'), 'utf8')).toBe(saved);
      expect(existsSync(join(repositoryA, '.takt', 'tasks.yaml'))).toBe(false);
    });
  });

  it.each(['read-only', 'all'] as const)('rejects workspace reads for %s without exposing assigned data', async (toolSet) => {
    const workspace = await createWorkspace({ globalConfigDirectory: globalDirectory, name: '開発担当', repositoryDirectories: [repositoryA] });
    await withClient({ toolSet, managerAssignment: { kind: 'workspace', workspaceId: workspace.id } }, async (client) => {
      const result = await client.callTool({ name: 'takt_list_tasks', arguments: { cwd: repositoryA, view: 'workspace' } });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
      expect(firstTextContent(result.content)).toMatch(/only available to managers/);
      expect((await call(client, 'takt_list_tasks', { cwd: repositoryA })).tasks).toEqual([]);
    });
  });

  it('creates a workspace on addition and resolves the same context from every member and subdirectory', async () => {
    const workspace = await addManagerRepository(single(), repositoryB, globalDirectory);
    expect(workspace).toBeDefined();
    const expected = createWorkspaceManagerContext(workspace!, globalDirectory);
    mkdirSync(join(repositoryB, 'src'));
    for (const cwd of [repositoryA, repositoryB, join(repositoryB, 'src')]) {
      expect(await resolveManagerStartup(cwd, globalDirectory)).toMatchObject({ kind: 'ready', context: expected });
    }
    expect(await readWorkspace(globalDirectory, workspace!.id)).toEqual(workspace);
    expect(JSON.parse(readFileSync(join(globalDirectory, 'workspaces', workspace!.id, 'workspace.json'), 'utf8'))).toEqual(workspace);
    expect(existsSync(join(globalDirectory, 'managers'))).toBe(false);
    expect(existsSync(join(globalDirectory, 'workspaces', 'registry.lock'))).toBe(false);
    expect(await resolveCurrentManagerAssignment(single(), globalDirectory)).toEqual(expected.assignment);
  });

  it('keeps unassigned repositories in single mode and offers workspaces outside repositories', async () => {
    expect(await readWorkspaceRegistry(globalDirectory)).toEqual([]);
    expect(await resolveManagerStartup(root, globalDirectory)).toEqual({ kind: 'selection', workspaces: [] });
    const workspace = await createWorkspace({ globalConfigDirectory: globalDirectory, name: '担当', repositoryDirectories: [repositoryA, repositoryB] });
    expect(await resolveManagerStartup(repositoryC, globalDirectory)).toEqual({ kind: 'ready', context: {
      cwd: repositoryC, assignment: { kind: 'repository', repositoryDirectory: repositoryC, repositoryDirectories: [repositoryC] },
    } });
    expect(await resolveManagerStartup(root, globalDirectory)).toEqual({ kind: 'selection', workspaces: [workspace] });
  });

  it('normalizes subdirectories and aliases and rejects non-Git and already assigned additions without changing records', async () => {
    const workspace = await addManagerRepository(single(), repositoryB, globalDirectory);
    const assignment = createWorkspaceManagerContext(workspace!, globalDirectory).assignment;
    mkdirSync(join(repositoryB, 'src'));
    symlinkSync(repositoryB, join(root, 'alias'), 'dir');
    expect(await addManagerRepository(assignment, join(repositoryB, 'src'), globalDirectory)).toEqual(workspace);
    expect(await addManagerRepository(assignment, join(root, 'alias'), globalDirectory)).toEqual(workspace);
    await expect(addManagerRepository(assignment, root, globalDirectory)).rejects.toThrow();
    const other = await createWorkspace({ globalConfigDirectory: globalDirectory, name: '別担当', repositoryDirectories: [repositoryC] });
    await expect(addManagerRepository(assignment, repositoryC, globalDirectory)).rejects.toThrow(other.id);
    await expect(createWorkspace({ globalConfigDirectory: globalDirectory, name: '重複', repositoryDirectories: [repositoryB] })).rejects.toThrow(workspace!.id);
    expect(await readWorkspace(globalDirectory, workspace!.id)).toEqual(workspace);
    expect(await findWorkspaceForRepository(globalDirectory, repositoryB)).toEqual(workspace);
  });

  it.each(['active', 'paused'] as const)('rejects removal with unfinished %s goals and permits it after abort', async (executionStatus) => {
    const workspace = await addManagerRepository(single(), repositoryB, globalDirectory);
    const assignment = createWorkspaceManagerContext(workspace!, globalDirectory).assignment;
    const goal = await new GoalStore(repositoryB).create({ ...goalRecord(), executionStatus });
    await expect(removeManagerRepository(assignment, repositoryB, globalDirectory)).rejects.toThrow(goal.id);
    expect(await readWorkspace(globalDirectory, workspace!.id)).toEqual(workspace);
    await new GoalStore(repositoryB).update(goal.id, (current) => ({ ...current, executionStatus: 'aborted' }));
    expect((await removeManagerRepository(assignment, repositoryB, globalDirectory)).repositoryDirectories).toEqual([repositoryA]);
    expect(await findWorkspaceForRepository(globalDirectory, repositoryB)).toBeUndefined();
  });

  it('renames, removes the session base, permits an empty workspace, and rejects removal outside the assignment', async () => {
    const workspace = await addManagerRepository(single(), repositoryB, globalDirectory);
    const identity = { kind: 'workspace' as const, workspaceId: workspace!.id };
    expect((await renameManagerWorkspace(await resolveCurrentManagerAssignment(identity, globalDirectory), '開発', globalDirectory)).name).toBe('開発');
    await expect(removeManagerRepository(await resolveCurrentManagerAssignment(identity, globalDirectory), repositoryC, globalDirectory)).rejects.toThrow();
    await removeManagerRepository(await resolveCurrentManagerAssignment(identity, globalDirectory), repositoryA, globalDirectory);
    const empty = await removeManagerRepository(await resolveCurrentManagerAssignment(identity, globalDirectory), repositoryB, globalDirectory);
    expect(empty.repositoryDirectories).toEqual([]);
    expect(await resolveManagerStartup(root, globalDirectory)).toEqual({ kind: 'selection', workspaces: [empty] });
  });

  it('rejects assigned-parent nested repositories and symlinks to unassigned repositories', async () => {
    const nested = repository('a/nested');
    const workspace = await addManagerRepository(single(), repositoryB, globalDirectory);
    const assignment = createWorkspaceManagerContext(workspace!, globalDirectory).assignment;
    symlinkSync(repositoryC, join(repositoryA, 'outside'), 'dir');
    for (const directory of [nested, repositoryC, join(repositoryA, 'outside')]) {
      await expect(resolveAssignedProjectRoot(directory, assignment)).rejects.toThrow();
    }
    expect(await resolveAssignedProjectRoot(repositoryB, assignment)).toBe(repositoryB);
  });

  it('checks every MCP operation against the current assignment, including nested repositories and later membership changes', async () => {
    const nested = repository('a/nested');
    const workspace = await addManagerRepository(single(), repositoryB, globalDirectory);
    const server = createTaktMcpServer({}, { toolSet: 'manager', allowedProjectRoot: repositoryA,
      managerAssignment: { kind: 'workspace', workspaceId: workspace!.id } });
    const client = new Client({ name: 'workspace-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    try {
      const goal = await new GoalStore(repositoryB).create(goalRecord());
      mkdirSync(join(repositoryB, 'src'));
      const result = await client.callTool({ name: 'takt_get_goal', arguments: { cwd: join(repositoryB, 'src'), goalId: goal.id } });
      expect(result.isError).not.toBe(true);
      expect(JSON.parse(firstTextContent(result.content)).goal.id).toBe(goal.id);
      for (const cwd of [repositoryC, nested]) {
        await new GoalStore(cwd).create({ ...goalRecord(), executionStatus: 'aborted' });
        const denied = await client.callTool({ name: 'takt_record_goal_work_log', arguments: { cwd, goalId: goal.id, summary: '担当外' } });
        expect(denied.isError).toBe(true);
        expect(firstTextContent(denied.content)).toContain('not assigned');
        expect((await new GoalStore(cwd).get(goal.id)).workLog).toEqual([]);
      }
      expect((await new GoalStore(repositoryB).get(goal.id)).workLog).toEqual([]);
      expect((await client.callTool({ name: 'takt_add_workspace_repository', arguments: { repositoryDirectory: repositoryC } })).isError).not.toBe(true);
      expect((await client.callTool({ name: 'takt_list_goals', arguments: { cwd: repositoryC } })).isError).not.toBe(true);
      const recorded = await client.callTool({ name: 'takt_record_goal_work_log', arguments: { cwd: repositoryC, goalId: goal.id, summary: '担当内' } });
      expect(recorded.isError, firstTextContent(recorded.content)).not.toBe(true);
      expect((await new GoalStore(repositoryC).get(goal.id)).workLog).toEqual([expect.objectContaining({ summary: '担当内' })]);
      expect((await client.callTool({ name: 'takt_remove_workspace_repository', arguments: { repositoryDirectory: repositoryC } })).isError).not.toBe(true);
      expect((await client.callTool({ name: 'takt_list_goals', arguments: { cwd: repositoryC } })).isError).toBe(true);
      expect((await client.callTool({ name: 'takt_remove_workspace_repository', arguments: { repositoryDirectory: repositoryA } })).isError).not.toBe(true);
      expect((await client.callTool({ name: 'takt_list_goals', arguments: { cwd: repositoryB } })).isError).not.toBe(true);
    } finally { await client.close(); await server.close(); }
  });

  it('uses mock conversation output to approve a goal only in its chosen repository and rechecks assignment before registering', async () => {
    const workspace = await addManagerRepository(single(), repositoryB, globalDirectory);
    const identity = { kind: 'workspace' as const, workspaceId: workspace!.id };
    const session = new ManagerServiceClient({ cwd: repositoryA, assignment: identity,
      plan: { ctx: { provider: new MockProvider(), providerType: 'mock', model: undefined, lang: 'ja' },
        strategy: { systemPrompt: 'manager fixture' } } });
    const reply = (repositoryDirectory: string | undefined) => setMockScenario([{ persona: 'manager', status: 'done', content: JSON.stringify({
      message: '確認', summary: { ...goalInput(), repositoryDirectory },
    }) }, { persona: 'manager', status: 'done', content: JSON.stringify({ message: '登録済み', summary: null }) }]);
    try {
      for (const target of [undefined, repositoryC, repository('a/nested')]) {
        reply(target);
        expect((await submitAndWait(session, { kind: 'message', text: getLabel('manager.goSummaryRequest', 'ja'), display: false, requestProposal: true })).kind).toBe('error');
        expect(session.getSnapshot().state?.pending).toBeNull();
      }
      reply(repositoryB);
      expect((await submitAndWait(session, { kind: 'message', text: getLabel('manager.goSummaryRequest', 'ja'), display: false, requestProposal: true })).kind).toBe('reply');
      expect(session.getSnapshot().state!.pending!.repositoryDirectory).toBe(repositoryB);
      const registered = await submitAndWait(session, { kind: 'approve_summary', revision: session.getSnapshot().state!.pending!.revision,
        conversationId: session.getSnapshot().state!.conversationId });
      expect(registered.kind).toBe('goal_registered');
      expect((await new GoalStore(repositoryA).list()).goals).toEqual([]);
      expect((await new GoalStore(repositoryB).list()).goals).toHaveLength(1);
      reply(repositoryC);
      await addManagerRepository(await resolveCurrentManagerAssignment(identity, globalDirectory), repositoryC, globalDirectory);
      await submitAndWait(session, { kind: 'message', text: getLabel('manager.goSummaryRequest', 'ja'), display: false, requestProposal: true });
      const pending = session.getSnapshot().state!.pending!;
      await removeManagerRepository(await resolveCurrentManagerAssignment(identity, globalDirectory), repositoryC, globalDirectory);
      expect((await submitAndWait(session, { kind: 'approve_summary', revision: pending.revision,
        conversationId: session.getSnapshot().state!.conversationId })).kind).toBe('error');
      expect((await new GoalStore(repositoryC).list()).goals).toEqual([]);
    } finally { await session.dispose(); }
  });

  it.each([false, true])('retains the workspace when removing the original repository in the same turn=%s', async (sameTurn) => {
    const assignment = single();
    const mcp = await connectTestManagerMcp(repositoryA, assignment);
    const provider = new MockProvider();
    const originalSetup = provider.setup.bind(provider);
    vi.spyOn(provider, 'setup').mockImplementation((config) => {
      const agent = originalSetup(config);
      return { call: async (prompt, options) => {
        const response = await agent.call(prompt, options);
        if (prompt.endsWith('担当を追加')) {
          const workspace = (await readWorkspaceRegistry(globalDirectory)).find((workspace) => workspace.repositoryDirectories.includes(repositoryB));
          if (workspace !== undefined) options.onStream?.({ type: 'tool_result', data: {
            id: 'workspace-operation', isError: false, content: JSON.stringify({ workspace }),
          } });
        }
        return response;
      } };
    });
    const executor = createManagerTurnExecutor(repositoryA, {
      ctx: { provider, providerType: 'mock', model: undefined, lang: 'ja', mcpServers: mcp.servers },
      strategy: { systemPrompt: 'manager fixture' } });
    const input: ManagerTurnInput = { prompt: '担当を追加', assignment, sessionId: undefined, abortSignal: new AbortController().signal };
    const scenario = (tool: string, args: Record<string, unknown>, removeOriginal = false) => setMockScenario([{ persona: 'manager', status: 'done',
      content: JSON.stringify({ message: '担当を更新', summary: null }),
      streamEvents: [{ type: 'tool_use', tool, id: 'workspace-operation', input: args }],
      mcpToolCalls: [{ server: TAKT_MANAGER_MCP_SERVER_NAME, tool, arguments: args },
        ...(removeOriginal ? [{ server: TAKT_MANAGER_MCP_SERVER_NAME, tool: 'takt_remove_workspace_repository', arguments: { repositoryDirectory: repositoryA } }] : [])],
    }]);
    try {
      mkdirSync(join(repositoryB, 'src'));
      scenario('takt_add_workspace_repository', { repositoryDirectory: sameTurn ? join(repositoryB, 'src') : repositoryB }, sameTurn);
      const first = await executor.execute(input);
      expect(first.message).toBe('担当を更新');
      let current = first.assignment!;
      if (!sameTurn) {
        expect((await readWorkspaceRegistry(globalDirectory))[0]!.repositoryDirectories).toEqual([repositoryA, repositoryB]);
        scenario('takt_remove_workspace_repository', { repositoryDirectory: repositoryA });
        const second = await executor.execute({ ...input, assignment: current, prompt: '元の担当を削除' });
        expect(second.message).toBe('担当を更新');
        current = second.assignment!;
      }
      expect((await readWorkspaceRegistry(globalDirectory))[0]!.repositoryDirectories).toEqual([repositoryB]);
      const workspace = (await readWorkspaceRegistry(globalDirectory))[0]!;
      expect(await resolveCurrentManagerAssignment(current, globalDirectory)).toEqual({ kind: 'workspace', workspaceId: workspace.id,
        name: workspace.name, repositoryDirectories: [repositoryB] });
      scenario('takt_list_goals', { cwd: repositoryB });
      expect(await executor.execute({ ...input, assignment: current, prompt: '現在の担当を確認' }))
        .toMatchObject({ message: '担当を更新' });
    } finally { await mcp.dispose(); }
  });

  it('keeps the standalone assignment after failed additions of missing, non-Git and already assigned repositories', async () => {
    const other = await createWorkspace({ globalConfigDirectory: globalDirectory, name: '別の担当', repositoryDirectories: [repositoryB] });
    const assignment = single();
    const mcp = await connectTestManagerMcp(repositoryA, assignment);
    const executor = createManagerTurnExecutor(repositoryA, {
      ctx: { provider: new MockProvider(), providerType: 'mock', model: undefined, lang: 'ja', mcpServers: mcp.servers },
      strategy: { systemPrompt: 'manager fixture' } });
    try {
      for (const repositoryDirectory of [join(root, 'missing'), root, repositoryB]) {
        const result = await mcp.client.callTool({ name: 'takt_add_workspace_repository', arguments: { repositoryDirectory } });
        expect(result.isError).toBe(true);
        setMockScenario([{ persona: 'manager', status: 'done', content: JSON.stringify({ message: '追加できません', summary: null }),
          streamEvents: [{ type: 'tool_use', tool: 'takt_add_workspace_repository', id: 'add-repository', input: { repositoryDirectory } }],
        }]);
        const turnResult = await executor.execute({ prompt: '担当を追加', assignment, sessionId: undefined, abortSignal: new AbortController().signal });
        expect(turnResult.message).toBe('追加できません');
        expect(await resolveCurrentManagerAssignment(turnResult.assignment!, globalDirectory)).toEqual(assignment);
        expect(await readWorkspaceRegistry(globalDirectory)).toEqual([other]);
      }
    } finally { await mcp.dispose(); }
  });

  it('shows the current repository count and goals from all members in the same TUI', async () => {
    const workspace = await addManagerRepository(single(), repositoryB, globalDirectory);
    const assignment = createWorkspaceManagerContext(workspace!, globalDirectory).assignment;
    const goal = await new GoalStore(repositoryB).create({ ...goalRecord(), executionStatus: 'paused' });
    const client = new ManagerServiceClient({ cwd: repositoryA, assignment,
      plan: { ctx: { provider: new MockProvider(), providerType: 'mock', model: undefined, lang: 'ja' },
        strategy: { systemPrompt: 'manager fixture' } } });
    const app = render(createElement(ManagerView, { cwd: repositoryA, assignment, lang: 'ja', client, initialDiagnostics: [], onExit: vi.fn() }));
    try {
      await client.ready;
      expect(client.getSnapshot().readStatus).toBe('complete');
      await vi.waitFor(() => {
        expect(app.lastFrame()!.split('\n').at(-1)).toBe('担当: a ほか 1 件 | 進行中 1 ／ マージ待ち 0 ／ 未回答 0');
        expect(app.lastFrame()).toMatch(/進行中\s*1/u);
      });
      app.stdin.write('\x07');
      await vi.waitFor(() => {
        expect(app.lastFrame()).toContain(goal.objective);
        expect(app.lastFrame()).toContain('一時停止');
      });
      app.stdin.write('\x1b[27u');
      await vi.waitFor(() => expect(app.lastFrame()).not.toContain(goal.objective));
      await renameManagerWorkspace(assignment, '新しい担当', globalDirectory);
      await addManagerRepository(assignment, repositoryC, globalDirectory);
      setMockScenario([{ persona: 'manager', status: 'done', content: JSON.stringify({ message: '担当を確認', summary: null }) }]);
      app.stdin.write('担当を確認');
      await vi.waitFor(() => expect(app.lastFrame()).toContain('担当を確認'));
      app.stdin.write('\r');
      await vi.waitFor(() => {
        expect(app.lastFrame()!.split('\n').at(-1)).toBe('担当: a ほか 2 件 | 進行中 1 ／ マージ待ち 0 ／ 未回答 0');
      }, { timeout: 30_000 });
    } finally { app.unmount(); await client.dispose(); }
  });

  it('shows the repository used for startup even when it is not the first workspace member', async () => {
    await createWorkspace({ globalConfigDirectory: globalDirectory, name: '開発担当', repositoryDirectories: [repositoryA, repositoryB, repositoryC] });
    const startupDirectory = join(repositoryB, 'src');
    mkdirSync(startupDirectory);
    const resolution = await resolveManagerStartup(startupDirectory, globalDirectory);
    expect(resolution.kind).toBe('ready');
    if (resolution.kind !== 'ready') throw new Error('Expected ready manager context');
    const { cwd, assignment } = resolution.context;
    expect(cwd).toBe(repositoryA);
    const client = new ManagerServiceClient({ cwd, assignment,
      plan: { ctx: { provider: new MockProvider(), providerType: 'mock', model: undefined, lang: 'ja' },
        strategy: { systemPrompt: 'manager fixture' } } });
    await client.ready;
    const app = render(createElement(ManagerView, { cwd, assignment, lang: 'ja', client, initialDiagnostics: [], onExit: vi.fn() }));
    try {
      await vi.waitFor(() => {
        expect(app.lastFrame()).not.toContain('処理中');
        expect(app.lastFrame()!.split('\n').at(-1)).toBe('担当: b ほか 2 件 | 進行中 0 ／ マージ待ち 0 ／ 未回答 0');
      });
      expect(client.getSnapshot().items.find((item) => item.kind === 'assignment')?.assignment).toMatchObject({ repositoryDirectories: [repositoryA, repositoryB, repositoryC] });
    } finally { app.unmount(); await client.dispose(); }
  });

  it.each(['ja', 'en'] as const)('shows an empty assignment when starting from a selected empty workspace in %s', async (lang) => {
    const workspace = await createWorkspace({ globalConfigDirectory: globalDirectory, name: '開発担当', repositoryDirectories: [repositoryA] });
    await removeManagerRepository(createWorkspaceManagerContext(workspace, globalDirectory).assignment, repositoryA, globalDirectory);
    const resolution = await resolveManagerStartup(root, globalDirectory);
    expect(resolution.kind).toBe('selection');
    if (resolution.kind !== 'selection') throw new Error('Expected workspace selection');
    const selectedWorkspace = resolution.workspaces.find((candidate) => candidate.id === workspace.id)!;
    expect(selectedWorkspace.repositoryDirectories).toEqual([]);
    const { cwd, assignment } = createWorkspaceManagerContext(selectedWorkspace, globalDirectory);
    expect(cwd).toBe(join(globalDirectory, 'workspaces', workspace.id));
    const client = new ManagerServiceClient({ cwd, assignment,
      plan: { ctx: { provider: new MockProvider(), providerType: 'mock', model: undefined, lang },
        strategy: { systemPrompt: 'manager fixture' } } });
    await client.ready;
    const app = render(createElement(ManagerView, { cwd, assignment, lang, client, initialDiagnostics: [], onExit: vi.fn() }));
    const checkHeading = () => {
      const rows = app.lastFrame()!.split('\n');
      expect(rows.at(-1)).toBe([getLabel('manager.selectionEmpty.repository', lang),
        getLabel('manager.counts', lang, { goals: '0', awaiting: '0', questions: '0' })].join(' | '));
      for (const value of [basename(cwd), workspace.id]) expect(rows.at(-1)).not.toContain(value);
    };
    try {
      checkHeading();
      await vi.waitFor(() => {
        expect(app.lastFrame()).not.toContain(lang === 'ja' ? '処理中' : 'Working');
        checkHeading();
      });
      expect((client.getSnapshot().items.find((item) => item.kind === 'assignment')?.assignment)!.repositoryDirectories).toEqual([]);
    } finally { app.unmount(); await client.dispose(); }
  });

  it.each(['ja', 'en'] as const)('updates the same screen to an empty assignment after removing its last repository in %s', async (lang) => {
    const workspace = await createWorkspace({ globalConfigDirectory: globalDirectory, name: '開発担当', repositoryDirectories: [repositoryA] });
    const { cwd, assignment } = createWorkspaceManagerContext(workspace, globalDirectory);
    const client = new ManagerServiceClient({ cwd, assignment,
      plan: { ctx: { provider: new MockProvider(), providerType: 'mock', model: undefined, lang },
        strategy: { systemPrompt: 'manager fixture' } } });
    await client.ready;
    const app = render(createElement(ManagerView, { cwd, assignment, lang, client, initialDiagnostics: [], onExit: vi.fn() }));
    try {
      await vi.waitFor(() => {
        expect(app.lastFrame()).not.toContain(lang === 'ja' ? '処理中' : 'Working');
        expect(app.lastFrame()!.split('\n').at(-1)).toBe([getLabel('manager.assignmentHeading', lang, { name: basename(repositoryA) }),
          getLabel('manager.counts', lang, { goals: '0', awaiting: '0', questions: '0' })].join(' | '));
      });
      const currentAssignment = (client.getSnapshot().items.find((item) => item.kind === 'assignment')?.assignment)!;
      if (currentAssignment.kind === 'daemon') throw new Error('Unexpected director assignment');
      await removeManagerRepository(currentAssignment, repositoryA, globalDirectory);
      expect((await readWorkspace(globalDirectory, workspace.id))!.repositoryDirectories).toEqual([]);
      const emptyWorkspaceAssignment = () => client.getSnapshot().items
        .find((item) => item.kind === 'assignment')?.assignment;
      await vi.waitFor(async () => {
        await client.refresh();
        expect(emptyWorkspaceAssignment()).toMatchObject({ kind: 'workspace', workspaceId: workspace.id, repositoryDirectories: [] });
      });
      await vi.waitFor(() => {
        const rows = app.lastFrame()!.split('\n');
        expect(rows.at(-1)).toBe([getLabel('manager.selectionEmpty.repository', lang),
          getLabel('manager.counts', lang, { goals: '0', awaiting: '0', questions: '0' })].join(' | '));
        for (const value of [basename(cwd), workspace.id]) {
          expect(rows.at(-1)).not.toContain(getLabel('manager.assignmentHeading', lang, { name: value }));
        }
      });
      expect(client.getSnapshot().items.find((item) => item.kind === 'assignment')?.assignment).toMatchObject({ kind: 'workspace', workspaceId: workspace.id, repositoryDirectories: [] });
    } finally { app.unmount(); await client.dispose(); }
  });

  it('transfers assignment to the real manager MCP child and restricts its operations', async () => {
    const workspace = await addManagerRepository(single(), repositoryB, globalDirectory);
    const mcp = await connectTestManagerMcp(repositoryA, { kind: 'workspace', workspaceId: workspace!.id });
    try {
      expect((await mcp.client.callTool({ name: 'takt_list_goals', arguments: { cwd: repositoryB } })).isError).not.toBe(true);
      expect((await mcp.client.callTool({ name: 'takt_list_goals', arguments: { cwd: repositoryC } })).isError).toBe(true);
      expect((await mcp.client.callTool({ name: 'takt_rename_workspace', arguments: { name: '担当変更' } })).isError).not.toBe(true);
      expect((await readWorkspace(globalDirectory, workspace!.id))!.name).toBe('担当変更');
    } finally { await mcp.dispose(); }
  });
});

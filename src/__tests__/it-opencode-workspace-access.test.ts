vi.mock('../../dist/infra/managed-providers/loader.js', () => import('./helpers/managed-sdk.js'));
import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { OpenCodeClient } from '../../dist/infra/opencode/client.js';
import { closeOpenCodeWorkspaceServers, resetSharedServerPool } from '../../dist/infra/opencode/server-pool.js';
import type { StreamEvent } from '../shared/types/provider.js';
import { createWorkspace, readWorkspace } from '../../dist/infra/config/global/workspaceRegistry.js';
import { addManagerRepository } from '../../dist/features/manager/workspaceOperations.js';
import { resolveManagerWorkspaceAccess } from '../../dist/features/manager/workspaceAccess.js';

afterEach(() => { resetSharedServerPool(); vi.unstubAllEnvs(); });

async function cleanupProbe(actions: readonly (() => void | Promise<void>)[]): Promise<void> {
  const errors: unknown[] = [];
  for (const action of actions) {
    try { await action(); } catch (error) { errors.push(error); }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'OpenCode workspace probe cleanup failed');
}

it.each([0, 1])('attempts every cleanup after action %s fails and reports collected failures', async (failed) => {
  const error = new Error('cleanup failed');
  const actions = [0, 1, 2].map((index) => vi.fn(async () => { if (index === failed) throw error; }));
  await expect(cleanupProbe(actions)).rejects.toMatchObject({ errors: [error] });
  for (const action of actions) expect(action).toHaveBeenCalledOnce();
});

for (const generation of ['v1', 'v2'] as const) {
  for (const variant of ['ordinary', 'asterisk', 'question'] as const) {
    const executable = process.env[generation === 'v1' ? 'TAKT_TEST_OPENCODE_V1_PATH' : 'TAKT_TEST_OPENCODE_V2_PATH'];
    it.skipIf(executable === undefined)(`reads and writes registered repositories and denies other directories through real OpenCode ${generation} (${variant})`, async () => {
      const command = resolve(executable!);
      const version = execFileSync(command, ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim();
      expect(version).toMatch(generation === 'v1' ? /^1\./ : /^(?:opencode v)?2\./);
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'takt-opencode-workspace-live-')));
      const cwd = join(root, 'a');
      const repository = join(root, variant === 'ordinary' ? 'b' : variant === 'asterisk' ? 'api*' : 'api?');
      const added = join(root, variant === 'ordinary' ? 'c' : variant === 'asterisk' ? 'next*' : 'next?');
      const unregistered = join(root, variant === 'ordinary' ? 'b-other' : variant === 'asterisk' ? 'api?' : 'apix');
      for (const directory of [cwd, repository, added, unregistered]) {
        mkdirSync(directory); writeFileSync(join(directory, 'target.txt'), `ORIGINAL:${directory}`);
        execFileSync('git', ['init', '-b', 'main', directory], { stdio: 'pipe' });
      }
      const scripts = new Map<string, { name: string; input: Record<string, string> }>();
      const requests = new Map<string, number>();
      const model = createServer(async (request, response) => {
        let body = '';
        for await (const chunk of request) body += String(chunk);
        const input = JSON.parse(body) as { messages?: Array<{ role: string; content: unknown }>; tools?: unknown[] };
        const lastUser = input.messages?.filter((message) => message.role === 'user').at(-1);
        const title = input.messages?.some((message) => message.role === 'system' && JSON.stringify(message.content).includes('title generator'));
        const name = title || !input.tools?.length ? undefined : JSON.stringify(lastUser)?.match(/WORKSPACE_CASE:([a-z_]+)/)?.[1];
        const count = (requests.get(name ?? '') ?? 0) + 1;
        requests.set(name ?? '', count);
        const tool = name === undefined || count !== 1 ? undefined : scripts.get(name);
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const send = (delta: unknown, finishReason: string | null = null) => response.write(`data: ${JSON.stringify({
          id: 'workspace-probe', object: 'chat.completion.chunk', model: 'probe',
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        })}\n\n`);
        if (tool !== undefined) {
          send({ role: 'assistant', tool_calls: [{ index: 0, id: `call_${name}`, type: 'function', function: { name: tool.name, arguments: '' } }] });
          send({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(tool.input) } }] });
          send({}, 'tool_calls');
        } else {
          send({ role: 'assistant', content: `OK:${name ?? 'auxiliary'}` }); send({}, 'stop');
        }
        response.end('data: [DONE]\n\n');
      });
      await new Promise<void>((done) => model.listen(0, '127.0.0.1', done));
      try {
        const address = model.address();
        if (address === null || typeof address === 'string') throw new Error('Missing probe address');
        for (const key of ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME']) vi.stubEnv(key, root);
        vi.stubEnv('TAKT_OPENCODE_VERSION', generation); vi.stubEnv('TAKT_OPENCODE_PATH', command);
        vi.stubEnv('OPENCODE_CONFIG_PROJECT_DISABLE', '1'); vi.stubEnv('OPENCODE_DISABLE_MODELS_FETCH', '1');
        vi.stubEnv('OPENCODE_DISABLE_AUTOUPDATE', 'true');
        const settings = { baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: 'probe' };
        const config = generation === 'v1'
          ? { provider: { probe: { npm: '@ai-sdk/openai-compatible', name: 'Probe', options: settings, models: { probe: { name: 'Probe' } } } } }
          : { providers: { probe: { package: '@opencode/ai/providers/openai-compatible', name: 'Probe', settings,
            models: { probe: { name: 'Probe', limit: { context: 32768, output: 4096 }, capabilities: { tools: true, input: ['text'], output: ['text'] } } } } } };
        mkdirSync(join(root, 'opencode'));
        writeFileSync(join(root, 'opencode', 'opencode.json'), JSON.stringify(config));
        const client = new OpenCodeClient();
        const workspace = await createWorkspace({ globalConfigDirectory: root, name: 'live', repositoryDirectories: [cwd, repository] });
        const registeredDirectories = async () => {
          const current = await readWorkspace(root, workspace.id);
          if (current === undefined) throw new Error('Workspace disappeared');
          return resolveManagerWorkspaceAccess('live-manager', current.repositoryDirectories).access.directories;
        };
        const events: StreamEvent[] = [];
        let sessionId: string | undefined;
        const call = async (name: string, tool: 'read' | 'write', directory: string, directories: readonly string[]) => {
          const path = join(directory, 'target.txt');
          scripts.set(name, { name: tool, input: {
            [generation === 'v1' ? 'filePath' : 'path']: path,
            ...(tool === 'write' ? { content: `WRITTEN:${name}` } : {}),
          } });
          events.length = 0;
          const result = await client.callCustom('manager', `WORKSPACE_CASE:${name}`, 'Execute the supplied tool and report its result.', {
            cwd, model: 'probe/probe', permissionMode: 'full', callerManagedSession: true,
            sessionId, workspaceAccess: { ownerId: 'live-manager', directories },
            abortSignal: AbortSignal.timeout(30_000), onStream: (event) => events.push(event),
          });
          expect(result.status, JSON.stringify(result)).toBe('done');
          expect(result.sessionId).toBeDefined();
          if (sessionId !== undefined) expect(result.sessionId).toBe(sessionId);
          sessionId = result.sessionId;
          const permissions = events.filter((event) => event.type === 'permission_asked');
          if (generation === 'v2') expect(permissions).toEqual([]);
          else {
            expect(permissions.some((event) => event.type === 'permission_asked' && event.data.permission === 'external_directory')).toBe(true);
            for (const event of permissions) {
              if (event.type === 'permission_asked' && event.data.permission === 'external_directory') {
                expect(event.data.reply).toBe(directory === unregistered || name === 'added_same_turn' ? 'reject' : 'once');
              }
            }
          }
          const results = events.filter((event) => event.type === 'tool_result');
          expect(results).toHaveLength(1);
          return results[0]!;
        };
        const check = (event: StreamEvent, denied: boolean) => {
          expect(event.type).toBe('tool_result');
          if (event.type !== 'tool_result') throw new Error('Expected tool result');
          expect(event.data.isError, event.data.content).toBe(denied);
          if (denied) expect(event.data.content).toMatch(/external_directory|permission|denied/i);
          return event.data.content;
        };
        const initial = await registeredDirectories();
        expect(check(await call('read_registered', 'read', repository, initial), false)).toContain(`ORIGINAL:${repository}`);
        check(await call('write_registered', 'write', repository, initial), false);
        expect(readFileSync(join(repository, 'target.txt'), 'utf8')).toBe('WRITTEN:write_registered');
        expect(check(await call('read_written', 'read', repository, initial), false)).toContain('WRITTEN:write_registered');
        const newDirectory = join(repository, 'new', 'nested');
        check(await call('write_new', 'write', newDirectory, initial), false);
        expect(readFileSync(join(newDirectory, 'target.txt'), 'utf8')).toBe('WRITTEN:write_new');
        check(await call('read_unregistered', 'read', unregistered, initial), true);
        check(await call('added_same_turn', 'read', added, initial), true);
        await addManagerRepository({ kind: 'workspace', workspaceId: workspace.id, name: workspace.name,
          repositoryDirectories: workspace.repositoryDirectories }, added, root);
        const next = await registeredDirectories();
        expect(check(await call('read_registered_after_add', 'read', repository, next), false)).toContain('WRITTEN:write_registered');
        check(await call('write_registered_after_add', 'write', repository, next), false);
        expect(readFileSync(join(repository, 'target.txt'), 'utf8')).toBe('WRITTEN:write_registered_after_add');
        expect(check(await call('read_added', 'read', added, next), false)).toContain(`ORIGINAL:${added}`);
        check(await call('write_added', 'write', added, next), false);
        expect(readFileSync(join(added, 'target.txt'), 'utf8')).toBe('WRITTEN:write_added');
        check(await call('still_unregistered', 'read', unregistered, next), true);
        expect(readFileSync(join(unregistered, 'target.txt'), 'utf8')).toBe(`ORIGINAL:${unregistered}`);
      } finally {
        await cleanupProbe([
          () => closeOpenCodeWorkspaceServers('live-manager'),
          () => new Promise<void>((done, fail) => model.close((error) => error === undefined ? done() : fail(error))),
          () => rmSync(root, { recursive: true, force: true }),
        ]);
      }
    }, 120_000);
  }
}

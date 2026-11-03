import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { listDirectorManagers, resolveDirectorManager } from '../features/director/managers.js';
import { createDirectorMcpServer, DIRECTOR_MCP_SERVER_NAME } from '../features/director/mcp.js';
import { createDirectorPatrol } from '../features/director/patrol.js';
import { listDaemonProjects } from '../features/daemon/projects.js';
import type { ManagerAssignment } from '../features/manager/startupResolution.js';
import { getGlobalConfigDir } from '../infra/config/paths.js';
import { invalidateGlobalConfigCache } from '../infra/config/global/globalConfig.js';
import { invalidateAllResolvedConfigCache } from '../infra/config/resolveConfigValue.js';
import { registerProject } from '../infra/config/global/projectRegistry.js';
import { createWorkspace } from '../infra/config/global/workspaceRegistry.js';
import { conversationId } from '../infra/conversations/identity.js';
import { GoalStore } from '../infra/goals/store.js';
import * as providers from '../infra/providers/index.js';
import type { ProviderAgent } from '../infra/providers/types.js';
import { firstTextContent } from './helpers/mcp-content.js';
import { goalRecord } from './helpers/goal-fixtures.js';
import { makeProvider } from './test-helpers.js';
import { initDebugLogger, resetDebugLogger } from '../shared/utils/debug.js';

const faults = vi.hoisted(() => ({ directory: undefined as string | undefined,
  operation: 'realpath' as 'realpath' | 'stat' | 'readdir', code: 'EACCES' as 'EACCES' | 'EIO' }));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  const check = (operation: typeof faults.operation, path: unknown) => {
    if (operation === faults.operation && path === faults.directory) {
      throw Object.assign(new Error(`${faults.code}: ${operation} '${faults.directory}'`), {
        code: faults.code, syscall: operation, path: faults.directory,
      });
    }
  };
  return { ...actual,
    realpath: async (...args: Parameters<typeof actual.realpath>) => { check('realpath', args[0]); return actual.realpath(...args); },
    stat: async (...args: Parameters<typeof actual.stat>) => { check('stat', args[0]); return actual.stat(...args); },
    readdir: async (...args: Parameters<typeof actual.readdir>) => { check('readdir', args[0]); return actual.readdir(...args); },
  };
});

interface ManagerPage {
  managers: Array<{ id: string; assignment: ManagerAssignment }>;
  errors: Array<{ repositoryDirectory: string; reason: string }>;
  totalCount: number;
  returnedCount: number;
  nextOffset: number | null;
}

let directory: string;
beforeEach(() => {
  faults.directory = undefined;
  faults.operation = 'realpath';
  faults.code = 'EACCES';
  directory = getGlobalConfigDir();
  writeFileSync(join(directory, 'config.yaml'), 'provider: mock\nlanguage: en\n');
  invalidateGlobalConfigCache();
  invalidateAllResolvedConfigCache();
});
afterEach(() => {
  faults.directory = undefined;
  resetDebugLogger();
  vi.restoreAllMocks();
  invalidateGlobalConfigCache();
  invalidateAllResolvedConfigCache();
});

function repository(name: string): string {
  const path = join(directory, name);
  mkdirSync(path);
  execFileSync('git', ['init', '-b', 'main', path], { stdio: 'pipe' });
  return path;
}

async function register(path: string): Promise<void> {
  await registerProject({ globalConfigDirectory: directory, projectDirectory: path, command: 'manager', managerUsed: true });
}

function assignment(path: string): ManagerAssignment {
  return { kind: 'repository', repositoryDirectory: path, repositoryDirectories: [path] };
}

async function projectsWithNonGitDirectory() {
  const first = repository('a-good');
  const broken = join(directory, 'b-not-git');
  mkdirSync(broken);
  const last = repository('c-good');
  for (const path of [first, broken, last]) await register(path);
  return { first, broken, last };
}

async function withMcp(action: (client: Client) => Promise<void>): Promise<void> {
  const server = createDirectorMcpServer(directory, { notify: vi.fn() }, new AbortController().signal);
  const client = new Client({ name: 'unreadable-project-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    await action(client);
  } finally {
    await client.close();
    await server.close();
  }
}

function decoded<T>(result: Awaited<ReturnType<Client['callTool']>>): T {
  return JSON.parse(firstTextContent(result.content)) as T;
}

function expectListing(result: unknown, managers: ManagerAssignment[], broken: string, reason: RegExp): void {
  expect(result).toMatchObject({
    managers: expect.arrayContaining(managers),
    errors: [{ repositoryDirectory: broken, reason: expect.stringMatching(reason) }],
  });
  expect(result).toHaveProperty('managers.length', managers.length);
}

it('returns both readable managers and the non-Git project reason through MCP pagination', async () => {
  const { first, broken, last } = await projectsWithNonGitDirectory();
  const expected = [first, last].map((path) => ({ id: conversationId(assignment(path)), assignment: assignment(path) }));

  await withMcp(async (client) => {
    const managers: ManagerPage['managers'] = [];
    for (const offset of [0, 1, 2]) {
      const response = await client.callTool({ name: 'takt_list_managers', arguments: { offset, limit: 1 } });
      expect(response.isError, firstTextContent(response.content)).not.toBe(true);
      const page = decoded<ManagerPage>(response);
      expect(page).toMatchObject({
        totalCount: 2, returnedCount: offset < 2 ? 1 : 0, nextOffset: offset === 0 ? 1 : null,
        errors: [{ repositoryDirectory: broken, reason: expect.stringMatching(/not a git repository/i) }],
      });
      managers.push(...page.managers);
    }
    expect(managers).toHaveLength(2);
    expect(managers).toEqual(expect.arrayContaining(expected));
  });
});

it.each([false, true])('finishes a patrol after reading every healthy manager with a non-Git project present=%s', async (includeBroken) => {
  const projects = await projectsWithNonGitDirectory();
  if (!includeBroken) {
    execFileSync('git', ['init', '-b', 'main', projects.broken], { stdio: 'pipe' });
  }
  const paths = includeBroken ? [projects.first, projects.last] : [projects.first, projects.broken, projects.last];
  for (const path of paths) await new GoalStore(path).create({ ...goalRecord(), objective: path });
  let observedPage: ManagerPage | undefined;
  const reads: Array<{ cwd: string; response: Awaited<ReturnType<Client['callTool']>> }> = [];
  const call = vi.fn<ProviderAgent['call']>(async (_prompt, options) => {
    const config = options.mcpServers?.[DIRECTOR_MCP_SERVER_NAME];
    if (config === undefined || config.type !== 'http') throw new Error('HTTP director MCP required');
    const client = new Client({ name: 'patrol-provider', version: '1' });
    const transport = new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } });
    try {
      await client.connect(transport);
      const response = await client.callTool({ name: 'takt_list_managers', arguments: {} });
      if (response.isError) throw new Error(firstTextContent(response.content));
      observedPage = decoded<ManagerPage>(response);
      for (const manager of observedPage.managers) {
        for (const cwd of manager.assignment.repositoryDirectories) {
          reads.push({ cwd, response: await client.callTool({ name: 'takt_list_goals', arguments: { managerId: manager.id, cwd } }) });
        }
      }
      return { persona: 'director', status: 'done', content: 'Patrol finished', timestamp: new Date() };
    } finally {
      await client.close();
      await transport.close();
    }
  });
  vi.spyOn(providers, 'getProvider').mockReturnValue(makeProvider({ supportsStrictToolAllowlist: true,
    supportedMcpTransports: new Set(['http']), setup: () => ({ call }) }));
  const patrol = createDirectorPatrol(directory, { notify: vi.fn() }, 600, 'en');

  patrol.poll(new AbortController().signal);
  await patrol.close();

  expect(call).toHaveBeenCalledOnce();
  expect(call.mock.settledResults[0]?.type).toBe('fulfilled');
  expect(patrol.running).toBe(false);
  expect(observedPage).toMatchObject({ totalCount: paths.length });
  if (includeBroken) {
    expect(observedPage).toMatchObject({ errors: [{ repositoryDirectory: projects.broken, reason: expect.stringMatching(/not a git repository/i) }] });
  }
  expect(reads.map((read) => read.cwd).sort()).toEqual([...paths].sort());
  for (const read of reads) {
    expect(read.response.isError, firstTextContent(read.response.content)).not.toBe(true);
    expect(decoded(read.response)).toMatchObject({ goals: [expect.objectContaining({ id: goalRecord().id, objective: read.cwd })] });
  }
});

it.each(['registered', 'workspace'] as const)('reports a missing %s project without discarding the healthy manager', async (source) => {
  const healthy = repository('a-good');
  const broken = repository('b-missing');
  const managers = [assignment(healthy)];
  await register(healthy);
  if (source === 'registered') await register(broken);
  else {
    const workspace = await createWorkspace({ globalConfigDirectory: directory, name: 'missing member', repositoryDirectories: [broken] });
    managers.push({ kind: 'workspace', workspaceId: workspace.id, name: workspace.name, repositoryDirectories: workspace.repositoryDirectories });
  }
  rmSync(broken, { recursive: true });

  const result = await listDirectorManagers(directory);

  expectListing(result, managers, broken, /ENOENT|no such file|unavailable|missing|not.*exist/i);
});

it.each(['registered', 'workspace'] as const)('reports a permission failure in a %s project while retaining the healthy manager', async (source) => {
  const healthy = repository('a-good');
  const broken = repository('b-denied');
  const managers = [assignment(healthy)];
  await register(healthy);
  if (source === 'registered') await register(broken);
  else {
    const workspace = await createWorkspace({ globalConfigDirectory: directory, name: 'denied member', repositoryDirectories: [broken] });
    managers.push({ kind: 'workspace', workspaceId: workspace.id, name: workspace.name, repositoryDirectories: workspace.repositoryDirectories });
  }
  faults.directory = broken;

  const result = await listDirectorManagers(directory);

  expectListing(result, managers, broken, /EACCES|permission denied|unavailable/i);
});

it('does not attach a replacement Git directory to its unavailable registration', async () => {
  const healthy = repository('a-good');
  const replaced = repository('b-replaced');
  await register(healthy);
  await register(replaced);
  renameSync(replaced, join(directory, 'original-project'));
  repository('b-replaced');

  expectListing(await listDirectorManagers(directory), [assignment(healthy)], replaced, /\S/);
  expect(await listDaemonProjects(directory)).toEqual([healthy]);
});

it('keeps a workspace assignment once and reports its non-Git member alongside a healthy repository manager', async () => {
  const { first, broken, last } = await projectsWithNonGitDirectory();
  execFileSync('git', ['init', '-b', 'main', broken], { stdio: 'pipe' });
  const workspace = await createWorkspace({ globalConfigDirectory: directory, name: 'mixed workspace', repositoryDirectories: [first, broken] });
  rmSync(join(broken, '.git'), { recursive: true });

  expectListing(await listDirectorManagers(directory), [
    { kind: 'workspace', workspaceId: workspace.id, name: workspace.name, repositoryDirectories: workspace.repositoryDirectories },
    assignment(last),
  ], broken, /not a git repository/i);
});

it('resolves a readable manager even when another assigned project is not a Git repository', async () => {
  const { last } = await projectsWithNonGitDirectory();

  await expect(resolveDirectorManager(directory, conversationId(assignment(last)))).resolves.toEqual(assignment(last));
});

it('keeps rejecting unknown manager IDs when an assigned project is unreadable', async () => {
  await projectsWithNonGitDirectory();

  await expect(resolveDirectorManager(directory, `manager-${'0'.repeat(64)}`)).rejects.toThrow('Manager is outside the daemon assignment');
});

it('propagates a registry-wide read failure instead of returning an empty successful list', async () => {
  writeFileSync(join(directory, 'projects'), 'not a directory');

  await expect(listDirectorManagers(directory)).rejects.toThrow();
});

it.each(['realpath', 'stat'] as const)('continues daemon enumeration after workspace %s EACCES but propagates EIO', async (operation) => {
  const first = repository('a-good');
  const denied = repository('b-denied');
  const last = repository('c-good');
  await register(first);
  await register(last);
  await createWorkspace({ globalConfigDirectory: directory, name: 'workspace only', repositoryDirectories: [denied] });
  const logFile = join(directory, 'daemon-projects.log');
  initDebugLogger({ enabled: true, logFile });
  await expect(listDaemonProjects(directory)).resolves.toEqual([first, denied, last]);

  faults.directory = denied;
  faults.operation = operation;

  await expect(listDaemonProjects(directory)).resolves.toEqual([first, last]);
  const log = readFileSync(logFile, 'utf8');
  expect(log).toContain(denied);
  expect(log).toContain('EACCES');
  expect(log).toContain(operation);

  faults.code = 'EIO';
  await expect(listDaemonProjects(directory)).rejects.toMatchObject({ code: 'EIO', syscall: operation, path: denied });
});

it.each(['projects', 'workspaces'])('propagates EACCES while reading the entire %s registry', async (registry) => {
  const healthy = repository('a-good');
  await register(healthy);
  await createWorkspace({ globalConfigDirectory: directory, name: 'workspace', repositoryDirectories: [healthy] });
  await expect(listDaemonProjects(directory)).resolves.toEqual([healthy]);
  faults.directory = join(directory, registry);
  faults.operation = 'readdir';

  await expect(listDaemonProjects(directory)).rejects.toMatchObject({ code: 'EACCES', syscall: 'readdir', path: faults.directory });
});

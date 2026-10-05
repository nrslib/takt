import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTaktMcpServer, TAKT_MCP_READ_ONLY_TOOL_NAMES } from '../features/mcp/server.js';
import { GoalStore } from '../infra/goals/store.js';
import { firstTextContent } from './helpers/mcp-content.js';
import {
  confirmationKeys, confirmationPayload, goalId, goalInput, goalRecord, signedConfirmation,
} from './helpers/goal-fixtures.js';

function git(cwd: string, args: string[], input?: string): string {
  return execFileSync('git', args, {
    cwd, input, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Goal Test', GIT_AUTHOR_EMAIL: 'goal@example.test',
      GIT_COMMITTER_NAME: 'Goal Test', GIT_COMMITTER_EMAIL: 'goal@example.test',
      GIT_AUTHOR_DATE: '2026-10-04T14:43:00Z', GIT_COMMITTER_DATE: '2026-10-04T14:43:00Z',
    },
  }).trim();
}

function initializeRepository(cwd: string): { mainCommit: string; releaseCommit: string } {
  git(cwd, ['init', '--initial-branch=main']);
  const tree = git(cwd, ['hash-object', '-w', '-t', 'tree', '--stdin'], '');
  const mainCommit = git(cwd, ['commit-tree', tree, '-m', 'main fixture']);
  const releaseCommit = git(cwd, ['commit-tree', tree, '-p', mainCommit, '-m', 'release fixture']);
  git(cwd, ['update-ref', 'refs/heads/main', mainCommit]);
  git(cwd, ['update-ref', 'refs/heads/release', releaseCommit]);
  git(cwd, ['update-ref', 'refs/heads/feature/current', releaseCommit]);
  git(cwd, ['symbolic-ref', 'HEAD', 'refs/heads/feature/current']);
  return { mainCommit, releaseCommit };
}

async function withServer<T>(
  cwd: string,
  publicKey: string | undefined,
  toolSet: 'all' | 'read-only',
  action: (client: Client) => Promise<T>,
): Promise<T> {
  const options = { allowedProjectRoot: cwd, toolSet, goalConfirmationPublicKey: publicKey };
  const server = createTaktMcpServer({}, options);
  const client = new Client({ name: 'goal-test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const names = (await client.listTools()).tools.map(({ name }) => name);
    expect(names).toContain('takt_list_goals');
    expect(names).toContain('takt_get_goal');
    if (toolSet === 'all') expect(names).toContain('takt_create_goal');
    return await action(client);
  } finally {
    await client.close();
    await server.close();
  }
}

describe('Goal MCP registration', () => {
  let cwd: string;
  let mainCommit: string;
  let releaseCommit: string;
  let keys: ReturnType<typeof confirmationKeys>;

  beforeEach(() => {
    cwd = realpathSync(mkdtempSync(join(tmpdir(), 'takt-goal-mcp-')));
    ({ mainCommit, releaseCommit } = initializeRepository(cwd));
    mkdirSync(join(cwd, '.takt'));
    writeFileSync(join(cwd, '.takt', 'config.yaml'), 'base_branch: release\n');
    keys = confirmationKeys();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    rmSync(cwd, { recursive: true, force: true });
  });

  function request(extra: Partial<ReturnType<typeof confirmationPayload>> & {
    startBranch?: string; integrationBranch?: string;
  } = {}) {
    const payload = { ...confirmationPayload(cwd), ...extra };
    const { id: _id, projectRoot: _projectRoot, confirmedAt: _confirmedAt, confirmedBy: _confirmedBy, ...input } = payload;
    return { cwd, ...input, confirmation: signedConfirmation(payload, keys.privateKey) };
  }

  async function create(client: Client, input: Record<string, unknown>) {
    const result = await client.callTool({ name: 'takt_create_goal', arguments: input });
    expect(result.isError).toBeUndefined();
    return (JSON.parse(firstTextContent(result.content)) as { goal: ReturnType<typeof goalRecord> }).goal;
  }

  function expectNoGoalSideEffects(branches: string): void {
    expect(existsSync(join(cwd, '.takt', 'goals', goalId, 'goal.json'))).toBe(false);
    expect(git(cwd, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads'])).toBe(branches);
  }

  function setRemoteDefault(commit: string): void {
    git(cwd, ['update-ref', 'refs/remotes/origin/main', commit]);
    git(cwd, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
  }

  function expectSavedGoal(created: ReturnType<typeof goalRecord>, startBranch: string,
    integrationBranch: string, commit: string): void {
    expect(created).toMatchObject({ startBranch, integrationBranch });
    expect(git(cwd, ['rev-parse', `refs/heads/${created.branch}`])).toBe(commit);
    expect(JSON.parse(readFileSync(join(cwd, '.takt', 'goals', goalId, 'goal.json'), 'utf-8'))).toEqual(created);
  }

  it.each(['human', 'director'] as const)('creates a saved %s goal and its branch from the default branch through MCP', async (creationOrigin) => {
    const head = git(cwd, ['symbolic-ref', 'HEAD']);
    const index = git(cwd, ['ls-files', '--stage']);
    const status = git(cwd, ['status', '--porcelain']);
    await withServer(cwd, keys.publicKey, 'all', async (client) => {
      const created = await create(client, request({ creationOrigin }));
      expect(created).toMatchObject({ ...goalRecord(), creationOrigin, branch: expect.stringMatching(/^takt\/\d{8}T\d{4}-.+/) });
      expect(git(cwd, ['rev-parse', `refs/heads/${created.branch}`])).toBe(mainCommit);
      expect(JSON.parse(readFileSync(join(cwd, '.takt', 'goals', goalId, 'goal.json'), 'utf-8'))).toEqual(created);
      expect(git(cwd, ['symbolic-ref', 'HEAD'])).toBe(head);
      expect(git(cwd, ['ls-files', '--stage'])).toBe(index);
      // ゴール保存が追加する未追跡ファイルだけを除き、利用者の作業状態を比較する。
      expect(git(cwd, ['status', '--porcelain']).split('\n').filter((line) => !line.includes('.takt/goals/')).join('\n')).toBe(status);
    });
  });

  it.each(['main', 'release'] as const)('uses the current local main commit from %s when the start is omitted', async (source) => {
    const commit = source === 'main' ? mainCommit : releaseCommit;
    git(cwd, ['update-ref', 'refs/heads/main', commit]);
    const created = await withServer(cwd, keys.publicKey, 'all', (client) => create(client, request()));
    expectSavedGoal(created, 'main', 'main', commit);
  });

  it.each([true, false])('handles a local master default with reference present=%s', async (present) => {
    git(cwd, ['update-ref', '-d', 'refs/heads/main']);
    if (present) git(cwd, ['update-ref', 'refs/heads/master', mainCommit]);
    const branches = git(cwd, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads']);
    await withServer(cwd, keys.publicKey, 'all', async (client) => {
      if (present) {
        expectSavedGoal(await create(client, request()), 'master', 'master', mainCommit);
      } else {
        expect((await client.callTool({ name: 'takt_create_goal', arguments: request() })).isError).toBe(true);
        expectNoGoalSideEffects(branches);
      }
    });
  });

  it.each([true, false])('creates from a remote-only default only when its reference exists: %s', async (present) => {
    setRemoteDefault(mainCommit);
    git(cwd, ['update-ref', '-d', 'refs/heads/main']);
    if (!present) git(cwd, ['update-ref', '-d', 'refs/remotes/origin/main']);
    const branches = git(cwd, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads']);
    await withServer(cwd, keys.publicKey, 'all', async (client) => {
      if (present) {
        expectSavedGoal(await create(client, request()), 'main', 'main', mainCommit);
      } else {
        expect((await client.callTool({ name: 'takt_create_goal', arguments: request() })).isError).toBe(true);
        expectNoGoalSideEffects(branches);
      }
    });
  });

  it.each([true, false])('prefers the local default over a different remote commit with local present=%s', async (localPresent) => {
    setRemoteDefault(releaseCommit);
    if (!localPresent) git(cwd, ['update-ref', '-d', 'refs/heads/main']);
    const created = await withServer(cwd, keys.publicKey, 'all', (client) => create(client, request()));
    expectSavedGoal(created, 'main', 'main', localPresent ? mainCommit : releaseCommit);
  });

  it('rejects an explicit start when only the remote default reference exists', async () => {
    setRemoteDefault(mainCommit);
    git(cwd, ['update-ref', '-d', 'refs/heads/main']);
    const branches = git(cwd, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads']);
    await withServer(cwd, keys.publicKey, 'all', async (client) => {
      expect((await client.callTool({ name: 'takt_create_goal', arguments: request({ startBranch: 'main' }) })).isError).toBe(true);
      expectNoGoalSideEffects(branches);
    });
  });

  it.each([true, false])('validates an explicit integration branch with a remote-only default and local integration present=%s', async (present) => {
    setRemoteDefault(mainCommit);
    git(cwd, ['update-ref', '-d', 'refs/heads/main']);
    git(cwd, ['update-ref', 'refs/remotes/origin/release', releaseCommit]);
    if (!present) git(cwd, ['update-ref', '-d', 'refs/heads/release']);
    const branches = git(cwd, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads']);
    await withServer(cwd, keys.publicKey, 'all', async (client) => {
      const input = request({ integrationBranch: 'release' });
      if (present) {
        expectSavedGoal(await create(client, input), 'main', 'release', mainCommit);
      } else {
        expect((await client.callTool({ name: 'takt_create_goal', arguments: input })).isError).toBe(true);
        expectNoGoalSideEffects(branches);
      }
    });
  });

  it.each([true, false])('uses an explicit local start as the omitted integration branch with local start present=%s', async (present) => {
    git(cwd, ['update-ref', 'refs/remotes/origin/release', releaseCommit]);
    if (!present) git(cwd, ['update-ref', '-d', 'refs/heads/release']);
    const branches = git(cwd, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads']);
    await withServer(cwd, keys.publicKey, 'all', async (client) => {
      const input = request({ startBranch: 'release' });
      if (present) {
        expectSavedGoal(await create(client, input), 'release', 'release', releaseCommit);
      } else {
        expect((await client.callTool({ name: 'takt_create_goal', arguments: input })).isError).toBe(true);
        expectNoGoalSideEffects(branches);
      }
    });
  });

  it.each([goalInput().objective, 'replacement'])('reads the created goal with objective %s from a new read-only server using list and detail tools', async (objective) => {
    const created = await withServer(cwd, keys.publicKey, 'all', (client) => create(client, request({ objective })));
    expect(created.objective).toBe(objective);
    await withServer(cwd, undefined, 'read-only', async (client) => {
      const listed = await client.callTool({ name: 'takt_list_goals', arguments: { cwd } });
      expect(listed.isError).toBeUndefined();
      expect(JSON.parse(firstTextContent(listed.content))).toMatchObject({ goals: [expect.objectContaining({ id: goalId, objective })] });
      const detail = await client.callTool({ name: 'takt_get_goal', arguments: { cwd, goalId } });
      expect(detail.isError).toBeUndefined();
      expect(JSON.parse(firstTextContent(detail.content))).toEqual({ goal: created });
    });
  });

  it('uses a signed explicit start and integration branch instead of the default', async () => {
    const input = request();
    const payload = { ...confirmationPayload(cwd), startBranch: 'release', integrationBranch: 'main' };
    await withServer(cwd, keys.publicKey, 'all', async (client) => {
      const created = await create(client, {
        ...input, startBranch: 'release', integrationBranch: 'main',
        confirmation: signedConfirmation(payload, keys.privateKey),
      });
      expect(created).toMatchObject({ startBranch: 'release', integrationBranch: 'main' });
      expect(git(cwd, ['rev-parse', `refs/heads/${created.branch}`])).toBe(releaseCommit);
    });
  });

  it('lists healthy goals with corrupt-file errors and keeps the same MCP connection usable', async () => {
    const healthy = { ...goalRecord(), id: '550e8400-e29b-41d4-a716-446655440001', objective: '{' };
    await new GoalStore(cwd).create(healthy);
    const healthyPath = join(cwd, '.takt', 'goals', healthy.id, 'goal.json');
    const saved = readFileSync(healthyPath);
    const corruptPath = join(cwd, '.takt', 'goals', goalId, 'goal.json');
    mkdirSync(join(cwd, '.takt', 'goals', goalId), { recursive: true });
    writeFileSync(corruptPath, '{');
    await withServer(cwd, undefined, 'read-only', async (client) => {
      const listed = await client.callTool({ name: 'takt_list_goals', arguments: { cwd } });
      expect(listed.isError).toBe(true);
      const output = JSON.parse(firstTextContent(listed.content)) as {
        goals: unknown[]; errors: { goalId: string; error: string }[];
      };
      expect(output.goals).toEqual([healthy]);
      expect(output.errors).toEqual([{ goalId, error: expect.stringMatching(/Invalid goal file/) }]);
      expect(output.errors[0]!.error).not.toContain(cwd);
      const corrupt = await client.callTool({ name: 'takt_get_goal', arguments: { cwd, goalId } });
      expect(corrupt.isError).toBe(true);
      expect(firstTextContent(corrupt.content)).toMatch(/Invalid goal file/);
      const detail = await client.callTool({ name: 'takt_get_goal', arguments: { cwd, goalId: healthy.id } });
      expect(detail.isError).toBeUndefined();
      expect(JSON.parse(firstTextContent(detail.content))).toEqual({ goal: healthy });
    });
    expect(readFileSync(corruptPath, 'utf-8')).toBe('{');
    expect(readFileSync(healthyPath)).toEqual(saved);
  });

  it('rejects a missing explicit integration branch before publication', async () => {
    const branches = git(cwd, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads']);
    await withServer(cwd, keys.publicKey, 'all', async (client) => {
      const input = request({ startBranch: 'release', integrationBranch: 'missing' });
      expect((await client.callTool({ name: 'takt_create_goal', arguments: input })).isError).toBe(true);
      expectNoGoalSideEffects(branches);
    });
  });

  it('rejects reuse of a confirmed ID without changing the existing goal or branch', async () => {
    await withServer(cwd, keys.publicKey, 'all', async (client) => {
      const created = await create(client, request());
      const saved = readFileSync(join(cwd, '.takt', 'goals', goalId, 'goal.json'));
      const branches = git(cwd, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads']);
      const duplicate = await client.callTool({ name: 'takt_create_goal', arguments: request({ objective: 'replacement' }) });
      expect(duplicate.isError).toBe(true);
      expect(readFileSync(join(cwd, '.takt', 'goals', goalId, 'goal.json'))).toEqual(saved);
      expect(git(cwd, ['rev-parse', `refs/heads/${created.branch}`])).toBe(mainCommit);
      expect(git(cwd, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads'])).toBe(branches);
    });
  });

  it('rejects a branch name collision without overwriting the existing Git reference', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-04T14:43:00.000Z'));
    await withServer(cwd, keys.publicKey, 'all', async (client) => {
      const created = await create(client, request());
      rmSync(join(cwd, '.takt', 'goals', goalId), { recursive: true, force: true });
      git(cwd, ['update-ref', `refs/heads/${created.branch}`, releaseCommit]);
      const collision = await client.callTool({ name: 'takt_create_goal', arguments: request() });
      expect(collision.isError).toBe(true);
      expect(git(cwd, ['rev-parse', `refs/heads/${created.branch}`])).toBe(releaseCommit);
      expect(existsSync(join(cwd, '.takt', 'goals', goalId, 'goal.json'))).toBe(false);
    });
  });

  it.each(['missing', 'self-reported', 'untrusted signature', 'changed criteria', 'tool public key'] as const)(
    'rejects %s confirmation before saving or creating a branch', async (kind) => {
      const otherKeys = confirmationKeys();
      const input: Record<string, unknown> = request();
      if (kind === 'missing') delete input.confirmation;
      if (kind === 'self-reported') input.confirmation = goalRecord().confirmation;
      if (kind === 'untrusted signature' || kind === 'tool public key') {
        input.confirmation = signedConfirmation(confirmationPayload(cwd), otherKeys.privateKey);
      }
      if (kind === 'changed criteria') input.acceptanceCriteria = ['unconfirmed criterion'];
      if (kind === 'tool public key') input.goalConfirmationPublicKey = otherKeys.publicKey;
      const branches = git(cwd, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads']);
      await withServer(cwd, keys.publicKey, 'all', async (client) => {
        expect((await client.callTool({ name: 'takt_create_goal', arguments: input })).isError).toBe(true);
        expectNoGoalSideEffects(branches);
      });
    },
  );

  it('rejects creation without a host public key while keeping read tools usable', async () => {
    const branches = git(cwd, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads']);
    await withServer(cwd, undefined, 'all', async (client) => {
      expect((await client.callTool({ name: 'takt_create_goal', arguments: request() })).isError).toBe(true);
      const result = await client.callTool({ name: 'takt_list_goals', arguments: { cwd } });
      expect(result.isError).toBeUndefined();
      expect(JSON.parse(firstTextContent(result.content))).toEqual({ goals: [] });
      expectNoGoalSideEffects(branches);
    });
  });

  it('exposes read tools and refuses direct creation in the read-only tool set', async () => {
    const branches = git(cwd, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads']);
    await withServer(cwd, keys.publicKey, 'read-only', async (client) => {
      const names = (await client.listTools()).tools.map(({ name }) => name).sort();
      expect(names).toEqual(['takt_get_goal', 'takt_get_run', 'takt_list_goals', 'takt_list_tasks']);
      expect([...TAKT_MCP_READ_ONLY_TOOL_NAMES].sort()).toEqual(names);
      expect((await client.callTool({ name: 'takt_create_goal', arguments: request() })).isError).toBe(true);
      expectNoGoalSideEffects(branches);
    });
  });

  it('does not publish a goal when the signed start branch does not exist', async () => {
    const branches = git(cwd, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads']);
    await withServer(cwd, keys.publicKey, 'all', async (client) => {
      const payload = { ...confirmationPayload(cwd), startBranch: 'missing' };
      const result = await client.callTool({ name: 'takt_create_goal', arguments: {
        ...request(), startBranch: 'missing', confirmation: signedConfirmation(payload, keys.privateKey),
      } });
      expect(result.isError).toBe(true);
      expectNoGoalSideEffects(branches);
    });
  });

  it('removes only the newly created branch when publication fails and allows retry', async () => {
    const branches = git(cwd, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads']);
    const publication = vi.spyOn(GoalStore.prototype, 'create').mockRejectedValueOnce(new Error('Injected publication failure'));
    await withServer(cwd, keys.publicKey, 'all', async (client) => {
      const result = await client.callTool({ name: 'takt_create_goal', arguments: request() });
      expect(result.isError).toBe(true);
      expect(publication).toHaveBeenCalledTimes(1);
      expectNoGoalSideEffects(branches);
      await create(client, request());
    });
  });

  it('preserves a branch advanced by another writer when failed publication is compensated', async () => {
    let createdBranch: string | undefined;
    vi.spyOn(GoalStore.prototype, 'create').mockImplementationOnce(async (record: ReturnType<typeof goalRecord>) => {
      createdBranch = record.branch;
      git(cwd, ['update-ref', `refs/heads/${record.branch}`, releaseCommit]);
      throw new Error('Injected publication failure after branch advancement');
    });
    await withServer(cwd, keys.publicKey, 'all', async (client) => {
      expect((await client.callTool({ name: 'takt_create_goal', arguments: request() })).isError).toBe(true);
      expect(createdBranch).toEqual(expect.any(String));
      expect(git(cwd, ['rev-parse', `refs/heads/${createdBranch}`])).toBe(releaseCommit);
      expect(existsSync(join(cwd, '.takt', 'goals', goalId, 'goal.json'))).toBe(false);
    });
  });

  it('rejects all goal operations outside the allowed project root', async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'takt-goal-outside-')));
    initializeRepository(outside);
    const outsideGoal = join(outside, '.takt', 'goals', goalId, 'goal.json');
    mkdirSync(join(outside, '.takt', 'goals', goalId), { recursive: true });
    writeFileSync(outsideGoal, JSON.stringify(goalRecord()));
    const saved = readFileSync(outsideGoal);
    const branches = git(outside, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads']);
    const newId = '550e8400-e29b-41d4-a716-446655440001';
    try {
      await withServer(cwd, keys.publicKey, 'all', async (client) => {
        for (const name of ['takt_list_goals', 'takt_get_goal']) {
          expect((await client.callTool({ name, arguments: { cwd: outside, ...(name === 'takt_get_goal' ? { goalId } : {}) } })).isError).toBe(true);
        }
        const input = {
          cwd: outside, ...goalInput(),
          confirmation: signedConfirmation({ ...confirmationPayload(outside), id: newId }, keys.privateKey),
        };
        expect((await client.callTool({ name: 'takt_create_goal', arguments: input })).isError).toBe(true);
        expect(readFileSync(outsideGoal)).toEqual(saved);
        expect(existsSync(join(outside, '.takt', 'goals', newId, 'goal.json'))).toBe(false);
        expect(git(outside, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads'])).toBe(branches);
      });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

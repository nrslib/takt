import { execFileSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createManagerConversationPlan } from '../features/manager/conversationPlan.js';
import { createManagerConversationSession } from '../features/manager/conversationSession.js';
import { createGoalConfirmation } from '../features/manager/goalConfirmation.js';
import { connectManagerMcp } from '../features/manager/managerMcp.js';
import { createTaktMcpServer, type TaktMcpToolSet } from '../features/mcp/server.js';
import { GoalStore } from '../infra/goals/store.js';
import type { Goal } from '../infra/goals/schema.js';
import { resetScenario, setMockScenario } from '../infra/mock/index.js';
import { firstTextContent } from './helpers/mcp-content.js';
import { goalId, goalRecord } from './helpers/goal-fixtures.js';

vi.mock('node:crypto', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:crypto')>();
  return { ...original, randomUUID: vi.fn(original.randomUUID) };
});

const newId = '550e8400-e29b-41d4-a716-446655440001';
const summary = {
  objective: 'JSONを出力する', outOfScope: ['CSV出力'], acceptanceCriteria: ['JSONを取得できる'],
  startBranch: 'release', integrationBranch: 'main',
};

function git(cwd: string, args: string[], input?: string): string {
  return execFileSync('git', args, {
    cwd, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env, GIT_AUTHOR_NAME: 'Manager Test', GIT_AUTHOR_EMAIL: 'manager@example.test',
      GIT_COMMITTER_NAME: 'Manager Test', GIT_COMMITTER_EMAIL: 'manager@example.test',
    },
  }).trim();
}

describe('manager conversation to local goal registration', () => {
  let cwd: string;
  let releaseCommit: string;

  beforeEach(() => {
    const temporaryRoot = join(process.cwd(), '.tmp');
    mkdirSync(temporaryRoot, { recursive: true });
    cwd = realpathSync(mkdtempSync(join(temporaryRoot, 'manager-goal-')));
    git(cwd, ['init', '--initial-branch=main']);
    const tree = git(cwd, ['hash-object', '-w', '-t', 'tree', '--stdin'], '');
    const mainCommit = git(cwd, ['commit-tree', tree, '-m', 'main fixture']);
    releaseCommit = git(cwd, ['commit-tree', tree, '-p', mainCommit, '-m', 'release fixture']);
    git(cwd, ['update-ref', 'refs/heads/main', mainCommit]);
    git(cwd, ['update-ref', 'refs/heads/release', releaseCommit]);
    mkdirSync(join(cwd, '.takt'));
    writeFileSync(join(cwd, '.takt', 'config.yaml'), 'provider: mock\nlanguage: en\n');
    resetScenario();
  });

  afterEach(async () => {
    resetScenario();
    vi.restoreAllMocks();
    vi.mocked(crypto.randomUUID).mockImplementation((await vi.importActual<typeof import('node:crypto')>('node:crypto')).randomUUID);
    rmSync(cwd, { recursive: true, force: true });
  });

  async function withManager<T>(action: (context: {
    session: ReturnType<typeof createManagerConversationSession>; client: Client;
  }) => Promise<T>): Promise<T> {
    const confirmation = createGoalConfirmation(cwd);
    const server = createTaktMcpServer({}, {
      toolSet: 'manager' as TaktMcpToolSet,
      allowedProjectRoot: cwd, goalConfirmationPublicKey: confirmation.publicKey,
    });
    const client = new Client({ name: 'manager-goal-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const plan = createManagerConversationPlan(cwd, { language: 'en' });
      const session = createManagerConversationSession({ cwd, plan, confirmation, mcpClient: client });
      return await action({ session, client });
    } finally {
      await client.close();
      await server.close();
    }
  }

  it('registers a new host ID through MCP after approval and preserves the existing goal and task queue', async () => {
    const existing = goalRecord();
    await new GoalStore(cwd).create(existing);
    git(cwd, ['update-ref', `refs/heads/${existing.branch}`, releaseCommit]);
    const existingPath = join(cwd, '.takt', 'goals', goalId, 'goal.json');
    const saved = readFileSync(existingPath);
    vi.mocked(crypto.randomUUID).mockReturnValue(newId);
    setMockScenario([
      { status: 'done', content: JSON.stringify({ message: '範囲外は何ですか', summary: null }) },
      { status: 'done', content: JSON.stringify({ message: '要約を確認してください', summary }), structuredOutput: { message: '要約を確認してください', summary } },
    ]);

    await withManager(async ({ session, client }) => {
      const calls = vi.spyOn(client, 'callTool');
      await session.handleUserMessage({ text: 'JSON出力を追加したい' });
      expect(session.getPendingSummary()).toBeNull();
      await session.handleUserMessage({ text: 'CSVは範囲外。JSONを取得できることを受け入れ条件にする' });
      expect(session.getPendingSummary()?.summary).toEqual(summary);
      expect((await new GoalStore(cwd).list()).goals.map(({ id }) => id)).toEqual([goalId]);

      const result = await session.approveSummary(session.getPendingSummary()!.revision);

      expect(result.kind).toBe('goal_registered');
      expect(calls.mock.calls.map(([request]) => request.name)).toEqual(['takt_create_goal']);
      const created = await new GoalStore(cwd).get(newId);
      expect(created).toMatchObject({ id: newId, ...summary, creationOrigin: 'human', status: 'created', mode: 'local' });
      expect(git(cwd, ['rev-parse', `refs/heads/${created.branch}`])).toBe(releaseCommit);
      const detail = await client.callTool({ name: 'takt_get_goal', arguments: { cwd, goalId: newId } });
      expect(detail.isError).toBeUndefined();
      expect(JSON.parse(firstTextContent(detail.content))).toEqual({ goal: created });
      const listed = await client.callTool({ name: 'takt_list_goals', arguments: { cwd } });
      expect(listed.isError).toBeUndefined();
      expect((JSON.parse(firstTextContent(listed.content)) as { goals: Goal[] }).goals.map(({ id }) => id).sort()).toEqual([goalId, newId].sort());
      expect(readFileSync(existingPath)).toEqual(saved);
      expect(git(cwd, ['rev-parse', `refs/heads/${existing.branch}`])).toBe(releaseCommit);
      const tasks = await client.callTool({ name: 'takt_list_tasks', arguments: { cwd } });
      expect(JSON.parse(firstTextContent(tasks.content))).toEqual({ tasks: [] });
      expect(existsSync(join(cwd, '.takt', 'tasks.yaml'))).toBe(false);
      expect(existsSync(join(cwd, '.takt', 'runs'))).toBe(false);
    });
  });

  it('rejects a host ID collision without changing the existing goal or Git references', async () => {
    await new GoalStore(cwd).create(goalRecord());
    git(cwd, ['update-ref', `refs/heads/${goalRecord().branch}`, releaseCommit]);
    const path = join(cwd, '.takt', 'goals', goalId, 'goal.json');
    const saved = readFileSync(path);
    const branches = git(cwd, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads']);
    vi.mocked(crypto.randomUUID).mockReturnValue(goalId);
    setMockScenario([{ status: 'done', content: JSON.stringify({ message: '要約', summary }), structuredOutput: { message: '要約', summary } }]);

    await withManager(async ({ session }) => {
      await session.handleUserMessage({ text: 'JSON出力' });
      const result = await session.approveSummary(session.getPendingSummary()!.revision);

      expect(result.kind).toBe('error');
      expect(readFileSync(path)).toEqual(saved);
      expect(git(cwd, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads'])).toBe(branches);
    });
  });

  it('registers through the production stdio MCP process and removes its public key after shutdown', async () => {
    const confirmation = createGoalConfirmation(cwd);
    const connection = await connectManagerMcp(cwd, confirmation.publicKey);
    const server = Object.values(connection.servers)[0];
    if (server?.type !== 'stdio') throw new Error('Expected stdio server');
    const keyPath = server.args![server.args!.indexOf('--goal-confirmation-public-key') + 1]!;
    const plan = createManagerConversationPlan(cwd, { language: 'en' });
    const session = createManagerConversationSession({ cwd, plan: { ...plan, ctx: { ...plan.ctx, mcpServers: connection.servers } }, confirmation, mcpClient: connection.client });
    try {
      expect(readFileSync(keyPath, 'utf8')).toBe(confirmation.publicKey);
      expect((await connection.client.listTools()).tools.map(({ name }) => name).sort()).toEqual(['takt_create_goal', 'takt_list_goals', 'takt_get_goal', 'takt_list_tasks', 'takt_get_run'].sort());
      vi.mocked(crypto.randomUUID).mockReturnValue(newId);
      setMockScenario([{ status: 'done', content: JSON.stringify({ message: '要約', summary }), structuredOutput: { message: '要約', summary } }]);
      await session.handleUserMessage({ text: 'JSON出力' });
      expect((await session.approveSummary(session.getPendingSummary()!.revision)).kind).toBe('goal_registered');
      const created = await new GoalStore(cwd).get(newId);
      expect(created).toMatchObject(summary);
      expect(git(cwd, ['rev-parse', `refs/heads/${created.branch}`])).toBe(releaseCommit);
    } finally {
      try { await session.close(); } finally { await connection.dispose(); }
    }
    expect(existsSync(keyPath)).toBe(false);
  });
});

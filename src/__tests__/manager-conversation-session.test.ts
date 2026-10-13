import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createManagerConversationSession } from '../features/manager/conversationSession.js';
import { goalRecord } from './helpers/goal-fixtures.js';
import { makeProvider } from './test-helpers.js';
import type { ManagerConversationPlan } from '../features/manager/conversationPlan.js';
import type { Provider, ProviderAgent } from '../infra/providers/types.js';
import * as mcpAdapters from '../infra/providers/mcp/index.js';
import * as assignments from '../features/manager/assignment.js';
import { MANAGER_ASSIGNMENT_ENV } from '../features/manager/assignment.js';
import { TAKT_MANAGER_MCP_SERVER_NAME } from '../features/manager/managerMcp.js';
import type { Goal } from '../infra/goals/schema.js';
import { GoalCreateInputSchema } from '../infra/goals/schema.js';
import { assertStrictStructuredOutputSchema, validateStructuredOutputAgainstSchema } from '../core/workflow/engine/structured-output-schema-validator.js';
import { createGoal } from '../infra/goals/service.js';
vi.mock('../infra/goals/service.js', () => ({ createGoal: vi.fn() }));
const answerDoubles = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn(), lock: vi.fn(), turn: vi.fn(), completions: vi.fn(), invalidatePending: vi.fn() }));
vi.mock('../infra/task/runner.js', () => ({ TaskRunner: class { invalidatePendingGoalTasks = answerDoubles.invalidatePending; } }));
vi.mock('../infra/goals/store.js', () => ({ GoalStore: class {
    get = answerDoubles.get;
    update = answerDoubles.update;
    async list() { return { goals: [], errors: [] }; }
  } }));
vi.mock('../infra/goals/turn-lock.js', () => ({ withGoalTurns: answerDoubles.lock }));
vi.mock('../features/manager/completionTurn.js', () => ({ processGoalAnswers: answerDoubles.turn, processGoalCompletions: answerDoubles.completions }));
vi.mock('../infra/goals/operations.js', async (original) => ({
  ...await original<typeof import('../infra/goals/operations.js')>(),
  withGoalWrites: async (_cwd: string, _id: string, action: () => Promise<unknown>) => action(),
}));
vi.mock('../features/manager/autoRun.js', () => ({ ensureManagerRun: vi.fn(async () => {}) }));

const doubles = { call: vi.fn<ProviderAgent['call']>(), setup: vi.fn<Provider['setup']>() };

const cwd = '/test/manager-repository';
const summaryA = { objective: 'CSVを出力する', outOfScope: ['JSON出力'], acceptanceCriteria: ['CSVを取得できる'], constraints: ['git commit 禁止'] };
const summaryB = { objective: 'JSONを出力する', outOfScope: ['CSV出力'], acceptanceCriteria: ['JSONを取得できる'], constraints: [] };

function response(summary: unknown, message = '要約を確認してください') {
  return { persona: 'manager', status: 'done' as const, timestamp: new Date('2026-10-05T12:00:00Z'), content: JSON.stringify({ message, summary }), structuredOutput: { message, summary }, sessionId: 'manager-session' };
}

function fixture(providerType: ManagerConversationPlan['ctx']['providerType'] = 'mock') {
  const register = vi.mocked(createGoal);
  register.mockImplementation(async ({ cwd: _cwd, ...input }) => ({ ...goalRecord(), ...input }));
  const plan: ManagerConversationPlan = {
    ctx: {
      providerType, model: undefined, lang: 'ja',
      provider: makeProvider({ supportsStructuredOutput: true, setup: doubles.setup }),
    },
    strategy: { systemPrompt: 'manager fixture', allowedTools: ['Read'] },
  };
  const session = createManagerConversationSession({ cwd, plan });
  return { session, register, plan };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  doubles.setup.mockReturnValue({ call: doubles.call });
  doubles.call.mockImplementation(async (prompt) => response(prompt.includes('goalRegistered') ? null : summaryA));
  answerDoubles.update.mockReset();
  answerDoubles.get.mockReset().mockResolvedValue(goalRecord());
  answerDoubles.completions.mockReset().mockResolvedValue(undefined);
  answerDoubles.turn.mockReset().mockResolvedValue(undefined);
  answerDoubles.lock.mockReset().mockImplementation(async (_cwd: string, _ids: string[], action: () => Promise<void>) => action());
  answerDoubles.invalidatePending.mockReset();
});

it.each(['active', 'paused'] as const)('aborts a %s goal, invalidates pending work and rejects resume without AI or MCP', async (executionStatus) => {
  let saved: Goal = { ...goalRecord(), executionStatus };
  answerDoubles.get.mockImplementation(async () => structuredClone(saved));
  answerDoubles.update.mockImplementation(async (_id: string, transform: (goal: Goal) => Goal) => { saved = transform(saved); return saved; });
  answerDoubles.invalidatePending.mockImplementation((id: string) => {
    expect(id).toBe(saved.id);
    expect(saved.executionStatus).toBe('aborted');
  });
  const { session, register } = fixture();
  try {
    expect((await session.abortGoal({ goalId: saved.id })).kind).toBe('reply');
    expect(answerDoubles.invalidatePending).toHaveBeenCalledOnce();
    expect((await session.resumeGoal({ goalId: saved.id })).kind).toBe('error');
    expect(saved.executionStatus).toBe('aborted');
    expect(answerDoubles.completions).not.toHaveBeenCalled();
    expect(doubles.call).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
  } finally { await session.close(); }
});

it('retains aborted state after invalidation fails and completes a repeated abort even when UI cancellation follows saving', async () => {
  let saved: Goal = goalRecord();
  const controller = new AbortController();
  answerDoubles.get.mockImplementation(async () => structuredClone(saved));
  answerDoubles.update.mockImplementation(async (_id: string, transform: (goal: Goal) => Goal) => {
    saved = transform(saved);
    controller.abort();
    return saved;
  });
  answerDoubles.invalidatePending.mockImplementationOnce(() => { throw new Error('Pending write unavailable'); });
  const { session } = fixture();
  try {
    expect(await session.abortGoal({ goalId: saved.id, abortSignal: controller.signal })).toMatchObject({ kind: 'error' });
    expect(saved.executionStatus).toBe('aborted');
    expect((await session.abortGoal({ goalId: saved.id })).kind).toBe('reply');
    expect(answerDoubles.invalidatePending).toHaveBeenCalledTimes(2);
    expect(saved.executionStatus).toBe('aborted');
  } finally { await session.close(); }
});

it('pauses and resumes explicitly without sending those operations to the conversation agent or MCP', async () => {
  let saved: Goal = goalRecord();
  answerDoubles.get.mockImplementation(async () => structuredClone(saved));
  answerDoubles.update.mockImplementation(async (_id: string, transform: (goal: Goal) => Goal) => {
    saved = transform(saved); return saved;
  });
  const { session, register } = fixture();
  try {
    expect((await session.pauseGoal({ goalId: saved.id })).kind).toBe('reply');
    expect(saved.executionStatus).toBe('paused');
    expect(answerDoubles.completions).not.toHaveBeenCalled();
    expect((await session.resumeGoal({ goalId: saved.id })).kind).toBe('reply');
    expect(saved.executionStatus).toBe('active');
    expect(answerDoubles.completions).toHaveBeenCalledOnce();
    expect(doubles.call).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
  } finally { await session.close(); }
});

it('judges pending work on resume even when no saved event requires a manager turn', async () => {
  let saved: Goal = { ...goalRecord(), executionStatus: 'paused', events: [] };
  answerDoubles.get.mockImplementation(async () => structuredClone(saved));
  answerDoubles.update.mockImplementation(async (_id: string, transform: (goal: Goal) => Goal) => {
    saved = transform(saved); return saved;
  });
  let locked = false;
  answerDoubles.lock.mockImplementation(async (_cwd: string, _ids: string[], action: () => Promise<void>) => {
    locked = true;
    try { await action(); } finally { locked = false; }
  });
  answerDoubles.completions.mockImplementation(async (project: string, id: string) => {
    expect(locked).toBe(false);
    expect(project).toBe(cwd);
    expect(id).toBe(saved.id);
    expect(saved.executionStatus).toBe('active');
  });
  const { ensureManagerRun } = await import('../features/manager/autoRun.js');
  const { session } = fixture();
  try {
    expect((await session.resumeGoal({ goalId: saved.id })).kind).toBe('reply');
    expect(answerDoubles.completions).toHaveBeenCalledOnce();
    expect(ensureManagerRun).toHaveBeenCalledWith(cwd);
  } finally { await session.close(); }
});

it.each(['pause', 'resume'] as const)('does not process events or launch work when %s persistence fails', async (operation) => {
  answerDoubles.get.mockResolvedValue({ ...goalRecord(), executionStatus: operation === 'resume' ? 'paused' : 'active' });
  answerDoubles.update.mockRejectedValueOnce(new Error('execution status publication failed'));
  const { ensureManagerRun } = await import('../features/manager/autoRun.js');
  const { session } = fixture();
  try {
    const result = operation === 'pause'
      ? await session.pauseGoal({ goalId: goalRecord().id })
      : await session.resumeGoal({ goalId: goalRecord().id });
    expect(result.kind).toBe('error');
    expect(answerDoubles.completions).not.toHaveBeenCalled();
    expect(ensureManagerRun).not.toHaveBeenCalled();
  } finally { await session.close(); }
});

it('waits for resume event processing to settle on close and rejects further human operations', async () => {
  let saved: Goal = { ...goalRecord(), executionStatus: 'paused' };
  answerDoubles.get.mockImplementation(async () => structuredClone(saved));
  answerDoubles.update.mockImplementation(async (_id: string, transform: (goal: Goal) => Goal) => {
    saved = transform(saved); return saved;
  });
  let finish!: () => void;
  answerDoubles.completions.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
  const { session } = fixture();
  const resuming = session.resumeGoal({ goalId: saved.id });
  await vi.waitFor(() => expect(answerDoubles.completions).toHaveBeenCalledOnce());
  let closed = false;
  const closing = session.close().then(() => { closed = true; });
  try {
    await Promise.resolve();
    expect(closed).toBe(false);
  } finally { finish(); await resuming; await closing; }
  expect(closed).toBe(true);
  expect((await session.pauseGoal({ goalId: saved.id })).kind).toBe('error');
  expect((await session.resumeGoal({ goalId: saved.id })).kind).toBe('error');
});

it.each(['pause', 'resume'] as const)('rejects human %s for an aborted goal without processing events or launching work', async (operation) => {
  let saved: Goal = { ...goalRecord(), executionStatus: 'aborted' };
  answerDoubles.update.mockImplementation(async (_id: string, transform: (goal: Goal) => Goal) => {
    saved = transform(saved); return saved;
  });
  const { ensureManagerRun } = await import('../features/manager/autoRun.js');
  const { session } = fixture();
  try {
    const result = operation === 'pause' ? await session.pauseGoal({ goalId: saved.id }) : await session.resumeGoal({ goalId: saved.id });
    expect(result.kind).toBe('error');
    expect(saved.executionStatus).toBe('aborted');
    expect(answerDoubles.completions).not.toHaveBeenCalled();
    expect(ensureManagerRun).not.toHaveBeenCalled();
  } finally { await session.close(); }
});

it('rejects a cancelled human pause before saving execution state', async () => {
  let saved: Goal = goalRecord();
  answerDoubles.update.mockImplementation(async (_id: string, transform: (goal: Goal) => Goal) => {
    saved = transform(saved); return saved;
  });
  const controller = new AbortController();
  controller.abort();
  const { session } = fixture();
  try {
    expect((await session.pauseGoal({ goalId: saved.id, abortSignal: controller.signal })).kind).toBe('error');
    expect(saved.executionStatus).toBe('active');
    expect(answerDoubles.completions).not.toHaveBeenCalled();
  } finally { await session.close(); }
});

it('resumes the same human conversation session on its second turn', async () => {
  const { session } = fixture();
  try {
    expect((await session.handleUserMessage({ text: 'CSV出力を相談したい' })).kind).toBe('reply');
    expect((await session.handleUserMessage({ text: '列名も含めたい' })).kind).toBe('reply');
    expect(doubles.call).toHaveBeenCalledTimes(2);
    expect(doubles.call.mock.calls[0]![1].sessionId).toBeUndefined();
    expect(doubles.call.mock.calls[1]![1].sessionId).toBe('manager-session');
  } finally { await session.close(); }
});

it.each(['json', 'text-array'] as const)('switches to the workspace returned by a successful repository addition (%s)', async (format) => {
  const repositoryB = '/test/repository-b';
  const repository = { kind: 'repository' as const, repositoryDirectory: cwd, repositoryDirectories: [cwd] };
  const workspace = { id: '650e8400-e29b-41d4-a716-446655440001', name: 'A + B', repositoryDirectories: [cwd, repositoryB] };
  const identity = { kind: 'workspace' as const, workspaceId: workspace.id };
  vi.spyOn(assignments, 'resolveCurrentManagerAssignment').mockImplementation(async (current) => current.kind === 'workspace'
    ? { ...current, name: workspace.name, repositoryDirectories: workspace.repositoryDirectories }
    : repository);
  const { plan } = fixture();
  const session = createManagerConversationSession({ cwd, plan, assignment: repository });
  doubles.call.mockImplementationOnce(async (_prompt, options) => {
    options.onStream?.({ type: 'tool_use', data: { id: 'add-b', tool: 'takt_add_workspace_repository', input: { repositoryDirectory: repositoryB } } });
    const text = JSON.stringify({ workspace });
    options.onStream?.({ type: 'tool_result', data: { id: 'add-b', isError: false,
      content: format === 'text-array' ? JSON.stringify([{ type: 'text', text }]) : text } });
    return response(null);
  });
  try {
    expect((await session.handleUserMessage({ text: 'B を追加してください' })).kind).toBe('reply');
    expect(await session.getAssignment()).toEqual({ ...identity, name: workspace.name, repositoryDirectories: workspace.repositoryDirectories });
  } finally { await session.close(); }
});

it.each([
  'takt_add_workspace_repository',
  `mcp__${TAKT_MANAGER_MCP_SERVER_NAME}__takt_add_workspace_repository`,
  `${TAKT_MANAGER_MCP_SERVER_NAME}__takt_add_workspace_repository`,
  `${TAKT_MANAGER_MCP_SERVER_NAME}_takt_add_workspace_repository`,
])('retains the workspace after adding B and removing A in one turn (%s)', async (tool) => {
  const repositoryB = '/test/repository-b';
  const repository = { kind: 'repository' as const, repositoryDirectory: cwd, repositoryDirectories: [cwd] };
  const workspace = { id: '650e8400-e29b-41d4-a716-446655440001', name: 'A + B', repositoryDirectories: [cwd, repositoryB] };
  const identity = { kind: 'workspace' as const, workspaceId: workspace.id };
  let removedA = false;
  vi.spyOn(assignments, 'resolveCurrentManagerAssignment').mockImplementation(async (current) => current.kind === 'workspace'
    ? { ...identity, name: workspace.name, repositoryDirectories: removedA ? [repositoryB] : workspace.repositoryDirectories }
    : repository);
  vi.spyOn(assignments, 'resolveAssignedProjectRoot').mockImplementation(async (directory, current) => {
    expect(current).toMatchObject({ ...identity, repositoryDirectories: [repositoryB] });
    expect(directory).toBe(repositoryB);
    return repositoryB;
  });
  vi.spyOn(mcpAdapters, 'createMcpAdapter').mockReturnValue({
    validate: vi.fn(), prepare: vi.fn(async () => ({ dispose: vi.fn(async () => {}) })),
    classifyFailure: vi.fn(() => ({ category: 'provider_error' as const })),
  });
  const { plan, register } = fixture();
  plan.ctx.mcpServers = { [TAKT_MANAGER_MCP_SERVER_NAME]: { command: 'node' } };
  const session = createManagerConversationSession({ cwd, plan, assignment: repository });
  doubles.call.mockImplementationOnce(async (_prompt, options) => {
    options.onStream?.({ type: 'tool_use', data: { id: 'add-b', tool, input: { repositoryDirectory: repositoryB } } });
    options.onStream?.({ type: 'tool_result', data: { id: 'add-b', isError: false, content: JSON.stringify({ workspace }) } });
    removedA = true;
    return response({ ...summaryB, repositoryDirectory: repositoryB });
  });
  const { ensureManagerRun } = await import('../features/manager/autoRun.js');
  try {
    expect((await session.handleUserMessage({ text: 'B を追加して A を外してください' })).kind).toBe('reply');
    expect(session.getPendingSummary()).toMatchObject({ summary: summaryB, repositoryDirectory: repositoryB });
    expect(await session.getAssignment()).toMatchObject({ ...identity, repositoryDirectories: [repositoryB] });
    expect(ensureManagerRun).toHaveBeenCalledExactlyOnceWith(repositoryB);
    await session.approveSummary(session.getPendingSummary()!.revision);
    expect(register).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ cwd: repositoryB, ...summaryB }));
    expect(doubles.call.mock.calls[1]![0]).toContain(JSON.stringify({ ...identity, name: workspace.name, repositoryDirectories: [repositoryB] }));
    const server = doubles.call.mock.calls[1]![1].mcpServers![TAKT_MANAGER_MCP_SERVER_NAME]!;
    expect(server).toMatchObject({ env: { [MANAGER_ASSIGNMENT_ENV]: JSON.stringify(identity) } });
    expect(ensureManagerRun).not.toHaveBeenCalledWith(cwd);
  } finally { await session.close(); }
});

it.each([
  { name: 'failed result', isError: true, content: JSON.stringify({ workspace: { id: '650e8400-e29b-41d4-a716-446655440001' } }) },
  { name: 'unreadable body', isError: false, content: 'Workspace operation failed' },
  { name: 'unreadable text block', isError: false, content: JSON.stringify([{ type: 'text', text: 'Workspace operation failed' }]) },
  { name: 'no workspace ID', isError: false, content: JSON.stringify({}) },
])('keeps the repository assignment for $name', async ({ isError, content }) => {
  const repository = { kind: 'repository' as const, repositoryDirectory: cwd, repositoryDirectories: [cwd] };
  vi.spyOn(assignments, 'resolveCurrentManagerAssignment').mockImplementation(async (current) => current.kind === 'repository'
    ? repository : { ...current, name: 'A + B', repositoryDirectories: [cwd, '/test/repository-b'] });
  const { plan } = fixture();
  const session = createManagerConversationSession({ cwd, plan, assignment: repository });
  doubles.call.mockImplementationOnce(async (_prompt, options) => {
    options.onStream?.({ type: 'tool_use', data: { id: 'add-b', tool: 'takt_add_workspace_repository', input: { repositoryDirectory: '/test/repository-b' } } });
    options.onStream?.({ type: 'tool_result', data: { id: 'add-b', content, isError } });
    return response(null);
  });
  try {
    expect((await session.handleUserMessage({ text: '担当を追加してください' })).kind).toBe('reply');
    expect(await session.getAssignment()).toEqual(repository);
  } finally { await session.close(); }
});

it('saves an explicit TUI answer and its event before invoking the goal turn after lock release', async () => {
  const questionId = '650e8400-e29b-41d4-a716-446655440001';
  let saved: Goal = { ...goalRecord(), questions: [{ id: questionId, body: '形式はどれですか', status: 'pending', recipient: 'human' }] };
  let locked = false;
  answerDoubles.lock.mockImplementation(async (_cwd: string, _ids: string[], action: () => Promise<void>) => {
    locked = true;
    try { await action(); } finally { locked = false; }
  });
  answerDoubles.update.mockImplementation(async (_id: string, transform: (goal: Goal) => Goal) => {
    expect(locked).toBe(true); saved = transform(saved); return saved;
  });
  answerDoubles.turn.mockImplementation(async (_cwd: string, id: string) => {
    expect(locked).toBe(false);
    expect(id).toBe(saved.id);
    expect(saved.events?.[0]).toMatchObject({ id: expect.any(String), kind: 'answer', questionId, answer: { text: 'JSON', source: 'tui' }, processed: false });
  });
  const { session, register } = fixture();
  const result = await session.answerQuestion({ goalId: saved.id, questionId, text: 'JSON' });
  expect(result.kind).toBe('reply');
  expect(answerDoubles.turn).toHaveBeenCalledOnce();
  expect(register).not.toHaveBeenCalled();
  expect(doubles.call).not.toHaveBeenCalled();
  await session.close();
});

it('does not invoke the manager answer turn when answer persistence fails', async () => {
  answerDoubles.update.mockRejectedValueOnce(new Error('answer publication failed'));
  const { session } = fixture();
  expect((await session.answerQuestion({ goalId: goalRecord().id, questionId: 'missing', text: 'JSON' })).kind).toBe('error');
  expect(answerDoubles.turn).not.toHaveBeenCalled();
  await session.close();
  expect((await session.answerQuestion({ goalId: goalRecord().id, questionId: 'missing', text: 'JSON' })).kind).toBe('error');
});

describe('manager conversation approval', () => {
  it('passes a strict Codex conversation schema requiring both nullable branches to the provider', async () => {
    const { session } = fixture('codex');
    try {
      expect((await session.handleUserMessage({ text: 'CSV出力' })).kind).toBe('reply');
      const schema = doubles.call.mock.calls[0]![1].outputSchema!;
      expect(() => assertStrictStructuredOutputSchema(schema)).not.toThrow();
      const wireSummary = { ...summaryA, repositoryDirectory: null, startBranch: null, integrationBranch: null };
      expect(() => validateStructuredOutputAgainstSchema({ message: '確認', summary: wireSummary }, schema)).not.toThrow();
      expect(() => validateStructuredOutputAgainstSchema({ message: '相談', summary: null }, schema)).not.toThrow();
      for (const branch of ['startBranch', 'integrationBranch'] as const) {
        const missing: Record<string, unknown> = { ...wireSummary };
        delete missing[branch];
        expect(() => validateStructuredOutputAgainstSchema({ message: '確認', summary: missing }, schema)).toThrow();
        expect(() => validateStructuredOutputAgainstSchema({ message: '確認', summary: { ...wireSummary, [branch]: 'release' } }, schema)).not.toThrow();
      }
    } finally { await session.close(); }
  });

  describe.each(['structuredOutput', 'content'] as const)('Codex summaries from %s', (format) => {
    it.each([
      { branches: { repositoryDirectory: null, startBranch: null, integrationBranch: null }, expected: {} },
      { branches: { startBranch: null, integrationBranch: 'release' }, expected: { integrationBranch: 'release' } },
      { branches: { startBranch: 'release', integrationBranch: null }, expected: { startBranch: 'release' } },
      { branches: { startBranch: 'null', integrationBranch: 'main' }, expected: { startBranch: 'null', integrationBranch: 'main' } },
      { branches: {}, expected: {} },
    ])('normalizes only null branches before approval, direct registration: $branches', async ({ branches, expected }) => {
      const reply = response({ ...summaryA, ...branches });
      doubles.call.mockResolvedValueOnce({ ...reply, structuredOutput: format === 'content' ? undefined : reply.structuredOutput });
      const { session, register } = fixture('codex');
      try {
        expect((await session.handleUserMessage({ text: '要件を整理してください' })).kind).toBe('reply');
        const normalized = { ...summaryA, ...expected };
        expect(session.getPendingSummary()?.summary).toEqual(normalized);
        expect(register).not.toHaveBeenCalled();
        const result = await session.approveSummary(session.getPendingSummary()!.revision);
        expect(result).toMatchObject({ kind: 'goal_registered', goal: normalized });
        expect(register).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ cwd, ...normalized }));
        const request = GoalCreateInputSchema.parse(register.mock.calls[0]![0]);
        for (const branch of ['startBranch', 'integrationBranch'] as const) {
          const value = normalized[branch as keyof typeof normalized];
          if (value === undefined) {
            expect(request[branch]).toBeUndefined();
          } else {
            expect(request).toHaveProperty(branch, value);
          }
        }
      } finally { await session.close(); }
    });

    it('keeps a null summary unavailable for approval without registration', async () => {
      const reply = response(null, '相談を続けます');
      doubles.call.mockResolvedValueOnce({ ...reply, structuredOutput: format === 'content' ? undefined : reply.structuredOutput });
      const { session, register } = fixture('codex');
      try {
        expect(await session.handleUserMessage({ text: '相談' })).toEqual({ kind: 'reply', message: '相談を続けます' });
        expect(session.getPendingSummary()).toBeNull();
        expect((await session.approveSummary(1)).kind).toBe('error');
        expect(register).not.toHaveBeenCalled();
      } finally { await session.close(); }
    });

    it.each([
      { name: 'null objective', invalid: { objective: null } },
      { name: 'empty objective', invalid: { objective: '' } },
      { name: 'blank objective', invalid: { objective: '   ' } },
      { name: 'oversized objective', invalid: { objective: 'a'.repeat(128 * 1024 + 1) } },
      { name: 'empty acceptance criteria', invalid: { acceptanceCriteria: [] } },
      { name: 'unsafe display characters', invalid: { objective: 'CSV\u0000出力' } },
      { name: 'invalid branch', invalid: { integrationBranch: 'bad branch' } },
      { name: 'unknown summary property', invalid: { unexpected: 'value' } },
    ])('retains summary validation after null normalization and rejects $name', async ({ invalid }) => {
      const { session, register } = fixture('codex');
      try {
        await session.handleUserMessage({ text: 'CSV出力' });
        const old = session.getPendingSummary()!;
        const reply = response({ ...summaryA, repositoryDirectory: null, startBranch: null, integrationBranch: null, ...invalid });
        doubles.call.mockResolvedValueOnce({ ...reply, structuredOutput: format === 'content' ? undefined : reply.structuredOutput });
        expect((await session.handleUserMessage({ text: '修正してください' })).kind).toBe('error');
        expect(session.getPendingSummary()).toBeNull();
        expect((await session.approveSummary(old.revision)).kind).toBe('error');
        expect(register).not.toHaveBeenCalled();
      } finally { await session.close(); }
    });
  });

  it.each(['claude', 'claude-sdk'] as const)('preserves optional branches and receive validation for %s', async (providerType) => {
    const { session, register } = fixture(providerType);
    try {
      expect((await session.handleUserMessage({ text: 'CSV出力' })).kind).toBe('reply');
      const schema = doubles.call.mock.calls[0]![1].outputSchema!;
      expect(schema).not.toHaveProperty('$schema');
      expect(schema).toMatchObject({ properties: { message: { minLength: 1 } } });
      expect(() => validateStructuredOutputAgainstSchema({ message: '確認', summary: summaryA }, schema)).not.toThrow();
      expect(() => validateStructuredOutputAgainstSchema({ message: '確認', summary: { ...summaryA, startBranch: 'release', integrationBranch: 'main' } }, schema)).not.toThrow();
      expect(() => validateStructuredOutputAgainstSchema({ message: '確認', summary: { ...summaryA, repositoryDirectory: null, startBranch: null, integrationBranch: null } }, schema)).toThrow();
      expect(() => validateStructuredOutputAgainstSchema({ message: '', summary: summaryA }, schema)).toThrow();
      expect(() => validateStructuredOutputAgainstSchema({ message: '確認', summary: { ...summaryA, acceptanceCriteria: [] } }, schema)).toThrow();
      expect(() => validateStructuredOutputAgainstSchema({ message: '確認', summary: { ...summaryA, objective: 'a'.repeat(128 * 1024 + 1) } }, schema)).toThrow();
      expect((await session.approveSummary(session.getPendingSummary()!.revision)).kind).toBe('goal_registered');
      expect(register).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ cwd, ...summaryA }));
      expect(register).toHaveBeenCalledOnce();
      doubles.call.mockResolvedValueOnce(response({ ...summaryA, repositoryDirectory: null, startBranch: null, integrationBranch: null }));
      expect((await session.handleUserMessage({ text: '修正' })).kind).toBe('error');
      expect(session.getPendingSummary()).toBeNull();
      expect(register).toHaveBeenCalledOnce();
    } finally { await session.close(); }
  });

  it.each(['structuredOutput', 'content'] as const)('preserves safe summaries from %s through direct registration', async (format) => {
    const summary = { ...summaryA, objective: 'CSV\n列名\t値', outOfScope: ['JSON出力', '通知'],
      acceptanceCriteria: ['CSVを取得できる', '列名を含む'], startBranch: 'release', integrationBranch: 'main', constraints: [], };
    const reply = response(summary, '\u001b[31mCSVを出力する\u001b[0m');
    doubles.call.mockResolvedValueOnce({ ...reply, structuredOutput: format === 'content' ? undefined : reply.structuredOutput });
    const { session, register } = fixture();
    expect((await session.handleUserMessage({ text: '要件を整理してください' })).kind).toBe('reply');
    expect(session.getPendingSummary()?.summary).toEqual(summary);
    const result = await session.approveSummary(session.getPendingSummary()!.revision);
    expect(result).toMatchObject({ kind: 'goal_registered', goal: summary });
    expect(register).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ cwd, ...summary }));
    const request = register.mock.calls[0]![0];
    expect(request).toMatchObject(summary);
  });

  describe.each(['structuredOutput', 'content'] as const)('display safety with %s', (format) => {
    it.each([
      { ...summaryA, objective: 'CSV\u0000出力' },
      { ...summaryA, objective: '\u001b[31mCSVを出力する\u001b[0m' },
      { ...summaryA, objective: 'CSV\u001b]0;title\u0007出力' },
      { ...summaryA, objective: 'CSV\u0085出力' },
      { ...summaryA, outOfScope: ['JSON出力', '通知\u0007'] },
      { ...summaryA, acceptanceCriteria: ['CSVを取得できる', '列名\u001b['] },
      { ...summaryA, startBranch: 'release\u0085' },
      { ...summaryA, integrationBranch: 'main\u0085' },
    ])('rejects unsafe summary %j and clears the previous approval without side effects', async (summary) => {
      const { session, register } = fixture();
      await session.handleUserMessage({ text: 'CSV出力' });
      const old = session.getPendingSummary()!;
      const reply = response(summary);
      doubles.call.mockResolvedValueOnce({ ...reply, structuredOutput: format === 'content' ? undefined : reply.structuredOutput });
      expect((await session.handleUserMessage({ text: '要件を修正してください' })).kind).toBe('error');
      expect(session.getPendingSummary()).toBeNull();
      expect((await session.approveSummary(old.revision)).kind).toBe('error');
      expect((await session.approveSummary(old.revision + 1)).kind).toBe('error');
      expect(register).not.toHaveBeenCalled();
    });
  });

  it('rejects a dismissed summary and does not let an old dismiss operation clear a newer summary', async () => {
    const { session, register } = fixture();
    await session.handleUserMessage({ text: 'CSV出力' });
    const old = session.getPendingSummary()!;
    session.dismissSummary(old.revision);
    expect(session.getPendingSummary()).toBeNull();
    expect((await session.approveSummary(old.revision)).kind).toBe('error');
    expect(register).not.toHaveBeenCalled();
    doubles.call.mockResolvedValueOnce(response(summaryB));
    await session.handleUserMessage({ text: 'JSON出力' });
    const latest = session.getPendingSummary()!;
    session.dismissSummary(old.revision);
    expect(session.getPendingSummary()).toEqual(latest);
    await session.approveSummary(latest.revision);
    expect(register).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ cwd, ...summaryB }));
  });
  it.each([false, true])('clears the approval target when prepared MCP cleanup is interrupted or fails=%s', async (fails) => {
    let finish!: () => void;
    const dispose = vi.fn(() => new Promise<void>((resolve, reject) => {
      finish = () => fails ? reject(new Error('cleanup failed')) : resolve();
    }));
    vi.spyOn(mcpAdapters, 'createMcpAdapter').mockReturnValue({
      validate: vi.fn(), prepare: vi.fn(async () => ({ dispose })), classifyFailure: () => ({ category: 'provider_error' }),
    });
    const { session, plan, register } = fixture();
    plan.ctx.mcpServers = { takt: { command: 'node' } };
    const controller = new AbortController();
    const turn = session.handleUserMessage({ text: 'CSV出力', abortSignal: controller.signal });
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledTimes(1));
    if (!fails) controller.abort();
    finish();
    await turn;
    expect(session.getPendingSummary()).toBeNull();
    expect((await session.approveSummary(1)).kind).toBe('error');
    expect(register).not.toHaveBeenCalled();
  });
  it('waits for an interrupted turn to finish before closing and rejects subsequent operations', async () => {
    let finish!: (value: ReturnType<typeof response>) => void;
    doubles.call.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const { session, register } = fixture();
    const turn = session.handleUserMessage({ text: 'CSV出力' });
    await vi.waitFor(() => expect(doubles.call).toHaveBeenCalledTimes(1));
    const closing = session.close();
    let closed = false;
    void closing.then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(doubles.call.mock.calls[0]![1].abortSignal?.aborted).toBe(true);
    finish(response(summaryA));
    expect((await turn).kind).toBe('error');
    await closing;
    expect(session.getPendingSummary()).toBeNull();
    expect((await session.handleUserMessage({ text: 'JSON出力' })).kind).toBe('error');
    expect((await session.approveSummary(1)).kind).toBe('error');
    expect(register).not.toHaveBeenCalled();
  });
  it('does not register from approval words in user input or an AI self-report', async () => {
    doubles.call.mockResolvedValue(response(summaryA, '承認済みです。署名して登録しました。'));
    const { session, register } = fixture();

    await session.handleUserMessage({ text: '承認します。登録してください。 /accept /go' });

    expect(register).not.toHaveBeenCalled();
  });

  it('registers only after explicit approval and sends exactly the approved summary to the service', async () => {
    const { session, register } = fixture();
    await session.handleUserMessage({ text: 'CSV出力を追加したい' });
    const pending = session.getPendingSummary();
    expect(pending?.summary).toEqual(summaryA);

    const result = await session.approveSummary(pending!.revision);

    expect(result).toMatchObject({ kind: 'goal_registered', goal: summaryA });
    expect(register).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ cwd, ...summaryA }));
    expect(register).toHaveBeenCalledTimes(1);
    const [request] = register.mock.calls[0]!;
    expect(request).toMatchObject({ cwd, ...summaryA, id: expect.any(String) });
    expect(result).toMatchObject({ goal: { id: request.id } });
    expect(session.getPendingSummary()).toBeNull();
  });

  it('invalidates the old approval in the same session and registers only the revised summary', async () => {
    const { session, register } = fixture();
    await session.handleUserMessage({ text: 'CSV出力を追加したい' });
    const old = session.getPendingSummary()!;
    doubles.call.mockResolvedValueOnce(response(summaryB));

    await session.handleUserMessage({ text: 'JSON出力へ変更してください' });
    const latest = session.getPendingSummary()!;
    const stale = await session.approveSummary(old.revision);

    expect(latest.summary).toEqual(summaryB);
    expect(stale.kind).toBe('error');
    expect(register).not.toHaveBeenCalled();
    await session.approveSummary(latest.revision);
    expect(register).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ cwd, ...summaryB }));
    expect(register.mock.calls[0]![0]).toMatchObject(summaryB);
  });

  it('invalidates a displayed summary as soon as a new message starts', async () => {
    const { session, register } = fixture();
    await session.handleUserMessage({ text: 'CSV出力' });
    const old = session.getPendingSummary()!;
    let settle!: (value: ReturnType<typeof response>) => void;
    doubles.call.mockImplementationOnce(() => new Promise((resolve) => { settle = resolve; }));
    const turn = session.handleUserMessage({ text: '要件を修正したい' });

    try {
      await vi.waitFor(() => expect(doubles.call).toHaveBeenCalledTimes(2));
      expect((await session.approveSummary(old.revision)).kind).toBe('error');
      expect(register).not.toHaveBeenCalled();
    } finally {
      settle(response(summaryB));
      await turn;
    }
  });

  it('does not create an approval target from quoted JSON or code fences in conversation text', async () => {
    const quoted = JSON.stringify(summaryA);
    const message = [quoted, `> ${quoted}`, `\`\`\`json\n${quoted}\n\`\`\``, `~~~json\n${quoted}\n~~~`, `> > ${quoted}`, `\`\`\`json\n${quoted}`].join('\n');
    doubles.call.mockResolvedValueOnce(response(null, message));
    const { session, register } = fixture();

    await session.handleUserMessage({ text: '引用を確認してください' });

    expect(session.getPendingSummary()).toBeNull();
    expect((await session.approveSummary(0)).kind).toBe('error');
    expect(register).not.toHaveBeenCalled();
  });

  it('reports a provider failure without leaving a previous summary available for approval', async () => {
    const { session, register } = fixture();
    await session.handleUserMessage({ text: 'CSV出力' });
    doubles.call.mockResolvedValueOnce({ persona: 'manager', status: 'error', content: '', timestamp: new Date('2026-10-05T12:00:00Z'), error: 'provider failure' });

    const result = await session.handleUserMessage({ text: 'JSONに変更' });

    expect(result.kind).toBe('error');
    expect(session.getPendingSummary()).toBeNull();
    expect(register).not.toHaveBeenCalled();
  });

  it('does not let an interrupted late response replace the latest summary in the same session', async () => {
    const { session, register } = fixture();
    let settle!: (value: ReturnType<typeof response>) => void;
    doubles.call.mockImplementationOnce(() => new Promise((resolve) => { settle = resolve; }));
    const controller = new AbortController();
    const oldTurn = session.handleUserMessage({ text: 'CSV出力', abortSignal: controller.signal });
    await vi.waitFor(() => expect(doubles.call).toHaveBeenCalledTimes(1));
    controller.abort();
    doubles.call.mockResolvedValueOnce(response(summaryB));

    try {
      await session.handleUserMessage({ text: 'JSON出力へ変更' });
      expect(session.getPendingSummary()?.summary).toEqual(summaryB);
    } finally {
      settle(response(summaryA));
      await oldTurn;
    }

    expect(session.getPendingSummary()?.summary).toEqual(summaryB);
    await session.approveSummary(session.getPendingSummary()!.revision);
    expect(register).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ cwd, ...summaryB }));
  });

  it.each([false, true])('does not restore an interrupted summary after repository resolution (new turn: %s)', async (newTurn) => {
    const assignment = { kind: 'repository' as const, repositoryDirectory: cwd, repositoryDirectories: [cwd] };
    vi.spyOn(assignments, 'resolveCurrentManagerAssignment').mockResolvedValue(assignment);
    let finish!: (repository: string) => void;
    const resolveRoot = vi.spyOn(assignments, 'resolveAssignedProjectRoot').mockResolvedValue(cwd)
      .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const { plan, register } = fixture();
    const session = createManagerConversationSession({ cwd, plan, assignment });
    const controller = new AbortController();
    const oldTurn = session.handleUserMessage({ text: 'CSV出力', abortSignal: controller.signal });
    try {
      await vi.waitFor(() => expect(resolveRoot).toHaveBeenCalledTimes(1));
      controller.abort();
      expect(session.getPendingSummary()).toBeNull();
      if (newTurn) {
        doubles.call.mockResolvedValueOnce(response(summaryB));
        expect((await session.handleUserMessage({ text: 'JSON出力へ変更' })).kind).toBe('reply');
      }
      const latest = session.getPendingSummary();
      finish(cwd);
      expect((await oldTurn).kind).toBe('error');
      expect(session.getPendingSummary()).toEqual(latest);
      if (newTurn) {
        expect(latest?.summary).toEqual(summaryB);
        await session.approveSummary(latest!.revision);
        expect(register).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ cwd, ...summaryB }));
      } else {
        expect((await session.approveSummary(1)).kind).toBe('error');
        expect(register).not.toHaveBeenCalled();
      }
    } finally {
      finish?.(cwd);
      await session.close();
    }
  });

  it.each([
    { ...summaryA, objective: '' },
    { ...summaryA, acceptanceCriteria: [] },
  ])('rejects an incomplete summary before making it available for approval: %j', async (summary) => {
    doubles.call.mockResolvedValueOnce(response(summary));
    const { session, register } = fixture();

    const result = await session.handleUserMessage({ text: '要件を整理してください' });

    expect(result.kind).toBe('error');
    expect(session.getPendingSummary()).toBeNull();
    expect(register).not.toHaveBeenCalled();
  });

  it('reports a registration error instead of announcing a registered goal', async () => {
    const { session, register } = fixture();
    await session.handleUserMessage({ text: 'CSV出力' });
    register.mockRejectedValueOnce(new Error('registration failed'));

    const result = await session.approveSummary(session.getPendingSummary()!.revision);

    expect(result.kind).toBe('error');
  });

  it('rejects duplicate approval while the registration is still pending', async () => {
    const { session, register } = fixture();
    await session.handleUserMessage({ text: 'CSV出力' });
    const revision = session.getPendingSummary()!.revision;
    let finish!: (value: Goal) => void;
    register.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const first = session.approveSummary(revision);
    let closed = false;
    let closing: Promise<void> | undefined;

    try {
      await vi.waitFor(() => expect(register).toHaveBeenCalledTimes(1));
      expect((await session.approveSummary(revision)).kind).toBe('error');
      expect(register).toHaveBeenCalledTimes(1);
      closing = session.close().then(() => { closed = true; });
      expect(closed).toBe(false);
    } finally {
      finish({ ...goalRecord(), ...summaryA, id: register.mock.calls[0]![0].id });
      await first;
      await (closing ?? session.close());
      expect(closed).toBe(true);
    }
  });
});

it.each(['response', 'throw', 'startup'] as const)('returns registration and the failed initial turn together and permits retry: %s', async (failure) => {
  const { session, register } = fixture();
  await session.handleUserMessage({ text: 'CSV出力' });
  const error = 'injected initial turn failure';
  if (failure === 'response') doubles.call.mockResolvedValueOnce({ persona: 'manager', status: 'error', content: '', timestamp: new Date(), error });
  if (failure === 'throw') doubles.call.mockRejectedValueOnce(new Error(error));
  if (failure === 'startup') {
    const { ensureManagerRun } = await import('../features/manager/autoRun.js');
    vi.mocked(ensureManagerRun).mockRejectedValueOnce(new Error(error));
  }
  const result = await session.approveSummary(session.getPendingSummary()!.revision);
  expect(result).toMatchObject({ kind: 'goal_registered', goal: summaryA, turn: { kind: 'error', message: error } });
  expect(register).toHaveBeenCalledOnce();
  expect(session.getPendingSummary()).toBeNull();
  doubles.call.mockResolvedValueOnce(response(null, 'retry complete'));
  expect(await session.handleUserMessage({ text: '登録済みゴールの作業投入を再試行してください' })).toEqual({ kind: 'reply', message: 'retry complete' });
  expect(register).toHaveBeenCalledOnce();
  await session.close();
});

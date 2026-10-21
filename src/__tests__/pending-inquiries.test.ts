import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listPendingInquiries } from '../infra/goals/pending-inquiries.js';
import { GoalQuestionSchema, type Goal, type GoalQuestion } from '../infra/goals/schema.js';
import { goalRecord } from './helpers/goal-fixtures.js';

const doubles = vi.hoisted(() => ({ goals: vi.fn(), standalone: vi.fn() }));
vi.mock('../infra/goals/store.js', () => ({ GoalStore: class {
  constructor(private readonly cwd: string) {}
  list(project?: (goal: Goal) => unknown) { return doubles.goals(this.cwd, project); }
} }));
vi.mock('../infra/goals/standalone-inquiries.js', () => ({ StandaloneInquiryStore: class {
  constructor(private readonly config: string, private readonly owner: unknown) {}
  listPending() { return doubles.standalone(this.config, this.owner); }
} }));

const config = '/isolated-config';
const workspace = { kind: 'workspace' as const, workspaceId: '750e8400-e29b-41d4-a716-446655440001',
  repositoryDirectories: ['/repos/a', '/repos/b'] };
const repository = { kind: 'repository' as const, repositoryDirectory: '/repos/a', repositoryDirectories: ['/repos/a'] };
const firstId = '650e8400-e29b-41d4-a716-446655440001';
const secondId = '650e8400-e29b-41d4-a716-446655440002';
const thirdId = '650e8400-e29b-41d4-a716-446655440003';
const firstGoalId = goalRecord().id;
const secondGoalId = '550e8400-e29b-41d4-a716-446655440001';
const now = '2026-10-19T01:00:00.000Z';
let savedGoals: Map<string, Goal[]>;
let standalone: GoalQuestion[];

function question(id: string, overrides: Partial<GoalQuestion>): GoalQuestion {
  return GoalQuestionSchema.parse({ id, body: '確認してください', status: 'pending', recipient: 'human', createdAt: now, ...overrides });
}

beforeEach(() => {
  vi.resetAllMocks();
  savedGoals = new Map();
  standalone = [];
  doubles.goals.mockImplementation(async (cwd: string, project?: (goal: Goal) => unknown) => ({
    goals: (savedGoals.get(cwd) ?? []).flatMap((goal) => {
      const result = project === undefined ? structuredClone(goal) : project(structuredClone(goal));
      return result === undefined ? [] : [result];
    }), errors: [],
  }));
  doubles.standalone.mockImplementation(async () => structuredClone(standalone.filter((entry) => entry.status === 'pending')));
});

describe('pending inquiry collection', () => {
  it('combines every assigned repository with workspace inquiries and keeps their provenance', async () => {
    const first = question(firstId, { kind: 'question' });
    const second = question(secondId, { kind: 'operation_request' });
    const unowned = question(thirdId, { kind: 'operation_request' });
    savedGoals.set('/repos/a', [{ ...goalRecord(), objective: '最初の目的', questions: [first] }]);
    savedGoals.set('/repos/b', [{ ...goalRecord(), id: secondGoalId, objective: '別の目的', executionStatus: 'aborted', questions: [second] }]);
    savedGoals.set('/repos/outside', [{ ...goalRecord(), questions: [unowned] }]);
    const free = question('650e8400-e29b-41d4-a716-446655440004', { body: 'ゴールなしの相談' });
    standalone = [free];

    const result = await listPendingInquiries(config, workspace);

    expect(result.errors).toEqual([]);
    expect(result.inquiries).toHaveLength(3);
    expect(result.inquiries).toEqual(expect.arrayContaining([
      expect.objectContaining({ goalId: firstGoalId, repositoryDirectory: '/repos/a', objective: '最初の目的', kind: 'question', question: first, summary: first.body }),
      expect.objectContaining({ goalId: secondGoalId, repositoryDirectory: '/repos/b', objective: '別の目的', kind: 'operation_request', question: second, summary: second.body }),
      expect.objectContaining({ goalId: null, kind: 'question', question: free, summary: free.body }),
    ]));
    expect(result.inquiries.map((entry: { question: GoalQuestion }) => entry.question.id)).not.toContain(unowned.id);
    expect(doubles.standalone).toHaveBeenCalledWith(config, expect.objectContaining({ kind: 'workspace', workspaceId: workspace.workspaceId }));
    const reduced = await listPendingInquiries(config, { ...workspace, repositoryDirectories: ['/repos/a'] });
    expect(reduced.inquiries.map((entry) => entry.question.id).sort()).toEqual([first.id, free.id].sort());
  });

  it('uses repository ownership for a single-repository collection', async () => {
    const local = question(firstId, {});
    const outside = question(secondId, {});
    savedGoals.set('/repos/a', [{ ...goalRecord(), questions: [local] }]);
    savedGoals.set('/repos/b', [{ ...goalRecord(), id: secondGoalId, questions: [outside] }]);
    const free = question(thirdId, {});
    standalone = [free];
    const result = await listPendingInquiries(config, repository);
    expect(result.inquiries.map((entry: { question: GoalQuestion }) => entry.question.id).sort()).toEqual([local.id, free.id].sort());
    expect(doubles.standalone).toHaveBeenCalledWith(config, expect.objectContaining({ kind: 'repository', repositoryDirectory: repository.repositoryDirectory }));
  });

  it('filters answered and withdrawn inquiries at the shared entry for both origins', async () => {
    const pending = question(firstId, {});
    const answered = question(secondId, { status: 'answered', answer: { text: 'JSON', source: 'tui', answeredAt: now } });
    const withdrawn = question(thirdId, { status: 'withdrawn', withdrawalReason: '不要です', withdrawnAt: now });
    savedGoals.set('/repos/a', [{ ...goalRecord(), questions: [answered, pending, withdrawn] }]);
    standalone = [withdrawn, answered, pending];
    const result = await listPendingInquiries(config, repository);
    expect(result.inquiries).toHaveLength(2);
    expect(result.inquiries.map((entry: { goalId: string | null; question: GoalQuestion }) => ({ goalId: entry.goalId, id: entry.question.id })))
      .toEqual(expect.arrayContaining([{ goalId: firstGoalId, id: pending.id }, { goalId: null, id: pending.id }]));
  });

  it('normalizes old missing kinds and returns an empty collection for goals without questions', async () => {
    const legacy: GoalQuestion = { id: firstId, body: '旧形式の質問', recipient: 'human', status: 'pending' };
    savedGoals.set('/repos/a', [goalRecord(), { ...goalRecord(), id: secondGoalId, questions: [legacy] }]);
    const result = await listPendingInquiries(config, repository);
    expect(result.inquiries).toEqual([expect.objectContaining({ goalId: secondGoalId, kind: 'question', summary: legacy.body })]);
    savedGoals.set('/repos/a', [goalRecord()]);
    expect(await listPendingInquiries(config, repository)).toEqual({ inquiries: [], errors: [] });
  });

  it('orders dated inquiries chronologically and resolves missing dates and ties independently of enumeration', async () => {
    const early = question(thirdId, { createdAt: '2026-10-18T01:00:00.000Z' });
    const late = question(secondId, {});
    const missing = question(firstId, { createdAt: undefined });
    const goalA: Goal = { ...goalRecord(), questions: [late, missing] };
    const goalB: Goal = { ...goalRecord(), id: secondGoalId, questions: [early, question(firstId, {})] };
    savedGoals.set('/repos/a', [goalA]);
    savedGoals.set('/repos/b', [goalB]);
    standalone = [question(secondId, {}), question(firstId, {})];
    const first = await listPendingInquiries(config, workspace);
    standalone.reverse();
    savedGoals.set('/repos/a', [{ ...goalA, questions: [...goalA.questions!].reverse() }]);
    savedGoals.set('/repos/b', [{ ...goalB, questions: [...goalB.questions!].reverse() }]);
    const second = await listPendingInquiries(config, { ...workspace, repositoryDirectories: [...workspace.repositoryDirectories].reverse() });
    expect(second).toEqual(first);
    const dated = first.inquiries.filter((entry: { question: GoalQuestion }) => entry.question.createdAt !== undefined);
    expect(dated[0]?.question.id).toBe(early.id);
    const currentGoalB = savedGoals.get('/repos/b')![0]!;
    savedGoals.set('/repos/b', [{ ...currentGoalB, questions: currentGoalB.questions!.map((entry) => entry.id === early.id
      ? { ...entry, createdAt: '2026-10-20T01:00:00.000Z' } : entry) }]);
    const changed = await listPendingInquiries(config, workspace);
    expect(changed.inquiries.findIndex((entry) => entry.question.id === late.id))
      .toBeLessThan(changed.inquiries.findIndex((entry) => entry.question.id === early.id));
  });

  it('summarizes long UTF-8 bodies while preserving the complete inquiry', async () => {
    const body = '相談内容: ' + '問い合わせ'.repeat(10000);
    const full = question(firstId, { body });
    standalone = [full];
    const result = await listPendingInquiries(config, repository);
    const entry = result.inquiries[0]!;
    expect(entry.summary.startsWith('相談内容: ')).toBe(true);
    expect(Buffer.byteLength(entry.summary)).toBeLessThan(Buffer.byteLength(body));
    expect(Buffer.byteLength(entry.summary)).toBeLessThanOrEqual(512);
    expect(entry.summary).not.toContain('\uFFFD');
    expect(entry.question.body).toBe(body);
    expect(standalone).toEqual([full]);
  });

  it('returns individual goal read errors with repository provenance alongside healthy inquiries', async () => {
    const failure = new Error('invalid saved goal');
    const healthy = question(firstId, {});
    doubles.goals.mockResolvedValueOnce({ goals: [], errors: [{ goalId: firstGoalId, error: failure }] });
    savedGoals.set('/repos/b', [{ ...goalRecord(), id: secondGoalId, questions: [healthy] }]);
    const result = await listPendingInquiries(config, workspace);
    expect(result.inquiries).toEqual([expect.objectContaining({ repositoryDirectory: '/repos/b', question: healthy })]);
    expect(result.errors).toEqual([expect.objectContaining({ repositoryDirectory: '/repos/a', goalId: firstGoalId, error: failure })]);
  });

  it.each(['goals', 'standalone'] as const)('propagates whole-storage errors from %s instead of returning a partial successful list', async (source) => {
    const failure = new Error('storage unavailable');
    if (source === 'goals') doubles.goals.mockRejectedValueOnce(failure);
    else doubles.standalone.mockRejectedValueOnce(failure);
    await expect(listPendingInquiries(config, workspace)).rejects.toThrow('storage unavailable');
  });
});

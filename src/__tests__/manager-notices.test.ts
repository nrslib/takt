import { readManagerTestDisplay } from './helpers/manager-display-items.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { iterateManagerDisplayEvents, iterateManagerNotices } from '../features/manager/savedEvents.js';
import { formatGoalNotification } from '../infra/goals/notifications.js';
import type { Goal } from '../infra/goals/schema.js';
import { getLabel } from '../shared/i18n/index.js';
import { goalRecord } from './helpers/goal-fixtures.js';

const storage = vi.hoisted(() => ({ list: vi.fn(), config: vi.fn(), iterate: vi.fn<(_directory: string) => AsyncIterable<Goal>>() }));
vi.mock('../infra/goals/store.js', () => ({ GoalStore: class {
  constructor(private readonly directory: string) {}
  list() { return storage.list(this.directory); }
  iterate() { return storage.iterate(this.directory); }
} }));
vi.mock('../infra/config/managerConfig.js', () => ({ resolveManagerConfig: storage.config }));
vi.mock('../infra/goals/pending-inquiries.js', () => ({
  iteratePendingInquiries: async function* () {},
}));

const policy = { question: true, awaiting_merge: true, completed: true, progress: true, blocked: true, custom: true };
const startedAt = Date.parse('2026-10-24T00:00:00.000Z');
const notice = (index: number, overrides: Partial<NonNullable<Goal['notifications']>[number]> = {}) => ({
  id: `650e8400-e29b-41d4-a716-${String(index).padStart(12, '0')}`,
  kind: 'completed' as const, body: `Saved body ${index}`,
  recordedAt: new Date(startedAt + index).toISOString(), ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  storage.list.mockResolvedValue({ goals: [], errors: [] });
  storage.config.mockReturnValue({ notifications: policy });
  storage.iterate.mockImplementation(async function* (directory) { yield* (await storage.list(directory)).goals; });
});

it.each(['events', 'notices'] as const)('resolves notification policy once per repository for multiple goals (%s)', async (kind) => {
  const repositories = ['/first', '/second'];
  const goals = [1, 2, 3].map((index) => ({ ...goalRecord(),
    id: `550e8400-e29b-41d4-a716-${String(index).padStart(12, '0')}`, workLog: [],
    notifications: [notice(index * 2), notice(index * 2 + 1, { kind: 'custom' })],
  }));
  storage.iterate.mockImplementation(async function* () { yield* goals; });
  storage.config.mockImplementation((directory: string) => ({ notifications: { ...policy, custom: directory === '/first' } }));
  const assignment = { kind: 'workspace' as const, workspaceId: 'fixture', name: 'Both', repositoryDirectories: repositories };
  const source = kind === 'events'
    ? iterateManagerDisplayEvents(assignment, 'en', new Map(), startedAt)
    : iterateManagerNotices(assignment, 'en');
  const ids = [];
  for await (const item of source) ids.push(item.id);
  const expected = repositories.flatMap((directory) => goals.flatMap((goal) => goal.notifications
    .filter((notification) => notification.kind !== 'custom' || directory === '/first')
    .map((notification) => kind === 'events' ? JSON.stringify([goal.id, 'notification', notification.id]) : notification.id)));
  expect(ids.sort()).toEqual(expected.sort());
  expect(storage.config.mock.calls).toEqual(repositories.map((directory) => [directory]));
});

it('projects sequential work logs and enabled notices with exact stable IDs and independent startup boundaries', async () => {
  const record = { id: '850e8400-e29b-41d4-a716-446655440001', summary: 'Old work', recordedAt: new Date(startedAt - 1).toISOString() };
  const goal: Goal = { ...goalRecord(), workLog: [record], notifications: [notice(1), notice(2, { kind: 'question' }), notice(3, { kind: 'custom' })] };
  storage.iterate.mockImplementation(async function* (directory) { if (directory === '/second') yield goal; });
  storage.config.mockReturnValue({ notifications: { ...policy, custom: false } });
  const assignment = { kind: 'workspace' as const, workspaceId: 'fixture', name: 'Both', repositoryDirectories: ['/first', '/second'] };
  const values = [];
  for await (const event of iterateManagerDisplayEvents(assignment, 'en', new Map([['/first', startedAt]]), startedAt + 2)) values.push(event);
  expect(values).toEqual([
    { id: JSON.stringify([goal.id, 'work-log', record.id]), message: goal.id + ': Old work' },
    { id: JSON.stringify([goal.id, 'notification', goal.notifications![0]!.id]),
      message: formatGoalNotification(goal, goal.notifications![0]!, 'en', 'second', 'tui'), suppressInitialDisplay: true },
  ]);
  expect(storage.iterate.mock.calls.map(([directory]) => directory)).toEqual(['/first', '/second']);
  expect(storage.list).not.toHaveBeenCalled();
});

describe.each(['ja', 'en'] as const)('TUI notice formatting in %s', (lang) => {
  it.each(['progress', 'awaiting_merge', 'completed', 'blocked', 'custom'] as const)(
    'keeps exactly three complete body lines and an omission hint without retired keys for %s', (kind) => {
      const body = ['first ' + 'e\u0301'.repeat(701) + '  ', '', 'third line  ', 'fourth line', 'fifth line'].join('\n');
      const goal = goalRecord();
      const lines = formatGoalNotification(goal, { kind, body, severity: 'warning' }, lang, 'fixture', 'tui').split('\n');

      expect(lines.slice(0, 3)).toEqual([
        getLabel(`manager.notificationHeadings.${kind}`, lang, { project: 'fixture' }),
        getLabel('manager.notificationGoal', lang, { objective: goal.objective, id: goal.id.slice(0, 8) }),
        getLabel('manager.notificationSeverity', lang, { severity: getLabel('manager.notificationSeverities.warning', lang) }),
      ]);
      expect(lines.slice(3, 6)).toEqual(body.split('\n').slice(0, 3));
      expect(lines[6]).not.toMatch(/Ctrl\+N|\^N/u);
      expect(lines[6]).toMatch(lang === 'ja' ? /省略/u : /omitted/iu);
      expect(lines.slice(7)).toEqual(kind === 'blocked'
        ? [getLabel('manager.notificationBlockedAction', lang, { project: 'fixture' })] : []);
    },
  );

  it.each([1, 2, 3])('keeps a %i-line body without a truncation hint or character limit', (count) => {
    const body = ['e\u0301'.repeat(7000) + '  ', 'second', 'third'].slice(0, count).join('\n');
    const lines = formatGoalNotification(goalRecord(), { kind: 'completed', body }, lang, 'fixture', 'tui').split('\n');
    expect(lines.slice(2).join('\n')).toBe(body);
  });

  it('takes the digest from completion and keeps every merge instruction after it', () => {
    const summary = ['first summary', 'second summary', 'third summary', 'hidden summary'].join('\n');
    const command = "git -C '/Users/nrs/work/git/takt3' merge --no-ff --no-edit b89dc7274403152da8933cda80a76a4751c7901d";
    const instructions = ["git -C '/Users/nrs/work/git/takt3' status --short", command, 'x'.repeat(800)];
    const goal: Goal = { ...goalRecord(), completion: {
      goalBranch: goalRecord().branch, goalSha: 'a'.repeat(40), targetBranch: 'main', summary,
      worktrees: ['/Users/nrs/work/git/takt3'], instructions,
      changeSummary: { filesChanged: 0, additions: 0, deletions: 0, files: [], truncated: false, totalsTruncated: false },
    } };

    const lines = formatGoalNotification(goal, { kind: 'awaiting_merge', body: 'Unused notification body' }, lang, 'fixture', 'tui').split('\n');

    expect(lines.slice(2, 5)).toEqual(summary.split('\n').slice(0, 3));
    expect(lines[5]).toMatch(lang === 'ja' ? /省略/u : /omitted/iu);
    expect(lines[5]).not.toMatch(/Ctrl\+N|\^N/u);
    expect(lines.slice(6, 8)).toEqual([
      getLabel('manager.notificationMerge', lang, { branch: 'main' }),
      getLabel('manager.notificationMergeWorktree', lang, { directory: '/Users/nrs/work/git/takt3' }),
    ]);
    expect(lines.slice(8)).toEqual(instructions);
  });

  it('leaves Slack multiline text and its existing character limit unchanged', () => {
    const body = ['one', 'two', 'three', 'four', 'five'].join('\n');
    for (const destination of [undefined, 'slack'] as const) {
      expect(formatGoalNotification(goalRecord(), { kind: 'completed', body }, lang, 'fixture', destination).split('\n').slice(2).join('\n')).toBe(body);
      const lines = formatGoalNotification(goalRecord(), { kind: 'custom', body: 'x'.repeat(601) }, lang, 'fixture', destination).split('\n');
      expect(lines.slice(2)).toEqual(['x'.repeat(599) + '…', getLabel('manager.notificationFullMessage', lang, { project: 'fixture' })]);
    }
  });

  it('keeps an unmatched question notification on the existing formatting path', () => {
    const body = 'one\ntwo\nthree\nfour';
    expect(formatGoalNotification(goalRecord(), { kind: 'question', body }, lang, 'fixture', 'tui').split('\n').slice(2).join('\n')).toBe(body);
  });
});

describe('saved manager notices', () => {
  it('applies the notification startup time to added repositories without changing work-log boundaries', async () => {
    const notification = notice(1, { recordedAt: new Date(startedAt - 1).toISOString() });
    const record = { id: '850e8400-e29b-41d4-a716-446655440001', recordedAt: notification.recordedAt, summary: 'Old work record' };
    const goal: Goal = { ...goalRecord(), workLog: [record], notifications: [notification] };
    const original = structuredClone(goal);
    storage.list.mockImplementation(async (directory: string) => ({ goals: directory === '/second' ? [goal] : [], errors: [] }));
    const assignment = { kind: 'workspace' as const, workspaceId: 'fixture', name: 'A + B', repositoryDirectories: ['/first', '/second'] };
    const boundaries = new Map([['/first', startedAt]]);

    const added = await readManagerTestDisplay('/first', 'en', assignment, boundaries, startedAt);
    expect(added.events).toEqual([
      { id: JSON.stringify([goal.id, 'work-log', record.id]), message: `${goal.id}: ${record.summary}` },
      { id: JSON.stringify([goal.id, 'notification', notification.id]),
        message: formatGoalNotification(goal, notification, 'en', 'second', 'tui'), suppressInitialDisplay: true },
    ]);
    expect(added.notices).toEqual([{ id: notification.id, repositoryDirectory: '/second', project: 'second',
      goalId: goal.id, objective: goal.objective, kind: notification.kind, recordedAt: notification.recordedAt,
      message: formatGoalNotification(goal, notification, 'en', 'second', 'tui', 'full') }]);

    const initial = await readManagerTestDisplay('/first', 'en', assignment, new Map([...boundaries, ['/second', startedAt]]), startedAt);
    expect(initial.events).toEqual(added.events.map((event) => ({ ...event, suppressInitialDisplay: true })));
    expect(initial.notices).toEqual(added.notices);
    expect(goal).toEqual(original);
  });

  it('suppresses only records before the repository startup boundary without discarding history', async () => {
    const notifications = [-1, 0, 1].map((index) => notice(index + 2, { recordedAt: new Date(startedAt + index).toISOString() }));
    const goal: Goal = { ...goalRecord(), notifications };
    const before = structuredClone(goal);
    storage.list.mockResolvedValue({ goals: [goal], errors: [] });

    const result = await readManagerTestDisplay('/fixture', 'en', undefined, new Map([['/fixture', startedAt]]), startedAt);

    expect(result.events.map((event) => event.suppressInitialDisplay)).toEqual([true, undefined, undefined]);
    expect(result).toMatchObject({ notices: [...notifications].reverse().map((notification) => ({
      goalId: goal.id, objective: goal.objective, kind: notification.kind, recordedAt: notification.recordedAt,
    })) });
    expect(goal).toEqual(before);
    const unbounded = await readManagerTestDisplay('/fixture', 'en');
    expect(unbounded.events.map((event) => event.suppressInitialDisplay)).toEqual([undefined, undefined, undefined]);
  });

  it('collects enabled non-question notices from every repository in descending recorded order', async () => {
    const first: Goal = { ...goalRecord(), notifications: [
      notice(1), notice(4, { kind: 'custom' }), notice(8, { kind: 'question' }),
    ] };
    const second: Goal = { ...goalRecord(), id: '550e8400-e29b-41d4-a716-446655440001', notifications: [
      notice(3, { kind: 'blocked' }), notice(2), notice(7, { kind: 'custom' }),
    ] };
    storage.list.mockImplementation(async (directory: string) => ({ goals: [directory === '/first' ? first : second], errors: [] }));
    storage.config.mockImplementation((directory: string) => ({ notifications: { ...policy, custom: directory === '/first' } }));
    const before = structuredClone([first, second]);

    const result = await readManagerTestDisplay('/first', 'en', {
      kind: 'workspace', workspaceId: 'fixture', name: 'Workspace', repositoryDirectories: ['/first', '/second'],
    }, new Map([['/first', startedAt + 100]]), startedAt + 100);

    const expected = [[first, first.notifications![1]!], [second, second.notifications![0]!],
      [second, second.notifications![1]!], [first, first.notifications![0]!]] as const;
    expect(result).toMatchObject({ notices: expected.map(([goal, notification]) => ({
      goalId: goal.id, objective: goal.objective, kind: notification.kind, recordedAt: notification.recordedAt,
    })) });
    expect(result.events.map((event) => JSON.parse(event.id)[2]).sort()).toEqual(expected.map(([, notification]) => notification.id).sort());
    expect(result.events.filter((event) => event.suppressInitialDisplay)).toHaveLength(4);
    expect([first, second]).toEqual(before);
  });

  it.each(['progress', 'completed', 'awaiting_merge', 'blocked', 'custom'] as const)('returns the complete 7000-character %s body for detail instead of its digest', async (kind) => {
    const body = ['first', 'second', 'third', 'tail ' + 'x'.repeat(6971), 'last'].join('\n');
    expect(body).toHaveLength(7000);
    const notification = notice(1, { kind, body: kind === 'awaiting_merge' ? 'Unused body' : body });
    const goal: Goal = { ...goalRecord(), notifications: [notification], ...(kind !== 'awaiting_merge' ? {} : { completion: {
      goalBranch: goalRecord().branch, goalSha: 'a'.repeat(40), targetBranch: 'main', summary: body,
      instructions: ['Run in this repository', 'git merge reviewed-sha'],
      changeSummary: { filesChanged: 0, additions: 0, deletions: 0, files: [], truncated: false, totalsTruncated: false },
    } }) };
    const before = structuredClone(goal);
    storage.list.mockResolvedValue({ goals: [goal], errors: [] });

    const result = await readManagerTestDisplay('/fixture', 'en');
    const prefix = [getLabel(`manager.notificationHeadings.${kind}`, 'en', { project: 'fixture' }),
      getLabel('manager.notificationGoal', 'en', { objective: goal.objective, id: goal.id.slice(0, 8) }), body];
    if (kind === 'blocked') prefix.push(getLabel('manager.notificationBlockedAction', 'en', { project: 'fixture' }));
    if (kind === 'awaiting_merge') prefix.push(getLabel('manager.notificationMerge', 'en', { branch: 'main' }),
      getLabel('manager.notificationMergeRepository', 'en', { project: 'fixture' }), 'git merge reviewed-sha');
    expect(result).toMatchObject({ notices: [{ goalId: goal.id, message: prefix.join('\n') }] });
    expect(result.events[0]!.message.split('\n').slice(2, 5)).toEqual(['first', 'second', 'third']);
    expect(goal).toEqual(before);
  });
});

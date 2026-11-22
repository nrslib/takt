import { beforeEach, expect, it, vi } from 'vitest';
import { directorInquiryProjection } from '../features/daemon/conversationProjection.js';
import { DaemonRouting } from '../features/daemon/routing.js';
import { DaemonDisplayFiles } from '../infra/daemon/displayFiles.js';
import { GoalSchema } from '../infra/goals/schema.js';
import { goalRecord } from './helpers/goal-fixtures.js';
import type { SnapshotItem } from '../features/manager/conversationPort.js';
const io = vi.hoisted(() => ({ entries: vi.fn<typeof import('../features/daemon/watchers/files.js').listWatchEntries>(),
  configuration: vi.fn(), tasks: vi.fn<typeof import('../features/daemon/watchers/state.js').readWatchTasks>() }));
vi.mock('../features/daemon/watchers/files.js', async original => ({
  ...await original<typeof import('../features/daemon/watchers/files.js')>(), listWatchEntries: io.entries,
}));
vi.mock('../features/daemon/configuration.js', async original => ({
  ...await original<typeof import('../features/daemon/configuration.js')>(),
  globalDaemonConfiguration: io.configuration, readDaemonConfiguration: io.configuration,
}));
vi.mock('../features/daemon/watchers/state.js', async original => ({
  ...await original<typeof import('../features/daemon/watchers/state.js')>(), readWatchTasks: io.tasks,
}));
beforeEach(() => { vi.restoreAllMocks(); vi.resetAllMocks(); io.configuration.mockResolvedValue({ language: 'en' }); io.tasks.mockResolvedValue([]); });
function fixture(recipient: 'human' | 'director') {
  const goals = [
    { repositoryDirectory: '/first', goal: GoalSchema.parse({ ...goalRecord(), questionRoute: 'director', questions: [
      { id: '650e8400-e29b-41d4-a716-446655440001', body: 'First permission?', questionType: 'permission', recipient, status: 'pending' },
      { id: '650e8400-e29b-41d4-a716-446655440002', body: 'First approach?', questionType: 'routine', recipient: 'director', status: 'pending' },
    ] }) },
    { repositoryDirectory: '/second', goal: GoalSchema.parse({ ...goalRecord(), id: '550e8400-e29b-41d4-a716-446655440001', questionRoute: 'director', questions: [
      { id: '650e8400-e29b-41d4-a716-446655440003', body: 'Second permission?', questionType: 'permission', recipient, status: 'pending' },
      { id: '650e8400-e29b-41d4-a716-446655440004', body: 'Second approach?', questionType: 'routine', recipient: 'director', status: 'pending' },
    ] }) },
  ];
  const routing = new DaemonRouting('/config');
  vi.spyOn(routing, 'routes').mockResolvedValue(['/first', '/second'].map(repositoryDirectory => ({ repositoryDirectory, workspaceId: null })));
  vi.spyOn(routing, 'display').mockImplementation(async identity => {
    if (identity.kind !== 'repository') throw new Error('Repository expected');
    return { ...identity, repositoryDirectories: [identity.repositoryDirectory] };
  });
  io.entries.mockImplementation(async (path: string) => goals.filter(({ repositoryDirectory }) => path === `${repositoryDirectory}/.takt/goals`)
    .map(({ goal }) => ({ name: goal.id, parentPath: path, path,
      isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false, isBlockDevice: () => false,
      isCharacterDevice: () => false, isFIFO: () => false, isSocket: () => false })));
  const files = new DaemonDisplayFiles();
  const read = vi.spyOn(files, 'goal').mockImplementation(async path => {
    const record = goals.find(({ repositoryDirectory, goal }) => path === `${repositoryDirectory}/.takt/goals/${goal.id}/goal.json`);
    if (record === undefined) throw new Error('Unknown goal path');
    return record.goal;
  });
  return { routing, files, read };
}
it('projects human questions from each manager repository without mixing in director questions', async () => {
  const { routing, files } = fixture('human');
  const items: SnapshotItem[] = [];
  for await (const item of directorInquiryProjection(routing, files)) items.push(item);
  expect(items).toEqual([
    expect.objectContaining({ kind: 'inquiry', inquiry: expect.objectContaining({
      target: { repositoryDirectory: '/first', goalId: '550e8400-e29b-41d4-a716-446655440000' },
      question: expect.objectContaining({ id: '650e8400-e29b-41d4-a716-446655440001', body: 'First permission?', recipient: 'human' }),
    }) }),
    expect.objectContaining({ kind: 'inquiry', inquiry: expect.objectContaining({
      target: { repositoryDirectory: '/second', goalId: '550e8400-e29b-41d4-a716-446655440001' },
      question: expect.objectContaining({ id: '650e8400-e29b-41d4-a716-446655440003', body: 'Second permission?', recipient: 'human' }),
    }) }),
  ]);
});
it('excludes the same questions when they are addressed to the director', async () => {
  const { routing, files } = fixture('director');
  const items: SnapshotItem[] = [];
  for await (const item of directorInquiryProjection(routing, files)) items.push(item);
  expect(items).toEqual([]);
});
it('keeps readable questions and a diagnostic while reporting the combined read failure', async () => {
  const { routing, files, read } = fixture('human');
  read.mockRejectedValueOnce(new Error('bad goal data'));
  const items: SnapshotItem[] = [];
  await expect((async () => { for await (const item of directorInquiryProjection(routing, files)) items.push(item); })()).rejects.toThrow();
  expect(items).toContainEqual(expect.objectContaining({ kind: 'display_event', event: expect.objectContaining({ message: expect.stringContaining('/first') }) }));
  expect(items).toContainEqual(expect.objectContaining({ kind: 'inquiry', inquiry: expect.objectContaining({ target: {
    repositoryDirectory: '/second', goalId: '550e8400-e29b-41d4-a716-446655440001',
  }, question: expect.objectContaining({ id: '650e8400-e29b-41d4-a716-446655440003', body: 'Second permission?' }) }) }));
});

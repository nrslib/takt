import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { enqueueDueGoalPatrols } from '../features/manager/patrol.js';
import { createRunEventManager } from '../features/manager/runEventManager.js';
import { readManagerEvents, saveManagerEvent } from '../infra/goals/events.js';
import { GoalStore } from '../infra/goals/store.js';
import { invalidateGlobalConfigCache } from '../infra/config/global/globalConfig.js';
import { MockProvider } from '../infra/providers/mock.js';
import { resetScenario, setMockScenario } from '../infra/mock/index.js';
import { goalRecord } from './helpers/goal-fixtures.js';

vi.mock('../features/manager/managerMcp.js', async (original) => ({
  ...await original<typeof import('../features/manager/managerMcp.js')>(),
  connectManagerMcp: async () => ({ servers: {}, dispose: async () => {} }),
}));
vi.mock('../features/manager/conversationPlan.js', () => ({
  createManagerConversationPlan: () => ({
    ctx: { provider: new MockProvider(), providerType: 'mock', lang: 'ja' },
    strategy: { systemPrompt: 'manager patrol fixture', allowedTools: ['Read'] },
  }),
}));

let root: string;
let cwd: string;
let manager: ReturnType<typeof createRunEventManager>;
beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'takt-patrol-')));
  cwd = join(root, 'project');
  mkdirSync(join(cwd, '.takt'), { recursive: true });
  vi.stubEnv('TAKT_CONFIG_DIR', join(root, 'global'));
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-14T01:00:00Z');
  writeFileSync(join(cwd, '.takt', 'config.yaml'), 'provider: mock\nmanager:\n  patrol_interval: 1800\n');
  invalidateGlobalConfigCache();
  await new GoalStore(cwd).create({ ...goalRecord(), createdAt: '2026-10-14T00:00:00Z' });
  manager = createRunEventManager(cwd);
});
afterEach(async () => {
  await manager.close(); resetScenario(); invalidateGlobalConfigCache();
  vi.useRealTimers(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true });
});
const signal = new AbortController().signal;
function reply(message: string) {
  const structuredOutput = { message, summary: null };
  return { status: 'done' as const, content: JSON.stringify(structuredOutput), structuredOutput };
}

it('persists successful patrols and schedules the next one from the saved completion time after reopening', async () => {
  await enqueueDueGoalPatrols(cwd, 1800); await enqueueDueGoalPatrols(cwd, 1800);
  expect(readManagerEvents(cwd)).toHaveLength(1);
  setMockScenario([reply('点検を終えました')]);
  await manager.processPending(signal, 10);
  expect(readManagerEvents(cwd)).toEqual([]);
  const saved = await new GoalStore(cwd).get(goalRecord().id);
  expect(saved.lastPatrolCompletedAt).toBe('2026-10-14T01:00:00.000Z');
  expect(saved.workLog).toEqual([expect.objectContaining({ kind: 'patrol' })]);
  await manager.close(); manager = createRunEventManager(cwd);
  vi.setSystemTime('2026-10-14T01:29:59Z'); await enqueueDueGoalPatrols(cwd, 1800);
  expect(readManagerEvents(cwd)).toEqual([]);
  vi.setSystemTime('2026-10-14T01:30:00Z'); await enqueueDueGoalPatrols(cwd, 1800);
  expect(readManagerEvents(cwd)).toEqual([expect.objectContaining({ event: expect.objectContaining({ kind: 'patrol' }) })]);
});

it('retries retained ordinary failures during patrol and persists failed patrol timing and blocked notification', async () => {
  saveManagerEvent(cwd, { kind: 'registered', goalId: goalRecord().id });
  setMockScenario([{ status: 'error', content: '', error: 'registration failed' }]);
  await manager.processPending(signal, 10);
  expect(readManagerEvents(cwd)).toHaveLength(1);
  setMockScenario([reply('登録を処理しました'), { status: 'error', content: '', error: 'patrol failed' }]);
  await manager.processPending(signal, 10);
  expect(readManagerEvents(cwd)).toHaveLength(1);
  await enqueueDueGoalPatrols(cwd, 1800);
  await manager.processPending(signal, 10);
  expect(readManagerEvents(cwd)).toEqual([]);
  const saved = await new GoalStore(cwd).get(goalRecord().id);
  expect(saved.lastPatrolCompletedAt).toBe('2026-10-14T01:00:00.000Z');
  expect(saved.notifications?.map((notification) => notification.kind)).toEqual(['blocked', 'blocked']);
  expect(saved.workLog).toEqual([expect.objectContaining({ summary: '登録を処理しました' })]);
  vi.setSystemTime('2026-10-14T01:29:59Z'); await enqueueDueGoalPatrols(cwd, 1800);
  expect(readManagerEvents(cwd)).toEqual([]);
});

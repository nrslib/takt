import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { notifyManagerTurnFailure } from '../features/manager/turnFailureNotification.js';
import { notifyTaktGoal } from '../features/mcp/goalNotificationOperations.js';
import { invalidateGlobalConfigCache } from '../infra/config/global/globalConfig.js';
import { GoalStore } from '../infra/goals/store.js';
import { getLabel } from '../shared/i18n/index.js';
import { goalRecord } from './helpers/goal-fixtures.js';

const webhookUrl = 'https://example.test/notify';
const reason = 'failed <@U012AB3CD> <!channel> <!here> <!everyone> <!subteam^S0123|team> <https://example.test/path?q=1&x=2|details>';
let cwd: string;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  cwd = realpathSync(mkdtempSync(join(tmpdir(), 'takt-failure-webhook-')));
  mkdirSync(join(cwd, '.takt'));
  vi.stubEnv('TAKT_NOTIFY_WEBHOOK', webhookUrl);
  fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('ok'));
  vi.stubGlobal('fetch', fetchMock);
  invalidateGlobalConfigCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  invalidateGlobalConfigCache();
  rmSync(cwd, { recursive: true, force: true });
});

it.each([
  { language: 'ja', withGoal: true }, { language: 'en', withGoal: true },
  { language: 'ja', withGoal: false }, { language: 'en', withGoal: false },
])('escapes failure mentions in the $language webhook payload while retaining links (goal=$withGoal)', async ({ language, withGoal }) => {
  writeFileSync(join(cwd, '.takt', 'config.yaml'), `language: ${language}\nmanager:\n  notifications:\n    blocked: true\n`);
  const store = new GoalStore(cwd);
  const goal = goalRecord();
  if (withGoal) await store.create(goal);

  const notice = await notifyManagerTurnFailure(cwd, withGoal ? goal.id : undefined, new Error(reason));

  expect(fetchMock).toHaveBeenCalledExactlyOnceWith(webhookUrl, expect.objectContaining({ method: 'POST' }));
  const request = fetchMock.mock.calls[0]![1]!;
  const payload = JSON.parse(request.body as string) as { text: string };
  expect(payload.text).not.toMatch(/<[@!]/u);
  for (const mention of ['@U012AB3CD', '!channel', '!here', '!everyone', '!subteam^S0123|team']) {
    expect(payload.text).toContain(`&lt;${mention}>`);
  }
  expect(payload.text).toContain('<https://example.test/path?q=1&x=2|details>');
  expect(payload.text.replace(/&lt;/gu, '<')).toContain(reason);
  if (withGoal) {
    const saved = await store.get(goal.id);
    expect(saved.notifications).toHaveLength(1);
    expect(saved.notifications![0]).toMatchObject({ kind: 'blocked', severity: 'error', source: 'manager_turn_failure' });
    expect(saved.notifications![0]!.body).toContain(reason);
    expect(notice).toBeUndefined();
  } else {
    expect(notice).toContain(reason);
    expect(await store.list()).toEqual({ goals: [], errors: [] });
  }
});

it.each(['ja', 'en'] as const)('preserves mentions after the %s turn failure prefix in an ordinary MCP blocked error', async (language) => {
  writeFileSync(join(cwd, '.takt', 'config.yaml'), `language: ${language}\nmanager:\n  notifications:\n    blocked: true\n`);
  const store = new GoalStore(cwd);
  const goal = goalRecord();
  await store.create(goal);
  const prefix = getLabel('manager.turnFailureNotification', language).split('\n')[0]!;
  const body = `${prefix}\n${reason}`;

  const result = await notifyTaktGoal({ cwd, goalId: goal.id, kind: 'blocked', severity: 'error', body }, {}, new AbortController().signal);

  expect(result.isError).toBeUndefined();
  expect(fetchMock).toHaveBeenCalledExactlyOnceWith(webhookUrl, expect.objectContaining({ method: 'POST' }));
  const payload = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string) as { text: string };
  expect(payload.text).toContain(body);
  expect(payload.text).not.toContain('&lt;');
  const saved = await store.get(goal.id);
  expect(saved.notifications).toHaveLength(1);
  expect(saved.notifications![0]!.body).toBe(body);
  expect(saved.notifications![0]!.source).toBeUndefined();
});

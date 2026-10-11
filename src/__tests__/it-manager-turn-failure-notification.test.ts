import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { processGoalAnswers, processGoalCompletions, recoverManagerEvents } from '../features/manager/completionTurn.js';
import { readManagerDisplayEvents } from '../features/manager/savedEvents.js';
import { invalidateGlobalConfigCache } from '../infra/config/global/globalConfig.js';
import { invalidateResolvedConfigCache } from '../infra/config/resolveConfigValue.js';
import { formatGoalNotification } from '../infra/goals/notifications.js';
import type { Goal } from '../infra/goals/schema.js';
import { GoalStore } from '../infra/goals/store.js';
import { getScenarioQueue, setMockScenario } from '../infra/mock/scenario.js';
import { readManagerRunFailures } from '../infra/task/manager-run-state.js';
import { sanitizeSensitiveText } from '../shared/utils/sensitiveText.js';
import { WEBHOOK_ENV_KEY } from '../shared/utils/slackWebhook.js';
import { goalId, goalRecord } from './helpers/goal-fixtures.js';

let cwd: string;
let store: GoalStore;
const fetchDouble = vi.fn<typeof fetch>();

function configure(language: 'ja' | 'en', blocked: boolean): void {
  writeFileSync(join(cwd, '.takt', 'config.yaml'), [
    'provider: mock', `language: ${language}`, 'manager:', '  auto_run: false',
    '  notifications:', `    blocked: ${blocked}`,
  ].join('\n'));
  invalidateGlobalConfigCache();
  invalidateResolvedConfigCache(cwd);
}

function completion(id: string): NonNullable<Goal['events']>[number] {
  return { id, kind: 'completion', taskName: `task-${id}`, runSlug: `run-${id}`,
    processed: false, result: { success: true, interrupted: false, sha: 'a'.repeat(40) } };
}

async function fail(reason: string, id: string): Promise<void> {
  setMockScenario([{ persona: 'manager', status: 'error', content: '', error: reason, mcpToolCalls: [] }]);
  await processGoalCompletions(cwd, id);
  expect(getScenarioQueue()!.remaining).toBe(0);
  expect(readManagerRunFailures(cwd)).toContainEqual(expect.objectContaining({ message: sanitizeSensitiveText(reason) }));
}

function sentTexts(): string[] {
  return fetchDouble.mock.calls.map(([, init]) => {
    if (typeof init?.body !== 'string') throw new Error('Expected a JSON webhook body');
    return (JSON.parse(init.body) as { text: string }).text;
  });
}

beforeEach(async () => {
  const root = join(process.cwd(), '.tmp');
  mkdirSync(root, { recursive: true });
  cwd = realpathSync(mkdtempSync(join(root, 'manager-turn-failure-')));
  mkdirSync(join(cwd, '.takt'));
  configure('en', true);
  store = new GoalStore(cwd);
  await store.create({ ...goalRecord(), events: [completion('event-a')] });
  fetchDouble.mockReset().mockResolvedValue(new Response('ok'));
  vi.stubGlobal('fetch', fetchDouble);
  vi.stubEnv(WEBHOOK_ENV_KEY, 'https://example.test/manager-notifications');
});

afterEach(() => {
  setMockScenario(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  invalidateGlobalConfigCache();
  invalidateResolvedConfigCache(cwd);
  rmSync(cwd, { recursive: true, force: true });
});

describe('manager turn failure notifications', () => {
  it.each(['completion', 'answer'] as const)('saves one blocked notification for a failed %s and delivers it through saved events and Slack', async (kind) => {
    if (kind === 'answer') {
      await store.update(goalId, (goal) => ({ ...goal, events: [{ id: 'answer-a', kind: 'answer', processed: false,
        questionId: '650e8400-e29b-41d4-a716-446655440001',
        answer: { text: 'JSON', source: 'tui', answeredAt: '2026-10-08T00:00:00Z' } }] }));
    }
    const original = (await store.get(goalId)).events;
    setMockScenario([{ persona: 'manager', status: 'error', content: '', error: 'provider capacity exhausted', mcpToolCalls: [] }]);

    if (kind === 'answer') await processGoalAnswers(cwd, goalId, {});
    else await processGoalCompletions(cwd, goalId);

    expect(getScenarioQueue()!.remaining).toBe(0);
    const saved = await store.get(goalId);
    expect(saved.events).toEqual(original);
    expect(saved.notifications).toHaveLength(1);
    const notification = saved.notifications![0]!;
    expect(notification).toMatchObject({ kind: 'blocked' });
    const formatted = formatGoalNotification(saved, notification);
    expect((await readManagerDisplayEvents(cwd)).events).toContainEqual({
      id: JSON.stringify([goalId, 'notification', notification.id]), message: formatted,
    });
    expect(fetchDouble).toHaveBeenCalledOnce();
    expect(fetchDouble.mock.calls[0]![0]).toBe('https://example.test/manager-notifications');
    expect(fetchDouble.mock.calls[0]![1]?.method).toBe('POST');
    expect(sentTexts()).toEqual([formatted]);
    expect(readManagerRunFailures(cwd)).toContainEqual(expect.objectContaining({ message: 'provider capacity exhausted' }));
  });

  it('suppresses repeated failures, recovers the same event, and notifies again after success without deleting history', async () => {
    const original = (await store.get(goalId)).events;
    await fail('capacity exhausted', goalId);
    const notices = (await store.get(goalId)).notifications;
    expect(notices).toHaveLength(1);
    await fail('capacity exhausted', goalId);
    expect((await store.get(goalId)).notifications).toEqual(notices);
    expect((await store.get(goalId)).events).toEqual(original);
    expect(fetchDouble).toHaveBeenCalledOnce();
    setMockScenario([{ persona: 'manager', status: 'done', content: '', mcpToolCalls: [],
      structuredOutput: { message: 'recovered summary', summary: null } }]);

    await recoverManagerEvents(cwd);

    expect(getScenarioQueue()!.remaining).toBe(0);
    expect((await store.get(goalId)).events).toEqual([expect.objectContaining({
      id: 'event-a', processed: true, summary: 'recovered summary',
    })]);
    expect((await store.get(goalId)).notifications).toEqual(notices);
    await store.update(goalId, (goal) => ({ ...goal, events: [...goal.events!, completion('event-b')] }));
    await fail('capacity exhausted', goalId);
    const saved = await store.get(goalId);
    expect(saved.notifications).toHaveLength(2);
    expect(saved.notifications![0]).toEqual(notices![0]);
    expect(saved.notifications![1]!.id).not.toBe(notices![0]!.id);
    expect(saved.events).toEqual([
      expect.objectContaining({ id: 'event-a', processed: true, summary: 'recovered summary' }), completion('event-b'),
    ]);
    expect(fetchDouble).toHaveBeenCalledTimes(2);
  });

  it('normalizes sanitized reasons, distinguishes a different failure, and keeps separate goals independent', async () => {
    await fail('capacity exhausted api_key=fixture-secret-a', goalId);
    expect((await store.get(goalId)).notifications).toHaveLength(1);
    await fail('  capacity   exhausted\napi_key=fixture-secret-b  ', goalId);
    expect((await store.get(goalId)).notifications).toHaveLength(1);
    await fail('authentication expired', goalId);
    expect((await store.get(goalId)).notifications).toHaveLength(2);
    const otherId = '550e8400-e29b-41d4-a716-446655440001';
    await store.create({ ...goalRecord(), id: otherId, events: [completion('other-event')] });
    await fail('authentication expired', otherId);
    expect((await store.get(otherId)).notifications).toHaveLength(1);
    expect((await store.get(goalId)).notifications).toHaveLength(2);
    expect(fetchDouble).toHaveBeenCalledTimes(3);
  });

  it.each(['ja', 'en'] as const)('includes the goal, sanitized reason, pending events and recovery instructions in %s', async (language) => {
    configure(language, true);
    const reason = 'authentication expired api_key=fixture-api-secret token=fixture-token-secret';
    await fail(reason, goalId);
    const saved = await store.get(goalId);
    expect(saved.notifications).toHaveLength(1);
    const body = saved.notifications![0]!.body;
    expect(body).toContain(goalId);
    expect(body).toContain(sanitizeSensitiveText(reason));
    expect(body).toContain('takt manager');
    expect(body).toContain(`/resume ${goalId}`);
    expect(body).toContain('takt run');
    expect(body).toMatch(language === 'ja' ? /未処理.*イベント/s : /(?:pending|unprocessed).*events/i);
    expect(body).toMatch(language === 'ja' ? /再起動/ : /restart/i);
    expect(body).toMatch(language === 'ja' ? /一時停止/ : /paused/i);
    expect(body).toMatch(language === 'ja' ? /中止/ : /aborted/i);
    const display = await readManagerDisplayEvents(cwd);
    const noticeEvents = display.events.filter(({ id }) => id === JSON.stringify([goalId, 'notification', saved.notifications![0]!.id]));
    expect(noticeEvents).toHaveLength(1);
    for (const secret of ['fixture-api-secret', 'fixture-token-secret']) {
      expect(body).not.toContain(secret);
      expect(noticeEvents[0]!.message).not.toContain(secret);
      for (const text of sentTexts()) expect(text).not.toContain(secret);
      expect(readFileSync(join(cwd, '.takt', 'goals', goalId, 'goal.json'), 'utf8')).not.toContain(secret);
    }
    expect(sentTexts()).toEqual([formatGoalNotification(saved, saved.notifications![0]!)]);
  });

  it('does not save or send blocked notifications when disabled and preserves the pending event', async () => {
    configure('en', false);
    const original = (await store.get(goalId)).events;
    await fail('capacity exhausted', goalId);
    await fail('capacity exhausted', goalId);
    expect((await store.get(goalId)).notifications ?? []).toHaveLength(0);
    expect((await store.get(goalId)).events).toEqual(original);
    expect(fetchDouble).not.toHaveBeenCalled();
  });

  it('saves the blocked notification without sending when no webhook is configured', async () => {
    vi.stubEnv(WEBHOOK_ENV_KEY, '');
    await fail('capacity exhausted', goalId);
    expect((await store.get(goalId)).notifications).toHaveLength(1);
    expect((await store.get(goalId)).events).toEqual([completion('event-a')]);
    expect(fetchDouble).not.toHaveBeenCalled();
  });

  it.each(['HTTP failure', 'connection failure'] as const)('preserves the original failure and pending event after Slack %s without repeating delivery', async (failure) => {
    if (failure === 'HTTP failure') fetchDouble.mockResolvedValue(new Response('unavailable', { status: 503 }));
    else fetchDouble.mockRejectedValue(new Error('connection unavailable'));
    const original = (await store.get(goalId)).events;
    await fail('capacity exhausted', goalId);
    const notices = (await store.get(goalId)).notifications;
    expect(notices).toHaveLength(1);
    expect((await store.get(goalId)).events).toEqual(original);
    expect(readManagerRunFailures(cwd)).toContainEqual(expect.objectContaining({
      message: expect.stringContaining(failure === 'HTTP failure' ? 'HTTP 503' : 'connection failed'),
    }));
    await fail('capacity exhausted', goalId);
    expect((await store.get(goalId)).notifications).toEqual(notices);
    expect((await store.get(goalId)).events).toEqual(original);
    expect(fetchDouble).toHaveBeenCalledOnce();
  });

  it('suppresses the same failure across concurrent and subsequent independent processes', async () => {
    vi.stubEnv(WEBHOOK_ENV_KEY, '');
    const releaseFile = join(cwd, 'release');
    const workers = [0, 1].map((index) => startWorker(index, releaseFile));
    try {
      await vi.waitFor(() => {
        for (const worker of workers) {
          if (worker.child.exitCode !== null) throw new Error('Worker exited before readiness');
          expect(existsSync(worker.readyFile)).toBe(true);
        }
      }, { timeout: 15_000 });
      writeFileSync(releaseFile, 'go');
      const results = await Promise.all(workers.map(({ result }) => result));
      for (const result of results) expect(result.code, result.stderr).toBe(0);
      const concurrentNotifications = (await store.get(goalId)).notifications;
      expect((await store.get(goalId)).events).toEqual([completion('event-a')]);
      expect(readManagerRunFailures(cwd).filter(({ message }) => message === 'capacity exhausted')).toHaveLength(2);
      const later = startWorker(2, releaseFile);
      workers.push(later);
      const result = await later.result;
      expect(result.code, result.stderr).toBe(0);
      expect(readManagerRunFailures(cwd).filter(({ message }) => message === 'capacity exhausted')).toHaveLength(3);
      expect(concurrentNotifications).toHaveLength(1);
      expect((await store.get(goalId)).notifications).toEqual(concurrentNotifications);
    } finally {
      writeFileSync(releaseFile, 'go');
      for (const { child } of workers) if (child.exitCode === null) child.kill('SIGKILL');
      await Promise.all(workers.map(({ result }) => result));
    }
  }, 40_000);
});

function startWorker(index: number, releaseFile: string) {
  const readyFile = join(cwd, `ready-${index}`);
  const child = spawn(process.execPath, [
    join(process.cwd(), 'node_modules', 'vite-node', 'vite-node.mjs'),
    '--config', 'src/__tests__/helpers/vite-node.config.ts',
    'src/__tests__/fixtures/manager-turn-failure-worker.ts', cwd, goalId, readyFile, releaseFile,
  ], { cwd: process.cwd(), env: { ...process.env, [WEBHOOK_ENV_KEY]: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const result = new Promise<{ code: number | null; stderr: string }>((resolve) => {
    let stderr = '';
    const timeout = setTimeout(() => child.kill('SIGKILL'), 25_000);
    child.stdout.resume();
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once('error', (error) => { clearTimeout(timeout); resolve({ code: -1, stderr: error.message }); });
    child.once('close', (code) => { clearTimeout(timeout); resolve({ code, stderr }); });
  });
  return { child, readyFile, result };
}

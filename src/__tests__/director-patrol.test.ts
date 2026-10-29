import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createDirectorPatrol } from '../features/director/patrol.js';

const doubles = vi.hoisted(() => ({ prepare: vi.fn(), managers: vi.fn(), execute: vi.fn(), dispose: vi.fn(), error: vi.fn() }));
vi.mock('../features/director/conversationRuntime.js', () => ({ prepareDirectorTurn: doubles.prepare }));
vi.mock('../features/director/managers.js', () => ({ listDirectorManagers: doubles.managers }));
vi.mock('../shared/utils/debug.js', () => ({ createLogger: () => ({ error: doubles.error }) }));
beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-29T01:00:00Z'));
  doubles.managers.mockResolvedValue([{}]);
  doubles.prepare.mockResolvedValue({ executor: { execute: doubles.execute }, dispose: doubles.dispose });
});
afterEach(() => vi.useRealTimers());

it.each(['ja', 'en'] as const)('starts a separate patrol with observation time and interval in %s', async (language) => {
  const notifications = { notify: vi.fn() };
  const patrol = createDirectorPatrol('/config', notifications, 600, language);
  const signal = new AbortController().signal;
  patrol.poll(signal);
  expect(patrol.running).toBe(true);
  await patrol.close();
  expect(doubles.prepare).toHaveBeenCalledExactlyOnceWith('/config', notifications, signal, {}, true);
  const input = doubles.execute.mock.calls[0]![0];
  expect(JSON.parse(input.prompt)).toEqual({ event: 'director_patrol', observedAt: '2026-10-29T01:00:00.000Z', patrolIntervalSeconds: 600 });
  expect(input).toMatchObject({ sessionId: undefined, assignment: undefined, abortSignal: signal });
  expect(doubles.dispose).toHaveBeenCalledOnce();
  expect(patrol.running).toBe(false);
});

it('skips providers with no managers and after cancellation', async () => {
  doubles.managers.mockResolvedValue([]);
  const patrol = createDirectorPatrol('/config', { notify: vi.fn() }, 900, 'en');
  const controller = new AbortController();
  patrol.poll(controller.signal);
  await patrol.close();
  expect(doubles.prepare).not.toHaveBeenCalled();
  controller.abort();
  vi.advanceTimersByTime(900_000);
  patrol.poll(controller.signal);
  expect(doubles.managers).toHaveBeenCalledOnce();
});

it('prevents overlap and measures the next deadline from completion', async () => {
  let release!: () => void;
  doubles.execute.mockReturnValueOnce(new Promise<void>((resolve) => { release = resolve; }));
  const patrol = createDirectorPatrol('/config', { notify: vi.fn() }, 900, 'en');
  const signal = new AbortController().signal;
  patrol.poll(signal);
  await vi.advanceTimersByTimeAsync(1_800_000);
  patrol.poll(signal);
  expect(doubles.execute).toHaveBeenCalledOnce();
  let closed = false;
  const closing = patrol.close().then(() => { closed = true; });
  await Promise.resolve();
  expect(closed).toBe(false);
  release();
  await closing;
  vi.advanceTimersByTime(899_999);
  patrol.poll(signal);
  expect(patrol.running).toBe(false);
  vi.advanceTimersByTime(1);
  patrol.poll(signal);
  await patrol.close();
  expect(doubles.execute).toHaveBeenCalledTimes(2);
});

it.each(['prepare', 'execute', 'managers'] as const)('waits after %s failure and releases allocated resources', async (boundary) => {
  doubles[boundary].mockRejectedValueOnce(new Error('API_KEY=private-test-value'));
  const patrol = createDirectorPatrol('/config', { notify: vi.fn() }, 900, 'ja');
  const signal = new AbortController().signal;
  patrol.poll(signal);
  await patrol.close();
  expect(doubles.dispose).toHaveBeenCalledTimes(boundary === 'execute' ? 1 : 0);
  expect(doubles.error).toHaveBeenCalledOnce();
  expect(JSON.stringify(doubles.error.mock.calls)).not.toContain('private-test-value');
  vi.advanceTimersByTime(899_999);
  patrol.poll(signal);
  expect(patrol.running).toBe(false);
  vi.advanceTimersByTime(1);
  patrol.poll(signal);
  await patrol.close();
  expect(doubles.managers).toHaveBeenCalledTimes(2);
});

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Worker } from 'node:worker_threads';
import { WatchGoalReader } from '../features/daemon/watchers/goalReader.js';
import { runStepIdentity } from '../core/workflow/run/step-executions.js';
import { startDaemonWatchers, type DaemonWatchSource } from '../features/daemon/watchers/index.js';
import type { RunWatchTarget } from '../features/daemon/watchers/checks.js';
import { WATCH_INTERVALS } from '../features/daemon/watchers/loop.js';

let directory: string;
let reader: WatchGoalReader;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'takt-run-progress-'));
  reader = new WatchGoalReader();
});
afterEach(async () => {
  await reader.close();
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

const frame = (workflow: string, step: string, count: number, counts?: Record<string, number>) => ({
  workflow, workflow_ref: `${workflow}.yaml`, step, kind: 'agent', occurrence: count,
  ...(counts === undefined ? {} : { step_iterations: counts }),
});
function metadata(stack: object[]) {
  return { runSlug: 'run', status: 'running', startTime: '2026-11-06T00:00:00.000Z',
    currentStep: 'call-child', currentIteration: 500,
    resume_point: { version: 2, iteration: 500, elapsed_ms: 0, stack,
      workflow_call_invocations: {}, workflow_step_participations: {} } };
}

it('reads per-step counts from every nested workflow frame rather than the global iteration', async () => {
  const path = join(directory, 'meta.json');
  const root = { ...frame('root', 'call-child', 2, { review: 5, 'call-child': 2 }), kind: 'workflow_call', call_instance: 2 };
  const child = { ...frame('child', 'call-grandchild', 3, { review: 6, 'call-grandchild': 3 }), kind: 'workflow_call', call_instance: 3 };
  const leaf = frame('grandchild', 'review', 7, { review: 7 });
  await writeFile(path, JSON.stringify(metadata([root, child, leaf])));
  const progress = await reader.readRunProgress(path);
  expect(progress).toMatchObject({ runSlug: 'run', running: true,
    steps: [{ workflow: 'root', step: 'review', count: 5 }, { workflow: 'root', step: 'call-child', count: 2 },
      { workflow: 'child', step: 'review', count: 6 }, { workflow: 'child', step: 'call-grandchild', count: 3 },
      { workflow: 'grandchild', step: 'review', count: 7 }] });
  expect(new Set(progress!.steps.map((step) => step.identity)).size).toBe(5);
  // 同じ呼出箇所の次の子実行でも同じ通知先。別の呼出箇所は区別する。
  await writeFile(path, JSON.stringify(metadata([{ ...root, call_instance: 3 }, child, leaf])));
  expect((await reader.readRunProgress(path))!.steps).toEqual(progress!.steps);
  await writeFile(path, JSON.stringify(metadata([{ ...root, step: 'other-call' }, child, leaf])));
  expect((await reader.readRunProgress(path))!.steps.at(-1)!.identity).not.toBe(progress!.steps.at(-1)!.identity);
});

it('uses the frame occurrence when old metadata has no step_iterations and ignores currentIteration', async () => {
  const path = join(directory, 'meta.json');
  await writeFile(path, JSON.stringify(metadata([frame('child', 'review', 6)])));
  expect((await reader.readRunProgress(path))!.steps).toMatchObject([{ workflow: 'child', step: 'review', count: 6 }]);
  await writeFile(path, JSON.stringify({ runSlug: 'run', status: 'running', startTime: '2026-11-06T00:00:00.000Z',
    currentIteration: 500, currentStep: 'review' }));
  expect((await reader.readRunProgress(path))!.steps).toEqual([]);
});

it('allows metadata not yet created and rejects malformed, invalid and nonregular metadata', async () => {
  const path = join(directory, 'meta.json');
  expect(await reader.readRunProgress(path)).toBeUndefined();
  for (const value of ['{', JSON.stringify(metadata([frame('root', 'review', 0)])),
    JSON.stringify({ ...metadata([]), startTime: 'unknown' }), 'x'.repeat(256 * 1024 + 1)]) {
    await writeFile(path, value);
    await expect(reader.readRunProgress(path)).rejects.toThrow();
  }
  await rm(path);
  await mkdir(path);
  await expect(reader.readRunProgress(path)).rejects.toThrow();
});

it('uses run-wide step executions after a child returns rather than its disappearing resume frame', async () => {
  const path = join(directory, 'meta.json');
  const child = { ...runStepIdentity([frame('root', 'delegate', 2), frame('child', 'review', 3)], 'child', 'review'), count: 6 };
  await writeFile(path, JSON.stringify({ ...metadata([frame('root', 'finish', 1)]), stepExecutions: [child] }));
  expect((await reader.readRunProgress(path))!.steps).toEqual([child]);
});

it('accepts the legacy camelCase resumePoint with the same validation and identity', async () => {
  const path = join(directory, 'meta.json');
  const meta = metadata([frame('child', 'review', 6)]);
  await writeFile(path, JSON.stringify(meta));
  const expected = await reader.readRunProgress(path);
  const { resume_point: resumePoint, ...rest } = meta;
  await writeFile(path, JSON.stringify({ ...rest, resumePoint }));
  expect(await reader.readRunProgress(path)).toEqual(expected);
  await writeFile(path, JSON.stringify({ ...rest, resumePoint: { stack: [frame('child', 'review', 0)] } }));
  await expect(reader.readRunProgress(path)).rejects.toThrow();
});

it.each(['requeue', 'retry', 'instruct'])('does not report inherited legacy frame counts in a %s run', async (mode) => {
  const path = join(directory, 'meta.json');
  const meta = metadata([frame('child', 'review', 106, { review: 106 })]);
  for (const lineage of [{ resume_mode: mode }, { source_run_slug: 'prior-run' }, { resumeMode: mode }, { sourceRunSlug: 'prior-run' }]) {
    await writeFile(path, JSON.stringify({ ...meta, ...lineage }));
    expect(await reader.readRunProgress(path)).toMatchObject({ running: true, startedAt: meta.startTime, steps: [] });
  }
  const step = { ...runStepIdentity([], 'root', 'review'), count: 6 };
  await writeFile(path, JSON.stringify({ ...meta, resume_mode: mode, stepExecutions: [step] }));
  expect((await reader.readRunProgress(path))!.steps).toEqual([step]);
});

it('keeps all distinct step counts observable when metadata exceeds 256 KiB', async () => {
  const path = join(directory, 'meta.json');
  const steps = Array.from({ length: 3000 }, (_, index) => ({ ...runStepIdentity([], 'root', `step-${index}`), count: 6 }));
  const text = JSON.stringify({ ...metadata([frame('root', 'review', 6)]), stepExecutions: steps });
  expect(Buffer.byteLength(text)).toBeGreaterThan(256 * 1024);
  await writeFile(path, text);
  expect(await reader.readRunProgress(path)).toMatchObject({ running: true, steps });
});

it('cancels an outstanding metadata read when the watcher stops', async () => {
  const terminate = vi.spyOn(Worker.prototype, 'terminate');
  const controller = new AbortController();
  const reading = reader.readRunProgress(join(directory, 'meta.json'), controller.signal);
  controller.abort(new Error('watcher stopped'));
  await expect(reading).rejects.toBe(controller.signal.reason);
  expect(terminate).toHaveBeenCalledOnce();
  await expect(reader.readRunProgress(join(directory, 'meta.json'), controller.signal)).rejects.toBe(controller.signal.reason);
  expect(terminate).toHaveBeenCalledOnce();
});

it('reuses the resident worker across consecutive run observations and reads updated metadata', async () => {
  const path = join(directory, 'meta.json');
  const target: RunWatchTarget = { targetId: 'run', generation: '1', conversationId: 'manager',
    task: { repositoryDirectory: directory, goalId: 'goal', taskName: 'task', runSlug: 'run' },
    running: true, paused: false, awaitingAnswer: false, owner: { pid: 123, startTime: 'start' }, logPath: null, metaPath: path,
    startedAt: '2026-11-06T00:00:00.000Z' };
  const source: DaemonWatchSource = { runs: async () => [target], run: async () => target,
    readRunProgress: vi.fn((path, signal) => reader.readRunProgress(path, signal)),
    pullRequests: async () => [], inquiries: async () => [], goals: async () => [], launches: async () => [], directories: async () => [] };
  const post = vi.spyOn(Worker.prototype, 'postMessage');
  const terminate = vi.spyOn(Worker.prototype, 'terminate');
  const onError = vi.fn();
  const accept = vi.fn();
  await writeFile(path, JSON.stringify(metadata([frame('root', 'review', 1)])));
  const watchers = startDaemonWatchers({ source, processes: { inspect: async () => ({ kind: 'alive', owner: target.owner! }) }, commands: { run: vi.fn() },
    records: { read: async () => undefined, write: async () => {} }, ingress: { accept }, filesChanged: vi.fn(),
    now: () => Date.parse(target.startedAt!), onError });
  try {
    await watchers.drain();
    for (const count of [2, 3]) {
      await writeFile(path, JSON.stringify(metadata([frame('root', 'review', count)])));
      watchers.changed();
      await watchers.drain();
    }
    const reads = vi.mocked(source.readRunProgress);
    expect(reads).toHaveBeenCalledTimes(3);
    for (const [index, result] of reads.mock.results.entries()) {
      expect(await result.value).toMatchObject({ steps: [{ count: index + 1 }] });
    }
    expect(post).toHaveBeenCalledTimes(3);
    expect(new Set(post.mock.contexts).size).toBe(1);
    expect(terminate).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(accept).not.toHaveBeenCalled();
  } finally { await watchers.close(); }
  await reader.close();
  expect(terminate).toHaveBeenCalledOnce();
});

it('terminates the resident worker at the read deadline and restarts it for the next read', async () => {
  const deadline = new AbortController();
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
  const terminate = vi.spyOn(Worker.prototype, 'terminate');
  const post = vi.spyOn(Worker.prototype, 'postMessage');
  const path = join(directory, 'meta.json');
  const reading = reader.readRunProgress(path);
  deadline.abort(new DOMException('deadline', 'TimeoutError'));
  await expect(reading).rejects.toBe(deadline.signal.reason);
  expect(timeout).toHaveBeenCalledWith(WATCH_INTERVALS.long);
  expect(terminate).toHaveBeenCalledOnce();
  timeout.mockRestore();
  await writeFile(path, JSON.stringify(metadata([frame('root', 'review', 2)])));
  expect(await reader.readRunProgress(path)).toMatchObject({ steps: [{ count: 2 }] });
  expect(post).toHaveBeenCalledTimes(2);
  expect(new Set(post.mock.contexts).size).toBe(2);
});

it('rejects outstanding metadata reads on reader shutdown and does not restart after closing', async () => {
  const terminate = vi.spyOn(Worker.prototype, 'terminate');
  const path = join(directory, 'meta.json');
  const pending = Promise.allSettled([reader.readRunProgress(path), reader.readRunProgress(path)]);
  await reader.close();
  expect((await pending).map((result) => result.status)).toEqual(['rejected', 'rejected']);
  expect(terminate).toHaveBeenCalledOnce();
  await expect(reader.readRunProgress(path)).rejects.toThrow();
  expect(terminate).toHaveBeenCalledOnce();
});

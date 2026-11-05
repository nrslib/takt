import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { readRunProgress } from '../features/daemon/watchers/runProgress.js';

let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'takt-run-progress-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

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
  const progress = await readRunProgress(path);
  expect(progress).toMatchObject({ runSlug: 'run', running: true,
    steps: [{ workflow: 'root', step: 'review', count: 5 }, { workflow: 'root', step: 'call-child', count: 2 },
      { workflow: 'child', step: 'review', count: 6 }, { workflow: 'child', step: 'call-grandchild', count: 3 },
      { workflow: 'grandchild', step: 'review', count: 7 }] });
  expect(new Set(progress!.steps.map((step) => step.identity)).size).toBe(5);
  // 同じ呼出箇所の次の子実行でも同じ通知先。別の呼出箇所は区別する。
  await writeFile(path, JSON.stringify(metadata([{ ...root, call_instance: 3 }, child, leaf])));
  expect((await readRunProgress(path))!.steps).toEqual(progress!.steps);
  await writeFile(path, JSON.stringify(metadata([{ ...root, step: 'other-call' }, child, leaf])));
  expect((await readRunProgress(path))!.steps.at(-1)!.identity).not.toBe(progress!.steps.at(-1)!.identity);
});

it('uses the frame occurrence when old metadata has no step_iterations and ignores currentIteration', async () => {
  const path = join(directory, 'meta.json');
  await writeFile(path, JSON.stringify(metadata([frame('child', 'review', 6)])));
  expect((await readRunProgress(path))!.steps).toMatchObject([{ workflow: 'child', step: 'review', count: 6 }]);
  await writeFile(path, JSON.stringify({ runSlug: 'run', status: 'running', startTime: '2026-11-06T00:00:00.000Z',
    currentIteration: 500, currentStep: 'review' }));
  expect((await readRunProgress(path))!.steps).toEqual([]);
});

it('allows metadata not yet created and rejects malformed, invalid and oversized metadata', async () => {
  const path = join(directory, 'meta.json');
  expect(await readRunProgress(path)).toBeUndefined();
  for (const value of ['{', JSON.stringify(metadata([frame('root', 'review', 0)])),
    JSON.stringify({ ...metadata([]), startTime: 'unknown' }), 'x'.repeat(256 * 1024 + 1)]) {
    await writeFile(path, value);
    await expect(readRunProgress(path)).rejects.toThrow();
  }
});

it('uses run-wide step executions after a child returns rather than its disappearing resume frame', async () => {
  const path = join(directory, 'meta.json');
  const { runStepIdentity } = await import('../core/workflow/run/step-executions.js');
  const child = { ...runStepIdentity([frame('root', 'delegate', 2), frame('child', 'review', 3)], 'child', 'review'), count: 6 };
  await writeFile(path, JSON.stringify({ ...metadata([frame('root', 'finish', 1)]), stepExecutions: [child] }));
  expect((await readRunProgress(path))!.steps).toEqual([child]);
});

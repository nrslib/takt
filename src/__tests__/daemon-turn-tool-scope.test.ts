import { expect, it } from 'vitest';
import { TurnToolScope } from '../features/daemonTurn/toolScope.js';
import { deferred } from './helpers/daemon-turn.js';

it('waits for tool cleanup and rejects work admitted after the turn ends', async () => {
  const scope = new TurnToolScope(); scope.begin(new AbortController().signal);
  const gate = deferred<void>(); const started = deferred<void>();
  const operation = scope.run(async () => { started.resolve(); await gate.promise; return 'done'; });
  await started.promise;
  const ending = scope.end(); let ended = false; void ending.then(() => { ended = true; });
  await expect(scope.run(async () => 'late')).rejects.toThrow();
  await Promise.resolve(); expect(ended).toBe(false);
  expect(() => scope.begin(new AbortController().signal)).toThrow();
  gate.resolve(); expect(await operation).toBe('done'); await ending;
  expect(ended).toBe(true);
  scope.begin(new AbortController().signal); await scope.end();
});
it('cancels in-flight tool work with the parent turn and waits for its cleanup', async () => {
  const scope = new TurnToolScope(); const controller = new AbortController(); scope.begin(controller.signal);
  const cleaned = deferred<void>(); const cancelled = deferred<void>();
  const signal = scope.signal(new AbortController().signal);
  const operation = scope.run(async () => {
    signal.addEventListener('abort', () => { cancelled.resolve(); }, { once: true });
    await cancelled.promise; await cleaned.promise;
  });
  await Promise.resolve(); controller.abort(); await cancelled.promise;
  const ending = scope.end(); let ended = false; void ending.then(() => { ended = true; });
  await Promise.resolve(); expect(ended).toBe(false);
  cleaned.resolve(); await operation; await ending;
  expect(signal.aborted).toBe(true);
});
it('settles failed tools and enforces the active-turn boundary', async () => {
  const scope = new TurnToolScope();
  await expect(scope.run(async () => 'outside')).rejects.toThrow();
  expect(() => scope.signal(new AbortController().signal)).toThrow();
  scope.begin(new AbortController().signal);
  await expect(scope.run(async () => { throw new Error('failed'); })).rejects.toThrow();
  await scope.end(); scope.begin(new AbortController().signal); await scope.end();
});

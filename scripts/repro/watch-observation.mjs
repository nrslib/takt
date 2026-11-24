import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { AsyncProcess } from '../../dist/infra/daemon/process.js';
import { startDaemonWatchers } from '../../dist/features/daemon/watchers/index.js';

const ps = promisify(execFile);
const psArgs = (pid) => ['-p', String(pid), '-o', 'lstart='];
const psOptions = {
  cwd: '/', env: { ...process.env, LC_ALL: 'C', LANG: 'C', TZ: 'UTC0' },
  maxBuffer: 4096,
};
const OBSERVATION_MS = 90_000;
const CONTROL_INTERVAL_MS = 2_000;
const SAFETY_MS = 130_000;
const requestedPid = process.argv.length === 2 ? undefined : process.argv.length === 4 && process.argv[2] === '--pid'
  && /^[1-9]\d*$/.test(process.argv[3]) && Number.isSafeInteger(Number(process.argv[3]))
  ? Number(process.argv[3]) : null;
const targetKind = requestedPid === undefined ? 'owned_child' : 'existing_pid';
const record = (kind, data) => console.log(JSON.stringify({ at: new Date().toISOString(), node: process.version, targetKind, kind, ...data }));

async function nativePs(pid) {
  const started = performance.now();
  const signal = AbortSignal.timeout(5_000);
  try {
    const { stdout } = await ps('/bin/ps', psArgs(pid), { ...psOptions, signal });
    const elapsedMs = Math.round(performance.now() - started);
    const startTime = stdout.trim();
    if (startTime === '') {
      record('native_ps', { elapsedMs, outcome: 'error', reason: 'Empty process identity' });
      return { kind: 'error', reason: 'Empty process identity' };
    }
    record('native_ps', { elapsedMs, outcome: 'ok', startTime });
    return { kind: 'ok', startTime };
  } catch (error) {
    const kind = signal.aborted ? 'timeout' : 'error';
    const reason = String(error);
    record('native_ps', { elapsedMs: Math.round(performance.now() - started), outcome: kind, reason });
    return { kind, reason };
  }
}

async function main() {
  if (process.platform !== 'darwin') throw new Error('This probe requires macOS legacy ps start times');
  if (requestedPid === null) throw new Error('Usage: node scripts/repro/watch-observation.mjs [--pid POSITIVE_INTEGER]');
  const ownedChild = requestedPid === undefined
    ? spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }) : undefined;
  let watchers;
  const stop = new AbortController();
  const stopOnSignal = () => stop.abort();
  process.on('SIGINT', stopOnSignal);
  process.on('SIGTERM', stopOnSignal);
  const safetyTimer = setTimeout(() => {
    ownedChild?.kill('SIGKILL');
    process.exit(124);
  }, SAFETY_MS);
  try {
    if (ownedChild !== undefined) await once(ownedChild, 'spawn');
    const pid = requestedPid ?? ownedChild?.pid;
    if (pid === undefined) throw new Error('Child PID is missing');
    const initial = await nativePs(pid);
    if (initial.kind !== 'ok') {
      record('not_started', { reason: `Initial process identity unavailable: ${initial.reason}` });
      throw new Error('Watch not started: initial process identity unavailable');
    }
    const startTime = initial.startTime;
    const targets = ['fixture-a', 'fixture-b', 'fixture-c'].map((name) => ({
      targetId: name, generation: 'fixture-generation', conversationId: 'fixture-conversation',
      task: { repositoryDirectory: '/fixture', goalId: '00000000-0000-4000-8000-000000000001', taskName: name },
      owner: { pid, startTime }, running: true,
    }));
    const observations = [];
    const errors = [];
    const saved = new Map();
    const processes = new AsyncProcess();
    record('setup', { pid, targets: targets.length, watchIntervalMs: 5000, durationMs: OBSERVATION_MS, safetyMs: SAFETY_MS });
    watchers = startDaemonWatchers({
      source: {
        async runs() { return targets; },
        async run(targetId) { return targets.find((target) => target.targetId === targetId); },
        async pullRequests() { return []; },
        async inquiries() {},
        async launches() { return []; },
        async directories() { return []; },
      },
      processes: {
        async inspect(owner, options) {
          const started = performance.now();
          try {
            const result = await processes.inspect(owner, options);
            record('inspect', { pid: owner.pid, elapsedMs: Math.round(performance.now() - started), result: result.kind,
              reason: result.kind === 'unknown' ? result.reason : null });
            return result;
          } catch (error) {
            record('inspect_error', { pid: owner.pid, elapsedMs: Math.round(performance.now() - started), reason: String(error) });
            throw error;
          }
        },
      },
      commands: { async run() { throw new Error('Unexpected PR command'); } },
      records: {
        async read(key) { return saved.get(key); },
        async write(key, value) { saved.set(key, value); },
      },
      ingress: {
        async accept(input) {
          observations.push(input.event.observation);
          record('observation', { observation: input.event.observation });
          return { kind: 'accepted', eventId: input.eventId, operationId: input.eventId, acceptedSequence: observations.length };
        },
      },
      async filesChanged() { throw new Error('Unexpected file change'); },
      now: Date.now,
      onError(target, error) {
        errors.push({ targetId: target?.targetId ?? null, reason: String(error) });
        record('watch_error', errors.at(-1));
      },
    });
    const controlOutcomes = { ok: 0, timeout: 0, error: 0 };
    const started = performance.now();
    while (!stop.signal.aborted && performance.now() - started < OBSERVATION_MS) {
      const remaining = OBSERVATION_MS - (performance.now() - started);
      await delay(Math.min(CONTROL_INTERVAL_MS, remaining), undefined, { signal: stop.signal }).catch((error) => {
        if (!stop.signal.aborted) throw error;
      });
      if (stop.signal.aborted || performance.now() - started >= OBSERVATION_MS) break;
      const control = await nativePs(pid);
      controlOutcomes[control.kind]++;
    }
    if (!stop.signal.aborted) await watchers.drain();
    await watchers.close();
    watchers = undefined;
    record('summary', { watchFailed: observations.filter((observation) => observation.kind === 'watch_failed').length,
      errors: errors.length, controlOutcomes, elapsedMs: Math.round(performance.now() - started) });
  } finally {
    try {
      if (watchers !== undefined) await watchers.close();
    } finally {
      if (ownedChild !== undefined) {
        const exited = ownedChild.exitCode !== null || ownedChild.signalCode !== null ? undefined : once(ownedChild, 'exit');
        if (exited !== undefined) {
          ownedChild.kill('SIGKILL');
          await exited;
        }
      }
      clearTimeout(safetyTimer);
      process.off('SIGINT', stopOnSignal);
      process.off('SIGTERM', stopOnSignal);
    }
  }
}

main().catch((error) => {
  record('fatal', { reason: String(error) });
  process.exitCode = 1;
});

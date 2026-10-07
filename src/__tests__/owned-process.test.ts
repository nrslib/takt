import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const doubles = vi.hoisted(() => ({ identity: vi.fn(), alive: vi.fn() }));
vi.mock('../infra/task/process.js', async (original) => ({
  ...await original<typeof import('../infra/task/process.js')>(),
  getProcessIdentity: doubles.identity, isProcessAlive: doubles.alive,
}));
import { captureOwnedChild, readOwnedProcessMarker, signalOwnedProcess, terminateOwnedProcess } from './helpers/owned-process.js';

describe.each([
  { platform: 'darwin', startTime: 'darwin-start-v2:1791244800', otherTime: 'darwin-start-v2:1791244801' },
  { platform: 'linux', startTime: 'linux-start-v3:550e8400-e29b-41d4-a716-446655440000:123450', otherTime: 'linux-start-v3:550e8400-e29b-41d4-a716-446655440000:123451' },
])('$platform process ownership', ({ startTime, otherTime }) => {
  const owned = readOwnedProcessMarker(JSON.stringify({ pid: 4242, startTime }));
  const hasExited = () => false;
  beforeEach(() => {
    vi.resetAllMocks();
    doubles.identity.mockReturnValue({ startTime });
    doubles.alive.mockReturnValue(true);
    vi.spyOn(process, 'kill').mockReturnValue(true);
  });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it.each(['matching', 'reused', 'unknown'] as const)('signals only a verified process: %s', (identity) => {
    doubles.identity.mockReturnValue(identity === 'unknown' ? undefined : { startTime: identity === 'reused' ? otherTime : startTime });
    expect(signalOwnedProcess(owned, 'SIGTERM', hasExited)).toBe(identity === 'matching');
    expect(process.kill).toHaveBeenCalledTimes(identity === 'matching' ? 1 : 0);
    if (identity === 'matching') expect(process.kill).toHaveBeenCalledWith(4242, 'SIGTERM');
    expect(doubles.alive()).toBe(true);
  });
  it.each([undefined, 'invalid', 'ps-lstart-utc-v1:Tue Oct  6 00:00:00 2026'])('does not signal a live process with missing or invalid recorded identity: %s', (recorded) => {
    const marker = readOwnedProcessMarker(JSON.stringify({ pid: 4242, startTime: recorded }));
    expect(signalOwnedProcess(marker, 'SIGTERM', hasExited)).toBe(false);
    expect(process.kill).not.toHaveBeenCalled();
  });
  it('rejects a PID-only marker instead of using its number as ownership', () => {
    expect(() => readOwnedProcessMarker('4242')).toThrow();
  });
  it('does not signal a child whose exit is already known', async () => {
    await terminateOwnedProcess(owned, () => true);
    expect(process.kill).not.toHaveBeenCalled();
    expect(doubles.identity).not.toHaveBeenCalled();
  });
  it('confirms an exit that happens while inspecting identity without sending a signal', async () => {
    doubles.identity.mockImplementation(() => {
      doubles.alive.mockReturnValue(false);
      return undefined;
    });
    await expect(terminateOwnedProcess(owned, hasExited)).resolves.toBeUndefined();
    expect(process.kill).not.toHaveBeenCalled();
  });
  it.each(['before-signal', 'after-signal'] as const)('waits for exit when identity disappears %s', async (phase) => {
    vi.useFakeTimers();
    if (phase === 'before-signal') doubles.identity.mockReturnValue(undefined);
    else vi.mocked(process.kill).mockImplementation(() => {
      doubles.identity.mockReturnValue(undefined);
      return true;
    });
    setTimeout(() => doubles.alive.mockReturnValue(false), 40);
    const ended = terminateOwnedProcess(owned, hasExited);
    await vi.advanceTimersByTimeAsync(60);
    await expect(ended).resolves.toBeUndefined();
    expect(process.kill).toHaveBeenCalledTimes(phase === 'before-signal' ? 0 : 1);
  });
  it('signals after an unavailable identity becomes verifiable within the deadline', async () => {
    vi.useFakeTimers();
    doubles.identity.mockReturnValue(undefined);
    setTimeout(() => doubles.identity.mockReturnValue({ startTime }), 40);
    vi.mocked(process.kill).mockImplementation(() => {
      doubles.alive.mockReturnValue(false);
      return true;
    });
    const ended = terminateOwnedProcess(owned, hasExited);
    await vi.advanceTimersByTimeAsync(60);
    await expect(ended).resolves.toBeUndefined();
    expect(process.kill).toHaveBeenCalledExactlyOnceWith(4242, 'SIGTERM');
  });
  it('reports an unconfirmed exit only after both deadlines when identity remains unknown', async () => {
    vi.useFakeTimers();
    doubles.identity.mockReturnValue(undefined);
    const result = expect(terminateOwnedProcess(owned, hasExited)).rejects.toThrow('Process exit was not confirmed');
    await vi.advanceTimersByTimeAsync(1980);
    expect(doubles.identity.mock.calls.length).toBeGreaterThan(1);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(40);
    await result;
    expect(process.kill).not.toHaveBeenCalled();
  });
  it.each(['matching', 'reused', 'unknown'] as const)('rechecks ownership before forced termination: %s', async (identity) => {
    vi.useFakeTimers();
    let inspections = 0;
    doubles.identity.mockImplementation(() => {
      inspections++;
      if (inspections < 52 || identity === 'matching') return { startTime };
      return identity === 'unknown' ? undefined : { startTime: otherTime };
    });
    vi.mocked(process.kill).mockImplementation((_pid, signal) => {
      if (signal === 'SIGKILL') doubles.alive.mockReturnValue(false);
      return true;
    });
    const ended = terminateOwnedProcess(owned, hasExited);
    const result = identity === 'unknown' ? expect(ended).rejects.toThrow() : expect(ended).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(2100);
    await result;
    expect(process.kill).toHaveBeenCalledTimes(identity === 'matching' ? 2 : 1);
    if (identity === 'matching') expect(process.kill).toHaveBeenLastCalledWith(4242, 'SIGKILL');
    else expect(doubles.alive()).toBe(true);
  });

  it.each(['ready', 'exit', 'unavailable'] as const)('captures a tracked child only after identity initialization: %s', async (state) => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), { pid: 4242, exitCode: null as number | null, signalCode: null }) as ChildProcess;
    doubles.identity.mockReturnValue(undefined);
    const pending = captureOwnedChild(child);
    const result = state === 'unavailable' ? expect(pending).rejects.toThrow() : pending;
    if (state === 'ready') doubles.identity.mockReturnValue({ startTime });
    if (state === 'exit') Object.assign(child, { exitCode: 0 });
    await vi.advanceTimersByTimeAsync(10020);
    if (state === 'ready') expect(await result).toEqual({ pid: 4242, identity: { startTime } });
    else if (state === 'exit') expect(await result).toBeUndefined();
    else await result;
    expect(process.kill).not.toHaveBeenCalled();
  });
});

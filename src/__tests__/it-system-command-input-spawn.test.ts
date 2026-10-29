import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { WorkflowSystemInput } from '../core/models/types.js';
import { makeRule, makeStep } from './test-helpers.js';

const doubles = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: doubles.spawn,
}));

import { WorkflowEngine } from '../core/workflow/index.js';
import { createDefaultSystemStepServices } from '../infra/workflow/system/DefaultSystemStepServices.js';
import { invalidateGlobalConfigCache } from '../infra/config/global/globalConfig.js';

function createChild() {
  return Object.assign(new EventEmitter(), {
    pid: 190500 as number | undefined, stdout: new PassThrough(), stderr: new PassThrough(),
    kill: vi.fn((_signal?: NodeJS.Signals | number) => true),
  });
}

describe('command system input process boundary', () => {
  let projectDir: string;
  let engine: WorkflowEngine;
  let child: ReturnType<typeof createChild>;
  const children: ReturnType<typeof createChild>[] = [];
  let kill: MockInstance<typeof process.kill>;
  const command = "  fixed-command '{previous_response}'  ";

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'takt-command-spawn-'));
    invalidateGlobalConfigCache();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    child = createChild();
    children.push(child);
    doubles.spawn.mockReset().mockReturnValue(child);
    kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
  });

  afterEach(() => {
    engine?.abort();
    for (const current of children.splice(0)) {
      current.emit('close', null, 'SIGTERM');
      current.stdout.destroy();
      current.stderr.destroy();
    }
    engine?.removeAllListeners();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    invalidateGlobalConfigCache();
    rmSync(projectDir, { recursive: true, force: true });
  });

  function createEngine(timeout_ms: number, waitForSuccess = false): WorkflowEngine {
    const input: WorkflowSystemInput = { type: 'command', as: 'result', command, timeout_ms };
    const step = makeStep({ name: 'check', kind: 'system',
      systemInputs: [input],
      rules: [makeRule('when(true)', 'after')],
    });
    if (waitForSuccess && step.kind === 'system') {
      step.wait = { until: 'when(context.check.result.exit_code == 0)', intervalMs: 1, maxRetries: 1, onTimeout: 'ABORT' };
    }
    const after = makeStep({ name: 'after', kind: 'system', rules: [makeRule('when(true)', 'COMPLETE')] });
    engine = new WorkflowEngine({ name: 'spawn', initialStep: 'check', maxSteps: 2, steps: [step, after] }, projectDir, '', {
      provider: 'mock', projectCwd: projectDir, reportDirName: 'spawn-test',
      systemStepServicesFactory: createDefaultSystemStepServices,
    });
    return engine;
  }

  it('passes the exact command with no extra arguments and only allowed environment values', async () => {
    vi.stubEnv('TAKT_COMMAND_TEST_SECRET', 'must-not-be-inherited');
    const running = createEngine(1000).run();
    await vi.advanceTimersByTimeAsync(0);
    expect(doubles.spawn).toHaveBeenCalledOnce();
    const call = doubles.spawn.mock.calls[0]!;
    expect(call[0]).toBe(command);
    if (Array.isArray(call[1])) expect(call[1]).toEqual([]);
    const options = (Array.isArray(call[1]) ? call[2] : call[1]) as { env: NodeJS.ProcessEnv };
    expect(options).toMatchObject({
      cwd: projectDir, shell: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(options.env).not.toHaveProperty('TAKT_COMMAND_TEST_SECRET');
    expect(options.env.TAKT_PREVIOUS_RESPONSE_FILE).toBeTruthy();
    expect(options.env).not.toHaveProperty('TAKT_PREVIOUS_STRUCTURED_OUTPUT_FILE');
    child.emit('close', 0, null);
    expect((await running).status).toBe('completed');
    expect(vi.getTimerCount()).toBe(0);
    engine.abort();
    expect(kill).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('fails a spawn error before the next step can start', async () => {
    const running = createEngine(1000).run();
    await vi.advanceTimersByTimeAsync(0);
    expect(doubles.spawn).toHaveBeenCalledOnce();
    child.pid = undefined;
    child.emit('error', Object.assign(new Error('Cannot spawn command'), { code: 'ENOENT' }));
    const state = await running;
    expect(state.status).toBe('aborted');
    expect(state.stepOutputs.has('after')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not stop a silent command after ten minutes and stops it at its explicit timeout', async () => {
    const running = createEngine(700000).run();
    await vi.advanceTimersByTimeAsync(600001);
    expect(doubles.spawn).toHaveBeenCalledOnce();
    expect(kill).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
    expect(engine.getState().status).toBe('running');
    expect(engine.getState().stepOutputs.has('after')).toBe(false);
    await vi.advanceTimersByTimeAsync(99999);
    expect(kill.mock.calls.some((call) => call[1] === 'SIGTERM')
      || child.kill.mock.calls.some((call) => call[0] === 'SIGTERM')).toBe(true);
    child.emit('close', null, 'SIGTERM');
    const state = await running;
    expect(state.status).toBe('completed');
    expect(state.systemContexts.get('check')?.result).toMatchObject({ timed_out: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('escalates termination to SIGKILL when a timed out child ignores SIGTERM', async () => {
    const running = createEngine(1000).run();
    await vi.advanceTimersByTimeAsync(1100);
    expect(doubles.spawn).toHaveBeenCalledOnce();
    const signals = [...kill.mock.calls.map((call) => call[1]), ...child.kill.mock.calls.map((call) => call[0])];
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
    child.emit('close', null, 'SIGKILL');
    const state = await running;
    expect(state.status).toBe('completed');
    expect(state.systemContexts.get('check')?.result).toMatchObject({ timed_out: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('gives every wait attempt its own full timeout', async () => {
    const secondChild = createChild();
    children.push(secondChild);
    doubles.spawn.mockReturnValueOnce(child).mockReturnValueOnce(secondChild);
    const running = createEngine(1000, true).run();
    await vi.advanceTimersByTimeAsync(600);
    expect(doubles.spawn).toHaveBeenCalledOnce();
    child.emit('close', 1, null);
    await vi.advanceTimersByTimeAsync(1);
    expect(doubles.spawn).toHaveBeenCalledTimes(2);
    expect(engine.getState().systemContexts.get('check')?.result).toMatchObject({ exit_code: 1, timed_out: false });
    await vi.advanceTimersByTimeAsync(600);
    expect(kill).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
    expect(secondChild.kill).not.toHaveBeenCalled();
    secondChild.emit('close', 0, null);
    const state = await running;
    expect(state.status).toBe('completed');
    expect(state.systemContexts.get('check')?.result).toMatchObject({ exit_code: 0, timed_out: false });
    expect(vi.getTimerCount()).toBe(0);
  });
});

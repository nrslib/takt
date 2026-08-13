import { afterEach, describe, expect, it, vi } from 'vitest';
import { settleShardResults } from '../../scripts/run-e2e-mock-shards.mjs';

afterEach(() => {
  vi.restoreAllMocks();
});

const birpcNoiseOutput = [
  ' ✓ e2e/specs/direct-task.e2e.ts (28 tests) 1200ms',
  '',
  '⎯⎯⎯⎯⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯⎯⎯⎯⎯',
  '',
  'Vitest caught 1 unhandled error during the test run.',
  '',
  '⎯⎯⎯⎯⎯⎯⎯⎯ Unhandled Error ⎯⎯⎯⎯⎯⎯⎯⎯',
  'Error: [vitest-worker]: Timeout calling "onTaskUpdate"',
  ' ❯ Timeout.<anonymous> node_modules/vitest/dist/chunks/rpc.js:49:10',
  '',
  ' Test Files  1 passed (1)',
  '      Tests  28 passed (28)',
  '     Errors  1 error',
  '   Start at  12:00:00',
  '   Duration  62.00s',
].join('\n');

describe('E2E mock shard birpc noise re-measurement', () => {
  it('should re-measure a noisy shard once and adopt the re-measured result', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const initialResult = { shardNumber: 2, code: 1, signal: null, output: birpcNoiseOutput };
    const remeasuredResult = { shardNumber: 2, code: 0, signal: null, output: '' };
    const remeasureShard = vi.fn(async () => remeasuredResult);

    const settled = await settleShardResults([initialResult], {
      isCI: false,
      remeasureShard,
    });

    expect(remeasureShard).toHaveBeenCalledTimes(1);
    expect(remeasureShard).toHaveBeenCalledWith(2);
    expect(settled).toEqual([remeasuredResult]);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('re-measuring this shard once'));
  });

  it('should re-measure multiple noisy shards serially', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const shardOne = { shardNumber: 1, code: 1, signal: null, output: birpcNoiseOutput };
    const shardTwo = { shardNumber: 2, code: 1, signal: null, output: birpcNoiseOutput };
    const remeasuredOne = { shardNumber: 1, code: 0, signal: null, output: '' };
    const remeasuredTwo = { shardNumber: 2, code: 0, signal: null, output: '' };
    let finishFirstRemeasure: (result: typeof remeasuredOne) => void = () => undefined;
    const remeasureShard = vi.fn((shardNumber: number) =>
      shardNumber === 1
        ? new Promise<typeof remeasuredOne>((resolve) => {
            finishFirstRemeasure = resolve;
          })
        : Promise.resolve(remeasuredTwo),
    );

    const settledPromise = settleShardResults([shardOne, shardTwo], {
      isCI: false,
      remeasureShard,
    });

    expect(remeasureShard).toHaveBeenCalledTimes(1);
    expect(remeasureShard).toHaveBeenCalledWith(1);

    finishFirstRemeasure(remeasuredOne);
    const settled = await settledPromise;

    expect(remeasureShard).toHaveBeenCalledTimes(2);
    expect(remeasureShard).toHaveBeenLastCalledWith(2);
    expect(settled).toEqual([remeasuredOne, remeasuredTwo]);
  });

  it('should not re-measure a shard with a real test failure', async () => {
    const output = birpcNoiseOutput.replace(
      '      Tests  28 passed (28)',
      '      Tests  1 failed | 27 passed (28)',
    );
    const result = { shardNumber: 2, code: 1, signal: null, output };
    const remeasureShard = vi.fn();

    const settled = await settleShardResults([result], {
      isCI: false,
      remeasureShard,
    });

    expect(remeasureShard).not.toHaveBeenCalled();
    expect(settled).toEqual([result]);
  });

  it('should not re-measure a noisy shard on CI', async () => {
    const result = { shardNumber: 2, code: 1, signal: null, output: birpcNoiseOutput };
    const remeasureShard = vi.fn();

    const settled = await settleShardResults([result], {
      isCI: true,
      remeasureShard,
    });

    expect(remeasureShard).not.toHaveBeenCalled();
    expect(settled).toEqual([result]);
  });

  it('should keep a failure after one unsuccessful re-measurement', async () => {
    const initialResult = { shardNumber: 2, code: 1, signal: null, output: birpcNoiseOutput };
    const remeasuredResult = { shardNumber: 2, code: 1, signal: null, output: birpcNoiseOutput };
    const remeasureShard = vi.fn(async () => remeasuredResult);

    const settled = await settleShardResults([initialResult], {
      isCI: false,
      remeasureShard,
    });

    expect(remeasureShard).toHaveBeenCalledTimes(1);
    expect(settled).toEqual([remeasuredResult]);
  });

  it('should leave a successful shard untouched', async () => {
    const result = { shardNumber: 2, code: 0, signal: null, output: birpcNoiseOutput };
    const remeasureShard = vi.fn();

    const settled = await settleShardResults([result], {
      isCI: false,
      remeasureShard,
    });

    expect(remeasureShard).not.toHaveBeenCalled();
    expect(settled).toEqual([result]);
  });
});

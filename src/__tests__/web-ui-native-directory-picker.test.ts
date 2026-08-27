import { describe, expect, it, vi } from 'vitest';
import {
  NativeDirectoryPickerUnavailableError,
  pickNativeDirectory,
} from '../features/web-ui/native-directory-picker.js';

function deferred<T>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

describe('Web UI native directory picker', () => {
  it('opens the macOS Finder picker with a fixed AppleScript', async () => {
    const execute = vi.fn().mockResolvedValue('/Users/example/project/\n');

    const result = await pickNativeDirectory({ platform: 'darwin', execute });

    expect(result).toEqual({ cancelled: false, path: '/Users/example/project/' });
    expect(execute).toHaveBeenCalledWith('osascript', [
      '-e',
      expect.stringContaining('choose folder with prompt'),
    ]);
  });

  it('reports cancellation without treating it as an error', async () => {
    const result = await pickNativeDirectory({
      platform: 'darwin',
      execute: async () => '__TAKT_DIRECTORY_PICKER_CANCELLED__\n',
    });

    expect(result).toEqual({ cancelled: true });
  });

  it('rejects native Finder selection outside macOS', async () => {
    await expect(pickNativeDirectory({ platform: 'linux', execute: vi.fn() }))
      .rejects.toBeInstanceOf(NativeDirectoryPickerUnavailableError);
  });

  it('serializes concurrent pickers in FIFO order and continues after failure', async () => {
    const firstOutput = deferred<string>();
    const secondOutput = deferred<string>();
    const execute = vi.fn()
      .mockReturnValueOnce(firstOutput.promise)
      .mockReturnValueOnce(secondOutput.promise);

    const first = pickNativeDirectory({ platform: 'darwin', execute });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    const concurrent = pickNativeDirectory({ platform: 'darwin', execute });
    expect(execute).toHaveBeenCalledTimes(1);

    firstOutput.resolve('/Users/example/first/\n');
    await expect(first).resolves.toEqual({ cancelled: false, path: '/Users/example/first/' });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    secondOutput.resolve('/Users/example/next/\n');
    await expect(concurrent).resolves.toEqual({ cancelled: false, path: '/Users/example/next/' });
    expect(execute).toHaveBeenCalledTimes(2);

    const failedOutput = deferred<string>();
    const recoveredOutput = deferred<string>();
    const failingExecute = vi.fn()
      .mockReturnValueOnce(failedOutput.promise)
      .mockReturnValueOnce(recoveredOutput.promise);
    const failed = pickNativeDirectory({ platform: 'darwin', execute: failingExecute });
    await vi.waitFor(() => expect(failingExecute).toHaveBeenCalledTimes(1));
    const recovered = pickNativeDirectory({ platform: 'darwin', execute: failingExecute });
    expect(failingExecute).toHaveBeenCalledTimes(1);
    const failedExpectation = expect(failed).rejects.toThrow('Finder failed');
    failedOutput.reject(new Error('Finder failed'));
    await failedExpectation;
    await vi.waitFor(() => expect(failingExecute).toHaveBeenCalledTimes(2));
    recoveredOutput.resolve('/Users/example/recovered/\n');
    await expect(recovered).resolves.toEqual({ cancelled: false, path: '/Users/example/recovered/' });
    expect(failingExecute).toHaveBeenCalledTimes(2);
  });
});

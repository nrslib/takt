import { describe, expect, it, vi } from 'vitest';
import {
  NativeDirectoryPickerUnavailableError,
  pickNativeDirectory,
} from '../features/web-ui/native-directory-picker.js';

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
    const execute = vi.fn()
      .mockResolvedValueOnce('/Users/example/first/\n')
      .mockResolvedValueOnce('/Users/example/next/\n');

    const first = pickNativeDirectory({ platform: 'darwin', execute });
    const concurrent = pickNativeDirectory({ platform: 'darwin', execute });

    await expect(first).resolves.toEqual({ cancelled: false, path: '/Users/example/first/' });
    await expect(concurrent).resolves.toEqual({ cancelled: false, path: '/Users/example/next/' });
    expect(execute).toHaveBeenCalledTimes(2);

    const failingExecute = vi.fn()
      .mockRejectedValueOnce(new Error('Finder failed'))
      .mockResolvedValueOnce('/Users/example/recovered/\n');
    const failed = pickNativeDirectory({ platform: 'darwin', execute: failingExecute });
    const recovered = pickNativeDirectory({ platform: 'darwin', execute: failingExecute });
    await expect(failed).rejects.toThrow('Finder failed');
    await expect(recovered).resolves.toEqual({ cancelled: false, path: '/Users/example/recovered/' });
    expect(failingExecute).toHaveBeenCalledTimes(2);
  });
});

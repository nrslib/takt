import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, statSync, type Stats } from 'node:fs';
import { readWorkflowFile } from '../infra/config/loaders/workflow-file-reader.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, statSync: vi.fn(actual.statSync), readFileSync: vi.fn(actual.readFileSync) };
});

describe('workflow file reader', () => {
  const path = '/project/workflow.yaml';

  function fileStats(regular: boolean): Stats {
    return {
      dev: 0, ino: 0, mode: 0, nlink: 0, uid: 0, gid: 0, rdev: 0,
      size: 0, blksize: 0, blocks: 0,
      atimeMs: 0, mtimeMs: 0, ctimeMs: 0, birthtimeMs: 0,
      atime: new Date(0), mtime: new Date(0), ctime: new Date(0), birthtime: new Date(0),
      isFile: () => regular,
      isDirectory: () => false,
      isBlockDevice: () => false,
      isCharacterDevice: () => false,
      isSymbolicLink: () => false,
      isFIFO: () => false,
      isSocket: () => false,
    };
  }

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it.each([true, false])('reads content only from a regular file (regular=%s)', (regular) => {
    vi.mocked(statSync).mockReturnValue(fileStats(regular));
    vi.mocked(readFileSync).mockReturnValue('name: sample');

    if (regular) {
      expect(readWorkflowFile(path)).toBe('name: sample');
      expect(readFileSync).toHaveBeenCalledWith(path, 'utf-8');
      expect(vi.mocked(statSync).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(readFileSync).mock.invocationCallOrder[0]!);
    } else {
      expect(() => readWorkflowFile(path)).toThrow();
      expect(readFileSync).not.toHaveBeenCalled();
    }
  });

  it('propagates stat failure without attempting a content read', () => {
    const failure = new Error('stat failed');
    vi.mocked(statSync).mockImplementation(() => { throw failure; });
    expect(() => readWorkflowFile(path)).toThrow(failure);
    expect(readFileSync).not.toHaveBeenCalled();
  });

  it('propagates content read failure after validating the file type', () => {
    vi.mocked(statSync).mockReturnValue(fileStats(true));
    const failure = new Error('read failed');
    vi.mocked(readFileSync).mockImplementation(() => { throw failure; });
    expect(() => readWorkflowFile(path)).toThrow(failure);
    expect(readFileSync).toHaveBeenCalledWith(path, 'utf-8');
  });
});

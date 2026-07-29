import { beforeEach, describe, expect, it, vi } from 'vitest';

const fs = vi.hoisted(() => ({
  closeSync: vi.fn(),
  fstatSync: vi.fn(),
  openSync: vi.fn(),
  readSync: vi.fn(),
}));

vi.mock('node:fs', () => ({
  ...fs,
  constants: { O_RDONLY: 0, O_NONBLOCK: 0 },
}));

import { readStepFragment } from '../infra/config/loaders/workflowStepFragmentReader.js';

const workflowPath = '/project/.takt/workflows/review.yaml';
const fragmentPath = '/project/.takt/steps/review.yaml';

function setupReadableFragment(): void {
  const content = 'instruction: review';
  fs.openSync.mockReturnValue(7);
  fs.fstatSync.mockReturnValue({ isFile: () => true, size: content.length });
  fs.readSync
    .mockImplementationOnce((_fd: number, buffer: Buffer, offset: number) => buffer.write(content, offset))
    .mockReturnValue(0);
}

describe('workflow step fragment reader', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should retain fragment context and cause when opening fails', () => {
    const failure = new Error('EACCES');
    fs.openSync.mockImplementation(() => { throw failure; });

    try {
      readStepFragment(fragmentPath, workflowPath, 'review');
      throw new Error('Expected readStepFragment to throw');
    } catch (error) {
      expect(error).toMatchObject({ cause: failure });
      expect(error).toHaveProperty('message', expect.stringContaining(workflowPath));
      expect(error).toHaveProperty('message', expect.stringContaining('step fragment "review"'));
      expect(error).toHaveProperty('message', expect.stringContaining(fragmentPath));
    }
  });

  it('should surface a close failure after a successful read', () => {
    setupReadableFragment();
    const failure = new Error('close failed');
    fs.closeSync.mockImplementation(() => { throw failure; });

    try {
      readStepFragment(fragmentPath, workflowPath, 'review');
      throw new Error('Expected readStepFragment to throw');
    } catch (error) {
      expect(error).toHaveProperty('message', expect.stringContaining('failed to parse step fragment "review"'));
      expect(error).toMatchObject({ cause: failure });
    }
  });

  it('should retain the read failure when reading and closing both fail', () => {
    fs.openSync.mockReturnValue(7);
    fs.fstatSync.mockReturnValue({ isFile: () => true, size: 18 });
    const readFailure = new Error('read failed');
    fs.readSync.mockImplementation(() => { throw readFailure; });
    fs.closeSync.mockImplementation(() => { throw new Error('close failed'); });

    try {
      readStepFragment(fragmentPath, workflowPath, 'review');
      throw new Error('Expected readStepFragment to throw');
    } catch (error) {
      expect(error).toMatchObject({ cause: readFailure });
    }
  });

  it('should read the complete fragment when the file descriptor returns short reads', () => {
    const content = 'instruction: review\nrules:\n  - condition: done\n    next: COMPLETE\n';
    let contentOffset = 0;
    fs.openSync.mockReturnValue(7);
    fs.fstatSync.mockReturnValue({ isFile: () => true, size: content.length });
    fs.readSync.mockImplementation((_fd: number, buffer: Buffer, bufferOffset: number) => {
      const chunk = content.slice(contentOffset, contentOffset + 9);
      contentOffset += chunk.length;
      return buffer.write(chunk, bufferOffset);
    });

    expect(readStepFragment(fragmentPath, workflowPath, 'review')).toMatchObject({
      instruction: 'review',
      rules: [{ condition: 'done', next: 'COMPLETE' }],
    });
  });

  it('should reject a fragment that grows after its descriptor is inspected', () => {
    fs.openSync.mockReturnValue(7);
    fs.fstatSync.mockReturnValue({ isFile: () => true, size: 3 });
    fs.readSync.mockImplementationOnce((_fd: number, buffer: Buffer, offset: number) => (
      buffer.write('four', offset)
    ));

    expect(() => readStepFragment(fragmentPath, workflowPath, 'review'))
      .toThrow('changed size while being read');
  });
});

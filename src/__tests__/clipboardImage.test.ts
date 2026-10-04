import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockExecFile } = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFile: mockExecFile,
}));

import { readClipboardImage } from '../features/interactive/clipboardImage.js';

type ExecFilePromisified = (
  file: string,
  args: string[],
  options: { timeout: number; maxBuffer: number },
) => Promise<{ stdout: string; stderr: string }>;

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
let originalTmpDir: string | undefined;
const tempRoots = new Set<string>();

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: platform,
  });
}

function setExecFilePromisified(implementation: ExecFilePromisified): void {
  const execFileWithPromisify = mockExecFile as unknown as {
    [promisify.custom]: ExecFilePromisified;
  };
  execFileWithPromisify[promisify.custom] = implementation;
}

describe('readClipboardImage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    originalTmpDir = process.env.TMPDIR;
    setPlatform('darwin');
  });

  afterEach(() => {
    if (originalPlatform === undefined) {
      delete (process as NodeJS.Process & { platform?: NodeJS.Platform }).platform;
    } else {
      Object.defineProperty(process, 'platform', originalPlatform);
    }
    if (originalTmpDir === undefined) {
      delete process.env.TMPDIR;
    } else {
      process.env.TMPDIR = originalTmpDir;
    }
    for (const root of tempRoots) {
      rmSync(root, { recursive: true, force: true });
    }
    tempRoots.clear();
  });

  it('should create a missing TMPDIR before reading clipboard image data', async () => {
    const parentDir = mkdtempSync(join(tmpdir(), 'takt-clipboard-missing-tmp-parent-'));
    tempRoots.add(parentDir);
    const missingTmpDir = join(parentDir, 'missing', 'tmp');
    process.env.TMPDIR = missingTmpDir;

    const execFileAsync = vi.fn(async (file: string, args: string[]) => {
      if (file !== 'osascript') {
        throw new Error(`Unexpected clipboard command: ${file}`);
      }
      expect(existsSync(missingTmpDir)).toBe(true);
      const pngPath = args[args.length - 2];
      if (pngPath === undefined) {
        throw new Error('Clipboard PNG path was not provided.');
      }
      writeFileSync(pngPath, Buffer.from('png-data'));
      return { stdout: 'png\n', stderr: '' };
    });
    setExecFilePromisified(execFileAsync);

    const image = await readClipboardImage();

    expect(image).toEqual({
      mimeType: 'image/png',
      data: Buffer.from('png-data'),
    });
    expect(execFileAsync).toHaveBeenCalledWith(
      'osascript',
      expect.any(Array),
      { timeout: 10_000, maxBuffer: 1024 * 1024 },
    );
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcess, SpawnOptions } from 'node:child_process';

const { crossSpawnMock, nodeSpawnMock } = vi.hoisted(() => ({
  crossSpawnMock: vi.fn(),
  nodeSpawnMock: vi.fn(),
}));

vi.mock('cross-spawn', () => ({
  default: crossSpawnMock,
}));

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    spawn: nodeSpawnMock,
  };
});

import { crossSpawn } from '../shared/utils/spawn.js';

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: platform,
  });
}

describe('crossSpawn', () => {
  const childProcess = {} as ChildProcess;

  beforeEach(() => {
    vi.clearAllMocks();
    crossSpawnMock.mockReturnValue(childProcess);
    nodeSpawnMock.mockReturnValue(childProcess);
  });

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform);
    }
  });

  it('uses cross-spawn on Windows without changing args or options', () => {
    setPlatform('win32');
    const args = ['chat', '--no-interactive', 'hello'];
    const options: SpawnOptions = {
      cwd: '/repo',
      env: { PATH: '/bin' },
      stdio: ['pipe', 'pipe', 'pipe'],
    };

    const result = crossSpawn('kiro-cli', args, options);

    expect(result).toBe(childProcess);
    expect(crossSpawnMock).toHaveBeenCalledTimes(1);
    expect(crossSpawnMock).toHaveBeenCalledWith('kiro-cli', args, options);
    expect(nodeSpawnMock).not.toHaveBeenCalled();
    expect(options.shell).toBeUndefined();
  });

  it('uses node spawn outside Windows without changing args or options', () => {
    setPlatform('darwin');
    const args = ['exec', '--json'];
    const options: SpawnOptions = {
      cwd: '/repo',
      stdio: 'pipe',
    };

    const result = crossSpawn('codex', args, options);

    expect(result).toBe(childProcess);
    expect(nodeSpawnMock).toHaveBeenCalledTimes(1);
    expect(nodeSpawnMock).toHaveBeenCalledWith('codex', args, options);
    expect(crossSpawnMock).not.toHaveBeenCalled();
    expect(options.shell).toBeUndefined();
  });
});

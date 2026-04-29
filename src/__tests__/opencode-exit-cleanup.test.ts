import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockResetSharedServer } = vi.hoisted(() => ({
  mockResetSharedServer: vi.fn(),
}));

vi.mock('../infra/opencode/client.js', () => ({
  resetSharedServer: () => mockResetSharedServer(),
}));

class FakeProcess extends EventEmitter {
  pid = 1234;
}

describe('installOpencodeExitCleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('should reset the shared OpenCode server when the process exits', async () => {
    const { installOpencodeExitCleanup } = await import('../app/cli/opencodeExitCleanup.js');
    const runtime = new FakeProcess();

    installOpencodeExitCleanup(runtime as never);
    runtime.emit('exit', 0);

    expect(mockResetSharedServer).toHaveBeenCalledTimes(1);
  });

  it('should register the cleanup with once so repeated exit events do not reset twice', async () => {
    const { installOpencodeExitCleanup } = await import('../app/cli/opencodeExitCleanup.js');
    const runtime = new FakeProcess();

    installOpencodeExitCleanup(runtime as never);
    runtime.emit('exit', 0);
    runtime.emit('exit', 1);

    expect(mockResetSharedServer).toHaveBeenCalledTimes(1);
  });
});

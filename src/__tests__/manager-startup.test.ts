import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const doubles = vi.hoisted(() => ({ plan: vi.fn(), confirmation: vi.fn(), connect: vi.fn(), session: vi.fn(), mount: vi.fn(), realpath: vi.fn() }));
vi.mock('node:fs', async (importOriginal) => ({ ...await importOriginal<typeof import('node:fs')>(), realpathSync: doubles.realpath }));
vi.mock('../features/manager/conversationPlan.js', () => ({ createManagerConversationPlan: doubles.plan }));
vi.mock('../features/manager/goalConfirmation.js', () => ({ createGoalConfirmation: doubles.confirmation }));
vi.mock('../features/manager/managerMcp.js', () => ({ connectManagerMcp: doubles.connect }));
vi.mock('../features/manager/conversationSession.js', () => ({ createManagerConversationSession: doubles.session }));
vi.mock('../features/tui/inkMount.js', () => ({ mountInk: doubles.mount }));
import { runManager } from '../features/manager/runManager.js';

describe('manager startup and teardown', () => {
  const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  const close = vi.fn(async () => {});
  const dispose = vi.fn(async () => {});
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    doubles.realpath.mockReturnValue('/canonical/repository');
    doubles.plan.mockReturnValue({ ctx: { lang: 'ja' }, strategy: {} });
    doubles.confirmation.mockReturnValue({ publicKey: 'public key', sign: vi.fn() });
    doubles.connect.mockResolvedValue({ client: {}, servers: {}, dispose });
    doubles.session.mockReturnValue({ close });
    doubles.mount.mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (stdinTTY) Object.defineProperty(process.stdin, 'isTTY', stdinTTY);
    else Reflect.deleteProperty(process.stdin, 'isTTY');
    if (stdoutTTY) Object.defineProperty(process.stdout, 'isTTY', stdoutTTY);
    else Reflect.deleteProperty(process.stdout, 'isTTY');
  });

  it('rejects a noninteractive terminal before preparing provider or MCP resources', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
    await expect(runManager({ cwd: '/repository' })).rejects.toThrow('interactive terminal');
    expect(doubles.plan).not.toHaveBeenCalled();
    expect(doubles.connect).not.toHaveBeenCalled();
  });

  it.each([false, true])('closes the conversation before MCP cleanup when the screen fails=%s', async (fails) => {
    if (fails) doubles.mount.mockRejectedValueOnce(new Error('screen failed'));
    const run = runManager({ cwd: '/repository', agentOverrides: { model: 'chosen-model' } });
    if (fails) await expect(run).rejects.toThrow('screen failed');
    else await run;
    expect(doubles.plan).toHaveBeenCalledWith('/canonical/repository', { model: 'chosen-model' });
    expect(doubles.connect).toHaveBeenCalledWith('/canonical/repository', 'public key');
    expect(close).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(close.mock.invocationCallOrder[0]).toBeLessThan(dispose.mock.invocationCallOrder[0]!);
  });
});

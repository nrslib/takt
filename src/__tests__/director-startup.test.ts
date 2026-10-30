import type { ReactElement } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runDirector } from '../features/director/runDirector.js';
import { DirectorView } from '../features/director/DirectorView.js';

const doubles = vi.hoisted(() => ({ construct: vi.fn(), connect: vi.fn(), close: vi.fn(), mount: vi.fn() }));
vi.mock('../infra/daemon/ipcEndpoint.js', () => ({ resolveDaemonConfigDirectory: () => '/config' }));
vi.mock('../infra/config/index.js', () => ({ resolveConfigValue: () => 'ja' }));
vi.mock('../features/manager/conversationIpcClient.js', () => ({ ConversationIpcClient: class {
  constructor(...args: unknown[]) { doubles.construct(...args); }
  connect = doubles.connect;
  close = doubles.close;
} }));
vi.mock('../features/tui/inkMount.js', () => ({ mountInk: doubles.mount }));
const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
beforeEach(() => {
  vi.resetAllMocks();
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
  doubles.connect.mockResolvedValue(undefined);
  doubles.mount.mockImplementation(async (tree: (handlers: { settle(): void }) => ReactElement) => {
    const view = tree({ settle: vi.fn() });
    expect(view.type).toBe(DirectorView);
    expect(view.props).toMatchObject({ lang: 'ja' });
  });
});
afterEach(() => {
  for (const [stream, descriptor] of [[process.stdin, stdinTTY], [process.stdout, stdoutTTY]] as const) {
    if (descriptor !== undefined) Object.defineProperty(stream, 'isTTY', descriptor);
    else Reflect.deleteProperty(stream, 'isTTY');
  }
});

it('opens the same daemon conversation from different startup repositories and closes its client', async () => {
  for (const cwd of ['/repository-a', '/workspace-b']) {
    await runDirector({ cwd, agentOverrides: { provider: 'mock', model: 'chosen' } });
  }
  expect(doubles.construct.mock.calls).toEqual([
    [{ kind: 'daemon' }, { provider: 'mock', model: 'chosen' }],
    [{ kind: 'daemon' }, { provider: 'mock', model: 'chosen' }],
  ]);
  expect(doubles.connect).toHaveBeenCalledTimes(2);
  expect(doubles.close).toHaveBeenCalledTimes(2);
});

it('closes the client when connection fails and never mounts the screen', async () => {
  doubles.connect.mockRejectedValueOnce(new Error('daemon unavailable'));
  await expect(runDirector({ cwd: '/repository' })).rejects.toThrow();
  expect(doubles.close).toHaveBeenCalledOnce();
  expect(doubles.mount).not.toHaveBeenCalled();
});

it('rejects a noninteractive terminal before opening a connection', async () => {
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
  await expect(runDirector({ cwd: '/repository' })).rejects.toThrow();
  expect(doubles.construct).not.toHaveBeenCalled();
});

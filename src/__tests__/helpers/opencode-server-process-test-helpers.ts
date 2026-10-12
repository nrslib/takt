export interface OpenCodeServerTestStartOptions {
  port: number;
  timeoutMs: number;
  config: Record<string, unknown>;
}

interface OpenCodeSdkStartOptions {
  port: number;
  timeout: number;
  config: Record<string, unknown>;
}

interface OpenCodeSdkServer {
  close: () => void | Promise<void>;
  onError?: (listener: (error: Error) => void) => () => void;
}

interface OpenCodeSdkStartResult<TClient> {
  client: TClient;
  server: OpenCodeSdkServer;
}

export function createOpenCodeServerStartMock<TClient extends object>(
  createOpencode: (options: OpenCodeSdkStartOptions) => Promise<OpenCodeSdkStartResult<TClient>>,
): (options: OpenCodeServerTestStartOptions) => Promise<{
  client: TClient & { sdkState: { directory: string; stale: boolean } };
  close: () => void;
  onError: (listener: (error: Error) => void) => () => void;
}> {
  return async (options) => {
    const result = await createOpencode({
      port: options.port,
      timeout: options.timeoutMs,
      config: options.config,
    });
    return {
      client: Object.assign(result.client, { sdkState: { directory: '/test/managed/opencode', stale: false } }),
      close: async () => {
        await result.server.close();
      },
      onError: (listener) => result.server.onError?.(listener) ?? (() => {}),
    };
  };
}
import { vi } from 'vitest';

vi.mock('../../infra/opencode/runtime.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../infra/opencode/runtime.js')>(),
  openCodeRuntimeSelection: vi.fn(() => ({ generation: 'v1', command: 'opencode' })),
  resolveOpenCodeRuntime: vi.fn(async () => ({ generation: 'v1', command: 'opencode', version: '1.18.2' })),
}));

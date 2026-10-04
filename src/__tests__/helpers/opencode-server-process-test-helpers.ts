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

export function createOpenCodeServerStartMock<TClient>(
  createOpencode: (options: OpenCodeSdkStartOptions) => Promise<OpenCodeSdkStartResult<TClient>>,
): (options: OpenCodeServerTestStartOptions) => Promise<{
  client: TClient;
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
      client: result.client,
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
  resolveOpenCodeRuntime: vi.fn(async () => ({ generation: 'v1', command: 'opencode', version: '1.18.2' })),
}));

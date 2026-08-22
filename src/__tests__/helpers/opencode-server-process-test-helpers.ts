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
  close: () => void;
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
      close: result.server.close,
      onError: (listener) => result.server.onError?.(listener) ?? (() => {}),
    };
  };
}

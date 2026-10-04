/**
 * Mock provider MCP adapter (issue #1137).
 *
 * Exposes the resolved server names and transports for test inspection
 * (order.md:240-242). The deterministic tool call/result simulation itself
 * is owned by `callMock` via `recordMcpToolCall`; the adapter does not retain
 * fixture state. No temp files are created; `dispose` is a no-op.
 */

import type {
  ProviderMcpAdapter,
  ProviderMcpContext,
  PreparedProviderMcp,
  ResolvedMcpServers,
} from './types.js';
import { validateTransports, noopDispose, classifyMcpFailure } from './adapter.js';

export function createMockMcpAdapter(): ProviderMcpAdapter {
  return {
    validate(servers, context) {
      validateTransports('mock', servers, context);
    },
    async prepare(
      servers: ResolvedMcpServers,
      _context: ProviderMcpContext,
    ): Promise<PreparedProviderMcp> {
      const prepared: PreparedProviderMcp = {
        dispose: noopDispose,
        resolvedServers: servers,
      };
      return prepared;
    },
    classifyFailure(error) {
      return classifyMcpFailure(error);
    },
  };
}
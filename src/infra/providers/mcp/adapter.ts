/**
 * Shared helpers for provider MCP adapters (issue #1137).
 */

import type {
  ProviderMcpAdapter,
  ProviderMcpContext,
  ResolvedMcpServers,
  ProviderMcpValidationContext,
} from './types.js';
import { getProvider } from '../index.js';
import type { ProviderType } from '../../../shared/types/provider.js';
import { AGENT_FAILURE_CATEGORIES, type AgentFailureCategory } from '../../../shared/types/agent-failure.js';

/**
 * Fail-fast when any resolved server uses a transport the provider does not
 * support. The error names the provider, server, transport, supported
 * transports, and the runtime.yaml source path (order.md:245-262).
 */
export function validateTransports(
  provider: ProviderType,
  servers: ResolvedMcpServers,
  context: ProviderMcpValidationContext | undefined,
): void {
  if (!servers.enabled) {
    return;
  }
  const supported = getProvider(provider).supportedMcpTransports;
  if (supported === undefined || supported.size === 0) {
    if (Object.keys(servers.servers).length === 0) {
      return;
    }
    const firstEntry = Object.entries(servers.servers)[0];
    if (firstEntry === undefined) {
      return;
    }
    const [serverName, server] = firstEntry;
    throw new Error(
      buildUnsupportedError(provider, serverName, server.type ?? 'stdio', context),
    );
  }
  for (const [name, server] of Object.entries(servers.servers)) {
    const transport = server.type ?? 'stdio';
    if (!supported.has(transport)) {
      throw new Error(
        buildUnsupportedError(provider, name, transport, context),
      );
    }
  }
}

/** Adapter used for providers whose capability set intentionally has no MCP transport. */
export function createUnsupportedMcpAdapter(provider: ProviderType): ProviderMcpAdapter {
  return {
    validate(servers, context) {
      validateTransports(provider, servers, context);
    },
    async prepare(servers: ResolvedMcpServers, context: ProviderMcpContext) {
      validateTransports(provider, servers, {
        ...(context.sourcePath !== undefined ? { sourcePath: context.sourcePath } : {}),
      });
      return { dispose: noopDispose };
    },
    classifyFailure(error) {
      return classifyMcpFailure(error);
    },
  };
}

function buildUnsupportedError(
  provider: ProviderType,
  serverName: string,
  transport: string | undefined,
  context: ProviderMcpValidationContext | undefined,
): string {
  const supported = getProvider(provider).supportedMcpTransports;
  const supportedList = supported === undefined || supported.size === 0
    ? '(none)'
    : [...supported].join(', ');
  const transportPart = transport === undefined
    ? ''
    : ` does not support MCP transport "${transport}"\nfor server "${serverName}".`;
  const sourcePart = context?.sourcePath !== undefined
    ? `\nSource: ${context.sourcePath}`
    : '';
  const header = transport === undefined
    ? `Provider "${provider}" does not support MCP servers for server "${serverName}".`
    : `Provider "${provider}"${transportPart}`;
  return `${header}\nSupported transports: ${supportedList}.${sourcePart}`;
}

/** No-op dispose helper for adapters that own no temp artifacts. */
export async function noopDispose(): Promise<void> {}

/** Build a dispose that runs `fn` exactly once. */
export function onceDispose(fn: () => Promise<void>): () => Promise<void> {
  let called = false;
  return async () => {
    if (called) {
      return;
    }
    called = true;
    await fn();
  };
}

/**
 * Classify an MCP-related failure into a provider error category
 * (order.md:271,334). Shared by all provider adapters so the mapping is
 * consistent:
 *   - abort (AbortError / DOMException / signal aborted) → `external_abort`
 *   - timeout (message contains "timeout") → `part_timeout`
 *   - startup failure / tool failure / any other error → `provider_error`
 */
export function classifyMcpFailure(error: unknown): { category: AgentFailureCategory } {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return { category: AGENT_FAILURE_CATEGORIES.EXTERNAL_ABORT };
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return { category: AGENT_FAILURE_CATEGORIES.EXTERNAL_ABORT };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/timeout|timed out/i.test(message)) {
    return { category: AGENT_FAILURE_CATEGORIES.PART_TIMEOUT };
  }
  return { category: AGENT_FAILURE_CATEGORIES.PROVIDER_ERROR };
}

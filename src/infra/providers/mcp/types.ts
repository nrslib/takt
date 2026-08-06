/**
 * Provider MCP adapter types (issue #1137).
 *
 * The adapter boundary separates MCP assignment resolution (which servers to
 * assign) from provider-specific config format conversion (how to pass them).
 * The engine never branches on provider names; each provider adapter owns its
 * temp files, args, SDK options, and cleanup (order.md:122-153).
 */

import type { McpServerConfig } from '../../../core/models/index.js';
import type { McpStdioServerConfig } from '../../../core/models/workflow-provider-options.js';
import type { ResolvedMcpServers } from '../../config/runtime-provider/mcp-assignment.js';
import type { AgentFailureCategory } from '../../../shared/types/agent-failure.js';
import type { PermissionMode } from '../../../core/models/status.js';

export type { ResolvedMcpServers, McpServerConfig };

/** Type guards for narrowing `McpServerConfig` union. */
export function isStdioServer(server: McpServerConfig): server is McpStdioServerConfig {
  return server.type === 'stdio' || server.type === undefined;
}

/** Context passed to `ProviderMcpAdapter.prepare`. */
export interface ProviderMcpContext {
  cwd: string;
  abortSignal?: AbortSignal;
  /** Optional source path for error messages (e.g. `<project>/.takt/runtime.yaml`). */
  sourcePath?: string;
  /** Optional provider-specific env override passed to child processes. */
  childProcessEnv?: Readonly<Record<string, string>>;
  /**
   * TAKT permission mode for the agent execution. Adapters that surface MCP
   * tool approval flags must keep them consistent with this mode so MCP tool
   * permission does not contradict TAKT's permission mode (order.md:220).
   */
  permissionMode?: PermissionMode;
}

/**
 * Result of `ProviderMcpAdapter.prepare`. The adapter owns any temp files or
 * SDK options it produced; `dispose` must clean them up on success, failure,
 * abort, and timeout (order.md:151,334). Calling `dispose` more than once must
 * not throw.
 *
 * The optional fields carry provider-specific materialized config (SDK
 * options, CLI args, temp file paths). The engine does not read these — they
 * are owned by the adapter and inspected only by tests and the provider
 * client that merges them into its call.
 */
export interface PreparedProviderMcp {
  /** Cleanup all temp artifacts. Must be safe to call multiple times. */
  dispose(): Promise<void>;
  /** Claude Agent SDK options (`mcpServers`/`strictMcpConfig`). */
  sdkOptions?: { mcpServers?: Record<string, unknown>; strictMcpConfig?: boolean };
  /** CLI args to append when launching a CLI provider. */
  args?: string[];
  /** Temp file path for cleanup verification. */
  path?: string;
  /** Codex `CodexOptions.config` to merge. */
  config?: { mcp_servers?: Record<string, unknown> };
  /** OpenCode SDK server config to merge into `createOpencode`. */
  serverConfig?: Record<string, unknown>;
  /** Identity of the resolved set (for shared server pool isolation). */
  identity?: string;
  /** Isolated workspace config root (Cursor). */
  configRoot?: string;
  /** Resolved server set for test inspection (Mock). */
  resolvedServers?: ResolvedMcpServers;
}

/** Validation context for `ProviderMcpAdapter.validate`. */
export interface ProviderMcpValidationContext {
  /** Source path to include in fail-fast error messages (order.md:259). */
  sourcePath?: string;
}

/**
 * Provider MCP adapter interface. The engine calls `validate` to fail-fast on
 * unsupported transports before agent startup, then `prepare` to materialize
 * the provider-specific config (SDK options, CLI args, temp files).
 * `classifyFailure` translates an MCP-related error into the provider's
 * failure category so the engine reports it consistently (order.md:271,334).
 */
export interface ProviderMcpAdapter {
  /** Fail-fast when the provider does not support a transport in the set. */
  validate(
    servers: ResolvedMcpServers,
    context?: ProviderMcpValidationContext,
  ): void;
  /** Materialize provider-specific MCP config and own temp artifacts. */
  prepare(
    servers: ResolvedMcpServers,
    context: ProviderMcpContext,
  ): Promise<PreparedProviderMcp>;
  /**
   * Classify an MCP-related failure into a provider error category
   * (order.md:271,334). startup failure → `provider_error`,
   * abort → `external_abort`, timeout → `part_timeout`,
   * tool failure → `provider_error`.
   */
  classifyFailure(error: unknown): { category: AgentFailureCategory };
}
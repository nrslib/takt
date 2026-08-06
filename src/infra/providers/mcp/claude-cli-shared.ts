/**
 * Shared Claude CLI MCP adapter factory (issue #1137).
 *
 * `claude` (headless) and `claude-terminal` use the same temp-file-based MCP
 * config generation; only the provider name passed to `validateTransports`
 * differs. This factory keeps that single body in one place so the two
 * adapters are thin wrappers (Policy「DRY」).
 */

import type {
  ProviderMcpAdapter,
  ProviderMcpContext,
  PreparedProviderMcp,
  ResolvedMcpServers,
} from './types.js';
import { validateTransports, onceDispose, classifyMcpFailure } from './adapter.js';
import { prepareClaudeMcpConfig } from '../../claude/mcp-config.js';

export type ClaudeCliProvider = 'claude' | 'claude-terminal';

export function createClaudeCliMcpAdapter(provider: ClaudeCliProvider): ProviderMcpAdapter {
  return {
    validate(servers, context) {
      validateTransports(provider, servers, context);
    },
    async prepare(
      servers: ResolvedMcpServers,
      _context: ProviderMcpContext,
    ): Promise<PreparedProviderMcp> {
      if (!servers.enabled || Object.keys(servers.servers).length === 0) {
        // Empty set: MCP is disabled (order.md:152) but `--strict-mcp-config`
        // is still emitted so ambient project/user/plugin MCP config is not
        // silently loaded (order.md:166,172). The adapter does not know
        // whether runtime MCP mode is active; the runner boundary decides
        // whether to call `prepare` at all for an empty set.
        return { dispose: () => Promise.resolve(), args: ['--strict-mcp-config'] };
      }
      const prepared = await prepareClaudeMcpConfig(servers.servers);
      const args: string[] = ['--strict-mcp-config'];
      if (prepared.path !== undefined) {
        args.push('--mcp-config', prepared.path);
      }
      return {
        args,
        path: prepared.path,
        dispose: onceDispose(prepared.cleanup),
      };
    },
    classifyFailure(error) {
      return classifyMcpFailure(error);
    },
  };
}
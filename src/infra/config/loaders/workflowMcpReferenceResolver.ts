/**
 * Workflow `mcp:` reference resolution (issue #1208 Stage 1).
 *
 * A step / sub-step `mcp: [name, ...]` reference resolves against the workflow's top-level
 * `mcp_servers` definitions (the portable, bundled defaults). An unresolved name fails fast at load
 * time — never a silent drop. The runtime.yaml override layer (`order.md:110` runtime > workflow >
 * error) is additive and lands in a later stage; here the workflow-bundled definitions are the
 * resolution source. Pre-existing inline step `mcp_servers` definitions (deprecated, maintained)
 * keep working and win over a reference on a name collision, so an explicit inline override is not
 * shadowed by a bundled default.
 */

import type { McpServerConfig } from '../../../core/models/index.js';
import { withWorkflowConfigErrorPath } from '../../../core/workflow/workflow-config-error.js';

export function resolveWorkflowMcpReferences(
  stepName: string,
  refs: readonly string[] | undefined,
  definitions: Record<string, McpServerConfig> | undefined,
  inline: Record<string, McpServerConfig> | undefined,
  stepPath: readonly PropertyKey[],
): Record<string, McpServerConfig> | undefined {
  if (refs === undefined || refs.length === 0) {
    return inline;
  }
  const resolved: Record<string, McpServerConfig> = {};
  refs.forEach((name, index) => {
    // 自前プロパティに限定する。素の索引では `toString` 等が `Object.prototype` 経由で
    // 解決され、関数が MCP サーバー定義として通ってしまう。
    const definition = definitions !== undefined && Object.hasOwn(definitions, name)
      ? definitions[name]
      : undefined;
    if (definition === undefined) {
      throw withWorkflowConfigErrorPath(
        new Error(
          `Configuration error: step "${stepName}" references MCP server "${name}", `
          + 'which is not defined at the workflow top level (`mcp_servers`)',
        ),
        [...stepPath, 'mcp', index],
      );
    }
    resolved[name] = definition;
  });
  return { ...resolved, ...(inline ?? {}) };
}

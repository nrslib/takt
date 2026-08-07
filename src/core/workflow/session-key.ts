/**
 * Session key generation for persona sessions.
 *
 * When multiple steps share the same persona but use different providers
 * (e.g., claude-eye uses Claude, codex-eye uses Codex, both with persona "coder"),
 * sessions must be keyed by provider and model to prevent incompatible resume.
 *
 * Without provider in the key, a Codex session ID could overwrite a Claude session,
 * causing Claude to attempt resuming a non-existent session file (exit code 1).
 */

import type { WorkflowStep } from '../models/types.js';
import type { ProviderType } from '../../shared/types/provider.js';

export interface ResolvedSessionTarget {
  provider?: ProviderType;
  model?: string;
  /** Deterministic MCP server set identity (server name + transport only). */
  mcpServerIdentity?: string;
}

/**
 * Build a unique session key for a step.
 *
 * - Base key: `step.sessionKey ?? step.persona ?? step.name`
 * - A resolved provider and model are encoded with the base key as a JSON tuple
 *   to disambiguate arbitrary component values.
 *
 * sessionKey is validated at parse time by Zod (z.string().trim().min(1).optional()),
 * so it is guaranteed to be a non-empty, trimmed string when present.
 *
 * Examples:
 *   - persona="coder", provider=undefined  → `["coder"]`
 *   - persona="coder", provider="claude", model="sonnet" → `["coder","claude","sonnet"]`
 *   - persona="coder", provider="codex", model="gpt-5" → `["coder","codex","gpt-5"]`
 *   - persona=undefined, name="plan"       → `["plan"]`
 */
export function buildSessionKey(step: WorkflowStep, resolvedTarget?: ResolvedSessionTarget): string {
  const base = step.sessionKey ?? step.persona ?? step.name;
  const provider = resolvedTarget === undefined ? step.provider : resolvedTarget.provider;
  const model = resolvedTarget === undefined ? step.model : resolvedTarget.model;
  const rawMcpIdentity = resolvedTarget?.mcpServerIdentity;
  // Normalize the MCP identity so the session key is order-independent: the
  // identity is a comma-separated `name:transport` list and is sorted before
  // being folded into the key (order.md:269,333).
  const mcpIdentity = rawMcpIdentity !== undefined && rawMcpIdentity.length > 0
    ? rawMcpIdentity.split(',').map((part) => part.trim()).filter((part) => part.length > 0).sort().join(',')
    : undefined;
  if (provider === undefined && mcpIdentity === undefined) return JSON.stringify([base]);
  const components: unknown[] = [base];
  if (provider !== undefined) {
    components.push(provider);
    if (model !== undefined) {
      components.push(model);
    }
  }
  if (mcpIdentity !== undefined && mcpIdentity.length > 0) {
    components.push(mcpIdentity);
  }
  return JSON.stringify(components);
}

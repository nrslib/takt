/**
 * Session key generation for persona sessions.
 *
 * When multiple steps share the same persona but use different providers
 * (e.g., claude-eye uses Claude, codex-eye uses Codex, both with persona "coder"),
 * sessions must be keyed by provider to prevent cross-provider contamination.
 *
 * Without provider in the key, a Codex session ID could overwrite a Claude session,
 * causing Claude to attempt resuming a non-existent session file (exit code 1).
 */

import type { WorkflowStep } from '../models/types.js';
import type { ProviderType } from '../../shared/types/provider.js';

/**
 * Build a unique session key for a step.
 *
 * - Base key: `step.sessionKey ?? step.persona ?? step.name`
 * - If the step specifies a provider, appends `:{provider}` to disambiguate
 *
 * Examples:
 *   - persona="coder", provider=undefined  → "coder"
 *   - persona="coder", provider="claude"   → "coder:claude"
 *   - persona="coder", provider="codex"    → "coder:codex"
 *   - persona=undefined, name="plan"       → "plan"
 */
function resolveSessionKeyBase(step: WorkflowStep): string {
  if (step.sessionKey !== undefined) {
    const sessionKey = step.sessionKey.trim();
    if (sessionKey.length === 0) {
      throw new Error(`Invalid session_key for step "${step.name}": expected non-empty string`);
    }
    return sessionKey;
  }
  return step.persona ?? step.name;
}

export function buildSessionKey(step: WorkflowStep, providerOverride?: ProviderType): string {
  const base = resolveSessionKeyBase(step);
  const provider = providerOverride ?? step.provider;
  return provider ? `${base}:${provider}` : base;
}

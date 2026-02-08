/**
 * Session key generation for persona sessions.
 *
 * When multiple movements share the same persona but use different providers
 * (e.g., claude-eye uses Claude, codex-eye uses Codex, both with persona "coder"),
 * sessions must be keyed by provider to prevent cross-provider contamination.
 *
 * Without provider in the key, a Codex session ID could overwrite a Claude session,
 * causing Claude to attempt resuming a non-existent session file (exit code 1).
 */

import type { PieceMovement } from '../models/types.js';

/**
 * Build a unique session key for a movement.
 *
 * - Base key: `step.persona ?? step.name`
 * - If the movement specifies a provider, appends `:{provider}` to disambiguate
 *
 * Examples:
 *   - persona="coder", provider=undefined  → "coder"
 *   - persona="coder", provider="claude"   → "coder:claude"
 *   - persona="coder", provider="codex"    → "coder:codex"
 *   - persona=undefined, name="plan"       → "plan"
 */
export function buildSessionKey(step: PieceMovement): string {
  const base = step.persona ?? step.name;
  return step.provider ? `${base}:${step.provider}` : base;
}

/**
 * Utility functions for Claude client operations.
 *
 * Stateless helpers for rule detection and regex safety validation.
 */

/**
 * Detect rule index from numbered tag pattern [STEP_NAME:N].
 * Returns 0-based rule index, or -1 if no match.
 *
 * Example: detectRuleIndex("... [PLAN:2] ...", "plan") → 1
 */
export function detectRuleIndex(content: string, movementName: string): number {
  const tag = movementName.toUpperCase();
  const regex = new RegExp(`\\[${tag}:(\\d+)\\]`, 'gi');
  const matches = [...content.matchAll(regex)];
  const match = matches.at(-1);
  if (match?.[1]) {
    const index = Number.parseInt(match[1], 10) - 1;
    return index >= 0 ? index : -1;
  }
  return -1;
}

/** Validate regex pattern for ReDoS safety */
export function isRegexSafe(pattern: string): boolean {
  if (pattern.length > 200) {
    return false;
  }

  const dangerousPatterns = [
    /\(\.\*\)\+/,      // (.*)+
    /\(\.\+\)\*/,      // (.+)*
    /\(\.\*\)\*/,      // (.*)*
    /\(\.\+\)\+/,      // (.+)+
    /\([^)]*\|[^)]*\)\+/, // (a|b)+
    /\([^)]*\|[^)]*\)\*/, // (a|b)*
  ];

  for (const dangerous of dangerousPatterns) {
    if (dangerous.test(pattern)) {
      return false;
    }
  }

  return true;
}

/**
 * Detect candidate index from numbered tag pattern [STEP_NAME:N].
 * Returns a 0-based semantic candidate index, or -1 if no match.
 */
export function detectCandidateIndex(content: string, stepName: string): number {
  const tag = stepName.toUpperCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`\\[${tag}:(\\d+)\\]`, 'gi');
  const matches = [...content.matchAll(regex)];
  const match = matches.at(-1);
  if (match?.[1]) {
    const index = Number.parseInt(match[1], 10) - 1;
    return index >= 0 ? index : -1;
  }
  return -1;
}

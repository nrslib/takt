const TASK_STATE_REFERENCE_PREFIX = '\u001eTAKT_TASK_REFERENCE_RUN_SLUG:';
const TASK_STATE_REFERENCE_SUFFIX = '\u001f';

function parseRunSlug(value: string): string | undefined {
  const slug = value.trim();
  return slug.length === 0 || slug === '.' || slug === '..' || /[\\/]/u.test(slug)
    ? undefined
    : slug;
}

/**
 * Internal metadata emitted only by the read-only task-state MCP server.
 * Control characters make this distinct from JSON or quoted report text.
 */
export function formatTaskStateReferenceMarker(runSlug: string): string {
  const parsed = parseRunSlug(runSlug);
  if (parsed === undefined) {
    throw new Error(`Invalid task-state reference run slug: ${runSlug}`);
  }
  return `${TASK_STATE_REFERENCE_PREFIX}${encodeURIComponent(parsed)}${TASK_STATE_REFERENCE_SUFFIX}`;
}

/** Read the internal reference metadata without interpreting ordinary tool text. */
export function parseTaskStateReferenceMarker(value: string): string | undefined {
  const start = value.lastIndexOf(TASK_STATE_REFERENCE_PREFIX);
  if (start === -1) {
    return undefined;
  }
  const encodedStart = start + TASK_STATE_REFERENCE_PREFIX.length;
  const end = value.indexOf(TASK_STATE_REFERENCE_SUFFIX, encodedStart);
  if (end === -1) {
    return undefined;
  }
  try {
    return parseRunSlug(decodeURIComponent(value.slice(encodedStart, end)));
  } catch {
    return undefined;
  }
}

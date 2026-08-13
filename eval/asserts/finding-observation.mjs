const FINDING_ID_PATTERN = /\b[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-\d+\b/g;
const FINDING_BLOCK_PATTERN = /<finding\s+id=["']([^"']+)["']\s*>([\s\S]*?)<\/finding>/gi;
const FINDING_TAG_PATTERN = /<\/?finding\b/gi;

export function extractFindingObservation(output, targetFinding) {
  const findingIds = new Set(output.match(FINDING_ID_PATTERN) ?? []);
  const blocks = [...output.matchAll(FINDING_BLOCK_PATTERN)];
  const tagCount = output.match(FINDING_TAG_PATTERN)?.length ?? 0;
  const [block] = blocks;
  const onlyTargetFinding = findingIds.size === 1
    && findingIds.has(targetFinding)
    && blocks.length === 1
    && tagCount === 2
    && block[1] === targetFinding;

  return {
    onlyTargetFinding,
    context: onlyTargetFinding ? block[2].trim() : '',
  };
}

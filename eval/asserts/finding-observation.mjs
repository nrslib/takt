const FINDING_ID_PATTERN = /\b[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-\d+\b/g;
const FINDING_BLOCK_PATTERN = /<finding\s+id=["']([^"']+)["']\s*>([\s\S]*?)<\/finding>/gi;
const FINDING_TAG_PATTERN = /<\/?finding(?=\s|\/?>)/gi;
const FINDING_FIELDS = new Set([
  'result',
  'disposition',
  'authority',
  'family',
  'winner',
  'preserved',
  'source_contradiction',
  'weakening',
  'evidence',
]);

function parseFindingFields(context) {
  const values = new Map();
  let currentField;

  for (const line of context.split('\n')) {
    const match = line.match(/^([a-z][a-z0-9_-]*)\s*[:：]\s*(.*)$/i);
    const field = match?.[1].toLowerCase();
    if (field && FINDING_FIELDS.has(field)) {
      const occurrences = values.get(field) ?? [];
      occurrences.push([match[2]]);
      values.set(field, occurrences);
      currentField = field;
      continue;
    }

    if (currentField) {
      values.get(currentField).at(-1).push(line);
    }
  }

  return Object.fromEntries(
    [...FINDING_FIELDS].map((field) => {
      const occurrences = values.get(field) ?? [];
      return [field, {
        count: occurrences.length,
        value: occurrences.length === 1 ? occurrences[0].join('\n').trim() : '',
      }];
    }),
  );
}

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
    fields: onlyTargetFinding ? parseFindingFields(block[2].trim()) : {},
  };
}

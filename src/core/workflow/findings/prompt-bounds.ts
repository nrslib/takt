import { RAW_FINDING_FIELD_LIMITS } from '../../models/finding-contract-limits.js';

export const FINDING_MANAGER_INPUT_MAX_BYTES = 24_000;

export const FINDING_MANAGER_PROMPT_FIELD_LIMITS = {
  rawTitleMaxBytes: 640,
  rawDescriptionMaxBytes: 1_536,
  rawSuggestionMaxBytes: 512,
  rawExcerptMaxBytes: 768,
  targetLiteralMaxBytes: 512,
  targetMaxBytes: 1_024,
  targetCollectionItemMaxBytes: 256,
  evidenceArrayMaxBytes: 1_536,
  evidenceMaxItems: 4,
  evidenceVerbatimExcerptMaxBytes: 768,
  ledgerTitleMaxBytes: 512,
  ledgerDescriptionMaxBytes: 768,
  ledgerSuggestionMaxBytes: 384,
  ledgerLocationMaxBytes: 512,
  ledgerMaxLocations: 4,
  provisionalReasonMaxBytes: 384,
  conflictReasonMaxBytes: 384,
  reviewerMaxBytes: 256,
  stepNameMaxBytes: 256,
  familyTagMaxBytes: 256,
} as const;

export const FINDING_MANAGER_PROMPT_BUDGET_ITEM_COUNT = 1;

export interface PromptTruncationMarker {
  kind: 'takt_prompt_truncation_v1';
  omittedUtf8Bytes: number;
}

export interface PromptArrayTruncationMarker {
  kind: 'takt_prompt_truncation_v1';
  omittedCount: number;
}

const PROMPT_TRUNCATION_MARKER_KIND = 'takt_prompt_truncation_v1' as const;

export function promptJsonUtf8Bytes(value: unknown): number {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? 0 : Buffer.byteLength(serialized, 'utf8');
}

export const MIN_PROMPT_STRING_TRUNCATION_MARKER_BYTES = promptJsonUtf8Bytes({
  kind: PROMPT_TRUNCATION_MARKER_KIND,
  omittedUtf8Bytes: 1,
});

export const MIN_PROMPT_ARRAY_TRUNCATION_MARKER_BYTES = promptJsonUtf8Bytes({
  kind: PROMPT_TRUNCATION_MARKER_KIND,
  omittedCount: 1,
});

function truncationMarkerBytes(marker: PromptTruncationMarker): number {
  return promptJsonUtf8Bytes(marker);
}

function promptStringCandidate(
  codePoints: readonly string[],
  retainedCount: number,
): string {
  return codePoints.slice(0, retainedCount).join('');
}

export function boundPromptString(input: {
  value: string;
  fieldPath: string;
  maxRenderedBytes: number;
}): { text: string; truncation?: PromptTruncationMarker } {
  const originalUtf8Bytes = Buffer.byteLength(input.value, 'utf8');
  if (promptJsonUtf8Bytes(input.value) <= input.maxRenderedBytes) {
    return { text: input.value };
  }

  const codePoints = [...input.value];
  for (let retainedCount = codePoints.length; retainedCount >= 0; retainedCount -= 1) {
    const text = promptStringCandidate(codePoints, retainedCount);
    const retainedUtf8Bytes = Buffer.byteLength(text, 'utf8');
    const truncation: PromptTruncationMarker = {
      kind: PROMPT_TRUNCATION_MARKER_KIND,
      omittedUtf8Bytes: originalUtf8Bytes - retainedUtf8Bytes,
    };
    if (
      promptJsonUtf8Bytes(text) + truncationMarkerBytes(truncation)
      <= input.maxRenderedBytes
    ) {
      return { text, truncation };
    }
  }

  return {
    text: '',
    truncation: {
      kind: PROMPT_TRUNCATION_MARKER_KIND,
      omittedUtf8Bytes: originalUtf8Bytes,
    },
  };
}

export function boundPromptArray<T>(input: {
  items: readonly T[];
  fieldPath: string;
  maxItems: number;
  maxRenderedBytes: number;
}): { items: T[]; truncation?: PromptArrayTruncationMarker } {
  const itemCount = Math.min(input.items.length, input.maxItems);
  for (let retainedCount = itemCount; retainedCount >= 0; retainedCount -= 1) {
    const omittedCount = input.items.length - retainedCount;
    const items = input.items.slice(0, retainedCount);
    if (omittedCount === 0 && promptJsonUtf8Bytes({ items }) <= input.maxRenderedBytes) {
      return { items };
    }
    const truncation: PromptArrayTruncationMarker = {
      kind: PROMPT_TRUNCATION_MARKER_KIND,
      omittedCount,
    };
    if (promptJsonUtf8Bytes({ items, truncation }) <= input.maxRenderedBytes) {
      return { items, truncation };
    }
  }

  return {
    items: [],
    truncation: {
      kind: PROMPT_TRUNCATION_MARKER_KIND,
      omittedCount: input.items.length,
    },
  };
}


/** 切り詰めが無ければ素の配列として埋め込む(マーカーは切り詰め時のみ現れる)。 */
export function promptArrayView<T>(bounded: {
  items: T[];
  truncation?: PromptArrayTruncationMarker;
}): unknown {
  return bounded.truncation === undefined ? bounded.items : bounded;
}

function fencedJsonSectionBytes(label: string, value: unknown): number {
  return Buffer.byteLength(
    [label, '```json', JSON.stringify(value, null, 2), '```'].join('\n'),
    'utf8',
  );
}

function boundedPromptField(
  value: string,
  maxRenderedBytes: number,
): Record<string, unknown> {
  const bounded = boundPromptString({
    value,
    fieldPath: 'budget',
    maxRenderedBytes,
  });
  return {
    text: bounded.text,
    ...(bounded.truncation === undefined ? {} : { truncation: bounded.truncation }),
  };
}

function rawReportExcerptBudget(): number {
  const boundedField = (
    field: string,
    value: string,
    maxRenderedBytes: number,
  ): Record<string, unknown> => {
    const bounded = boundedPromptField(value, maxRenderedBytes);
    return {
      [field]: bounded.text,
      ...(bounded.truncation === undefined ? {} : { [`${field}Truncation`]: bounded.truncation }),
    };
  };
  const item = {
    rawFindingId: '',
    ...boundedField(
      'title',
      'x'.repeat(RAW_FINDING_FIELD_LIMITS.maxTitleChars),
      FINDING_MANAGER_PROMPT_FIELD_LIMITS.rawTitleMaxBytes,
    ),
    ...boundedField(
      'description',
      'x'.repeat(RAW_FINDING_FIELD_LIMITS.maxDescriptionChars),
      FINDING_MANAGER_PROMPT_FIELD_LIMITS.rawDescriptionMaxBytes,
    ),
    ...boundedField(
      'suggestion',
      'x'.repeat(RAW_FINDING_FIELD_LIMITS.maxSuggestionChars),
      FINDING_MANAGER_PROMPT_FIELD_LIMITS.rawSuggestionMaxBytes,
    ),
    ...boundedField(
      'rawExcerpt',
      'x'.repeat(RAW_FINDING_FIELD_LIMITS.maxDescriptionChars),
      FINDING_MANAGER_PROMPT_FIELD_LIMITS.rawExcerptMaxBytes,
    ),
  };
  return fencedJsonSectionBytes('## Report excerpts', { items: [item] });
}

function rawQuoteWindowBudget(): number {
  const boundedField = (
    field: string,
    value: string,
    maxRenderedBytes: number,
  ): Record<string, unknown> => {
    const bounded = boundedPromptField(value, maxRenderedBytes);
    return {
      [field]: bounded.text,
      ...(bounded.truncation === undefined ? {} : { [`${field}Truncation`]: bounded.truncation }),
    };
  };
  const evidenceEntry = {
    kind: 'file_quote',
    startLine: 1,
    endLine: 2,
    snapshotId: '0'.repeat(64),
    ...boundedField(
      'path',
      'x'.repeat(RAW_FINDING_FIELD_LIMITS.maxEvidencePathChars),
      FINDING_MANAGER_PROMPT_FIELD_LIMITS.targetCollectionItemMaxBytes,
    ),
    ...boundedField(
      'verbatimExcerpt',
      'x'.repeat(RAW_FINDING_FIELD_LIMITS.maxVerbatimExcerptChars),
      FINDING_MANAGER_PROMPT_FIELD_LIMITS.evidenceVerbatimExcerptMaxBytes,
    ),
  };
  const evidence = boundPromptArray({
    items: Array.from(
      { length: FINDING_MANAGER_PROMPT_FIELD_LIMITS.evidenceMaxItems },
      () => evidenceEntry,
    ),
    fieldPath: 'budget.evidence',
    maxItems: FINDING_MANAGER_PROMPT_FIELD_LIMITS.evidenceMaxItems,
    maxRenderedBytes: FINDING_MANAGER_PROMPT_FIELD_LIMITS.evidenceArrayMaxBytes,
  });
  return fencedJsonSectionBytes(
    '## Byte-exact quote windows',
    { items: [{ rawFindingId: '', evidence }] },
  );
}

function rawManifestViewBudget(itemCount: number): number {
  const item = {
    rawFindingId: '',
    componentId: '0'.repeat(64),
    relation: 'resolution_confirmation',
    targetFindingId: 'F'.repeat(RAW_FINDING_FIELD_LIMITS.maxFindingIdChars),
    // targetMaxBytes is the compact JSON bound for the already bounded target view.
    target: 'x'.repeat(FINDING_MANAGER_PROMPT_FIELD_LIMITS.targetMaxBytes),
  };
  return fencedJsonSectionBytes(
    '## Task manifest',
    {
      taskId: '0'.repeat(64),
      rawFindings: Array.from({ length: itemCount }, () => item),
    },
  );
}

export const FINDING_MANAGER_PROMPT_MANIFEST_ROW_FIXED_BYTES = (
  rawManifestViewBudget(FINDING_MANAGER_PROMPT_BUDGET_ITEM_COUNT)
  - rawManifestViewBudget(0)
);

function rawManifestBudget(): number {
  return rawManifestViewBudget(0)
    + FINDING_MANAGER_PROMPT_MANIFEST_ROW_FIXED_BYTES
      * FINDING_MANAGER_PROMPT_BUDGET_ITEM_COUNT;
}

function contextCoverageBudget(): number {
  const candidateId = 'F'.repeat(RAW_FINDING_FIELD_LIMITS.maxFindingIdChars);
  return fencedJsonSectionBytes('## Context coverage', {
    candidateFindingCount: FINDING_MANAGER_PROMPT_BUDGET_ITEM_COUNT,
    candidateFindingIdsDigest: '0'.repeat(64),
    selectedFindingIds: [candidateId],
    selectedConflictCount: 0,
    selectedConflictIdsDigest: '0'.repeat(64),
    locusCandidateCount: FINDING_MANAGER_PROMPT_BUDGET_ITEM_COUNT,
    locusCandidateIdsDigest: '0'.repeat(64),
  });
}

export const FINDING_MANAGER_PROMPT_CONTEXT_COVERAGE_MAX_BYTES = contextCoverageBudget();

function ledgerProjectionBudget(): number {
  const finding = {
    id: 'F'.repeat(RAW_FINDING_FIELD_LIMITS.maxFindingIdChars),
    revision: 1,
    status: 'open',
    lifecycle: 'new',
    severity: 'high',
    title: 'x'.repeat(FINDING_MANAGER_PROMPT_FIELD_LIMITS.ledgerTitleMaxBytes),
    target: 'x'.repeat(FINDING_MANAGER_PROMPT_FIELD_LIMITS.targetMaxBytes),
    targetIdentityHash: '0'.repeat(64),
    claimIdentityHash: '0'.repeat(64),
    semanticClaimIdentityHash: '0'.repeat(64),
    locations: 'x'.repeat(FINDING_MANAGER_PROMPT_FIELD_LIMITS.ledgerLocationMaxBytes),
    description: 'x'.repeat(FINDING_MANAGER_PROMPT_FIELD_LIMITS.ledgerDescriptionMaxBytes),
    suggestion: 'x'.repeat(FINDING_MANAGER_PROMPT_FIELD_LIMITS.ledgerSuggestionMaxBytes),
    reviewers: [],
    rawFindingIds: [],
    evidenceDetails: 'x'.repeat(FINDING_MANAGER_PROMPT_FIELD_LIMITS.evidenceArrayMaxBytes),
    firstSeen: null,
    lastSeen: null,
    waivers: [],
    disputes: [],
  };
  return fencedJsonSectionBytes(
    '## Relevant ledger projection',
    { workflowName: '', nextId: 0, updatedAt: '', findings: [finding], conflicts: [] },
  );
}

const RAW_FINDING_ID_EMPTY_JSON_BYTES = promptJsonUtf8Bytes('');

export const FINDING_MANAGER_PROMPT_BUDGETS = {
  fixedPrefixMaxBytes: 9_000,
  structureMaxBytes: 1_000,
  // Sections are allocated for the smallest split unit: one raw task item.
  manifestMaxBytes: rawManifestBudget() + FINDING_MANAGER_PROMPT_CONTEXT_COVERAGE_MAX_BYTES,
  quoteWindowsMaxBytes: rawQuoteWindowBudget(),
  reportExcerptsMaxBytes: rawReportExcerptBudget(),
  ledgerProjectionMaxBytes: ledgerProjectionBudget(),
  certificateMaxBytes: FINDING_MANAGER_INPUT_MAX_BYTES,
} as const;

export function rawTaskSectionBudget(
  section: 'manifest' | 'quoteWindows' | 'reportExcerpts' | 'ledgerProjection',
  rawFindingIds: readonly string[],
): number {
  const baseBudget = {
    manifest: FINDING_MANAGER_PROMPT_BUDGETS.manifestMaxBytes,
    quoteWindows: FINDING_MANAGER_PROMPT_BUDGETS.quoteWindowsMaxBytes,
    reportExcerpts: FINDING_MANAGER_PROMPT_BUDGETS.reportExcerptsMaxBytes,
    ledgerProjection: FINDING_MANAGER_PROMPT_BUDGETS.ledgerProjectionMaxBytes,
  }[section];
  const idBytes = rawFindingIds.reduce(
    (sum, rawFindingId) => sum + promptJsonUtf8Bytes(rawFindingId),
    0,
  );
  return baseBudget + idBytes
    - (FINDING_MANAGER_PROMPT_BUDGET_ITEM_COUNT * RAW_FINDING_ID_EMPTY_JSON_BYTES);
}

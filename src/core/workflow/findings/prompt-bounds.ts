import {
  FINDING_EVIDENCE_ISSUANCE_LIMITS,
  RAW_FINDING_FIELD_LIMITS,
} from '../../models/finding-contract-limits.js';

export const FINDING_MANAGER_INPUT_MAX_BYTES = 24_000;

export const FINDING_MANAGER_PROMPT_FIELD_LIMITS = {
  rawTitleMaxBytes: 640,
  rawDescriptionMaxBytes: 1_536,
  rawSuggestionMaxBytes: 512,
  rawExcerptMaxBytes: 768,
  targetLiteralMaxBytes: 512,
  targetMaxBytes: 1_024,
  targetCollectionItemMaxBytes: 256,
  quoteWindowPathMaxBytes: 128,
  evidenceArrayMaxBytes: 1_536,
  evidenceMaxItems: 4,
  evidenceVerbatimExcerptMaxBytes: 768,
  ledgerEvidenceArrayMaxBytes: 4_096,
  taskLedgerEvidenceArrayMaxBytes: 640,
  ledgerEvidenceVerbatimExcerptMaxBytes: 256,
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

export function renderCompactJsonBlock(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error('Prompt JSON is not serializable');
  }
  // JSON.stringify は改行を escape するため、内容中の backtick は fence 行にならない。
  return ['```json', serialized, '```'].join('\n');
}

export const renderQuoteWindowsJsonBlock = renderCompactJsonBlock;

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

function promptSectionBytes(label: string, value: unknown): number {
  return Buffer.byteLength(
    [label, renderCompactJsonBlock(value)].join('\n'),
    'utf8',
  );
}

function quoteWindowsSectionBytes(label: string, value: unknown): number {
  return Buffer.byteLength(
    [label, renderQuoteWindowsJsonBlock(value)].join('\n'),
    'utf8',
  );
}

function boundedPromptProperty(
  field: string,
  value: string,
  maxRenderedBytes: number,
): Record<string, unknown> {
  const bounded = boundPromptString({
    value,
    fieldPath: 'budget',
    maxRenderedBytes,
  });
  return {
    [field]: bounded.text,
    ...(bounded.truncation === undefined ? {} : { [`${field}Truncation`]: bounded.truncation }),
  };
}

function rawReportExcerptBudget(): number {
  const item = {
    rawFindingId: '',
    ...boundedPromptProperty(
      'title',
      '\0'.repeat(RAW_FINDING_FIELD_LIMITS.maxTitleChars),
      FINDING_MANAGER_PROMPT_FIELD_LIMITS.rawTitleMaxBytes,
    ),
    ...boundedPromptProperty(
      'description',
      '\0'.repeat(RAW_FINDING_FIELD_LIMITS.maxDescriptionChars),
      FINDING_MANAGER_PROMPT_FIELD_LIMITS.rawDescriptionMaxBytes,
    ),
    ...boundedPromptProperty(
      'suggestion',
      '\0'.repeat(RAW_FINDING_FIELD_LIMITS.maxSuggestionChars),
      FINDING_MANAGER_PROMPT_FIELD_LIMITS.rawSuggestionMaxBytes,
    ),
    ...boundedPromptProperty(
      'rawExcerpt',
      '\0'.repeat(RAW_FINDING_FIELD_LIMITS.maxDescriptionChars),
      FINDING_MANAGER_PROMPT_FIELD_LIMITS.rawExcerptMaxBytes,
    ),
  };
  return promptSectionBytes('## Report excerpts', { items: [item] });
}

const QUOTE_WINDOW_EXCERPT = 'x'.repeat(RAW_FINDING_FIELD_LIMITS.maxVerbatimExcerptBytes);

function rawQuoteWindowEvidenceEntry(
  verbatimExcerpt = QUOTE_WINDOW_EXCERPT,
): Record<string, unknown> {
  const path = boundPromptString({
    value: 'x'.repeat(RAW_FINDING_FIELD_LIMITS.maxEvidencePathChars),
    fieldPath: 'budget.path',
    maxRenderedBytes: FINDING_MANAGER_PROMPT_FIELD_LIMITS.quoteWindowPathMaxBytes,
  });
  return {
    kind: 'file_quote',
    path: path.text,
    ...(path.truncation === undefined ? {} : { pathTruncation: path.truncation }),
    startLine: FINDING_EVIDENCE_ISSUANCE_LIMITS.maxSourceFileBytes,
    endLine: FINDING_EVIDENCE_ISSUANCE_LIMITS.maxSourceFileBytes,
    verbatimExcerpt,
    snapshotId: '0'.repeat(64),
  };
}

function quoteWindowsEvidenceArrayMaxBytes(): number {
  return Math.max(
    ...[
      QUOTE_WINDOW_EXCERPT,
      String.fromCodePoint(0x60).repeat(RAW_FINDING_FIELD_LIMITS.maxVerbatimExcerptBytes),
    ].map((verbatimExcerpt) => promptJsonUtf8Bytes({
      items: Array.from(
        { length: FINDING_MANAGER_PROMPT_FIELD_LIMITS.evidenceMaxItems },
        () => rawQuoteWindowEvidenceEntry(verbatimExcerpt),
      ),
      truncation: {
        kind: PROMPT_TRUNCATION_MARKER_KIND,
        omittedCount: 1,
      },
    })),
  );
}

export const FINDING_MANAGER_PROMPT_QUOTE_WINDOWS_ARRAY_MAX_BYTES = (
  quoteWindowsEvidenceArrayMaxBytes()
);

function rawQuoteWindowBudget(): number {
  const evidenceEntry = rawQuoteWindowEvidenceEntry();
  const fenceStretchEvidenceEntry = rawQuoteWindowEvidenceEntry(
    String.fromCodePoint(0x60).repeat(RAW_FINDING_FIELD_LIMITS.maxVerbatimExcerptBytes),
  );
  return Math.max(
    quoteWindowsSectionBytes(
      '## Byte-exact quote windows',
      {
        items: [{
          rawFindingId: '',
          evidence: Array.from(
            { length: FINDING_MANAGER_PROMPT_FIELD_LIMITS.evidenceMaxItems },
            () => evidenceEntry,
          ),
        }],
      },
    ),
    quoteWindowsSectionBytes(
      '## Byte-exact quote windows',
      {
        items: [{
          rawFindingId: '',
          evidence: Array.from(
            { length: FINDING_MANAGER_PROMPT_FIELD_LIMITS.evidenceMaxItems },
            () => fenceStretchEvidenceEntry,
          ),
        }],
      },
    ),
  );
}

function rawManifestViewBudget(itemCount: number): number {
  const item = {
    rawFindingId: '',
    componentId: '0'.repeat(64),
    relation: 'resolution_confirmation',
    targetFindingId: 'F'.repeat(RAW_FINDING_FIELD_LIMITS.maxFindingIdChars),
    target: {
      kind: 'code',
      paths: Array.from(
        { length: 3 },
        () => 'x'.repeat(FINDING_MANAGER_PROMPT_FIELD_LIMITS.targetCollectionItemMaxBytes - 16),
      ),
    },
  };
  return promptSectionBytes(
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
  return promptSectionBytes('## Context coverage', {
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

function fullDetailFindingBudget(): Record<string, unknown> {
  const boundedText = (field: string, maxBytes: number): Record<string, unknown> => (
    boundedPromptProperty(field, '\0'.repeat(maxBytes), maxBytes)
  );
  const boundedEvidencePath = boundPromptString({
    value: 'p'.repeat(RAW_FINDING_FIELD_LIMITS.maxEvidencePathChars),
    fieldPath: 'budget.evidenceDetails.path',
    maxRenderedBytes: FINDING_MANAGER_PROMPT_FIELD_LIMITS.targetCollectionItemMaxBytes,
  });
  const evidenceDetails = Array.from({ length: FINDING_MANAGER_PROMPT_FIELD_LIMITS.evidenceMaxItems }, () => ({
    kind: 'file_quote',
    path: boundedEvidencePath.text,
    ...(boundedEvidencePath.truncation === undefined
      ? {}
      : { pathTruncation: boundedEvidencePath.truncation }),
    startLine: FINDING_EVIDENCE_ISSUANCE_LIMITS.maxFileQuoteLines,
    endLine: FINDING_EVIDENCE_ISSUANCE_LIMITS.maxFileQuoteLines,
    ...boundedPromptProperty(
      'verbatimExcerpt',
      'x'.repeat(RAW_FINDING_FIELD_LIMITS.maxVerbatimExcerptBytes),
      FINDING_MANAGER_PROMPT_FIELD_LIMITS.ledgerEvidenceVerbatimExcerptMaxBytes,
    ),
  }));
  const boundedEvidenceDetails = boundPromptArray({
    items: evidenceDetails,
    fieldPath: 'budget.evidenceDetails',
    maxItems: FINDING_MANAGER_PROMPT_FIELD_LIMITS.evidenceMaxItems,
    maxRenderedBytes: FINDING_MANAGER_PROMPT_FIELD_LIMITS.taskLedgerEvidenceArrayMaxBytes,
  });
  return {
    id: 'F'.repeat(RAW_FINDING_FIELD_LIMITS.maxFindingIdChars),
    revision: 1,
    status: 'open',
    lifecycle: 'new',
    severity: 'high',
    ...boundedText('title', FINDING_MANAGER_PROMPT_FIELD_LIMITS.ledgerTitleMaxBytes),
    target: {
      kind: 'code',
      paths: Array.from(
        { length: 3 },
        () => 'x'.repeat(FINDING_MANAGER_PROMPT_FIELD_LIMITS.targetCollectionItemMaxBytes - 16),
      ),
    },
    ...boundedText('description', FINDING_MANAGER_PROMPT_FIELD_LIMITS.ledgerDescriptionMaxBytes),
    ...boundedText('suggestion', FINDING_MANAGER_PROMPT_FIELD_LIMITS.ledgerSuggestionMaxBytes),
    evidenceDetails: boundedEvidenceDetails.truncation === undefined
      ? boundedEvidenceDetails.items
      : boundedEvidenceDetails,
  };
}

function ledgerProjectionBudget(): number {
  return promptSectionBytes(
    '## Relevant ledger projection',
    {
      findings: [fullDetailFindingBudget()],
      conflicts: [],
    },
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
  totalMaxBytes: FINDING_MANAGER_INPUT_MAX_BYTES,
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

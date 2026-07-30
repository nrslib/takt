import { compareBinaryStrings } from '../utils/binary-string-comparator.js';

export const FINDING_CLAIM_BEGIN_MARKER = '<!-- TAKT_FINDING_CLAIM_BEGIN -->';
export const FINDING_CLAIM_END_MARKER = '<!-- TAKT_FINDING_CLAIM_END -->';
export const FINDING_CLAIM_PROTOCOL_REVISION = 1;

const RAW_FINDING_RELATIONS = [
  'new',
  'persists',
  'resolution_confirmation',
  'reopened',
] as const;
type CanonicalClaimRelation = typeof RAW_FINDING_RELATIONS[number];

const FINDING_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
type CanonicalClaimSeverity = typeof FINDING_SEVERITIES[number];

const FINDING_REPORT_VERDICTS = ['APPROVE', 'REJECT', 'NEED_REPLAN'] as const;
export type FindingReportVerdict = typeof FINDING_REPORT_VERDICTS[number];

interface FileQuoteRequest {
  readonly kind: 'file_quote';
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly verbatimExcerpt: string;
}

type EngineProofRequest =
  | {
      readonly kind: 'engine_proof';
      readonly subject: { readonly kind: 'repository_manifest' };
    }
  | {
      readonly kind: 'engine_proof';
      readonly subject: { readonly kind: 'repository_query' };
    }
  | {
      readonly kind: 'engine_proof';
      readonly subject: {
        readonly kind: 'authoritative_quote';
        readonly source: 'task' | 'public_declaration';
        readonly declarationId: string;
        readonly verbatimExcerpt: string;
      };
    };

type CanonicalClaimTarget =
  | { readonly kind: 'code'; readonly paths: string[] }
  | {
      readonly kind: 'structure';
      readonly scope: { readonly kind: 'review_scope'; readonly roots: string[] };
      readonly manifestTargets: string[];
    }
  | {
      readonly kind: 'absence';
      readonly predicate:
        | { readonly kind: 'path_state'; readonly path: string; readonly expected: 'absent' }
        | {
            readonly kind: 'exact_literal_search';
            readonly roots: string[];
            readonly literal: string;
            readonly textDomain: 'utf8';
          };
    };

export interface CanonicalFindingClaimItem {
  readonly rawExcerpt: string;
  readonly candidate: {
    readonly rawFindingId: string | null;
    readonly familyTag: string | null;
    readonly severity: CanonicalClaimSeverity | null;
    readonly title: string | null;
    readonly description: string;
    readonly suggestion: string | null;
    readonly relation: CanonicalClaimRelation;
    readonly targetFindingIds: string[];
    readonly target: CanonicalClaimTarget;
    readonly evidenceRequests: Array<FileQuoteRequest | EngineProofRequest>;
  };
}

export interface ParsedCanonicalFindingClaimReport {
  readonly verdict: FindingReportVerdict;
  readonly items: readonly CanonicalFindingClaimItem[];
}

export type CanonicalFindingClaimReportParseResult =
  | { readonly report: ParsedCanonicalFindingClaimReport; readonly error?: never }
  | { readonly report?: never; readonly error: string };

interface SourceLine {
  readonly text: string;
  readonly ending: '' | '\n' | '\r\n';
}

interface ClaimFields {
  readonly rawFindingId: string;
  readonly relation: string;
  readonly targetFindingId: string;
  readonly familyTag: string;
  readonly severity: string;
  readonly title: string;
  readonly description: string;
  readonly suggestion: string;
  readonly targetKind: string;
  readonly targetPaths: string;
  readonly reviewScopeRoots: string;
  readonly manifestTargets: string;
  readonly absencePredicate: string;
  readonly absencePath: string;
  readonly absenceLiteral: string;
}

class ClaimBlockCursor {
  private index = 0;

  constructor(private readonly lines: readonly SourceLine[]) {}

  expect(expected: string): void {
    const actual = this.lines[this.index]?.text;
    if (actual !== expected) {
      throw new Error(`expected "${expected}" at block line ${this.index + 1}`);
    }
    this.index += 1;
  }

  value(label: string): string {
    const prefix = `${label}: `;
    const actual = this.lines[this.index]?.text;
    if (actual === undefined || !actual.startsWith(prefix)) {
      throw new Error(`expected "${label}" at block line ${this.index + 1}`);
    }
    const value = actual.slice(prefix.length);
    if (value.length === 0) {
      throw new Error(`"${label}" must not be empty`);
    }
    this.index += 1;
    return value;
  }

  current(): SourceLine | undefined {
    return this.lines[this.index];
  }

  advance(): void {
    this.index += 1;
  }

  fencedExcerpt(): string {
    this.expect('  Verbatim Excerpt:');
    const opener = this.current()?.text;
    const match = opener?.match(/^ {2}(`{3,})text$/u);
    if (match?.[1] === undefined) {
      throw new Error('Verbatim Excerpt requires a backtick fence of length 3 or greater');
    }
    const closingFence = `  ${match[1]}`;
    this.advance();
    const content: SourceLine[] = [];
    while (this.current()?.text !== closingFence) {
      const line = this.current();
      if (line === undefined) {
        throw new Error('unterminated Verbatim Excerpt fence');
      }
      if (!line.text.startsWith('  ')) {
        throw new Error(`verbatim excerpt line ${this.index + 1} requires list indentation`);
      }
      content.push({ text: line.text.slice(2), ending: line.ending });
      this.advance();
    }
    this.expect(closingFence);
    if (content.length === 0 || content.every((line) => line.text.length === 0)) {
      throw new Error('Verbatim Excerpt must not be empty');
    }
    return content.map((line, index) => (
      index + 1 < content.length ? `${line.text}${line.ending}` : line.text
    )).join('');
  }

  done(): boolean {
    return this.index === this.lines.length;
  }
}

function splitSourceLines(source: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let offset = 0;
  while (offset < source.length) {
    const newline = source.indexOf('\n', offset);
    if (newline === -1) {
      lines.push({ text: source.slice(offset), ending: '' });
      break;
    }
    const hasCarriageReturn = newline > offset && source[newline - 1] === '\r';
    lines.push({
      text: source.slice(offset, hasCarriageReturn ? newline - 1 : newline),
      ending: hasCarriageReturn ? '\r\n' : '\n',
    });
    offset = newline + 1;
  }
  return lines;
}

function exactEnum<T extends string>(
  value: string,
  values: readonly T[],
  label: string,
): T {
  const exact = values.find((candidate) => candidate === value);
  if (exact === undefined) {
    throw new Error(`"${label}" has unsupported value "${value}"`);
  }
  return exact;
}

function nullableValue(value: string): string | null {
  return value === 'none' ? null : value;
}

function requiredValue(value: string, label: string): string {
  if (value === 'none') {
    throw new Error(`"${label}" must not be none`);
  }
  return value;
}

function parseStringSet(value: string, label: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`"${label}" must be a JSON string array`);
  }
  if (
    !Array.isArray(parsed)
    || parsed.length === 0
    || !parsed.every((item) => typeof item === 'string' && item.length > 0)
  ) {
    throw new Error(`"${label}" must be a non-empty JSON string array`);
  }
  const canonical = [...new Set(parsed)].sort(compareBinaryStrings);
  if (
    canonical.length !== parsed.length
    || canonical.some((item, index) => item !== parsed[index])
  ) {
    throw new Error(`"${label}" must be binary-sorted and unique`);
  }
  return parsed;
}

function requireNone(value: string, label: string): void {
  if (value !== 'none') {
    throw new Error(`"${label}" must be none for this Target Kind`);
  }
}

function parseTarget(fields: ClaimFields): CanonicalClaimTarget {
  switch (fields.targetKind) {
    case 'code':
      requireNone(fields.reviewScopeRoots, 'Review Scope Roots');
      requireNone(fields.manifestTargets, 'Manifest Targets');
      requireNone(fields.absencePredicate, 'Absence Predicate');
      requireNone(fields.absencePath, 'Absence Path');
      requireNone(fields.absenceLiteral, 'Absence Literal');
      return { kind: 'code', paths: parseStringSet(fields.targetPaths, 'Target Paths') };
    case 'structure':
      requireNone(fields.targetPaths, 'Target Paths');
      requireNone(fields.absencePredicate, 'Absence Predicate');
      requireNone(fields.absencePath, 'Absence Path');
      requireNone(fields.absenceLiteral, 'Absence Literal');
      return {
        kind: 'structure',
        scope: {
          kind: 'review_scope',
          roots: parseStringSet(fields.reviewScopeRoots, 'Review Scope Roots'),
        },
        manifestTargets: parseStringSet(fields.manifestTargets, 'Manifest Targets'),
      };
    case 'absence':
      requireNone(fields.targetPaths, 'Target Paths');
      requireNone(fields.manifestTargets, 'Manifest Targets');
      return {
        kind: 'absence',
        predicate: parseAbsencePredicate(fields),
      };
    default:
      throw new Error(`"Target Kind" has unsupported value "${fields.targetKind}"`);
  }
}

function parseAbsencePredicate(
  fields: ClaimFields,
): Extract<CanonicalClaimTarget, { kind: 'absence' }>['predicate'] {
  if (fields.absencePredicate === 'path_state') {
    requireNone(fields.reviewScopeRoots, 'Review Scope Roots');
    requireNone(fields.absenceLiteral, 'Absence Literal');
    return {
      kind: 'path_state',
      path: requiredValue(fields.absencePath, 'Absence Path'),
      expected: 'absent',
    };
  }
  if (fields.absencePredicate === 'exact_literal_search') {
    requireNone(fields.absencePath, 'Absence Path');
    return {
      kind: 'exact_literal_search',
      roots: parseStringSet(fields.reviewScopeRoots, 'Review Scope Roots'),
      literal: requiredValue(fields.absenceLiteral, 'Absence Literal'),
      textDomain: 'utf8',
    };
  }
  throw new Error(
    `"Absence Predicate" has unsupported value "${fields.absencePredicate}"`,
  );
}

function parsePositiveInteger(value: string, label: string): number {
  if (!/^[1-9]\d*$/u.test(value)) {
    throw new Error(`"${label}" must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`"${label}" exceeds the safe integer range`);
  }
  return parsed;
}

function parseEvidenceRequests(
  cursor: ClaimBlockCursor,
): Array<FileQuoteRequest | EngineProofRequest> {
  const requests: Array<FileQuoteRequest | EngineProofRequest> = [];
  while (!cursor.done()) {
    switch (cursor.current()?.text) {
      case '- File Quote': {
        cursor.advance();
        const path = cursor.value('  Path');
        const startLine = parsePositiveInteger(cursor.value('  Start Line'), 'Start Line');
        const endLine = parsePositiveInteger(cursor.value('  End Line'), 'End Line');
        if (endLine < startLine) {
          throw new Error('"End Line" must not precede "Start Line"');
        }
        requests.push({
          kind: 'file_quote',
          path,
          startLine,
          endLine,
          verbatimExcerpt: cursor.fencedExcerpt(),
        });
        break;
      }
      case '- Repository Manifest':
        cursor.advance();
        requests.push({
          kind: 'engine_proof',
          subject: { kind: 'repository_manifest' },
        });
        break;
      case '- Repository Query':
        cursor.advance();
        requests.push({
          kind: 'engine_proof',
          subject: { kind: 'repository_query' },
        });
        break;
      case '- Authoritative Quote': {
        cursor.advance();
        const source = exactEnum(
          cursor.value('  Source'),
          ['task', 'public_declaration'] as const,
          'Source',
        );
        const declarationId = cursor.value('  Declaration ID');
        requests.push({
          kind: 'engine_proof',
          subject: {
            kind: 'authoritative_quote',
            source,
            declarationId,
            verbatimExcerpt: cursor.fencedExcerpt(),
          },
        });
        break;
      }
      default:
        throw new Error(`unexpected evidence line "${cursor.current()?.text ?? '<eof>'}"`);
    }
  }
  if (requests.length === 0) {
    throw new Error('Evidence Requests requires at least one request');
  }
  return requests;
}

function assertEvidenceMatrix(
  target: CanonicalClaimTarget,
  requests: ReadonlyArray<FileQuoteRequest | EngineProofRequest>,
): void {
  const has = (kind: 'file_quote' | 'repository_manifest' | 'repository_query' | 'authoritative_quote') => (
    requests.some((request) => (
      kind === 'file_quote'
        ? request.kind === 'file_quote'
        : request.kind === 'engine_proof' && request.subject.kind === kind
    ))
  );
  if (target.kind === 'code' && !has('file_quote')) {
    throw new Error('code target requires File Quote evidence');
  }
  if (target.kind === 'structure' && !has('repository_manifest')) {
    throw new Error('structure target requires Repository Manifest evidence');
  }
  if (
    target.kind === 'absence'
    && (!has('repository_query') || !has('authoritative_quote'))
  ) {
    throw new Error('absence target requires Repository Query and Authoritative Quote evidence');
  }
}

function parseClaimFields(cursor: ClaimBlockCursor): ClaimFields {
  return {
    rawFindingId: cursor.value('Raw Finding ID'),
    relation: cursor.value('Relation'),
    targetFindingId: cursor.value('Target Finding ID'),
    familyTag: cursor.value('Family Tag'),
    severity: cursor.value('Severity'),
    title: cursor.value('Title'),
    description: cursor.value('Description'),
    suggestion: cursor.value('Suggestion'),
    targetKind: cursor.value('Target Kind'),
    targetPaths: cursor.value('Target Paths'),
    reviewScopeRoots: cursor.value('Review Scope Roots'),
    manifestTargets: cursor.value('Manifest Targets'),
    absencePredicate: cursor.value('Absence Predicate'),
    absencePath: cursor.value('Absence Path'),
    absenceLiteral: cursor.value('Absence Literal'),
  };
}

function parseCanonicalClaimBlock(rawExcerpt: string): CanonicalFindingClaimItem {
  const lines = splitSourceLines(rawExcerpt);
  if (lines.at(-1)?.text !== FINDING_CLAIM_END_MARKER) {
    throw new Error(`expected "${FINDING_CLAIM_END_MARKER}" at final block line`);
  }
  const cursor = new ClaimBlockCursor(lines.slice(0, -1));
  cursor.expect(FINDING_CLAIM_BEGIN_MARKER);
  cursor.expect('Finding Claim');
  const fields = parseClaimFields(cursor);
  cursor.expect('Evidence Requests:');
  const evidenceRequests = parseEvidenceRequests(cursor);
  const relation = exactEnum(fields.relation, RAW_FINDING_RELATIONS, 'Relation');
  const targetFindingId = nullableValue(fields.targetFindingId);
  if (relation === 'new' ? targetFindingId !== null : targetFindingId === null) {
    throw new Error(
      relation === 'new'
        ? '"new" requires Target Finding ID none'
        : `"${relation}" requires exactly one Target Finding ID`,
    );
  }
  const severity = fields.severity === 'none'
    ? null
    : exactEnum(fields.severity, FINDING_SEVERITIES, 'Severity');
  const target = parseTarget(fields);
  assertEvidenceMatrix(target, evidenceRequests);
  return {
    rawExcerpt,
    candidate: {
      rawFindingId: nullableValue(fields.rawFindingId),
      familyTag: nullableValue(fields.familyTag),
      severity,
      title: nullableValue(fields.title),
      description: requiredValue(fields.description, 'Description'),
      suggestion: nullableValue(fields.suggestion),
      relation,
      targetFindingIds: targetFindingId === null ? [] : [targetFindingId],
      target,
      evidenceRequests,
    },
  };
}

type CanonicalFindingClaimBlockScan =
  | { readonly blocks: readonly string[]; readonly error?: never }
  | { readonly blocks?: never; readonly error: string };

export function scanCanonicalFindingClaimBlocks(
  report: string,
): CanonicalFindingClaimBlockScan {
  const escapedBegin = FINDING_CLAIM_BEGIN_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedEnd = FINDING_CLAIM_END_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const beginMatches = [...report.matchAll(new RegExp(`^${escapedBegin}(?=\\r?$)`, 'gm'))];
  const endMatches = [...report.matchAll(new RegExp(`^${escapedEnd}(?=\\r?$)`, 'gm'))];
  if (beginMatches.length !== endMatches.length) {
    return {
      error: `canonical claim marker count mismatch (${beginMatches.length} begin, ${endMatches.length} end)`,
    };
  }
  const blocks: string[] = [];
  let previousEnd = -1;
  for (const [index, begin] of beginMatches.entries()) {
    const beginIndex = begin.index;
    const endIndex = endMatches[index]?.index;
    if (beginIndex === undefined || endIndex === undefined || endIndex < beginIndex) {
      return { error: 'canonical claim markers are nested or out of order' };
    }
    if (beginIndex < previousEnd) {
      return { error: 'canonical claim blocks overlap' };
    }
    const blockEnd = endIndex + FINDING_CLAIM_END_MARKER.length;
    blocks.push(report.slice(beginIndex, blockEnd));
    previousEnd = blockEnd;
  }
  return { blocks };
}

function parseReportVerdict(report: string): FindingReportVerdict {
  const matches = [
    ...report.matchAll(
      /^## (?:Result|結果):[ \t]*(APPROVE|REJECT|NEED_REPLAN)[ \t]*(?=\r?$)/gmu,
    ),
  ];
  if (matches.length !== 1 || matches[0]?.[1] === undefined) {
    throw new Error('report requires exactly one canonical Result/結果 verdict heading');
  }
  return exactEnum(matches[0][1], FINDING_REPORT_VERDICTS, 'Result');
}

function assertVerdictCardinality(
  verdict: FindingReportVerdict,
  items: readonly CanonicalFindingClaimItem[],
): void {
  const issueCount = items.filter(
    (item) => item.candidate.relation !== 'resolution_confirmation',
  ).length;
  if (verdict === 'REJECT' ? issueCount === 0 : issueCount > 0) {
    throw new Error(
      `report verdict ${verdict} is inconsistent with ${issueCount} issue-bearing canonical claims`,
    );
  }
}

export function parseCanonicalFindingClaimReport(
  report: string,
): CanonicalFindingClaimReportParseResult {
  try {
    const verdict = parseReportVerdict(report);
    const scan = scanCanonicalFindingClaimBlocks(report);
    if (scan.error !== undefined) {
      throw new Error(scan.error);
    }
    const items = scan.blocks.map((block, index) => {
      try {
        return parseCanonicalClaimBlock(block);
      } catch (error) {
        throw new Error(
          `canonical claim block ${index}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    });
    assertVerdictCardinality(verdict, items);
    return { report: { verdict, items } };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export const FINDING_CLAIM_BLOCK_PROTOCOL = `Each observed finding or ledger lifecycle claim MUST be one complete canonical block.
Do not put machine claims in a Markdown table or ordinary prose.
Use the English labels and boundary markers below exactly. Every displayed
label is required and must remain in this order.

${FINDING_CLAIM_BEGIN_MARKER}
Finding Claim
Raw Finding ID: <reviewer-local id, or none>
Relation: <new | persists | resolution_confirmation | reopened>
Target Finding ID: <none for new; exactly one existing F-... id otherwise>
Family Tag: <tag, or none>
Severity: <critical | high | medium | low | none>
Title: <exact claim title, or none>
Description: <exact defect or lifecycle assertion>
Suggestion: <exact correction, or none>
Target Kind: <code | structure | absence>
Target Paths: <JSON string array for code, or none>
Review Scope Roots: <JSON string array for structure or exact_literal_search, or none>
Manifest Targets: <JSON string array for structure, or none>
Absence Predicate: <path_state | exact_literal_search | none>
Absence Path: <path for path_state, or none>
Absence Literal: <exact UTF-8 literal for exact_literal_search, or none>
Evidence Requests:
<one or more evidence request blocks required by the matrix below>
${FINDING_CLAIM_END_MARKER}

Evidence request blocks:

For each Verbatim Excerpt, use an opening fence of N backticks followed by
\`text\` and a closing fence of exactly the same N backticks, where N is at
least 3. Use 3 unless the excerpt contains a whole line of exactly 3
backticks; then increase N until no excerpt line equals the closing fence.
Indent the fence and every excerpt line by two spaces as shown.

- File Quote
  Path: <review-scope relative path>
  Start Line: <positive integer>
  End Line: <positive integer>
  Verbatim Excerpt:
  \`\`\`text
  <the complete current text of that exact contiguous range>
  \`\`\`
- Repository Manifest
- Repository Query
- Authoritative Quote
  Source: <task | public_declaration>
  Declaration ID: <registered declaration id>
  Verbatim Excerpt:
  \`\`\`text
  <exact obligation text from that declaration>
  \`\`\`

Typed evidence matrix:
- code: Target Paths plus at least one File Quote.
- structure: Review Scope Roots plus Manifest Targets and Repository Manifest.
- absence/path_state: Absence Path, Repository Query, and Authoritative Quote.
- absence/exact_literal_search: Review Scope Roots, Absence Literal, Repository Query, and Authoritative Quote.

Target Paths, Review Scope Roots, and Manifest Targets MUST be binary-sorted
unique JSON string arrays.

The matrix depends on Target Kind, not Relation. A resolution_confirmation for
structure or absence therefore uses the corresponding engine-proof requests;
it is not restricted to File Quote. Never output snapshotId, runId, proofId,
digests, query results, manifest contents, or other engine-issued values.

For Relation new, Target Finding ID MUST be none. For persists,
resolution_confirmation, and reopened it MUST be exactly one existing finding
ID. Keep every claim in a separate block. If there is no observed finding and
no lifecycle claim, emit no canonical block.`;

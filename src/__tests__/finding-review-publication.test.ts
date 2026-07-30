import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CANONICAL_BLOCKS_FINDING_REVIEW_PUBLICATION_PROTOCOL,
  createFindingReviewPublication,
  loadFindingReviewPublication,
  persistFindingReviewPublication,
  publishFindingReviewPublication,
  STRUCTURED_FINDING_REVIEW_PUBLICATION_PROTOCOL,
  type FindingReviewPublicationIdentity,
} from '../core/workflow/findings/review-publication.js';
import { bindReviewerReportExcerpt } from '../core/workflow/findings/raw-canonicalization.js';
import {
  FINDING_CLAIM_BEGIN_MARKER,
  FINDING_CLAIM_END_MARKER,
  parseCanonicalFindingClaimReport,
} from '../shared/prompts/finding-canonical-claim.js';

const temporaryDirectories: string[] = [];

function createReportDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'takt-finding-publication-'));
  temporaryDirectories.push(directory);
  return directory;
}

function identity(
  overrides: Partial<FindingReviewPublicationIdentity> = {},
): FindingReviewPublicationIdentity {
  return {
    scopeIdentity: 'scope-1',
    callNamespace: '',
    parentStepName: 'reviewers',
    stepIteration: 2,
    reviewerStepName: 'architecture-reviewer',
    reportName: 'architecture-review.md',
    ...overrides,
  };
}

function canonicalCodeReport(): string {
  return [
    '## Result: REJECT',
    '',
    FINDING_CLAIM_BEGIN_MARKER,
    'Finding Claim',
    'Raw Finding ID: code-1',
    'Relation: new',
    'Target Finding ID: none',
    'Family Tag: correctness',
    'Severity: high',
    'Title: Incorrect value',
    'Description: The value is incorrect.',
    'Suggestion: Return the required value.',
    'Target Kind: code',
    'Target Paths: ["src/code.ts"]',
    'Review Scope Roots: none',
    'Manifest Targets: none',
    'Absence Predicate: none',
    'Absence Path: none',
    'Absence Literal: none',
    'Evidence Requests:',
    '- File Quote',
    '  Path: src/code.ts',
    '  Start Line: 1',
    '  End Line: 1',
    '  Verbatim Excerpt:',
    '  ```text',
    '    const value = 1;',
    '  ```',
    FINDING_CLAIM_END_MARKER,
  ].join('\n');
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('Finding review publication', () => {
  it('persists the generation protocol and selects resume records by that protocol', () => {
    const reportDir = createReportDirectory();
    const publication = createFindingReviewPublication({
      identity: identity(),
      protocol: CANONICAL_BLOCKS_FINDING_REVIEW_PUBLICATION_PROTOCOL,
      reportContent: '## Result: NEED_REPLAN\n\nReview scope must be replanned.',
      rawFindings: [],
    });
    persistFindingReviewPublication(reportDir, { publication });

    const loaded = loadFindingReviewPublication(
      reportDir,
      identity(),
      CANONICAL_BLOCKS_FINDING_REVIEW_PUBLICATION_PROTOCOL,
    )!.publication;
    expect(loaded.protocol).toEqual(CANONICAL_BLOCKS_FINDING_REVIEW_PUBLICATION_PROTOCOL);
    expect(() => loadFindingReviewPublication(
      reportDir,
      identity(),
      STRUCTURED_FINDING_REVIEW_PUBLICATION_PROTOCOL,
    )).toThrow(/protocol mismatch/);
  });

  it.each([
    {
      label: 'relation',
      mutate: (item: Record<string, unknown>) => {
        (item.candidate as Record<string, unknown>).relation = 'reopened';
      },
    },
    {
      label: 'evidence indentation',
      mutate: (item: Record<string, unknown>) => {
        const candidate = item.candidate as {
          evidenceRequests: Array<Record<string, unknown>>;
        };
        candidate.evidenceRequests[0]!.verbatimExcerpt = 'const value = 1;';
      },
    },
  ])('rejects stored canonical raw findings with changed $label on resume', ({ mutate }) => {
    const reportDir = createReportDirectory();
    const reportContent = canonicalCodeReport();
    const parsed = parseCanonicalFindingClaimReport(reportContent);
    if (parsed.error !== undefined) {
      throw new Error(parsed.error);
    }
    const changed = structuredClone(parsed.report.items[0]) as unknown as Record<string, unknown>;
    mutate(changed);
    const publication = createFindingReviewPublication({
      identity: identity(),
      protocol: CANONICAL_BLOCKS_FINDING_REVIEW_PUBLICATION_PROTOCOL,
      reportContent,
      rawFindings: [changed],
    });
    persistFindingReviewPublication(reportDir, { publication });

    expect(() => loadFindingReviewPublication(
      reportDir,
      identity(),
      CANONICAL_BLOCKS_FINDING_REVIEW_PUBLICATION_PROTOCOL,
    )).toThrow(/Stored finding review publication canonical claim invariant failed/);
  });

  it('does not apply the canonical claim parser to structured publications', () => {
    const reportDir = createReportDirectory();
    const reportContent = '## Result: REJECT\n\nNot a canonical claim block.';
    const publication = createFindingReviewPublication({
      identity: identity(),
      protocol: STRUCTURED_FINDING_REVIEW_PUBLICATION_PROTOCOL,
      reportContent,
      rawFindings: [{ rawExcerpt: 'Not a canonical claim block.' }],
    });
    persistFindingReviewPublication(reportDir, { publication });

    expect(loadFindingReviewPublication(
      reportDir,
      identity(),
      STRUCTURED_FINDING_REVIEW_PUBLICATION_PROTOCOL,
    )?.publication.reportContent).toBe(reportContent);
  });

  it('defensive clone後にpublication全体を再帰freezeする', () => {
    const inputRawFindings = [{
      rawExcerpt: 'Nested issue',
      candidate: {
        title: 'Original title',
        target: { kind: 'code', paths: ['src/a.ts'] },
      },
    }];
    const publication = createFindingReviewPublication({
      identity: identity(),
      protocol: STRUCTURED_FINDING_REVIEW_PUBLICATION_PROTOCOL,
      reportContent: 'Nested issue',
      rawFindings: inputRawFindings,
    });

    inputRawFindings[0]!.candidate.title = 'Mutated input title';
    inputRawFindings[0]!.candidate.target.paths.push('src/mutated.ts');

    expect(Object.isFrozen(publication)).toBe(true);
    expect(Object.isFrozen(publication.rawFindings)).toBe(true);
    expect(Object.isFrozen(publication.rawFindings[0])).toBe(true);
    const storedCandidate = (publication.rawFindings[0] as {
      candidate: { title: string; target: { paths: string[] } };
    }).candidate;
    expect(Object.isFrozen(storedCandidate)).toBe(true);
    expect(Object.isFrozen(storedCandidate.target.paths)).toBe(true);
    expect(storedCandidate).toEqual({
      title: 'Original title',
      target: { kind: 'code', paths: ['src/a.ts'] },
    });
    expect(() => {
      (publication.rawFindings as unknown[]).push({ rawExcerpt: 'Mutation' });
    }).toThrow(TypeError);
    expect(() => {
      storedCandidate.title = 'Mutation';
    }).toThrow(TypeError);
  });

  it('loadしたpublicationも再帰freezeされ、復元後のmutationを拒否する', () => {
    const reportDir = createReportDirectory();
    const publication = createFindingReviewPublication({
      identity: identity(),
      protocol: STRUCTURED_FINDING_REVIEW_PUBLICATION_PROTOCOL,
      reportContent: 'Loaded issue',
      rawFindings: [{
        rawExcerpt: 'Loaded issue',
        candidate: { evidenceRequests: [{ kind: 'repository_manifest', roots: ['src'] }] },
      }],
    });
    persistFindingReviewPublication(reportDir, { publication });

    const loaded = loadFindingReviewPublication(
      reportDir,
      identity(),
      STRUCTURED_FINDING_REVIEW_PUBLICATION_PROTOCOL,
    )!.publication;

    expect(Object.isFrozen(loaded)).toBe(true);
    expect(Object.isFrozen(loaded.rawFindings)).toBe(true);
    const candidate = (loaded.rawFindings[0] as {
      candidate: { evidenceRequests: Array<{ roots: string[] }> };
    }).candidate;
    expect(Object.isFrozen(candidate.evidenceRequests[0]!.roots)).toBe(true);
    expect(() => {
      candidate.evidenceRequests[0]!.roots[0] = 'mutated';
    }).toThrow(TypeError);
  });

  it('persists canonical report bytes and publishes them idempotently', () => {
    const reportDir = createReportDirectory();
    const reportContent = '# Review\n\n設計上の問題です。\n';
    const publication = createFindingReviewPublication({
      identity: identity(),
      protocol: STRUCTURED_FINDING_REVIEW_PUBLICATION_PROTOCOL,
      reportContent,
      rawFindings: [{ rawExcerpt: '設計上の問題です。' }],
    });

    const persisted = persistFindingReviewPublication(reportDir, {
      publication,
      relationClarification: {
        attempted: true,
        flaggedRawFindingIds: ['raw-1'],
        priorAmbiguityCodesByRawId: {
          'raw-1': ['relation-target-mismatch'],
        },
      },
    });
    const replayed = persistFindingReviewPublication(reportDir, { publication });
    publishFindingReviewPublication(reportDir, persisted.publication);
    publishFindingReviewPublication(reportDir, replayed.publication);

    expect(replayed).toEqual(persisted);
    expect(loadFindingReviewPublication(
      reportDir,
      identity(),
      STRUCTURED_FINDING_REVIEW_PUBLICATION_PROTOCOL,
    )).toEqual(persisted);
    expect(replayed.relationClarification?.flaggedRawFindingIds).toEqual(['raw-1']);
    expect(readFileSync(join(reportDir, 'architecture-review.md'), 'utf8'))
      .toBe(reportContent);
  });

  it('rejects the same publication identity with different report bytes', () => {
    const reportDir = createReportDirectory();
    persistFindingReviewPublication(
      reportDir,
      {
        publication: createFindingReviewPublication({
          identity: identity(),
          protocol: STRUCTURED_FINDING_REVIEW_PUBLICATION_PROTOCOL,
          reportContent: 'first issue',
          rawFindings: [{ rawExcerpt: 'first issue' }],
        }),
      },
    );

    expect(() => persistFindingReviewPublication(
      reportDir,
      {
        publication: createFindingReviewPublication({
          identity: identity(),
          protocol: STRUCTURED_FINDING_REVIEW_PUBLICATION_PROTOCOL,
          reportContent: 'second issue',
          rawFindings: [{ rawExcerpt: 'second issue' }],
        }),
      },
    )).toThrow(/publication conflict/);
  });

  it('binds excerpts to exact UTF-8 report bytes before persistence', () => {
    expect(() => createFindingReviewPublication({
      identity: identity(),
      protocol: STRUCTURED_FINDING_REVIEW_PUBLICATION_PROTOCOL,
      reportContent: '実際の指摘',
      rawFindings: [{ rawExcerpt: '存在しない指摘' }],
    })).toThrow(/exactly once/);
  });

  it('derives UTF-8 byte offsets and digests from the report bytes', () => {
    const report = 'prefix\n日本語の指摘\nsuffix';
    const excerpt = '日本語の指摘';
    const binding = bindReviewerReportExcerpt(report, excerpt);

    expect(binding.startByte).toBe(Buffer.byteLength('prefix\n', 'utf8'));
    expect(binding.endByte - binding.startByte)
      .toBe(Buffer.byteLength(excerpt, 'utf8'));
    expect(binding.reportDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(binding.excerptDigest).toMatch(/^[a-f0-9]{64}$/);
  });
});

import { describe, expect, it } from 'vitest';
import {
  FINDING_CLAIM_BEGIN_MARKER,
  FINDING_CLAIM_BLOCK_PROTOCOL,
  FINDING_CLAIM_END_MARKER,
  parseCanonicalFindingClaimReport,
  scanCanonicalFindingClaimBlocks,
} from '../shared/prompts/finding-canonical-claim.js';
import {
  inspectCanonicalClaimPublication,
} from '../core/workflow/findings/canonical-claim-publication.js';
import {
  buildFindingIntakeCorrectionPrompt,
  buildFindingIntakeExtractionPrompt,
} from '../shared/prompts/finding-intake-extraction.js';
import { ReviewerRawFindingSchema } from '../core/models/finding-schemas.js';

function claimBlock(lines: readonly string[], eol = '\n'): string {
  return [
    FINDING_CLAIM_BEGIN_MARKER,
    'Finding Claim',
    ...lines,
    FINDING_CLAIM_END_MARKER,
  ].join(eol);
}

function codeClaim(input: {
  relation?: 'new' | 'persists' | 'resolution_confirmation' | 'reopened';
  targetFindingId?: string;
  eol?: '\n' | '\r\n';
} = {}): string {
  const relation = input.relation ?? 'new';
  return claimBlock([
    'Raw Finding ID: code-1',
    `Relation: ${relation}`,
    `Target Finding ID: ${input.targetFindingId ?? 'none'}`,
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
    '  const value = 1;',
    '  ```',
  ], input.eol);
}

function structureClaim(): string {
  return claimBlock([
    'Raw Finding ID: none',
    'Relation: persists',
    'Target Finding ID: F-0001',
    'Family Tag: architecture',
    'Severity: medium',
    'Title: Required module is absent',
    'Description: The required module is absent from the repository.',
    'Suggestion: Add the required module.',
    'Target Kind: structure',
    'Target Paths: none',
    'Review Scope Roots: ["src"]',
    'Manifest Targets: ["src/required.ts"]',
    'Absence Predicate: none',
    'Absence Path: none',
    'Absence Literal: none',
    'Evidence Requests:',
    '- Repository Manifest',
  ]);
}

function absenceConfirmation(): string {
  return claimBlock([
    'Raw Finding ID: none',
    'Relation: resolution_confirmation',
    'Target Finding ID: F-0002',
    'Family Tag: correctness',
    'Severity: high',
    'Title: Forbidden call was removed',
    'Description: The forbidden call no longer occurs.',
    'Suggestion: none',
    'Target Kind: absence',
    'Target Paths: none',
    'Review Scope Roots: ["src"]',
    'Manifest Targets: none',
    'Absence Predicate: exact_literal_search',
    'Absence Path: none',
    'Absence Literal: forbidden()',
    'Evidence Requests:',
    '- Repository Query',
    '- Authoritative Quote',
    '  Source: task',
    '  Declaration ID: task-main',
    '  Verbatim Excerpt:',
    '  ````text',
    '  Remove forbidden().',
    '  ```',
    '  Keep the requirement exact.',
    '  ````',
  ]);
}

function fenceCollisionCodeClaim(eol: '\n' | '\r\n'): string {
  return claimBlock([
    'Raw Finding ID: fence-1',
    'Relation: new',
    'Target Finding ID: none',
    'Family Tag: correctness',
    'Severity: high',
    'Title: Fence content is mishandled',
    'Description: A literal fence line is mishandled.',
    'Suggestion: Preserve the literal line.',
    'Target Kind: code',
    'Target Paths: ["src/fence.ts"]',
    'Review Scope Roots: none',
    'Manifest Targets: none',
    'Absence Predicate: none',
    'Absence Path: none',
    'Absence Literal: none',
    'Evidence Requests:',
    '- File Quote',
    '  Path: src/fence.ts',
    '  Start Line: 1',
    '  End Line: 3',
    '  Verbatim Excerpt:',
    '  ````text',
    '  before',
    '  ```',
    '  after',
    '  ````',
  ], eol);
}

function pathStateClaim(): string {
  return claimBlock([
    'Raw Finding ID: path-1',
    'Relation: new',
    'Target Finding ID: none',
    'Family Tag: wiring',
    'Severity: high',
    'Title: Required path is absent',
    'Description: The required path is absent.',
    'Suggestion: Add the required path.',
    'Target Kind: absence',
    'Target Paths: none',
    'Review Scope Roots: none',
    'Manifest Targets: none',
    'Absence Predicate: path_state',
    'Absence Path: src/required.ts',
    'Absence Literal: none',
    'Evidence Requests:',
    '- Repository Query',
    '- Authoritative Quote',
    '  Source: task',
    '  Declaration ID: task-main',
    '  Verbatim Excerpt:',
    '  ```text',
    '  Add src/required.ts.',
    '  ```',
  ]);
}

function parsedItems(report: string): readonly unknown[] {
  const parsed = parseCanonicalFindingClaimReport(report);
  expect(parsed.error).toBeUndefined();
  return parsed.report!.items;
}

describe('canonical Finding Contract claim publication', () => {
  it('uses one shared protocol in initial and correction extraction prompts', () => {
    expect(FINDING_CLAIM_BLOCK_PROTOCOL).toContain(
      'Relation: <new | persists | resolution_confirmation | reopened>',
    );
    expect(FINDING_CLAIM_BLOCK_PROTOCOL).toContain(
      'absence/path_state: Absence Path, Repository Query, and Authoritative Quote.',
    );
    for (const prompt of [
      buildFindingIntakeExtractionPrompt('report'),
      buildFindingIntakeCorrectionPrompt('report'),
    ]) {
      expect(prompt).toContain(FINDING_CLAIM_BLOCK_PROTOCOL);
      expect(prompt).toContain('## Candidate report\n\nreport');
      expect(prompt).toContain('Do not call tools, inspect a repository');
    }
  });

  it('preserves CRLF blocks byte-for-byte while parsing every protocol value', () => {
    const block = codeClaim({ eol: '\r\n' });
    const report = `## Result: REJECT\r\n\r\n${block}\r\n`;
    expect(scanCanonicalFindingClaimBlocks(report)).toEqual({ blocks: [block] });

    const items = parsedItems(report);
    expect(items).toHaveLength(1);
    expect(Reflect.get(items[0]!, 'rawExcerpt')).toBe(block);
    expect(() => ReviewerRawFindingSchema.parse(items[0])).not.toThrow();
    expect(inspectCanonicalClaimPublication(report, items)).toEqual({
      valid: true,
      correctable: false,
    });
  });

  it('uses matching variable-length fences and preserves shorter fence lines as content', () => {
    const block = fenceCollisionCodeClaim('\r\n');
    const report = `## Result: REJECT\r\n\r\n${block}`;
    const item = parsedItems(report)[0] as {
      rawExcerpt: string;
      candidate: {
        evidenceRequests: Array<{ verbatimExcerpt?: string }>;
      };
    };
    expect(item.rawExcerpt).toBe(block);
    expect(item.candidate.evidenceRequests[0]?.verbatimExcerpt)
      .toBe('before\r\n```\r\nafter');
    expect(inspectCanonicalClaimPublication(report, [item])).toEqual({
      valid: true,
      correctable: false,
    });
  });

  it('deep-compares every normalized field and rejects relation corruption', () => {
    const block = codeClaim({
      relation: 'persists',
      targetFindingId: 'F-0009',
    });
    const report = `## Result: REJECT\n\n${block}`;
    const expected = parsedItems(report);
    const replacements: ReadonlyArray<readonly [string, unknown]> = [
      ['rawFindingId', 'changed-id'],
      ['relation', 'resolution_confirmation'],
      ['targetFindingIds', ['F-other']],
      ['familyTag', 'changed-family'],
      ['severity', 'low'],
      ['title', 'Changed title'],
      ['description', 'Changed description'],
      ['suggestion', 'Changed suggestion'],
      ['target', { kind: 'code', paths: ['src/other.ts'] }],
      ['evidenceRequests', []],
    ];
    for (const [field, value] of replacements) {
      const corrupted = structuredClone(expected) as Array<{
        candidate: Record<string, unknown>;
      }>;
      corrupted[0]!.candidate[field] = value;
      expect(
        inspectCanonicalClaimPublication(report, corrupted),
        field,
      ).toMatchObject({
        valid: false,
        correctable: true,
        detail: expect.stringContaining('lossless canonical parse'),
      });
    }
  });

  it('treats malformed report grammar as fail-loud rather than correctable', () => {
    const valid = codeClaim();
    const malformed = [
      valid.replace('Finding Claim\n', ''),
      valid.replace('Severity: high\n', ''),
      `${FINDING_CLAIM_BEGIN_MARKER}\n${FINDING_CLAIM_END_MARKER}`,
      `${FINDING_CLAIM_BEGIN_MARKER}\nFinding Claim`,
    ];
    for (const block of malformed) {
      expect(inspectCanonicalClaimPublication(
        `## Result: REJECT\n\n${block}`,
        [],
      )).toMatchObject({
        valid: false,
        correctable: false,
      });
    }
  });

  it('derives zero-issue validity from the canonical report verdict', () => {
    for (const report of [
      '## Result: APPROVE\n\nNo issues.',
      '## Result: NEED_REPLAN\n\nThe review scope must be replanned.',
      '## 結果: APPROVE\n\n問題なし。',
      '## 結果: NEED_REPLAN\n\n再計画が必要。',
    ]) {
      expect(inspectCanonicalClaimPublication(report, [])).toEqual({
        valid: true,
        correctable: false,
      });
    }
    expect(inspectCanonicalClaimPublication(
      '## Result: REJECT\n\nNo canonical claim was published.',
      [],
    )).toMatchObject({
      valid: false,
      correctable: false,
      detail: expect.stringContaining('inconsistent'),
    });
  });

  it('allows confirmation-only APPROVE and enforces issue-bearing verdicts', () => {
    const confirmation = absenceConfirmation();
    const approve = `## Result: APPROVE\n\n${confirmation}`;
    expect(inspectCanonicalClaimPublication(
      approve,
      parsedItems(approve),
    )).toEqual({ valid: true, correctable: false });
    const authoritative = parsedItems(approve)[0] as {
      candidate: {
        evidenceRequests: Array<{ subject?: { verbatimExcerpt?: string } }>;
      };
    };
    expect(authoritative.candidate.evidenceRequests[1]?.subject?.verbatimExcerpt)
      .toBe('Remove forbidden().\n```\nKeep the requirement exact.');

    const issue = structureClaim();
    const structureReport = `## Result: REJECT\n\n${issue}`;
    expect(() => ReviewerRawFindingSchema.parse(
      parsedItems(structureReport)[0],
    )).not.toThrow();
    const pathReport = `## Result: REJECT\n\n${pathStateClaim()}`;
    expect(() => ReviewerRawFindingSchema.parse(
      parsedItems(pathReport)[0],
    )).not.toThrow();
    const invalidApprove = `## Result: APPROVE\n\n${issue}`;
    expect(inspectCanonicalClaimPublication(
      invalidApprove,
      [],
    )).toMatchObject({ valid: false, correctable: false });
  });

  it('uses correction only for normalized count or value mismatches', () => {
    const block = codeClaim();
    const report = `## Result: REJECT\n\n${block}`;
    expect(inspectCanonicalClaimPublication(report, [])).toMatchObject({
      valid: false,
      correctable: true,
      detail: expect.stringContaining('claim count 1'),
    });
    expect(inspectCanonicalClaimPublication(
      '## Result: APPROVE\n\nNo issues.',
      [{ rawExcerpt: block, candidate: null }],
    )).toMatchObject({
      valid: false,
      correctable: true,
      detail: expect.stringContaining('claim count 0'),
    });
  });
});

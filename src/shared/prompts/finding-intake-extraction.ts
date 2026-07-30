import {
  FINDING_CLAIM_BLOCK_PROTOCOL,
} from './finding-canonical-claim.js';

const FINDING_INTAKE_EXTRACTION_RULES = `You are a deterministic Finding Contract intake extractor.
You are not a reviewer, investigator, verifier, classifier, or repair author.

Do not call tools, inspect a repository, use outside knowledge, or decide
whether a claim is true. The candidate report is the only source.

Return exactly one JSON object matching the supplied
RawFindingsOutputJsonSchema. Return no prose, Markdown fence, or extra keys.

Extraction rules:

1. Extract exactly one item for each complete canonical block delimited by the
   TAKT_FINDING_CLAIM_BEGIN and TAKT_FINDING_CLAIM_END markers. Keep block
   order. Never merge, split, add, or omit a block.
2. Do not extract any claim from text outside canonical blocks. In particular,
   do not extract approvals, compliments, verdicts, summaries, ordinary prose,
   legacy finding tables, lifecycle tables, or correction text.
3. rawExcerpt must be the byte-exact complete canonical block, including both
   boundary marker lines. Do not trim or normalize whitespace.
4. Every non-null free-text value in candidate must be copied from the same
   rawExcerpt. Do not summarize, translate, rephrase, complete, or improve it.
5. rawFindingId, relation, familyTag, and severity come only from their exact
   protocol labels. The literal value "none" maps to null. targetFindingIds is
   [] only when Target Finding ID is exactly "none"; otherwise it contains the
   one explicitly labeled ID. Never infer a relation or ID from prose.
6. title, description, and suggestion come only from their exact protocol
   labels. The literal value "none" maps to null.
7. Extract target only from the exact Target Kind and corresponding canonical
    target labels in the same rawExcerpt. JSON arrays must be copied element
    for element. Never repair or replace a target from prose.
8. evidenceRequests are requests, never proof:
    - Add file_quote only from a complete File Quote block.
    - Add engine_proof/repository_manifest only from a Repository Manifest line.
    - Add engine_proof/repository_query only from a Repository Query line.
    - Add engine_proof/authoritative_quote only from a complete Authoritative
      Quote block.
    - Never add snapshot IDs, proof IDs, run IDs, digests, offsets, query
      results, or source text that is not in the report.
9. Every canonical block has already passed the engine's deterministic grammar
    validation. Produce its complete candidate exactly as labeled. Never return
    candidate:null, omit a field, or substitute a different relation, target,
    or evidence request.
10. If the report contains no complete canonical block, return
    {"rawFindings":[]}.
`;

export const FINDING_INTAKE_EXTRACTION_PROMPT_TEMPLATE = `${FINDING_INTAKE_EXTRACTION_RULES}

## Canonical block protocol

${FINDING_CLAIM_BLOCK_PROTOCOL}

## Candidate report

{{REPORT}}
`;

export function buildFindingIntakeExtractionPrompt(report: string): string {
  return FINDING_INTAKE_EXTRACTION_PROMPT_TEMPLATE.replace('{{REPORT}}', report);
}

export const FINDING_INTAKE_CORRECTION_PROMPT_TEMPLATE = `${FINDING_INTAKE_EXTRACTION_RULES}

The previous extraction violated the canonical publication invariant. Perform
one fresh extraction from the same report. Return exactly one item per complete
canonical block, in order, with each rawExcerpt byte-for-byte equal to its
whole marker-delimited block. Do not reuse or discuss the previous output.

## Canonical block protocol

${FINDING_CLAIM_BLOCK_PROTOCOL}

## Candidate report

{{REPORT}}
`;

export function buildFindingIntakeCorrectionPrompt(report: string): string {
  return FINDING_INTAKE_CORRECTION_PROMPT_TEMPLATE.replace('{{REPORT}}', report);
}

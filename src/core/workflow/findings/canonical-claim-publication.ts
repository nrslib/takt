import { isDeepStrictEqual } from 'node:util';
import {
  parseCanonicalFindingClaimReport,
} from '../../../shared/prompts/finding-canonical-claim.js';

export interface CanonicalClaimPublicationInspection {
  readonly valid: boolean;
  readonly correctable: boolean;
  readonly detail?: string;
}

/**
 * The canonical parser determines the only normalized representation accepted
 * at the publication boundary. It does not read the ledger or evaluate truth.
 */
export function inspectCanonicalClaimPublication(
  reportContent: string,
  rawFindings: readonly unknown[],
): CanonicalClaimPublicationInspection {
  const parsed = parseCanonicalFindingClaimReport(reportContent);
  if (parsed.error !== undefined) {
    return {
      valid: false,
      correctable: false,
      detail: parsed.error,
    };
  }

  if (parsed.report.items.length !== rawFindings.length) {
    return {
      valid: false,
      correctable: true,
      detail: `canonical claim count ${parsed.report.items.length} does not match normalized item count ${rawFindings.length}`,
    };
  }

  for (const [index, expected] of parsed.report.items.entries()) {
    if (!isDeepStrictEqual(expected, rawFindings[index])) {
      return {
        valid: false,
        correctable: true,
        detail: `normalized item ${index} is not the lossless canonical parse of block ${index}`,
      };
    }
  }

  return { valid: true, correctable: false };
}

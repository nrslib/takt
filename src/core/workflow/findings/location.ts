/**
 * Shared parsing for the "path:line" shape used by RawFinding.location and
 * FindingLedgerEntry.location (see finding_contract_instruction.md: "file:line
 * evidence"). The ledger keeps `location` as a single free-form string for
 * backward compatibility (existing v1 ledgers parse unchanged); this module is
 * the single place that decomposes it into path/line for callers that need to
 * reason about identity (decision-assembly.ts) or admission (admission-validation.ts)
 * without treating the line number as part of identity (see Finding Contract
 * convergence design: familyTag and line number are demoted from identity to hints).
 */

export interface ParsedFindingLocation {
  path: string;
  line?: number;
}

/**
 * Parses a "path:line" location string. Locations without a trailing ":<digits>"
 * are treated as a bare path (line is undefined) rather than rejected, since some
 * findings only have file-level evidence. Returns undefined for empty/undefined
 * input (locationless findings, e.g. architectural observations with no single site).
 */
export function parseFindingLocation(location: string | undefined): ParsedFindingLocation | undefined {
  if (location === undefined) {
    return undefined;
  }
  const trimmed = location.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const match = /^(.+?):(\d+)$/.exec(trimmed);
  if (match) {
    return { path: match[1]!.trim(), line: Number(match[2]) };
  }
  return { path: trimmed };
}

/** Normalizes free text for identity comparisons: trims and collapses internal whitespace. Case is preserved because exact-duplicate checks should not conflate differently-cased identifiers. */
export function normalizeFindingText(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

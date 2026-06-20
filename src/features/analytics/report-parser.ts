/**
 * Extracts analytics event data from review report markdown.
 *
 * Review reports follow a consistent structure with finding tables
 * under "new", "persists", and "resolved" sections. Each table row
 * contains a finding_id column.
 */

import type { FindingLedger, FindingLedgerEntry } from '../../core/models/finding-types.js';
import type { FindingStatus, FindingSeverity, FindingDecision, FixActionEvent, FixActionType, ReviewFindingEvent } from './events.js';
import { writeAnalyticsEvent } from './writer.js';

export interface ParsedFinding {
  findingId: string;
  status: FindingStatus;
  ruleId: string;
  file: string;
  line: number;
}

const SECTION_PATTERNS: Array<{ pattern: RegExp; status: FindingStatus }> = [
  { pattern: /^##\s+.*\bnew\b/i, status: 'new' },
  { pattern: /^##\s+.*\bpersists\b/i, status: 'persists' },
  { pattern: /^##\s+.*\bresolved\b/i, status: 'resolved' },
];

export function parseFindingsFromReport(reportContent: string): ParsedFinding[] {
  const lines = reportContent.split('\n');
  const findings: ParsedFinding[] = [];
  let currentStatus: FindingStatus | null = null;
  let columnIndices: TableColumnIndices | null = null;
  let headerParsed = false;

  for (const line of lines) {
    const sectionMatch = matchSection(line);
    if (sectionMatch) {
      currentStatus = sectionMatch;
      columnIndices = null;
      headerParsed = false;
      continue;
    }

    if (line.startsWith('## ')) {
      currentStatus = null;
      columnIndices = null;
      headerParsed = false;
      continue;
    }

    if (!currentStatus) continue;

    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    if (isSeparatorRow(trimmed)) continue;

    if (!headerParsed) {
      columnIndices = detectColumnIndices(trimmed);
      headerParsed = true;
      continue;
    }

    if (!columnIndices || columnIndices.findingId < 0) continue;

    const finding = parseTableRow(line, currentStatus, columnIndices);
    if (finding) {
      findings.push(finding);
    }
  }

  return findings;
}

export function extractDecisionFromReport(reportContent: string): FindingDecision | null {
  const resultMatch = reportContent.match(/^##\s+(?:結果|Result)\s*:\s*(\w+)/m);
  const decision = resultMatch?.[1];
  if (!decision) return null;
  return decision.toUpperCase() === 'REJECT' ? 'reject' : 'approve';
}

function matchSection(line: string): FindingStatus | null {
  for (const { pattern, status } of SECTION_PATTERNS) {
    if (pattern.test(line)) return status;
  }
  return null;
}

function isSeparatorRow(trimmed: string): boolean {
  return /^\|[\s-]+\|/.test(trimmed);
}

interface TableColumnIndices {
  findingId: number;
  category: number;
}

function detectColumnIndices(headerRow: string): TableColumnIndices {
  const cells = headerRow.split('|').map((c) => c.trim()).filter(Boolean);
  const findingId = cells.findIndex((c) => c.toLowerCase() === 'finding_id');
  const category = cells.findIndex((c) => {
    const lower = c.toLowerCase();
    return lower === 'category' || lower === 'カテゴリ';
  });
  return { findingId, category };
}

function parseTableRow(
  line: string,
  status: FindingStatus,
  indices: TableColumnIndices,
): ParsedFinding | null {
  const cells = line.split('|').map((c) => c.trim()).filter(Boolean);
  if (cells.length <= indices.findingId) return null;

  const findingId = cells[indices.findingId];
  if (!findingId) return null;

  const categoryValue = indices.category >= 0 ? cells[indices.category] : undefined;
  const ruleId = categoryValue ?? findingId;

  const locationCell = findLocation(cells);
  const { file, line: lineNum } = parseLocation(locationCell);

  return { findingId, status, ruleId, file, line: lineNum };
}

function findLocation(cells: string[]): string {
  for (const cell of cells) {
    if (cell.includes('/') || cell.includes('.ts') || cell.includes('.js') || cell.includes('.py')) {
      return cell;
    }
  }
  return '';
}

function parseLocation(location: string): { file: string; line: number } {
  const cleaned = location.replace(/`/g, '');
  const lineMatch = cleaned.match(/:(\d+)/);
  const lineStr = lineMatch?.[1];
  const lineNum = lineStr ? parseInt(lineStr, 10) : 0;
  const file = cleaned.replace(/:\d+.*$/, '').trim();
  return { file, line: lineNum };
}

export function inferSeverity(findingId: string): FindingSeverity {
  const id = findingId.toUpperCase();
  if (id.includes('SEC')) return 'error';
  return 'warning';
}

function inferLedgerSeverity(finding: FindingLedgerEntry): FindingSeverity {
  return finding.severity === 'critical' || finding.severity === 'high' ? 'error' : 'warning';
}

function toFindingStatus(finding: FindingLedgerEntry): FindingStatus {
  return finding.lifecycle;
}

const FINDING_CONTRACT_RULE_ID = 'finding-contract';

export function buildReviewFindingEventsFromLedger(
  ledger: FindingLedger,
  iteration: number,
  runId: string,
  timestamp: Date,
): ReviewFindingEvent[] {
  const decision: FindingDecision = ledger.findings.some((finding) => finding.status === 'open')
    || ledger.conflicts.some((conflict) => conflict.status === 'active')
    ? 'reject'
    : 'approve';

  return ledger.findings.map((finding) => {
    const { file, line } = parseLocation(finding.location ?? '');
    return {
      type: 'review_finding',
      findingId: finding.id,
      status: toFindingStatus(finding),
      ruleId: FINDING_CONTRACT_RULE_ID,
      severity: inferLedgerSeverity(finding),
      decision,
      file,
      line,
      iteration,
      runId,
      timestamp: timestamp.toISOString(),
    };
  });
}

const FINDING_ID_PATTERN = /\b(?:F-\d{4}|[A-Z]{2,}-(?:NEW-)?[\w-]+)\b/g;
const ENGINE_FINDING_ID_PATTERN = /^F-\d{4}$/;

export function emitFixActionEvents(
  responseContent: string,
  iteration: number,
  runId: string,
  timestamp: Date,
  findingContractFindingIds?: ReadonlySet<string>,
): void {
  emitActionEvents(responseContent, 'fixed', iteration, runId, timestamp, findingContractFindingIds);
}

export function emitRebuttalEvents(
  responseContent: string,
  iteration: number,
  runId: string,
  timestamp: Date,
  findingContractFindingIds?: ReadonlySet<string>,
): void {
  emitActionEvents(responseContent, 'rebutted', iteration, runId, timestamp, findingContractFindingIds);
}

function emitActionEvents(
  responseContent: string,
  action: FixActionType,
  iteration: number,
  runId: string,
  timestamp: Date,
  findingContractFindingIds?: ReadonlySet<string>,
): void {
  const matches = responseContent.match(FINDING_ID_PATTERN);
  if (!matches) return;

  const uniqueIds = [...new Set(matches)].filter((findingId) => {
    if (!ENGINE_FINDING_ID_PATTERN.test(findingId)) {
      return true;
    }
    return findingContractFindingIds?.has(findingId) === true;
  });
  for (const findingId of uniqueIds) {
    const event: FixActionEvent = {
      type: 'fix_action',
      findingId,
      action,
      iteration,
      runId,
      timestamp: timestamp.toISOString(),
    };
    writeAnalyticsEvent(event);
  }
}

/**
 * Extracts analytics event data from review report markdown.
 *
 * Review reports follow a consistent structure with finding tables
 * under "new", "persists", and "resolved" sections. Each table row
 * contains a finding_id column.
 */

import type { FindingStatus, FindingSeverity, FindingDecision, FixActionEvent, FixActionType } from './events.js';
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

const FINDING_ID_PATTERN = /\b[A-Z]{2,}-(?:NEW-)?[\w-]+\b/g;

export function emitFixActionEvents(
  responseContent: string,
  iteration: number,
  runId: string,
  timestamp: Date,
): void {
  emitActionEvents(responseContent, 'fixed', iteration, runId, timestamp);
}

export function emitRebuttalEvents(
  responseContent: string,
  iteration: number,
  runId: string,
  timestamp: Date,
): void {
  emitActionEvents(responseContent, 'rebutted', iteration, runId, timestamp);
}

function emitActionEvents(
  responseContent: string,
  action: FixActionType,
  iteration: number,
  runId: string,
  timestamp: Date,
): void {
  const matches = responseContent.match(FINDING_ID_PATTERN);
  if (!matches) return;

  const uniqueIds = [...new Set(matches)];
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

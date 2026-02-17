/**
 * Report file reader for health monitor.
 *
 * Reads report markdown files from the reports directory and extracts
 * raw findings using text-based parsing. When Finding Contract (#277)
 * is introduced, this can be replaced with structured data reading.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { RawFinding, FindingStatus, ConversationEntry } from '../../core/piece/health-monitor/types.js';

/**
 * Read all markdown report files from a reports directory.
 * Returns file contents keyed by filename.
 */
export function readReportFiles(reportsDir: string): ReadonlyMap<string, string> {
  if (!existsSync(reportsDir)) {
    return new Map();
  }

  const entries = readdirSync(reportsDir);
  const result = new Map<string, string>();

  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    const filePath = join(reportsDir, entry);
    const content = readFileSync(filePath, 'utf-8');
    result.set(entry, content);
  }

  return result;
}

const FINDING_LINE_PATTERN = /^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/;
const VALID_STATUSES: ReadonlySet<string> = new Set(['new', 'persists', 'resolved']);

function parseStatus(raw: string): FindingStatus | null {
  const normalized = raw.trim().toLowerCase();
  if (VALID_STATUSES.has(normalized)) {
    return normalized as FindingStatus;
  }
  return null;
}

/**
 * Extract raw findings from a report file content.
 *
 * Looks for markdown table rows matching the pattern:
 *   | finding_id | status | category | location |
 *
 * Skips header rows and separator rows (containing dashes).
 */
export function extractFindings(content: string): readonly RawFinding[] {
  const lines = content.split('\n');
  const findings: RawFinding[] = [];

  for (const line of lines) {
    const match = FINDING_LINE_PATTERN.exec(line);
    if (!match) continue;

    const col1 = match[1];
    const col2 = match[2];
    const col3 = match[3];
    const col4 = match[4];
    if (!col1 || !col2 || !col3 || !col4) continue;

    const id = col1.trim();
    const rawStatus = col2.trim();
    const category = col3.trim();
    const location = col4.trim();
    if (id === 'finding_id' || id.startsWith('-')) continue;
    if (rawStatus.startsWith('-')) continue;

    const status = parseStatus(rawStatus);
    if (!status) continue;

    findings.push({ id, status, category, location });
  }

  return findings;
}

/**
 * Read and extract all findings from a reports directory.
 * Aggregates findings across all report files.
 */
export function readAndExtractFindings(reportsDir: string): readonly RawFinding[] {
  const reportFiles = readReportFiles(reportsDir);
  const allFindings: RawFinding[] = [];

  for (const [, content] of reportFiles) {
    const findings = extractFindings(content);
    allFindings.push(...findings);
  }

  return allFindings;
}

/**
 * Read the most recent N movement conversations from NDJSON log files.
 *
 * Parses step_complete records from all .jsonl files in the logs directory
 * and returns the last `depth` entries. Each entry captures what the reviewer
 * asked (instruction) and what the agent responded (content).
 */
export function readRecentConversations(logsDir: string, depth: number): readonly ConversationEntry[] {
  if (!existsSync(logsDir)) {
    return [];
  }

  const entries = readdirSync(logsDir);
  const allConversations: ConversationEntry[] = [];

  for (const entry of entries) {
    if (!entry.endsWith('.jsonl')) continue;
    const filePath = join(logsDir, entry);
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter((line) => line.trim().length > 0);

    for (const line of lines) {
      const parsed = parseNdjsonLine(line);
      if (!parsed) continue;
      if (parsed.type !== 'step_complete') continue;

      allConversations.push({
        step: parsed.step as string,
        instruction: parsed.instruction as string,
        content: parsed.content as string,
        ...(parsed.error ? { error: parsed.error as string } : {}),
      });
    }
  }

  return allConversations.slice(-depth);
}

function parseNdjsonLine(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    if (typeof parsed === 'object' && parsed !== null && 'type' in parsed) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getErrorMessage } from '../../shared/utils/index.js';

const MAX_REPORT_DEPTH = 12;
const MAX_REPORT_ENTRIES = 1_024;

export interface ReportEntryScanResult {
  readonly entries: readonly string[];
  readonly failure?: string;
}

export function scanReportEntries(root: string): ReportEntryScanResult {
  const entries: string[] = [];
  const pending: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
  try {
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (current.depth > MAX_REPORT_DEPTH) {
        return { entries, failure: `report_scan_depth_exceeded:${MAX_REPORT_DEPTH}` };
      }
      for (const entry of readdirSync(current.path, { withFileTypes: true })) {
        if (entries.length >= MAX_REPORT_ENTRIES) {
          return { entries, failure: `report_scan_entry_limit_exceeded:${MAX_REPORT_ENTRIES}` };
        }
        const entryPath = join(current.path, entry.name);
        entries.push(entryPath);
        if (entry.isDirectory()) pending.push({ path: entryPath, depth: current.depth + 1 });
      }
    }
  } catch (error) {
    return { entries, failure: `report_scan_failed:${getErrorMessage(error)}` };
  }
  return { entries };
}

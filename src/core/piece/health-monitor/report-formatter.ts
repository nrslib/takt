/**
 * Report formatter — renders a HealthSnapshot into a human-readable
 * console output string matching the spec format.
 */

import type { FindingRecord, HealthSnapshot, HealthVerdict } from './types.js';

const BORDER = '═══════════════════════════════════';
const HEADER = '═══ Loop Health Monitor ═══';

const VERDICT_LABELS: Record<HealthVerdict, string> = {
  converging: '✓ 収束',
  improving: '→ 改善動作',
  stagnating: '▲ 停滞',
  looping: '✗ ループ',
  needs_attention: '⚠ 要注意',
  misaligned: '✗ 噛み合い不全',
};

function formatTrend(record: FindingRecord): string {
  switch (record.trend) {
    case 'improving':
      return '✓ 改善';
    case 'stagnating':
      return '▲ 停滞';
    case 'looping':
      return '✗ ループ';
    case 'new':
      return '→ 新規';
  }
}

function padRight(str: string, len: number): string {
  if (str.length >= len) return str;
  return str + ' '.repeat(len - str.length);
}

function formatFindingsTable(findings: readonly FindingRecord[]): string {
  if (findings.length === 0) {
    return '  (no findings)';
  }

  const header = `  ${padRight('finding_id', 20)}| ${padRight('status', 10)}| ${padRight('連続回数', 10)}| 傾向`;
  const rows = findings.map((f) => {
    const persistsDisplay = f.status === 'resolved' ? '-' : String(f.consecutivePersists);
    return `  ${padRight(f.findingId, 20)}| ${padRight(f.status, 10)}| ${padRight(persistsDisplay, 10)}| ${formatTrend(f)}`;
  });

  return [header, ...rows].join('\n');
}

/**
 * Format a health snapshot into a display string.
 */
export function formatHealthReport(snapshot: HealthSnapshot): string {
  const lines: string[] = [
    HEADER,
    `Movement: ${snapshot.movementName} (iteration ${snapshot.iteration}/${snapshot.maxMovements})`,
    '',
    '指摘内訳:',
    formatFindingsTable(snapshot.findings),
    '',
    `健全性: ${VERDICT_LABELS[snapshot.verdict.verdict]}`,
    `  理由: ${snapshot.verdict.summary}`,
    BORDER,
  ];

  return lines.join('\n');
}

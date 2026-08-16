export interface RunReportForSummary {
  readonly filename: string;
  readonly content: string;
}

export interface RunReportSummary {
  readonly fulfilledRequirements: readonly string[];
  readonly unresolvedFindingCount: number;
  readonly reviewHistory: readonly string[];
  readonly unverifiedGates: readonly string[];
}

type ReportContract = 'supervisor-validation' | 'review-decision' | 'supervisor-summary';

const REPORT_SECTION_NAMES = {
  supervisorValidationRequirements: [
    '要件充足チェック',
    'Requirements Fulfillment Check',
    'Requirement Fulfillment Check',
  ],
  supervisorValidationFindings: [
    '前段 finding の再評価',
    'Re-evaluation of Prior Findings',
  ],
  reviewDecisionRequirements: [
    '要件の判定根拠',
    'Requirement Decision Grounds',
  ],
  reviewDecisionFindings: [
    '指摘ごとの裁定',
    'Finding Dispositions',
  ],
  supervisorSummaryRequirements: [
    '要件充足',
    'Requirement Fulfillment',
  ],
  supervisorSummaryFindings: [
    '前段 finding',
    'Preceding Findings',
  ],
  reviewHistory: [
    'レビュー履歴',
    'Review History',
    '前段 finding の再評価',
    'Re-evaluation of Prior Findings',
  ],
  unverified: [
    '判定不能の理由（BLOCKED の場合）',
    '判定不能の理由',
    '判定不能',
    '未解決の前提',
    'Reason the Decision Cannot Be Made (when BLOCKED)',
    'Reason the Decision Cannot Be Made',
    'Unresolved Premises',
  ],
} as const;

interface ReportSections {
  readonly requirements: readonly string[];
  readonly findings: readonly string[];
  readonly reviewHistory: readonly string[];
  readonly unverified: readonly string[];
}

const REPORT_SECTIONS: Record<ReportContract, ReportSections> = {
  'supervisor-validation': {
    requirements: REPORT_SECTION_NAMES.supervisorValidationRequirements,
    findings: REPORT_SECTION_NAMES.supervisorValidationFindings,
    reviewHistory: REPORT_SECTION_NAMES.reviewHistory,
    unverified: REPORT_SECTION_NAMES.unverified,
  },
  'review-decision': {
    requirements: REPORT_SECTION_NAMES.reviewDecisionRequirements,
    findings: REPORT_SECTION_NAMES.reviewDecisionFindings,
    reviewHistory: REPORT_SECTION_NAMES.reviewHistory,
    unverified: REPORT_SECTION_NAMES.unverified,
  },
  'supervisor-summary': {
    requirements: REPORT_SECTION_NAMES.supervisorSummaryRequirements,
    findings: REPORT_SECTION_NAMES.supervisorSummaryFindings,
    reviewHistory: REPORT_SECTION_NAMES.reviewHistory,
    unverified: REPORT_SECTION_NAMES.unverified,
  },
};

const FULFILLED_STATUS = /^(?:充足|fulfilled|satisfied)$/i;
const UNRESOLVED_STATUS = /(?:未解決|未解消|未確認|未対応|unresolved|open|actionable|unverified)/i;

interface FenceMarker {
  readonly character: '`' | '~';
  readonly length: number;
  readonly info: string;
}

function parseFenceMarker(line: string): FenceMarker | undefined {
  const match = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
  if (!match) return undefined;
  return {
    character: match[1]![0] as '`' | '~',
    length: match[1]!.length,
    info: match[2]!.trim(),
  };
}

function outsideMarkdownFence(content: string): string {
  let sourceLines = content.split(/\r?\n/);
  const firstNonEmpty = sourceLines.findIndex((line) => line.trim().length > 0);
  let lastNonEmpty = -1;
  for (let index = sourceLines.length - 1; index >= 0; index -= 1) {
    if (sourceLines[index]!.trim().length > 0) {
      lastNonEmpty = index;
      break;
    }
  }

  const wrapperOpening = firstNonEmpty === -1 ? undefined : parseFenceMarker(sourceLines[firstNonEmpty]!);
  const wrapperClosing = lastNonEmpty === -1 ? undefined : parseFenceMarker(sourceLines[lastNonEmpty]!);
  if (
    wrapperOpening !== undefined
    && wrapperOpening.length >= 3
    && /^(?:markdown|md)?$/i.test(wrapperOpening.info)
    && wrapperClosing?.character === wrapperOpening.character
    && wrapperClosing.length >= wrapperOpening.length
    && wrapperClosing.info === ''
  ) {
    sourceLines = sourceLines.slice(firstNonEmpty + 1, lastNonEmpty);
  }

  let activeFence: FenceMarker | undefined;
  const lines: string[] = [];
  for (const line of sourceLines) {
    const fence = parseFenceMarker(line);
    if (activeFence === undefined) {
      if (fence !== undefined) {
        activeFence = fence;
        continue;
      }
      lines.push(line);
      continue;
    }

    if (
      fence !== undefined
      && fence.character === activeFence.character
      && fence.length >= activeFence.length
      && fence.info === ''
    ) {
      activeFence = undefined;
    }
  }
  return lines.join('\n');
}

function getHeading(line: string): string | undefined {
  return line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/)?.[1];
}

function getHeadings(content: string): Set<string> {
  return new Set(
    outsideMarkdownFence(content)
      .split(/\r?\n/)
      .map(getHeading)
      .filter((heading): heading is string => heading !== undefined),
  );
}

function sectionContent(content: string, names: readonly string[]): string[] {
  const nameSet = new Set(names);
  let active = false;
  const result: string[] = [];

  for (const line of outsideMarkdownFence(content).split(/\r?\n/)) {
    const heading = getHeading(line);
    if (heading !== undefined) {
      active = nameSet.has(heading);
      continue;
    }
    if (active) {
      result.push(line);
    }
  }
  return result;
}

function parseTableRows(lines: readonly string[]): string[][] {
  return lines
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|') && line.endsWith('|'))
    .map((line) => line.slice(1, -1).split('|').map((cell) => cell.trim()))
    .filter((cells) => !cells.every((cell) => /^:?-{2,}:?$/.test(cell)));
}

function findHeaderIndex(rows: readonly string[][], matcher: RegExp): number {
  return rows.findIndex((row) => row.some((cell) => matcher.test(cell)));
}

function findColumn(row: readonly string[], matcher: RegExp): number {
  return row.findIndex((cell) => matcher.test(cell));
}

function cleanCell(value: string | undefined): string {
  return value?.replace(/\s+/g, ' ').trim() ?? '';
}

function fulfilledRequirements(lines: readonly string[]): string[] {
  const rows = parseTableRows(lines);
  const headerIndex = findHeaderIndex(rows, /要件|requirement|subject|対象/i);
  if (headerIndex >= 0) {
    const header = rows[headerIndex]!;
    const requirementColumn = findColumn(header, /要件|requirement|subject|対象/i);
    const statusColumn = findColumn(header, /充足|status|状態/i);
    if (requirementColumn >= 0 && statusColumn >= 0) {
      return rows
        .slice(headerIndex + 1)
        .filter((row) => FULFILLED_STATUS.test(cleanCell(row[statusColumn])))
        .map((row) => cleanCell(row[requirementColumn]))
        .filter((value) => value.length > 0);
    }
  }

  return lines
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('|'))
    .filter((line) => /(?:^|[-:：])\s*(?:充足|fulfilled|satisfied)(?:\s|$)/i.test(line))
    .map((line) => line.replace(/^[-*]\s*/, '').trim());
}

function unresolvedFindingCount(lines: readonly string[]): number {
  const rows = parseTableRows(lines);
  const headerIndex = findHeaderIndex(rows, /finding|解消状態|resolution|status|状態|disposition|裁定/i);
  if (headerIndex >= 0) {
    const statusColumn = findColumn(
      rows[headerIndex]!,
      /解消状態|resolution|status|状態|disposition|裁定/i,
    );
    if (statusColumn >= 0) {
      return rows
        .slice(headerIndex + 1)
        .filter((row) => UNRESOLVED_STATUS.test(cleanCell(row[statusColumn])))
        .length;
    }
  }

  return lines.filter((line) => UNRESOLVED_STATUS.test(line)).length;
}

function meaningfulLines(lines: readonly string[]): string[] {
  return lines
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !/^\|?\s*:?-{2,}(?:\s*\|\s*:?-{2,})+\s*\|?$/.test(line))
    .filter((line) => !/^\|.*(?:要件|Requirement|status|状態).*(?:\|.*){1,}$/i.test(line));
}

function isNoItemsStatement(line: string): boolean {
  return /^[-*]?\s*(?:なし|該当なし|none)(?:\s*[。.!]|\s*$)/i.test(line.trim());
}

function hasTableWithColumns(
  lines: readonly string[],
  firstColumnMatcher: RegExp,
  statusColumnMatcher: RegExp,
): boolean {
  return parseTableRows(lines).some((row) => (
    findColumn(row, firstColumnMatcher) >= 0
    && findColumn(row, statusColumnMatcher) >= 0
  ));
}

function isParseableReport(report: RunReportForSummary, contract: ReportContract): boolean {
  const sections = REPORT_SECTIONS[contract];
  const requirements = sectionContent(report.content, sections.requirements);
  const findings = sectionContent(report.content, sections.findings);
  const unverified = sectionContent(report.content, sections.unverified);

  if (contract === 'review-decision' || contract === 'supervisor-validation') {
    return hasTableWithColumns(
      requirements,
      /要件|requirement|subject|対象/i,
      /充足|status|状態/i,
    );
  }

  return [requirements, findings, unverified]
    .some((lines) => meaningfulLines(lines).length > 0);
}

function getOccurrence(filename: string): number {
  const occurrences = [...filename.matchAll(/(?:^|\/)iteration-(\d+)(?:--|\/)/g)]
    .map((match) => Number(match[1]));
  return occurrences.length > 0 ? Math.max(...occurrences) : -1;
}

function getContract(report: RunReportForSummary): ReportContract | undefined {
  const basename = report.filename.split('/').pop();
  if (basename === 'supervisor-validation.md') {
    const headings = getHeadings(report.content);
    return REPORT_SECTION_NAMES.supervisorValidationRequirements.some((name) => headings.has(name))
      || REPORT_SECTION_NAMES.supervisorValidationFindings.some((name) => headings.has(name))
      || REPORT_SECTION_NAMES.unverified.some((name) => headings.has(name))
      ? 'supervisor-validation'
      : undefined;
  }
  if (basename === 'summary.md') {
    const headings = getHeadings(report.content);
    return REPORT_SECTION_NAMES.supervisorSummaryRequirements.some((name) => headings.has(name))
      || REPORT_SECTION_NAMES.supervisorSummaryFindings.some((name) => headings.has(name))
      ? 'supervisor-summary'
      : undefined;
  }
  if (basename !== 'review-resolution.md') {
    return undefined;
  }

  const headings = getHeadings(report.content);
  if (REPORT_SECTION_NAMES.reviewDecisionRequirements.some((name) => headings.has(name))) {
    return 'review-decision';
  }
  if (REPORT_SECTION_NAMES.supervisorValidationRequirements.some((name) => headings.has(name))) {
    return 'supervisor-validation';
  }
  return undefined;
}

function selectFinalReport(reports: readonly RunReportForSummary[]): {
  report: RunReportForSummary;
  contract: ReportContract;
} | undefined {
  const priority: readonly ReportContract[] = [
    'supervisor-validation',
    'review-decision',
    'supervisor-summary',
  ];
  const candidates = reports.flatMap((report) => {
    const contract = getContract(report);
    return contract === undefined
      ? []
      : [{ report, contract }];
  });

  candidates.sort((left, right) => {
    const occurrenceOrder = getOccurrence(right.report.filename) - getOccurrence(left.report.filename);
    if (occurrenceOrder !== 0) return occurrenceOrder;
    const depthOrder = left.report.filename.split('/').length - right.report.filename.split('/').length;
    if (depthOrder !== 0) return depthOrder;
    const leftScope = left.report.filename.split('/').slice(0, -1).join('/');
    const rightScope = right.report.filename.split('/').slice(0, -1).join('/');
    const scopeOrder = leftScope.localeCompare(rightScope);
    if (scopeOrder !== 0) return scopeOrder;
    const contractOrder = priority.indexOf(left.contract) - priority.indexOf(right.contract);
    if (contractOrder !== 0) return contractOrder;
    return left.report.filename.localeCompare(right.report.filename);
  });

  const primary = candidates[0];
  return primary !== undefined && isParseableReport(primary.report, primary.contract)
    ? primary
    : undefined;
}

export function summarizeRunReports(
  reports: readonly RunReportForSummary[],
): RunReportSummary | null {
  const selected = selectFinalReport(reports);
  if (selected === undefined) {
    return null;
  }

  const { report, contract } = selected;
  const sections = REPORT_SECTIONS[contract];
  const requirements = sectionContent(report.content, sections.requirements);
  const findingLines = sectionContent(report.content, sections.findings);
  const reviewHistory = sectionContent(report.content, sections.reviewHistory);
  const unverifiedGates = sectionContent(report.content, sections.unverified);

  return {
    fulfilledRequirements: fulfilledRequirements(requirements),
    unresolvedFindingCount: unresolvedFindingCount(findingLines),
    reviewHistory: meaningfulLines(reviewHistory),
    unverifiedGates: meaningfulLines(unverifiedGates)
      .filter((line) => !isNoItemsStatement(line)),
  };
}

export function formatRunReportSummary(summary: RunReportSummary): string {
  const sections = [
    '## 最終裁定サマリー',
    '### 充足要件',
    ...(summary.fulfilledRequirements.length > 0 ? summary.fulfilledRequirements : ['記録なし']),
    `### 未解決 finding: ${summary.unresolvedFindingCount}件`,
    '### レビュー履歴',
    ...(summary.reviewHistory.length > 0 ? summary.reviewHistory : ['記録なし']),
  ];

  if (summary.unverifiedGates.length > 0) {
    sections.push('### 未実証ゲート', ...summary.unverifiedGates);
  }

  return sections.join('\n');
}

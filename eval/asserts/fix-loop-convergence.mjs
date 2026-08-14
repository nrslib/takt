const E06_INVARIANT_NAMES = ['INV-RESUME-DEFAULT', 'INV-BUDGET-50'];
const E12_CARRIED_ROW = {
  familyId: 'FAM-RETRY-PICKER',
  invariantName: 'BW-2',
  responsibleSource: 'TaskRetryRestartTree の target 解決・visible projection',
  cumulativeIncompleteCount: '3',
  recurrenceConfirmed: '確認済み',
};
const E12_ACTIONABLE_FINDING = 'ARCH-NEW-picker-L520';
const E12_NON_ACTIONABLE_INVARIANT = 'INV-EMPTY-TERM';
const INVARIANT_NAME_HEADERS = [/^不変条件の名前$/, /^invariant name$/i];

function unwrapProviderOutput(output) {
  try {
    const parsed = JSON.parse(output);
    if (parsed !== null && typeof parsed === 'object' && typeof parsed.output === 'string') {
      return parsed.output;
    }
  } catch {
    return output;
  }
  return output;
}

function splitMarkdownRow(line) {
  const cells = [];
  let cell = '';
  let inCode = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '`' && line[index - 1] !== '\\') inCode = !inCode;
    if (character === '|' && !inCode && line[index - 1] !== '\\') {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += character;
    }
  }
  cells.push(cell.trim());
  if (cells[0] === '') cells.shift();
  if (cells.at(-1) === '') cells.pop();
  return cells;
}

function normalize(value) {
  return value.replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim();
}

function normalizeHeader(value) {
  return normalize(value).toLowerCase();
}

function parseFence(line) {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (match === null) return undefined;
  return { marker: match[1][0], length: match[1].length, suffix: match[2] };
}

function canOpenFence(fence) {
  return fence.marker === '~' || !fence.suffix.includes('`');
}

function closesFence(fence, openFence) {
  return fence !== undefined
    && fence.marker === openFence.marker
    && fence.length >= openFence.length
    && /^[ \t]*$/.test(fence.suffix);
}

function unwrapOuterFence(output) {
  const lines = output.split('\n');
  if (lines.length < 3) return output;
  const opening = parseFence(lines[0]);
  if (opening === undefined || !canOpenFence(opening)) return output;

  let closingIndex = lines.length - 1;
  if (!closesFence(parseFence(lines[closingIndex]), opening)) {
    if (!/^JUDGEMENT:/.test(lines.at(-1))) return output;
    closingIndex -= 1;
    while (closingIndex > 0 && lines[closingIndex].trim() === '') closingIndex -= 1;
    if (!closesFence(parseFence(lines[closingIndex]), opening)) return output;
  }

  const closesBeforeOuterFence = lines.slice(1, closingIndex).some((line) =>
    closesFence(parseFence(line), opening));
  if (closesBeforeOuterFence) return output;
  return [...lines.slice(1, closingIndex), ...lines.slice(closingIndex + 1)].join('\n');
}

function extractSections(output) {
  const preamble = { heading: '', level: 0, lines: [], directLines: [] };
  const sections = [];
  const openSections = [];
  let openFence;
  for (const line of output.split('\n')) {
    const fence = parseFence(line);
    const wasInsideFence = openFence !== undefined;
    let isFenceContent = wasInsideFence;
    if (wasInsideFence) {
      if (closesFence(fence, openFence)) openFence = undefined;
    } else if (fence !== undefined && canOpenFence(fence)) {
      openFence = fence;
      isFenceContent = true;
    }

    const heading = isFenceContent
      ? null
      : /^ {0,3}(#{1,6})[ \t]+(.+?)\s*$/.exec(line);
    if (heading !== null) {
      const level = heading[1].length;
      while (openSections.at(-1)?.level >= level) openSections.pop();
      for (const section of openSections) section.lines.push(line);
      const section = {
        heading: normalize(heading[2]),
        level,
        lines: [],
        directLines: [],
      };
      sections.push(section);
      openSections.push(section);
    } else if (openSections.length === 0) {
      preamble.lines.push(line);
      preamble.directLines.push(line);
    } else {
      openSections.at(-1).directLines.push(line);
      for (const section of openSections) section.lines.push(line);
    }
  }
  return preamble.lines.length > 0 ? [preamble, ...sections] : sections;
}

function extractTableRows(section) {
  const rows = [];
  for (let index = 0; index < section.directLines.length - 1; index += 1) {
    if (!section.directLines[index].includes('|')) continue;
    const headers = splitMarkdownRow(section.directLines[index]).map(normalizeHeader);
    const separator = splitMarkdownRow(section.directLines[index + 1]);
    if (
      headers.length === 0
      || separator.length !== headers.length
      || !separator.every((cell) => /^:?-{3,}:?$/.test(cell))
    ) {
      continue;
    }

    for (
      let rowIndex = index + 2;
      rowIndex < section.directLines.length && section.directLines[rowIndex].includes('|');
      rowIndex += 1
    ) {
      const cells = splitMarkdownRow(section.directLines[rowIndex]).map(normalize);
      if (cells.length === headers.length) rows.push({ section: section.heading, headers, cells });
    }
  }
  return rows;
}

function extractReport(output) {
  const report = unwrapOuterFence(unwrapProviderOutput(output));
  const sections = extractSections(report);
  return {
    report,
    sections,
    rows: sections.flatMap(extractTableRows),
  };
}

function headerIndex(row, patterns) {
  return row.headers.findIndex((header) => patterns.some((pattern) => pattern.test(header)));
}

function valueForHeader(row, patterns) {
  const index = headerIndex(row, patterns);
  return index < 0 ? undefined : row.cells[index];
}

function gradingResult(checks, successReason) {
  const failed = checks.filter(([, pass]) => !pass).map(([name]) => name);
  return {
    pass: failed.length === 0,
    score: (checks.length - failed.length) / checks.length,
    reason: failed.length === 0 ? successReason : `failed: ${failed.join(', ')}`,
  };
}

function assertE06(report) {
  const recurrenceRows = report.rows.filter(({ section }) =>
    /^(?:不変条件の再発記録|invariant recurrence record)$/i.test(section));
  const checks = E06_INVARIANT_NAMES.map((invariantName) => [
    `one-row-for-${invariantName}`,
    recurrenceRows.filter((row) =>
      valueForHeader(row, INVARIANT_NAME_HEADERS) === invariantName).length === 1,
  ]);
  return gradingResult(
    checks,
    'every planned invariant appears exactly once in the invariant recurrence record',
  );
}

function isCarriedBw2Row(row) {
  return valueForHeader(row, [/^family id$/i]) === E12_CARRIED_ROW.familyId
    && valueForHeader(row, INVARIANT_NAME_HEADERS)
      === E12_CARRIED_ROW.invariantName
    && valueForHeader(row, [/^担当箇所$/, /^responsible source$/i])
      === E12_CARRIED_ROW.responsibleSource
    && valueForHeader(row, [/^累積 incomplete 回数$/, /^cumulative incomplete count$/i])
      === E12_CARRIED_ROW.cumulativeIncompleteCount
    && valueForHeader(row, [
      /^別経路での再発が確認済みか$/,
      /^recurrence on a different path confirmed\??$/i,
    ]) === E12_CARRIED_ROW.recurrenceConfirmed;
}

function isExecutionOrderSection(heading) {
  return /^(?:実施順序|execution order)$/i.test(heading);
}

function isFindingCoverageSection(heading) {
  return /^(?:指摘カバレッジ|finding coverage)$/i.test(heading);
}

function isCarryForwardRowsSection(heading) {
  return /^(?:引き継ぎ元からの行|rows from the carry-forward source)$/i.test(heading);
}

function isNewPlanningRowsSection(heading) {
  return /^(?:新規・現在の計画行|new and current planning rows)$/i.test(heading);
}

function isCodeChangeTargetSection(heading) {
  return /^(?:コード変更対象|変更対象|code changes?|code change targets?|implementation targets?)$/i
    .test(heading);
}

function assertE12(report) {
  const bw2Rows = report.rows.filter((row) =>
    valueForHeader(row, INVARIANT_NAME_HEADERS) === E12_CARRIED_ROW.invariantName);
  const carriedBw2Rows = bw2Rows.filter((row) =>
    isCarryForwardRowsSection(row.section) && isCarriedBw2Row(row));
  const actionableRows = report.rows.filter((row) =>
    row.cells.some((cell) => cell.includes(E12_ACTIONABLE_FINDING)));
  const actionablePlanningRows = actionableRows.filter((row) =>
    isFindingCoverageSection(row.section) || isNewPlanningRowsSection(row.section));
  const executionOrderSections = report.sections.filter(({ heading }) =>
    isExecutionOrderSection(heading));
  const workSections = report.sections.filter(({ heading }) =>
    isFindingCoverageSection(heading)
      || isExecutionOrderSection(heading)
      || isCodeChangeTargetSection(heading));
  const checks = [
    ['one-unchanged-bw2-row-in-carry-forward-section',
      bw2Rows.length === 1 && carriedBw2Rows.length === 1],
    ['actionable-finding-only-in-planning-sections',
      actionableRows.length > 0 && actionablePlanningRows.length === actionableRows.length],
    ['actionable-finding-is-not-in-bw2-row',
      actionableRows.every((row) => !row.cells.includes(E12_CARRIED_ROW.invariantName))
        && carriedBw2Rows.every((row) =>
          row.cells.every((cell) => !cell.includes(E12_ACTIONABLE_FINDING)))],
    ['execution-order-section-present', executionOrderSections.length > 0],
    ['non-actionable-invariant-absent-from-work-sections', workSections.every(({ lines }) =>
      !lines.join('\n').includes(E12_NON_ACTIONABLE_INVARIANT))],
  ];
  return gradingResult(
    checks,
    'the BW-2 row is carried unchanged and non-actionable work stays outside work sections',
  );
}

export default function assertFixLoopConvergence(output, context) {
  const report = extractReport(output);
  if (context?.vars?.scenario === 'E06') return assertE06(report);
  if (context?.vars?.scenario === 'E12') return assertE12(report);
  return {
    pass: false,
    score: 0,
    reason: `unsupported scenario: ${context?.vars?.scenario ?? 'missing'}`,
  };
}

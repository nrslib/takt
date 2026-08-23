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
const E13_COLUMN_HEADERS = [
  [/^修正単位$/, /^fix unit$/i],
  [/^family id$/i],
  INVARIANT_NAME_HEADERS,
  [/^担当箇所$/, /^responsible source$/i],
  [/^今回の検証回数$/, /^current verification number$/i],
  [/^前回の検証回数$/, /^previous verification number$/i],
  [/^前回経路$/, /^previous path$/i],
  [/^今回経路$/, /^current path$/i],
  [/^同一不変条件・再発判定$/, /^same invariant recurrence judgement$/i],
  [/^累積 incomplete 回数$/, /^cumulative incomplete count$/i],
  [/^別経路での再発が確認済みか$/, /^recurrence on a different path confirmed\??$/i],
  [/^強制点候補$/, /^enforcement point candidate$/i],
  [/^記録の完全性$/, /^record integrity$/i],
];
const WORK_ITEM_KEY_HEADERS = [
  /^finding id(?: \/ (?:出典|source))?$/i,
  /^family id$/i,
  ...INVARIANT_NAME_HEADERS,
  /^修正単位(?: \/ 後続確認)?$/,
  /^change unit(?: \/ follow-up)?$/i,
  /^変更対象$/,
  /^code change targets?$/i,
  /^implementation targets?$/i,
];

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

function extractRowsWithinSection(section) {
  return extractTableRows({ heading: section.heading, directLines: section.lines });
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
  const recurrenceRows = report.sections
    .filter(({ heading }) =>
      /^(?:不変条件の再発記録|invariant recurrence record)$/i.test(heading))
    .flatMap(extractRowsWithinSection);
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

function rowUsesIdentifierAsKey(row, identifier) {
  const matchesIdentifier = (cell) => cell === identifier
    || cell.startsWith(`${identifier} /`);
  return matchesIdentifier(row.cells[0])
    || row.headers.some((header, index) =>
      WORK_ITEM_KEY_HEADERS.some((pattern) => pattern.test(header))
        && matchesIdentifier(row.cells[index]));
}

function lineUsesIdentifierAsWorkItem(line, identifier) {
  const normalizedLine = normalize(line);
  if (normalizedLine === identifier) return true;
  const item = /^ {0,3}(?:[-+*]|\d+[.)])[ \t]+(.+)$/.exec(line);
  if (item === null) return false;
  const normalizedItem = normalize(item[1]);
  return normalizedItem === identifier
    || normalizedItem.startsWith(`${identifier} `)
    || normalizedItem.startsWith(`${identifier}:`)
    || normalizedItem.startsWith(`${identifier}：`);
}

function sectionUsesIdentifierAsWorkItem(section, identifier) {
  const rows = extractRowsWithinSection(section);
  return rows.some((row) => rowUsesIdentifierAsKey(row, identifier))
    || section.lines.some((line) => lineUsesIdentifierAsWorkItem(line, identifier));
}

function assertE12(report) {
  const bw2Rows = report.rows.filter((row) =>
    valueForHeader(row, INVARIANT_NAME_HEADERS) === E12_CARRIED_ROW.invariantName);
  const carriedBw2Rows = bw2Rows.filter((row) =>
    isCarryForwardRowsSection(row.section) && isCarriedBw2Row(row));
  const actionableKeyRows = report.rows.filter((row) =>
    rowUsesIdentifierAsKey(row, E12_ACTIONABLE_FINDING));
  const actionablePlanningRows = actionableKeyRows.filter((row) =>
    isFindingCoverageSection(row.section) || isNewPlanningRowsSection(row.section));
  const executionOrderSections = report.sections.filter(({ heading }) =>
    isExecutionOrderSection(heading));
  const actionableExecutionItems = executionOrderSections.some((section) =>
    section.lines.some((line) =>
      lineUsesIdentifierAsWorkItem(line, E12_ACTIONABLE_FINDING)));
  const workSections = report.sections.filter(({ heading }) =>
    isFindingCoverageSection(heading)
      || isExecutionOrderSection(heading)
      || isCodeChangeTargetSection(heading));
  const checks = [
    ['one-unchanged-bw2-row-in-carry-forward-section',
      bw2Rows.length === 1 && carriedBw2Rows.length === 1],
    ['actionable-finding-only-in-planning-sections',
      actionableKeyRows.length > 0
        && actionablePlanningRows.length === actionableKeyRows.length
        && !actionableExecutionItems],
    ['actionable-finding-is-not-in-bw2-row',
      actionableKeyRows.every((row) =>
        valueForHeader(row, INVARIANT_NAME_HEADERS) !== E12_CARRIED_ROW.invariantName)
        && carriedBw2Rows.every((row) =>
          !rowUsesIdentifierAsKey(row, E12_ACTIONABLE_FINDING))],
    ['execution-order-section-present', executionOrderSections.length > 0],
    ['non-actionable-invariant-absent-from-work-sections',
      workSections.every((section) =>
        !sectionUsesIdentifierAsWorkItem(section, E12_NON_ACTIONABLE_INVARIANT))],
  ];
  return gradingResult(
    checks,
    'the BW-2 row is carried unchanged and non-actionable work stays outside work sections',
  );
}

function assertE13(report, scenario) {
  const recurrenceRows = report.sections
    .filter(({ heading }) =>
      /^(?:不変条件の再発記録|invariant recurrence record)$/i.test(heading))
    .flatMap(extractRowsWithinSection)
    .filter((row) => valueForHeader(row, INVARIANT_NAME_HEADERS) === 'BW-2');
  const expectedResult = scenario === 'E13a' ? 'verified' : 'incomplete';
  const expectedSemanticResult = scenario === 'E13a' ? '維持' : '不一致';
  const checks = [
    ['one-bw2-recurrence-row', recurrenceRows.length === 1],
    ['result-reflects-semantic-contract', new RegExp(
      `(?:^|\\n)##\\s+(?:結果|Result):\\s*${expectedResult}(?:\\s|$)`,
      'i',
    ).test(report.report)],
    ['judgement-reflects-semantic-contract', new RegExp(
      `JUDGEMENT: result=${expectedResult}; semantic_carry_forward=${expectedSemanticResult}\\s*$`,
    ).test(report.report)],
  ];
  if (recurrenceRows.length === 1) {
    const [row] = recurrenceRows;
    const expectedPreviousPath = scenario === 'E13a'
      ? /^なし（引(?:き|え)継ぎ行なし）$/
      : /^P2: 親 window 置換$/;
    checks.push(
      ['all-thirteen-columns-present', row.headers.length === 13
        && E13_COLUMN_HEADERS.every((patterns) => headerIndex(row, patterns) >= 0)],
      ['fix-unit-preserved', valueForHeader(row, E13_COLUMN_HEADERS[0]) === 'FP-PICKER-STATE'],
      ['family-id-preserved', valueForHeader(row, [/^family id$/i]) === 'FAM-RETRY-PICKER'],
      ['invariant-name-preserved', valueForHeader(row, INVARIANT_NAME_HEADERS) === 'BW-2'],
      ['responsible-source-present', (valueForHeader(row, E13_COLUMN_HEADERS[3]) ?? '') !== ''],
      ['verification-number-preserved', valueForHeader(row, [
        /^今回の検証回数$/,
        /^current verification number$/i,
      ]) === '2'],
      ['previous-verification-number-preserved', valueForHeader(row, E13_COLUMN_HEADERS[5]) === '1'],
      ['previous-path-preserved', expectedPreviousPath.test(
        valueForHeader(row, E13_COLUMN_HEADERS[6]) ?? '',
      )],
      ['path-set-preserved', valueForHeader(row, [
        /^今回経路$/,
        /^current path$/i,
      ]) === 'P3: prune 復帰漏れ'],
      ['recurrence-enum-preserved', valueForHeader(row, E13_COLUMN_HEADERS[8]) === '同一・再発'],
      ['cumulative-count-preserved', valueForHeader(row, [
        /^累積 incomplete 回数$/,
        /^cumulative incomplete count$/i,
      ]) === '2'],
      ['confirmed-enum-preserved', valueForHeader(row, [
        /^別経路での再発が確認済みか$/,
        /^recurrence on a different path confirmed\??$/i,
      ]) === '確認済み'],
      ['enforcement-point-present', (valueForHeader(row, E13_COLUMN_HEADERS[11]) ?? '') !== ''],
      ['record-integrity-preserved', scenario === 'E13a'
        ? valueForHeader(row, E13_COLUMN_HEADERS[12]) === '完全'
        : /成果物不足/.test(valueForHeader(row, E13_COLUMN_HEADERS[12]) ?? '')],
    );
  }
  if (scenario === 'E13b') {
    checks.push(
      ['path-change-recognized', /P3[\s\S]*P4|P4[\s\S]*P3/.test(report.report)],
      ['artifact-deficiency-recognized', /成果物不足/.test(report.report)],
    );
  }
  return gradingResult(checks, 'semantic descriptions are tolerant while mechanical state is preserved');
}

export default function assertFixLoopConvergence(output, context) {
  const report = extractReport(output);
  if (context?.vars?.scenario === 'E06') return assertE06(report);
  if (context?.vars?.scenario === 'E12') return assertE12(report);
  if (context?.vars?.scenario === 'E13a' || context?.vars?.scenario === 'E13b') {
    return assertE13(report, context.vars.scenario);
  }
  return {
    pass: false,
    score: 0,
    reason: `unsupported scenario: ${context?.vars?.scenario ?? 'missing'}`,
  };
}

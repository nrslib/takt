const E06_INVARIANT_NAMES = ['INV-RESUME-DEFAULT', 'INV-BUDGET-50'];
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
  [/^同一不変条件・再発判定$/, /^same-invariant \/ recurrence judgment$/i],
  [/^累積 incomplete 回数$/, /^cumulative incomplete count$/i],
  [/^別経路での再発が確認済みか$/, /^recurrence on a different path confirmed\??$/i],
  [/^強制点候補$/, /^enforcement point candidate$/i],
  [/^記録の完全性$/, /^record integrity$/i],
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

function assertE13(report) {
  const recurrenceRows = report.sections
    .filter(({ heading }) =>
      /^(?:不変条件の再発記録|invariant recurrence record)$/i.test(heading))
    .flatMap(extractRowsWithinSection)
    .filter((row) => valueForHeader(row, INVARIANT_NAME_HEADERS) === 'BW-2');
  const recurrenceRow = recurrenceRows.length === 1 ? recurrenceRows[0] : undefined;
  const recordIntegrityValue = recurrenceRow === undefined
    ? ''
    : valueForHeader(recurrenceRow, E13_COLUMN_HEADERS[12]) ?? '';
  const recordIntegrityIsExpected = recordIntegrityValue === '完全';
  const checks = [
    ['one-bw2-recurrence-row', recurrenceRows.length === 1],
    ['result-reflects-semantic-contract', new RegExp(
      '(?:^|\\n)##\\s+(?:結果|Result):\\s*verified(?:\\s|$)',
      'i',
    ).test(report.report)],
    ['judgement-reflects-semantic-contract', new RegExp(
      'JUDGEMENT: result=verified; semantic_carry_forward=維持\\s*$',
    ).test(report.report)],
  ];
  if (recurrenceRows.length === 1) {
    const [row] = recurrenceRows;
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
      ['previous-path-preserved', /^なし（引(?:き|え)継ぎ行なし）$/.test(
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
      ['record-integrity-column-preserved', recordIntegrityIsExpected],
    );
  }
  return gradingResult(checks, 'semantic descriptions are tolerant while mechanical state is preserved');
}

export default function assertFixLoopConvergence(output, context) {
  const report = extractReport(output);
  if (context?.vars?.scenario === 'E06') return assertE06(report);
  if (context?.vars?.scenario === 'E13a') {
    return assertE13(report);
  }
  return {
    pass: false,
    score: 0,
    reason: `unsupported scenario: ${context?.vars?.scenario ?? 'missing'}`,
  };
}

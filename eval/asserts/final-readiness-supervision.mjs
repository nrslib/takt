const OLD_NON_ACTIONABLE_FINDING = 'OLD-REVIEW-readme-L1';
const ALLOWED_AUTHORIZATION_BASIS_PATTERNS = [
  /direct.{0,24}acceptance.{0,24}(?:violation|failure|gap)/i,
  /acceptance.{0,24}(?:criterion|requirement).{0,24}(?:violation|failure|gap)/i,
  /(?:diff|remediation|patch|current change).{0,32}(?:introduced|caused)?.{0,12}regression/i,
  /regression.{0,32}(?:introduced|caused).{0,12}(?:diff|remediation|patch|current change)/i,
  /required.{0,24}consumer.{0,24}migration/i,
  /consumer.{0,24}migration.{0,24}required/i,
  /accepted.{0,24}family.{0,24}(?:closure|unvisited consumer)/i,
  /(?:closure|unvisited consumer).{0,24}accepted.{0,24}family/i,
  /受入.{0,24}(?:条件|要件).{0,12}(?:直接違反|未充足)/i,
  /(?:差分|修正).{0,24}(?:起因|導入).{0,12}回帰/i,
  /必須.{0,24}consumer.{0,24}migration/i,
  /採用済み.{0,24}family.{0,24}(?:閉鎖|未確認.{0,12}consumer)/i,
  /(?:閉鎖|未確認.{0,12}consumer).{0,24}採用済み.{0,24}family/i,
];
const INITIAL_ROUND_REASON_PATTERNS = [
  /(?:initial|earlier|previous|review evidence).{0,80}(?:covered only|limited|did not|not inspect|omitted|missed|unvisited|absent|not included|scope)/i,
  /(?:covered only|limited|did not|not inspect|omitted|missed|unvisited|absent|not included|scope).{0,80}(?:initial|earlier|previous|review evidence)/i,
  /(?:初回|前段).{0,80}(?:未走査|未確認|含まれなかった|見落|対象外|限定)/i,
  /(?:未走査|未確認|含まれなかった|見落|対象外|限定).{0,80}(?:初回|前段)/i,
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

function normalizeHeading(value) {
  return value.replace(/[`*_]/g, '').trim().toLowerCase();
}

function classifyLifecycleSection(heading) {
  const normalized = normalizeHeading(heading);
  if (/current iteration findings|今回の指摘/.test(normalized)) return 'new';
  if (/carry-?over findings|継続指摘/.test(normalized)) return 'persists';
  if (/reopened findings|再開指摘/.test(normalized)) return 'reopened';
  if (/actionable families|outstanding items|修正対象\s*family|未完了項目/.test(normalized)) {
    return 'actionable';
  }
  if (/resolved findings|解消済み/.test(normalized)) return 'resolved';
  if (/prior finding dispositions|re-evaluation of prior findings|finding dispositions|前段.*(?:扱い|再評価)|finding.*裁定/.test(normalized)) {
    return 'disposition';
  }
  return 'other';
}

function extractSections(output) {
  const lines = output.split('\n');
  const sections = [];
  let current = { heading: '', kind: 'other', lines: [] };
  for (const line of lines) {
    const match = /^##\s+(.+?)\s*$/.exec(line.trim());
    if (match !== null) {
      if (current.heading !== '' || current.lines.length > 0) sections.push(current);
      current = {
        heading: match[1],
        kind: classifyLifecycleSection(match[1]),
        lines: [],
      };
      continue;
    }
    current.lines.push(line);
  }
  if (current.heading !== '' || current.lines.length > 0) sections.push(current);
  return sections;
}

function extractTableRows(section) {
  const rows = [];
  for (let index = 0; index < section.lines.length - 2; index += 1) {
    if (!section.lines[index].includes('|')) continue;
    const headers = splitMarkdownRow(section.lines[index]).map(normalizeHeading);
    const separator = splitMarkdownRow(section.lines[index + 1]);
    if (
      headers.length === 0
      || separator.length !== headers.length
      || !separator.every((cell) => /^:?-{3,}:?$/.test(cell))
    ) {
      continue;
    }
    for (
      let rowIndex = index + 2;
      rowIndex < section.lines.length && section.lines[rowIndex].includes('|');
      rowIndex += 1
    ) {
      const cells = splitMarkdownRow(section.lines[rowIndex]);
      if (cells.length !== headers.length) continue;
      rows.push({
        sectionKind: section.kind,
        headers,
        cells,
        content: cells.join(' '),
      });
    }
  }
  return rows;
}

export function extractFindingLifecycle(output) {
  const reviewOutput = unwrapProviderOutput(output);
  const sections = extractSections(reviewOutput);
  const rows = sections.flatMap(extractTableRows);
  return {
    reviewOutput,
    rows,
    actionableSections: sections.filter(({ kind }) => (
      kind === 'new'
      || kind === 'persists'
      || kind === 'reopened'
      || kind === 'actionable'
    )),
  };
}

function valueForHeader(row, pattern) {
  const index = row.headers.findIndex((header) => pattern.test(header));
  return index < 0 ? undefined : row.cells[index];
}

function extractNewFindingRows(lifecycle) {
  return lifecycle.rows
    .filter(({ sectionKind }) => sectionKind === 'new')
    .flatMap((row) => {
      const findingId = valueForHeader(row, /finding[_ -]?id/);
      const basis = valueForHeader(row, /authorization\s+basis|権限根拠/);
      const absentReason = valueForHeader(row, /reason.*initial|initial.*reason|初回.*理由/);
      if (
        findingId === undefined
        || basis === undefined
        || absentReason === undefined
        || !/\b(?:MERGE|VAL)-NEW-[A-Za-z0-9_-]+/i.test(findingId)
      ) {
        return [];
      }
      return [{ ...row, findingId, basis, absentReason }];
    });
}

function hasAllowedAuthorizationBasis(value) {
  return ALLOWED_AUTHORIZATION_BASIS_PATTERNS.some((pattern) => pattern.test(value))
    && !/^(?:none|n\/a|not applicable|なし|該当なし|-)$/i.test(value.trim());
}

function hasMeaningfulInitialRoundReason(value) {
  return INITIAL_ROUND_REASON_PATTERNS.some((pattern) => pattern.test(value))
    && !/^(?:none|n\/a|not applicable|なし|該当なし|-)$/i.test(value.trim());
}

function keepsOldFindingNonActionable(lifecycle) {
  const escapedId = OLD_NON_ACTIONABLE_FINDING.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const nonActionable = '(?:adjudicated[ _-]?non[ _-]?actionable|non[ _-]?actionable|out[ _-]?of[ _-]?scope|false[ _-]?positive|overreach|非修正対象|対象外)';
  return new RegExp(`${escapedId}[^\\n]{0,240}${nonActionable}|${nonActionable}[^\\n]{0,240}${escapedId}`, 'i')
    .test(lifecycle.reviewOutput);
}

function revivesOldFinding(lifecycle) {
  return lifecycle.actionableSections.some(({ lines }) => lines.some((line) => (
    line.includes(OLD_NON_ACTIONABLE_FINDING)
  )));
}

export default function assertFinalReadinessSupervision(output) {
  const lifecycle = extractFindingLifecycle(output);
  const findings = extractNewFindingRows(lifecycle);
  const configurationGap = findings.find((finding) =>
    /(config|configuration|設定)/i.test(finding.content)
      && /(normalize|normalization|正規化)/i.test(finding.content));
  const checks = [
    ['reject-verdict', /(?:Result|結果)\s*:\s*REJECT/i.test(lifecycle.reviewOutput)],
    ['configuration-consumer-finding', configurationGap !== undefined],
    ['authorization-basis', configurationGap !== undefined
      && hasAllowedAuthorizationBasis(configurationGap.basis)],
    ['initial-round-reason', configurationGap !== undefined
      && hasMeaningfulInitialRoundReason(configurationGap.absentReason)],
    ['old-finding-disposition', keepsOldFindingNonActionable(lifecycle)],
    ['old-finding-not-revived', !revivesOldFinding(lifecycle)],
  ];
  const failed = checks.filter(([, pass]) => !pass).map(([name]) => name);

  return {
    pass: failed.length === 0,
    score: (checks.length - failed.length) / checks.length,
    reason: failed.length === 0
      ? 'the final-gate report preserves authorized findings and non-actionable dispositions'
      : `failed: ${failed.join(', ')}`,
  };
}

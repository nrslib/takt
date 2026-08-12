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

function normalizeHeader(cell) {
  return cell.replace(/[`*_]/g, '').trim().toLowerCase();
}

function extractNewFindingRows(output) {
  const lines = output.split('\n');
  const findings = [];
  for (let index = 0; index < lines.length - 2; index += 1) {
    if (!lines[index].includes('|')) continue;
    const headers = splitMarkdownRow(lines[index]).map(normalizeHeader);
    const findingIndex = headers.findIndex((header) => /finding[_ -]?id/.test(header));
    const basisIndex = headers.findIndex((header) => /authorization\s+basis|権限根拠/.test(header));
    const absentIndex = headers.findIndex((header) => /reason.*initial|initial.*reason|初回.*理由/.test(header));
    if (findingIndex < 0 || basisIndex < 0 || absentIndex < 0) continue;
    const separator = splitMarkdownRow(lines[index + 1]);
    if (separator.length !== headers.length || !separator.every((cell) => /^:?-{3,}:?$/.test(cell))) continue;

    for (let rowIndex = index + 2; rowIndex < lines.length && lines[rowIndex].includes('|'); rowIndex += 1) {
      const cells = splitMarkdownRow(lines[rowIndex]);
      if (cells.length !== headers.length) continue;
      if (!/\b(?:MERGE|VAL)-NEW-[A-Za-z0-9_-]+/i.test(cells[findingIndex])) continue;
      findings.push({
        content: cells.join(' '),
        basis: cells[basisIndex],
        absentReason: cells[absentIndex],
      });
    }
  }
  return findings;
}

function hasMeaningfulBasis(value) {
  return /(acceptance|requirement|criterion|consumer|family|regression|受入|要件|consumer|利用側|系列|回帰)/i.test(value)
    && !/^(?:none|n\/a|not applicable|なし|該当なし|-)$/i.test(value.trim());
}

function hasMeaningfulInitialRoundReason(value) {
  return /(initial|earlier|previous|unvisited|omitted|missed|not included|review evidence|初回|前段|未走査|未確認|含まれなかった|見落)/i.test(value)
    && !/^(?:none|n\/a|not applicable|なし|該当なし|-)$/i.test(value.trim());
}

export default function assertFinalReadinessSupervision(output) {
  const reviewOutput = unwrapProviderOutput(output);
  const findings = extractNewFindingRows(reviewOutput);
  const configurationGap = findings.find((finding) =>
    /(config|configuration|設定)/i.test(finding.content)
      && /(normalize|normalization|正規化)/i.test(finding.content));
  const checks = [
    ['reject-verdict', /(?:Result|結果)\s*:\s*REJECT/i.test(reviewOutput)],
    ['configuration-consumer-finding', configurationGap !== undefined],
    ['authorization-basis', configurationGap !== undefined && hasMeaningfulBasis(configurationGap.basis)],
    ['initial-round-reason', configurationGap !== undefined
      && hasMeaningfulInitialRoundReason(configurationGap.absentReason)],
    ['old-finding-not-reopened', !findings.some((finding) => finding.content.includes('OLD-REVIEW-readme-L1'))],
  ];
  const failed = checks.filter(([, pass]) => !pass).map(([name]) => name);

  return {
    pass: failed.length === 0,
    score: (checks.length - failed.length) / checks.length,
    reason: failed.length === 0
      ? 'the public final-gate producer records both remediation authority and initial-round omission evidence'
      : `failed: ${failed.join(', ')}`,
  };
}

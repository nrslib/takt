function hasRejectVerdict(output) {
  return /(?:結果|判定|Result|Verdict)\s*:\s*REJECT/i.test(output)
    || /^#+\s*REJECT\s*$/im.test(output);
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

function extractTableFamilyRecords(output) {
  const lines = output.split('\n');
  const records = [];
  for (let index = 0; index < lines.length - 2; index += 1) {
    if (!lines[index].includes('|')) continue;
    const headers = splitMarkdownRow(lines[index]).map(normalizeHeader);
    const familyIndex = headers.findIndex((header) => /^family[ _-]?tag$/.test(header));
    const locationIndex = headers.findIndex((header) => /^(?:場所|location|paths?|files?)$/.test(header));
    const problemIndex = headers.findIndex((header) => /^(?:問題|problem|issue|defect)$/.test(header));
    const repairIndex = headers.findIndex((header) => /^(?:修正案|修正方針|fix|remediation|proposed fix|recommendation)$/.test(header));
    if (familyIndex < 0 || locationIndex < 0 || problemIndex < 0 || repairIndex < 0) continue;
    const separator = splitMarkdownRow(lines[index + 1]);
    if (separator.length !== headers.length || !separator.every((cell) => /^:?-{3,}:?$/.test(cell))) continue;

    for (let rowIndex = index + 2; rowIndex < lines.length && lines[rowIndex].includes('|'); rowIndex += 1) {
      const cells = splitMarkdownRow(lines[rowIndex]);
      if (cells.length !== headers.length) continue;
      const familyTag = cells[familyIndex].replace(/`/g, '').trim();
      if (!familyTag) continue;
      records.push({
        familyTag,
        content: headers.map((header, cellIndex) => `${header}: ${cells[cellIndex]}`).join('\n'),
        locationEvidence: cells[locationIndex],
        problemEvidence: cells[problemIndex],
        repairEvidence: cells[repairIndex],
      });
    }
  }
  return records;
}

function extractLabeledFamilyRecords(output) {
  const matches = [...output.matchAll(/family[_ -]?tag`?\s*[=:|]\s*`?([a-z0-9_-]+)/gi)];
  return matches.map((match, index) => ({
    familyTag: match[1],
    content: output.slice(match.index, matches[index + 1]?.index ?? output.length),
  }));
}

function extractFamilyRecords(output) {
  return [...extractTableFamilyRecords(output), ...extractLabeledFamilyRecords(output)];
}

function extractLocationEvidence(record) {
  const locations = [];
  let tableLocationIndex = -1;
  for (const line of record.split('\n')) {
    const labeled = line.match(/^\s*[-*]?\s*(?:場所|Location|Paths?|Files?)\s*[:：]\s*(.+)$/i);
    if (labeled) locations.push(labeled[1]);

    if (!line.includes('|')) continue;
    const cells = line.split('|').map((cell) => cell.trim());
    const headerIndex = cells.findIndex((cell) => /^(?:場所|Location|Paths?|Files?)$/i.test(cell));
    if (headerIndex >= 0) {
      tableLocationIndex = headerIndex;
      continue;
    }
    if (tableLocationIndex >= 0 && !cells.every((cell) => /^:?-+:?$/.test(cell) || cell === '')) {
      locations.push(cells[tableLocationIndex] ?? '');
    }
  }
  return locations.join('\n');
}

function getRecordLocationEvidence(record) {
  return record.locationEvidence ?? extractLocationEvidence(record.content);
}

function recordIncludesAllLocations(record, paths) {
  const locationEvidence = getRecordLocationEvidence(record);
  return paths.every((path) => locationEvidence.includes(path));
}

export default function assertInitialReviewContractDiscovery(output) {
  const projectionPaths = [
    'src/preview.js',
    'src/doctor.js',
    'tests/public-projections.test.js',
  ];
  const identityPaths = [
    'src/name-schema.js',
    'src/path-key.js',
    'src/job-store.js',
    'src/checkpoint.js',
    'src/event-bus.js',
  ];
  const records = extractFamilyRecords(output);
  const projectionRecord = records.find((record) => recordIncludesAllLocations(record, projectionPaths));
  const identityRecord = records.find((record) => recordIncludesAllLocations(record, identityPaths));
  const hasProblemAndRepair = (record) => {
    if (record === undefined) return false;
    if (record.problemEvidence !== undefined || record.repairEvidence !== undefined) {
      return Boolean(record.problemEvidence?.trim() && record.repairEvidence?.trim());
    }
    return /(問題|違反|誤認|欠陥|incorrect|broken|bug|violation|collision|衝突)/i.test(record.content)
      && /(修正|変更|統一|分離|追加|維持|fix|change|unify|separate|encode|preserve|test)/i.test(record.content);
  };
  const checks = [
    ['reject-verdict', hasRejectVerdict(output)],
    ['projection-family-complete', projectionRecord !== undefined],
    ['projection-contract-grounded', projectionRecord !== undefined
      && /(control|制御).*(worker|実行者|task|タスク)|(worker|実行者|task|タスク).*(control|制御)/is.test(projectionRecord.content)],
    ['projection-finding-actionable', hasProblemAndRepair(projectionRecord)],
    ['identity-family-complete', identityRecord !== undefined],
    ['identity-collision-demonstrated', identityRecord !== undefined
      && /(collision|衝突|injective|単射|同一.*key|same.*key)/is.test(identityRecord.content)],
    ['identity-finding-actionable', hasProblemAndRepair(identityRecord)],
    ['families-separated', projectionRecord !== undefined
      && identityRecord !== undefined
      && projectionRecord.familyTag !== identityRecord.familyTag],
    ['clean-decoy-not-a-location', !records.some((record) => /audit(?:-key)?\.js/i.test(getRecordLocationEvidence(record)))],
  ];
  const failed = checks.filter(([, pass]) => !pass).map(([name]) => name);
  return {
    pass: failed.length === 0,
    score: (checks.length - failed.length) / checks.length,
    reason: failed.length === 0
      ? 'the initial review discovers and closes both changed-contract families'
      : `failed: ${failed.join(', ')}`,
  };
}

import { splitMarkdownTableCells } from './boundary-markdown-table.mjs';

const FILE_CITATION = /\b[\w./-]+\.[a-z0-9]+:\d+\b/gi;
const FINDING_CELL_NAMES = [
  'number',
  'familyTag',
  'severity',
  'location',
  'defect',
  'impact',
  'fix',
];
const FINDING_TEXT_CELL_NAMES = ['defect', 'impact', 'fix'];
const NEGATED_FIX_ACTION = /\b(?:do not|don't)\b/i;

function markdownTableCells(line) {
  const cells = splitMarkdownTableCells(line);
  if (cells === null) {
    return null;
  }

  return cells.map((cell) => cell
    .trim()
    .replace(/(?:\*\*|__|`)/g, '')
    .trim());
}

function testPattern(pattern, text) {
  const flags = pattern.flags.replace(/[gy]/g, '');
  return new RegExp(pattern.source, flags).test(text);
}

function matchesEntireCell(pattern, text) {
  const flags = pattern.flags.replace(/[gy]/g, '');
  return new RegExp(`^(?:${pattern.source})$`, flags).test(text);
}

function findingFromCells(cells) {
  if (cells === null || cells.length !== FINDING_CELL_NAMES.length) {
    return null;
  }

  return Object.fromEntries(
    FINDING_CELL_NAMES.map((name, index) => [name, cells[index] ?? '']),
  );
}

function findingRows(output) {
  return output
    .split(/\r?\n/)
    .map((line) => findingFromCells(markdownTableCells(line)))
    .filter((finding) => finding !== null && /^\d+$/.test(finding.number));
}

function hasOnlyLocationCitation(finding) {
  return FINDING_CELL_NAMES.every((name) => {
    const citations = finding[name].match(FILE_CITATION) ?? [];
    return name === 'location' ? citations.length === 1 : citations.length === 0;
  });
}

function matchesCellRequirements(finding, requirements) {
  return Object.entries(requirements).every(([cellName, patterns]) => {
    if (!FINDING_TEXT_CELL_NAMES.includes(cellName) || !Array.isArray(patterns)) {
      throw new Error(`Unknown finding requirement cell: ${cellName}`);
    }
    return patterns.every((pattern) => testPattern(pattern, finding[cellName]));
  });
}

function matchesExcludedCell(finding, exclusions) {
  return Object.entries(exclusions).some(([cellName, patterns]) => {
    if (!FINDING_TEXT_CELL_NAMES.includes(cellName) || !Array.isArray(patterns)) {
      throw new Error(`Unknown finding exclusion cell: ${cellName}`);
    }
    return patterns.some((pattern) => testPattern(pattern, finding[cellName]));
  });
}

export function hasFindingLine(output, {
  familyTag,
  citation,
  required,
  excluded = {},
}) {
  const findings = findingRows(output);
  if (!findings.every((finding) => finding.familyTag === familyTag)) {
    return false;
  }

  return findings.some((finding) => {
    return /^\d+$/.test(finding.number)
      && finding.familyTag === familyTag
      && /^(?:critical|high|medium|low)$/i.test(finding.severity)
      && FINDING_TEXT_CELL_NAMES.every((name) => finding[name] !== '')
      && hasOnlyLocationCitation(finding)
      && matchesEntireCell(citation, finding.location)
      && matchesCellRequirements(finding, required)
      && !NEGATED_FIX_ACTION.test(finding.fix)
      && !matchesExcludedCell(finding, excluded);
  });
}

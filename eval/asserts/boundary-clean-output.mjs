import { splitMarkdownTableCells } from './boundary-markdown-table.mjs';

function stripInlineMarkdown(text) {
  return text
    .replace(/(?:\*\*|__|`)/g, '')
    .replace(/(?<![\w/])[*_](?=\S)/g, '')
    .replace(/(?<=\S)[*_](?![\w/])/g, '');
}

function stripLightMarkdown(text) {
  return stripInlineMarkdown(text
    .trim()
    .replace(/^>\s*/, '')
    .replace(/^#{1,6}\s*/, '')
    .replace(/^[-+*]\s+/, '')
    .replace(/\s+#+$/, '')
    .trim());
}

function markdownTableCells(line) {
  const cells = splitMarkdownTableCells(line);
  if (cells === null) {
    return null;
  }

  return cells.map(stripLightMarkdown);
}

function isSelectedRejectValue(value) {
  if (/\b(?:APPROVE\s*\/\s*REJECT|REJECT\s*\/\s*APPROVE)\b/i.test(value)) {
    return false;
  }

  return /^REJECT(?:[.!。！？]*|\s*(?:\([^()\r\n]*\)|（[^（）\r\n]*）|\[[^[\]\r\n]*\]|[-–—]\s*\S.*))$/i.test(value);
}

function isSelectedRejectDecision(line) {
  const content = stripLightMarkdown(line);
  const result = content.match(/^(?:(?:Result|結果)\s*(?:[:：]|[-–—])\s*)?(REJECT.*)$/i);
  if (result !== null && isSelectedRejectValue(result[1])) {
    return true;
  }

  const cells = markdownTableCells(line);
  if (cells === null || !/^(?:Result|結果)$/i.test(cells[0] ?? '')) {
    return false;
  }

  return isSelectedRejectValue(cells[1] ?? '')
    || (
      /^REJECT[.!。！？]*$/i.test(cells[1] ?? '')
      && /^(?:\d+\s+(?:issues?|findings?)|\d+\s*件)$/i.test(cells[2] ?? '')
    );
}

function isCompactRejectedFinding(line) {
  const content = stripLightMarkdown(line);
  const rejected = content.match(/^REJECT\s*(?:\||[-–—:：])\s*(.+)$/i);
  if (!rejected) {
    return false;
  }

  const citations = [...rejected[1].matchAll(/\b[\w./-]+\.[a-z0-9]+:\d+\b/gi)];
  if (citations.length === 0) {
    return false;
  }

  const description = rejected[1]
    .replace(/\b[\w./-]+\.[a-z0-9]+:\d+\b/gi, ' ')
    .replace(/[|:：,，;；()[\]{}]/g, ' ')
    .replace(/[-–—]/g, ' ')
    .replace(/\b(?:and|at)\b/gi, ' ')
    .trim();
  return description !== '';
}

function markdownHeading(line) {
  const content = line
    .trim()
    .replace(/^>\s*/, '');
  const undecorated = stripInlineMarkdown(content);
  const match = undecorated.match(/^(#{1,6})\s+(.+?)\s*#*$/);
  return match
    ? {
      level: match[1].length,
      text: match[2].trim().replace(/[:：]\s*$/, ''),
    }
    : null;
}

function observedFindingLines(lines) {
  let inObservedFindings = false;
  return lines.filter((line) => {
    const heading = markdownHeading(line);
    if (heading === null || heading.level > 2) {
      return inObservedFindings;
    }
    if (heading.level < 2) {
      inObservedFindings = false;
      return false;
    }

    inObservedFindings = /^(?:Observed Findings|観測した指摘)$/i.test(heading.text);
    return false;
  });
}

function isObservedFindingDataRow(line) {
  const cells = markdownTableCells(line);
  if (cells === null) {
    return false;
  }

  if (cells.length < 2 || cells.every((cell) => cell === '')) {
    return false;
  }
  if (cells.every((cell) => /^:?-{3,}:?$/.test(cell))) {
    return false;
  }

  const firstCell = cells[0] ?? '';
  if (firstCell === ''
    || /^(?:#|No\.?|ID|finding(?:_id)?|番号|指摘)$/i.test(firstCell)
    || /^(?:[-—]|N\/A|none|なし|該当なし)$/i.test(firstCell)) {
    return false;
  }

  return cells.slice(1).some((cell) => (
    cell !== ''
    && !/^(?:[-—–]|\.{2,}|…|N\/A|none|なし|該当なし)$/i.test(cell)
    && !/^(?:\{[^{}]*\}|<[^<>]*>|\[[^\][]*])$/.test(cell)
    && !/^(?:family_tag|Severity|重大度|Location|場所|Defect|欠陥|Impact|影響|Fix Direction|修正方針)$/i.test(cell)
    && !/^(?:contract-wiring|resource-ownership|failure-boundary|boundary)$/i.test(cell)
    && !/^(?:high|medium|low)(?:\s*\/\s*(?:high|medium|low))*$/i.test(cell)
    && !/^`?file:line`?$/i.test(cell)
  ));
}

export function hasRejectedFinding(output) {
  const lines = output.split(/\r?\n/);

  return lines.some(isSelectedRejectDecision)
    || observedFindingLines(lines).some(isObservedFindingDataRow)
    || lines.some(isCompactRejectedFinding);
}

export function splitMarkdownTableCells(line) {
  const content = line.trim().replace(/^>\s*/, '');
  if (!content.startsWith('|')) {
    return null;
  }

  const cells = [];
  let cell = '';
  let consecutiveBackslashes = 0;

  for (const character of content) {
    if (character === '\\') {
      cell += character;
      consecutiveBackslashes += 1;
      continue;
    }

    if (character === '|' && consecutiveBackslashes % 2 === 0) {
      cells.push(cell);
      cell = '';
    } else if (character === '|') {
      cell = `${cell.slice(0, -1)}|`;
    } else {
      cell += character;
    }
    consecutiveBackslashes = 0;
  }
  cells.push(cell);

  return cells.slice(1, cells.at(-1) === '' ? -1 : undefined);
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className !== '') node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function appendInline(parent, source) {
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g;
  let cursor = 0;
  for (const match of source.matchAll(pattern)) {
    if (match.index > cursor) parent.append(document.createTextNode(source.slice(cursor, match.index)));
    const token = match[0];
    if (token.startsWith('`')) {
      parent.append(element('code', '', token.slice(1, -1)));
    } else if (token.startsWith('**')) {
      parent.append(element('strong', '', token.slice(2, -2)));
    } else {
      const separator = token.lastIndexOf('](');
      const href = token.slice(separator + 2, -1);
      const link = element('a', '', token.slice(1, separator));
      if (/^https?:\/\//u.test(href)) {
        link.href = href;
        link.target = '_blank';
        link.rel = 'noreferrer';
      }
      parent.append(link);
    }
    cursor = match.index + token.length;
  }
  if (cursor < source.length) parent.append(document.createTextNode(source.slice(cursor)));
}

function appendParagraph(container, lines) {
  if (lines.length === 0) return;
  const paragraph = element('p', '');
  lines.forEach((line, index) => {
    if (index > 0) paragraph.append(document.createTextNode(' '));
    appendInline(paragraph, line);
  });
  container.append(paragraph);
}

export function renderMarkdown(source) {
  const container = element('div', 'markdown-view');
  const lines = source.replaceAll('\r\n', '\n').split('\n');
  let paragraph = [];
  let list = null;
  let code = null;

  const flushParagraph = () => {
    appendParagraph(container, paragraph);
    paragraph = [];
  };
  const flushList = () => {
    if (list !== null) container.append(list);
    list = null;
  };
  const flushCode = () => {
    if (code === null) return;
    const pre = element('pre', '');
    pre.append(element('code', '', code.lines.join('\n')));
    container.append(pre);
    code = null;
  };

  for (const line of lines) {
    if (code !== null) {
      if (line.startsWith('```')) flushCode();
      else code.lines.push(line);
      continue;
    }
    if (line.startsWith('```')) {
      flushParagraph();
      flushList();
      code = { lines: [] };
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/u);
    if (heading !== null) {
      flushParagraph();
      flushList();
      const node = element(`h${heading[1].length}`, '');
      appendInline(node, heading[2]);
      container.append(node);
      continue;
    }
    const item = line.match(/^\s*(?:([-*+])|(\d+)\.)\s+(.+)$/u);
    if (item !== null) {
      flushParagraph();
      const tag = item[2] === undefined ? 'ul' : 'ol';
      if (list?.tagName.toLowerCase() !== tag) {
        flushList();
        list = element(tag, '');
      }
      const listItem = element('li', '');
      appendInline(listItem, item[3]);
      list.append(listItem);
      continue;
    }
    if (/^\s*$/u.test(line)) {
      flushParagraph();
      flushList();
      continue;
    }
    flushList();
    paragraph.push(line.trim());
  }
  flushParagraph();
  flushList();
  flushCode();
  return container;
}

export function markdownTitle(source) {
  const firstContentLine = source
    .replaceAll('\r\n', '\n')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '' && !line.startsWith('```'));
  if (firstContentLine === undefined) return '';
  return firstContentLine
    .replace(/^#{1,6}\s+/u, '')
    .replace(/^(?:タスク指示書|Task instructions)\s*[:：]\s*/iu, '')
    .trim();
}

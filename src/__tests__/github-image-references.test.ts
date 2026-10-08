import { describe, expect, it } from 'vitest';
import { annotateGithubImageReferences, extractGithubImageReferences } from '../features/tasks/githubImageReferences.js';

const x = 'https://github.com/user-attachments/assets/x';
const y = 'https://github.com/user-attachments/assets/y';

describe('extractGithubImageReferences', () => {
  it('extracts Markdown and HTML images in source order with their original spans', () => {
    const markdown = `![a](<${x}> "title")`;
    const html = `<img width="100" src='${y}' />`;
    const body = `説明\n${markdown}\n${html}\n終わり`;

    const references = extractGithubImageReferences(body);

    expect(references.map((reference) => reference.url)).toEqual([x, y]);
    expect(references.map((reference) => body.slice(reference.start, reference.end)))
      .toEqual([markdown, html]);
  });

  it.each([
    `![a](${x})`,
    `![a](${x} 'title')`,
    `[![a](${x})](https://example.com)`,
    `> ![a](${x})`,
    `- ![a](${x})`,
    `<img src="${x}" width="200">`,
    `<img alt='a' src='${x}'>`,
    `<img src=${x}>`,
  ])('extracts a supported image reference: %s', (body) => {
    expect(extractGithubImageReferences(body).map((reference) => reference.url)).toEqual([x]);
  });

  it('keeps balanced URL parentheses and decodes HTML entities only in the lookup URL', () => {
    const markdown = `![a](${x}(part) "title")`;
    const html = `<img src="${y}?a=1&amp;b=2">`;
    const body = `${markdown}\n${html}`;

    const references = extractGithubImageReferences(body);

    expect(references.map((reference) => reference.url)).toEqual([`${x}(part)`, `${y}?a=1&b=2`]);
    expect(references.map((reference) => body.slice(reference.start, reference.end)))
      .toEqual([markdown, html]);
  });

  it('rejects whitespace inside bare URL parentheses while preserving escaped spaces', () => {
    const invalid = `![a](${x}(part part))`;
    const escaped = `![a](${y}(part\\ part))`;
    const references = extractGithubImageReferences(`${invalid}\n${escaped}`);

    expect(references.map((reference) => reference.url)).toEqual([`${y}(part\\ part)`]);
  });

  it('ignores image code examples and comments while extracting visible images', () => {
    const hidden = `![hidden](${x})`;
    const body = [
      `\`${hidden}\``,
      `<!-- <img src="${x}"> -->`,
      '```markdown', hidden, '```',
      '~~~markdown', hidden, '~~~',
      `    ${hidden}`,
      `\\${hidden}`,
      `![visible](${y})`,
      '~~~markdown', hidden,
    ].join('\n\n');

    const references = extractGithubImageReferences(body);

    expect(references.map((reference) => reference.url)).toEqual([y]);
    expect(body.slice(references[0]!.start, references[0]!.end)).toBe(`![visible](${y})`);
  });

  it('ignores ordinary links and text placeholders', () => {
    expect(extractGithubImageReferences(`[a](${x})\n${x}\n[Image #1]`)).toEqual([]);
  });

  it('handles escaped URL punctuation, numeric entities, and case-insensitive img attributes', () => {
    const markdown = `![a](${x}\\(part\\))`;
    const html = `<IMG ALT='a' SRC="${y}?a=1&#38;b=2"/>`;
    const body = `${markdown}\n${html}`;
    const references = extractGithubImageReferences(body);

    expect(references.map((reference) => reference.url)).toEqual([`${x}(part)`, `${y}?a=1&b=2`]);
    expect(references.map((reference) => body.slice(reference.start, reference.end))).toEqual([markdown, html]);
  });

  it('does not interpret malformed destinations or attributes named data-src as images', () => {
    const body = `![a](<${x}\n>)\n<img data-src="${x}">\n![a](${x} "unclosed)\n\\<img src="${y}">`;
    expect(extractGithubImageReferences(body)).toEqual([]);
  });

  it.each([`![a](${x})`, `<img src='${x}'>`])('requires the final delimiter and preserves source text: %s', (syntax) => {
    const placeholders = new Map([[x, '[Image #1]']]);
    const references = extractGithubImageReferences(syntax);
    expect(references.map((reference) => reference.url)).toEqual([x]);
    expect(annotateGithubImageReferences(syntax, references, placeholders)).toBe(`${syntax} [Image #1]`);

    const malformed = syntax.slice(0, -1);
    const missingDelimiter = extractGithubImageReferences(malformed);
    expect(missingDelimiter).toEqual([]);
    expect(annotateGithubImageReferences(malformed, missingDelimiter, placeholders)).toBe(malformed);
  });

  it.each(['![', '<img '])('rejects repeated malformed candidates: %s', (prefix) => {
    const body = prefix.repeat(32_768);
    const references = extractGithubImageReferences(body);

    expect(references).toEqual([]);
  });

  it.each([
    '![a](', '![a](<', '![a](url "', '![a](url \'', '![a](url (',
    '<img alt="', '<img alt=\'', '<img data-src="url" ',
  ])('rejects repeated unterminated destinations, titles, and attributes: %s', (prefix) => {
    const body = prefix.repeat(8192);
    const references = extractGithubImageReferences(body);

    expect(references).toEqual([]);
  });

  it.each([
    { prefix: '![', syntax: `<img src='${x}'>` },
    { prefix: '<img ', syntax: `![a](${x})` },
    { prefix: '<img alt="', syntax: `![a](${x})` },
  ])('retains a normal image after malformed $prefix candidates', ({ prefix, syntax }) => {
    const malformed = prefix.repeat(8192);
    const body = `${malformed}\n${syntax}`;
    const references = extractGithubImageReferences(body);

    expect(references).toEqual([{ url: x, start: malformed.length + 1, end: body.length }]);
    expect(body.slice(references[0]!.start, references[0]!.end)).toBe(syntax);
    expect(annotateGithubImageReferences(body, references, new Map([[x, '[Image #1]']])))
      .toBe(`${body} [Image #1]`);
    expect(extractGithubImageReferences(body.slice(0, -1))).toEqual([]);
  });

  it('rejects overlapping candidates that cross excluded lines', () => {
    const body = `${'!['.repeat(32_768)}\n    code\n${']'.repeat(32_768)}(${x})`;

    expect(extractGithubImageReferences(body)).toEqual([]);
  });

  it.each(['~~~', '```'].flatMap((fence) => [1, 2, 3, 4].flatMap((spaces) => [
    { fence, spaces, syntax: `![a](${x})` },
    { fence, spaces, syntax: `<img src='${x}'>` },
  ])))('excludes blockquote $fence code with $spaces spaces and restores images after closing', ({ fence, spaces, syntax }) => {
    const marker = `>${' '.repeat(spaces)}${fence}`;
    const body = [`> ${syntax}`, `${marker}markdown`, `> ${syntax}`, marker, `> ${syntax}`].join('\n');
    const references = extractGithubImageReferences(body);

    expect(references.map((reference) => reference.url)).toEqual([x, x]);
    expect(references.map((reference) => body.slice(reference.start, reference.end))).toEqual([syntax, syntax]);
    expect(annotateGithubImageReferences(body, references, new Map([[x, '[Image #1]']])))
      .toBe([`> ${syntax} [Image #1]`, `${marker}markdown`, `> ${syntax}`, marker, `> ${syntax} [Image #1]`].join('\n'));
  });

  it.each(['>  ~~', '>  ```', '>  ~~~~ trailing', '> '])('keeps a blockquote fence open after an invalid closing line: %s', (closing) => {
    const body = [`>  ~~~~markdown`, `> ![a](${x})`, closing, `> <img src='${y}'>`].join('\n');
    const references = extractGithubImageReferences(body);

    expect(references).toEqual([]);
    expect(annotateGithubImageReferences(body, references, new Map([[x, '[Image #1]'], [y, '[Image #2]']]))).toBe(body);
  });

  it('preserves nested blockquote offsets and rejects excess fence indentation', () => {
    const syntax = `<img src='${x}'>`;
    const body = ['> >   ~~~html', `> > ${syntax}`, '> >   ~~~~', `> > ${syntax}`, '>     ~~~', `> ${syntax}`].join('\n');
    const references = extractGithubImageReferences(body);

    expect(references.map((reference) => body.slice(reference.start, reference.end))).toEqual([syntax, syntax]);
    expect(references.map((reference) => reference.start)).toEqual([body.indexOf(syntax, body.indexOf(syntax) + syntax.length), body.lastIndexOf(syntax)]);
  });

  it.each(['~~~', '```'].flatMap((fence) => [1, 2].flatMap((depth) => [
    { fence, depth, syntax: `![a](${x})` },
    { fence, depth, syntax: `<img src='${x}'>` },
  ])))('ends a $fence fence when blockquote depth drops below $depth: $syntax', ({ fence, depth, syntax }) => {
    const prefix = '> '.repeat(depth);
    const opening = `${prefix} ${fence}markdown\n`;
    const outside = `${opening}${'> '.repeat(depth - 1)}${syntax}`;
    const inside = `${opening}${prefix}${syntax}`;
    const start = outside.length - syntax.length;
    const placeholders = new Map([[x, '[Image #1]']]);

    const references = extractGithubImageReferences(outside);
    const excluded = extractGithubImageReferences(inside);

    expect(references).toEqual([{ url: x, start, end: outside.length }]);
    expect(outside.slice(references[0]!.start, references[0]!.end)).toBe(syntax);
    expect(annotateGithubImageReferences(outside, references, placeholders)).toBe(`${outside} [Image #1]`);
    expect(excluded).toEqual([]);
    expect(annotateGithubImageReferences(inside, excluded, placeholders)).toBe(inside);
  });

  it.each(['~~~', '```'])('distinguishes quoted and unquoted blank lines inside a $fence fence', (fence) => {
    const syntax = `<img src='${y}'>`;
    const lines = [`> ${fence}`, `> ![a](${x})`, '', `> ${syntax}`];
    const outside = lines.join('\n');
    const inside = [`> ${fence}`, `> ![a](${x})`, '> ', `> ${syntax}`].join('\n');
    const placeholders = new Map([[x, '[Image #1]'], [y, '[Image #2]']]);

    const references = extractGithubImageReferences(outside);
    const excluded = extractGithubImageReferences(inside);

    expect(references).toEqual([{ url: y, start: outside.lastIndexOf(syntax), end: outside.length }]);
    expect(outside.slice(references[0]!.start, references[0]!.end)).toBe(syntax);
    expect(annotateGithubImageReferences(outside, references, placeholders)).toBe(`${outside} [Image #2]`);
    expect(excluded).toEqual([]);
    expect(annotateGithubImageReferences(inside, excluded, placeholders)).toBe(inside);
  });

  it.each(['~~~', '```'])('rechecks the line ending a quoted $fence fence as a new code block', (fence) => {
    const syntax = `![a](${x})`;
    const outside = [`> ${fence}`, fence.slice(0, -1), syntax].join('\n');
    const fenced = [`> ${fence}`, fence, syntax].join('\n');
    const indented = [`> ${fence}`, `    ${syntax}`, syntax].join('\n');
    const placeholders = new Map([[x, '[Image #1]']]);

    for (const body of [outside, indented]) {
      const references = extractGithubImageReferences(body);
      expect(references).toEqual([{ url: x, start: body.lastIndexOf(syntax), end: body.length }]);
      expect(body.slice(references[0]!.start, references[0]!.end)).toBe(syntax);
      expect(annotateGithubImageReferences(body, references, placeholders)).toBe(`${body} [Image #1]`);
    }
    expect(extractGithubImageReferences(fenced)).toEqual([]);
    expect(annotateGithubImageReferences(fenced, extractGithubImageReferences(fenced), placeholders)).toBe(fenced);
  });

  it.each(['~~~', '```'])('keeps extra blockquote markers as code inside a quoted $fence fence', (fence) => {
    const syntax = `<img src='${x}'>`;
    const closed = [`> ${fence}`, `> ${fence}`, `> ${syntax}`].join('\n');
    const inside = [`> ${fence}`, `> > ${fence}`, `> ${syntax}`].join('\n');
    const placeholders = new Map([[x, '[Image #1]']]);
    const references = extractGithubImageReferences(closed);

    expect(references).toEqual([{ url: x, start: closed.lastIndexOf(syntax), end: closed.length }]);
    expect(closed.slice(references[0]!.start, references[0]!.end)).toBe(syntax);
    expect(annotateGithubImageReferences(closed, references, placeholders)).toBe(`${closed} [Image #1]`);
    expect(extractGithubImageReferences(inside)).toEqual([]);
    expect(annotateGithubImageReferences(inside, extractGithubImageReferences(inside), placeholders)).toBe(inside);
  });

  it.each(['~~~', '```'])('does not close an ordinary $fence fence with a quoted marker', (fence) => {
    const syntax = `![a](${x})`;
    const closed = [fence, fence, syntax].join('\n');
    const inside = [fence, `> ${fence}`, syntax].join('\n');
    const placeholders = new Map([[x, '[Image #1]']]);
    const references = extractGithubImageReferences(closed);

    expect(references).toEqual([{ url: x, start: closed.lastIndexOf(syntax), end: closed.length }]);
    expect(annotateGithubImageReferences(closed, references, placeholders)).toBe(`${closed} [Image #1]`);
    expect(extractGithubImageReferences(inside)).toEqual([]);
    expect(annotateGithubImageReferences(inside, extractGithubImageReferences(inside), placeholders)).toBe(inside);
  });
});

describe('annotateGithubImageReferences', () => {
  it('preserves every source character and supplements only successful references', () => {
    const first = `![a](<${x}> "title")`;
    const second = `<img src='${y}'>`;
    const body = `[Image #9]\n${first}\n${second}\n${first}\n`;
    const result = annotateGithubImageReferences(body, extractGithubImageReferences(body), new Map([[x, '[Image #1]']]));

    expect(result).toBe(`[Image #9]\n${first} [Image #1]\n${second}\n${first} [Image #1]\n`);
  });

  it('leaves the body unchanged when no reference succeeds', () => {
    const body = `![a](${x})`;
    expect(annotateGithubImageReferences(body, extractGithubImageReferences(body), new Map())).toBe(body);
  });
});

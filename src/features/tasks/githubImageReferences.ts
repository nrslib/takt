export interface GithubImageReference {
  readonly url: string;
  readonly start: number;
  readonly end: number;
}

function excludedCodeLines(body: string): Uint8Array {
  const excluded = new Uint8Array(body.length);
  let fence: { character: string; length: number; blockquoteDepth: number } | undefined;
  let offset = 0;
  const blockquote = / {0,3}> ?/y;
  for (const line of body.split('\n')) {
    let contentStart = 0;
    let blockquoteDepth = 0;
    blockquote.lastIndex = 0;
    while ((!fence || blockquoteDepth < fence.blockquoteDepth) && blockquote.test(line)) {
      contentStart = blockquote.lastIndex;
      blockquoteDepth += 1;
    }
    if (fence && blockquoteDepth < fence.blockquoteDepth) fence = undefined;
    const content = line.slice(contentStart);
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(content);
    const run = marker?.[1];
    if (fence) {
      excluded.fill(1, offset, offset + line.length + 1);
      if (run && run[0] === fence.character && run.length >= fence.length && marker![2]!.trim() === '') {
        fence = undefined;
      }
    } else if (run && (run[0] !== '`' || !marker![2]!.includes('`'))) {
      fence = { character: run[0]!, length: run.length, blockquoteDepth };
      excluded.fill(1, offset, offset + line.length + 1);
    } else if (/^(?: {4}|\t)/.test(content)) {
      excluded.fill(1, offset, offset + line.length + 1);
    }
    offset += line.length + 1;
  }
  return excluded;
}

function unescapeMarkdown(value: string): string {
  return value.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/g, '$1');
}

function decodeHtmlEntities(value: string): string {
  const named = new Map([['amp', '&'], ['quot', '"'], ['apos', "'"], ['lt', '<'], ['gt', '>']]);
  return value.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (entity: string, name: string) => {
    if (!name.startsWith('#')) return named.get(name.toLowerCase())!;
    const hexadecimal = name[1]?.toLowerCase() === 'x';
    const codePoint = Number.parseInt(name.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
    return codePoint > 0 && codePoint <= 0x10ffff && !(codePoint >= 0xd800 && codePoint <= 0xdfff)
      ? String.fromCodePoint(codePoint) : entity;
  });
}

interface ImageSpan {
  readonly start: number;
  readonly end: number;
  readonly urlStart: number;
  readonly urlEnd: number;
  readonly markdown: boolean;
}

// Failed candidates can share an arbitrarily long suffix; resolve its delimiters only once.
class ImageSyntaxIndex {
  readonly brackets: Int32Array;
  readonly whitespace: Int32Array;
  readonly angleEnd: Int32Array;
  readonly destinationEnd: Int32Array;
  readonly titleEnds: ReadonlyMap<string, Int32Array>;
  readonly htmlEnd: Int32Array;
  readonly attributeNameEnd: Int32Array;
  readonly attributeValueEnd: Int32Array;
  readonly rawQuoteEnds: ReadonlyMap<string, Int32Array>;
  readonly firstSrc: Int32Array;
  readonly codeEnds = new Map<number, number>();

  constructor(private readonly body: string) {
    const size = body.length + 1;
    const escaped = new Uint8Array(size);
    this.brackets = new Int32Array(size).fill(-1);
    const parenthesisEnds = new Int32Array(size).fill(-1);
    const brackets: number[] = [];
    const parentheses: number[] = [];
    for (let i = 0; i < body.length; i += 1) {
      if (body[i] === '\\') {
        escaped[i + 1] = 1;
        i += 1;
        continue;
      }
      if (body[i] === '[') brackets.push(i);
      else if (body[i] === ']' && brackets.length) this.brackets[brackets.pop()!] = i;
      if (body[i] === '(') parentheses.push(i);
      else if (body[i] === ')' && parentheses.length) parenthesisEnds[parentheses.pop()!] = i;
    }

    this.whitespace = new Int32Array(size);
    this.whitespace[body.length] = body.length;
    this.angleEnd = new Int32Array(size).fill(-1);
    this.destinationEnd = new Int32Array(size).fill(-1);
    this.titleEnds = new Map(['"', "'", ')'].map((quote) => [quote, new Int32Array(size).fill(-1)]));
    this.rawQuoteEnds = new Map(['"', "'"].map((quote) => [quote, new Int32Array(size).fill(-1)]));
    this.htmlEnd = new Int32Array(size).fill(-1);
    const singleQuotedEnd = new Int32Array(size).fill(-1);
    const doubleQuotedEnd = new Int32Array(size).fill(-1);
    this.attributeNameEnd = new Int32Array(size);
    this.attributeValueEnd = new Int32Array(size);
    this.attributeNameEnd[body.length] = body.length;
    this.attributeValueEnd[body.length] = body.length;
    let nextDestinationWhitespace = body.length;
    for (let i = body.length - 1; i >= 0; i -= 1) {
      const character = body[i]!;
      const space = /\s/.test(character);
      if (space && !escaped[i]) nextDestinationWhitespace = i;
      this.whitespace[i] = space ? this.whitespace[i + 1]! : i;
      this.attributeNameEnd[i] = /[^\s=/'"<>]/.test(character) ? this.attributeNameEnd[i + 1]! : i;
      this.attributeValueEnd[i] = /[^\s'"=<>`]/.test(character) ? this.attributeValueEnd[i + 1]! : i;
      for (const [quote, ends] of this.rawQuoteEnds) ends[i] = character === quote ? i : ends[i + 1]!;
      for (const [quote, ends] of this.titleEnds) ends[i] = character === quote && !escaped[i] ? i : ends[i + 1]!;
      this.angleEnd[i] = !escaped[i] && (character === '<' || character === '>' || character === '\n')
        ? i : this.angleEnd[i + 1]!;
      if (character === '\\' && !escaped[i] && i + 1 < body.length) {
        this.destinationEnd[i] = this.destinationEnd[i + 2]!;
      } else if (!escaped[i] && (space || character === ')')) {
        this.destinationEnd[i] = i;
      } else if (character === '(' && !escaped[i]) {
        const closing = parenthesisEnds[i]!;
        this.destinationEnd[i] = closing < 0 || nextDestinationWhitespace < closing
          ? -1 : this.destinationEnd[closing + 1]!;
      } else this.destinationEnd[i] = this.destinationEnd[i + 1]!;

      this.htmlEnd[i] = character === '>' ? i
        : character === '"' ? doubleQuotedEnd[i + 1]!
        : character === "'" ? singleQuotedEnd[i + 1]! : this.htmlEnd[i + 1]!;
      singleQuotedEnd[i] = character === "'" ? this.htmlEnd[i + 1]! : singleQuotedEnd[i + 1]!;
      doubleQuotedEnd[i] = character === '"' ? this.htmlEnd[i + 1]! : doubleQuotedEnd[i + 1]!;
    }

    this.firstSrc = new Int32Array(size).fill(-1);
    for (let i = body.length - 1; i >= 0; i -= 1) {
      const nameEnd = this.attributeNameEnd[i]!;
      if (nameEnd === i) {
        this.firstSrc[i] = this.firstSrc[i + 1]!;
        continue;
      }
      const attribute = this.attributeAt(i);
      this.firstSrc[i] = nameEnd - i === 3 && body.slice(i, nameEnd).toLowerCase() === 'src'
        ? i : this.firstSrc[attribute.end]!;
    }

    const nextRuns = new Map<number, number>();
    for (let i = body.length - 1; i >= 0; i -= 1) {
      if (body[i] !== '`') continue;
      const end = i + 1;
      while (i > 0 && body[i - 1] === '`') i -= 1;
      const length = end - i;
      const closing = nextRuns.get(length);
      if (closing !== undefined) this.codeEnds.set(i, closing + length);
      nextRuns.set(length, i);
    }
  }

  attributeAt(start: number): { end: number; urlStart?: number; urlEnd?: number } {
    const nameEnd = this.attributeNameEnd[start]!;
    let cursor = this.whitespace[nameEnd]!;
    if (this.body[cursor] !== '=') return { end: nameEnd };
    cursor = this.whitespace[cursor + 1]!;
    const quote = this.body[cursor];
    if (quote === '"' || quote === "'") {
      const end = this.rawQuoteEnds.get(quote)![cursor + 1]!;
      return end < 0 ? { end: nameEnd } : { end: end + 1, urlStart: cursor + 1, urlEnd: end };
    }
    const end = this.attributeValueEnd[cursor]!;
    return end === cursor ? { end: nameEnd } : { end, urlStart: cursor, urlEnd: end };
  }
}

function markdownImageAt(body: string, start: number, index: ImageSyntaxIndex): ImageSpan | undefined {
  const altEnd = index.brackets[start + 1]!;
  if (altEnd < 0 || body[altEnd + 1] !== '(') return undefined;
  let cursor = index.whitespace[altEnd + 2]!;
  const angled = body[cursor] === '<';
  if (angled) cursor += 1;
  const urlStart = cursor;
  const urlEnd = angled ? index.angleEnd[cursor]! : index.destinationEnd[cursor]!;
  if (urlEnd <= urlStart || (angled && body[urlEnd] !== '>')) return undefined;
  const afterUrl = angled ? urlEnd + 1 : urlEnd;
  cursor = index.whitespace[afterUrl]!;
  if (body[cursor] !== ')') {
    if (cursor === afterUrl) return undefined;
    const quote = body[cursor];
    if (quote !== '"' && quote !== "'" && quote !== '(') return undefined;
    const end = index.titleEnds.get(quote === '(' ? ')' : quote)![cursor + 1]!;
    if (end < 0) return undefined;
    cursor = index.whitespace[end + 1]!;
  }
  if (body[cursor] !== ')') return undefined;
  return { start, end: cursor + 1, urlStart, urlEnd, markdown: true };
}

function htmlImageAt(body: string, start: number, index: ImageSyntaxIndex): ImageSpan | undefined {
  if (!/^<img(?=\s|\/?>)/i.test(body.slice(start, start + 6))) return undefined;
  const end = index.htmlEnd[start + 4]!;
  if (end < 0) return undefined;
  const src = index.firstSrc[start + 4]!;
  if (src < 0 || src >= end) return undefined;
  const attribute = index.attributeAt(src);
  if (attribute.urlStart === undefined || attribute.urlEnd === undefined || attribute.end > end) return undefined;
  const urlEnd = attribute.urlEnd === end && body[end - 1] === '/' ? end - 1 : attribute.urlEnd;
  if (attribute.urlStart === urlEnd) return undefined;
  return { start, end: end + 1, urlStart: attribute.urlStart, urlEnd, markdown: false };
}

export function extractGithubImageReferences(body: string): GithubImageReference[] {
  const excluded = excludedCodeLines(body);
  const excludedCount = new Uint32Array(body.length + 1);
  for (let i = 0; i < body.length; i += 1) excludedCount[i + 1] = excludedCount[i]! + excluded[i]!;
  const index = new ImageSyntaxIndex(body);
  const references: GithubImageReference[] = [];
  let cursor = 0;
  while (cursor < body.length) {
    if (excluded[cursor]) {
      cursor += 1;
      continue;
    }
    if (body[cursor] === '\\') {
      cursor += 2;
      continue;
    }
    if (body.startsWith('<!--', cursor)) {
      const end = body.indexOf('-->', cursor + 4);
      cursor = end === -1 ? body.length : end + 3;
      continue;
    }
    if (body[cursor] === '`') {
      let runEnd = cursor + 1;
      while (body[runEnd] === '`') runEnd += 1;
      const end = index.codeEnds.get(cursor);
      cursor = end === undefined ? runEnd : end;
      continue;
    }
    const reference = body.startsWith('![', cursor)
      ? markdownImageAt(body, cursor, index)
      : body[cursor] === '<' ? htmlImageAt(body, cursor, index) : undefined;
    if (reference && excludedCount[reference.start] === excludedCount[reference.end]) {
      const rawUrl = body.slice(reference.urlStart, reference.urlEnd);
      const url = decodeHtmlEntities(reference.markdown ? unescapeMarkdown(rawUrl) : rawUrl);
      references.push({ url, start: reference.start, end: reference.end });
      cursor = reference.end;
    } else cursor += 1;
  }
  return references;
}

export function annotateGithubImageReferences(
  body: string,
  references: readonly GithubImageReference[],
  placeholders: ReadonlyMap<string, string>,
): string {
  let cursor = 0;
  const parts: string[] = [];
  for (const reference of references) {
    parts.push(body.slice(cursor, reference.end));
    const placeholder = placeholders.get(reference.url);
    if (placeholder !== undefined) parts.push(` ${placeholder}`);
    cursor = reference.end;
  }
  parts.push(body.slice(cursor));
  return parts.join('');
}

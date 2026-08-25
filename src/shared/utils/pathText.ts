const PATH_BOUNDARY_PATTERN = /[\s'"`(){}=,:;<>[]/u;

function isPathBoundary(text: string, index: number): boolean {
  if (index === 0) {
    return true;
  }
  return PATH_BOUNDARY_PATTERN.test(text.charAt(index - 1));
}

function shouldMaskPath(text: string, index: number, candidate: string): boolean {
  if (/^file:\/\//i.test(candidate)
    || candidate.startsWith('\\\\')) {
    return true;
  }
  if (/^[A-Za-z]:[\\/]/.test(candidate)) {
    const isUrlSchemeContinuation = candidate.startsWith('://', 1)
      && /[A-Za-z0-9]/.test(text.charAt(index - 1));
    return !isUrlSchemeContinuation;
  }
  if (
    text.charAt(index - 1) === '<'
    && text.charAt(index + candidate.length) === '>'
    && /^\/[A-Za-z][A-Za-z0-9:-]*$/u.test(candidate)
    && text.charAt(index - 2) !== '('
  ) {
    return false;
  }
  if (candidate.startsWith('~/')) {
    return isPathBoundary(text, index);
  }
  if (candidate.startsWith('//')) {
    return isPathBoundary(text, index) && text.charAt(index - 1) !== ':';
  }
  if (candidate === '/') {
    return false;
  }
  return isPathBoundary(text, index);
}

export function sanitizePathText(text: string): string {
  const pathTokenPattern = /file:\/\/(?:[^\s'"`<>|)[\]]|\[[^\s'"`<>|]*\]|<[A-Za-z0-9._~+-]+>)*|[A-Za-z]:[\\/](?:[^\s'"`<>|)[\]]|\[[^\s'"`<>|]*\]|<[A-Za-z0-9._~+-]+>)*|\\\\(?:[^\s'"`<>|)[\]]|\[[^\s'"`<>|]*\]|<[A-Za-z0-9._~+-]+>)*|\/\/[A-Za-z0-9._~+-]+(?:\/(?:[^\s'"`<>|)[\]]|\[[^\s'"`<>|]*\]|<[A-Za-z0-9._~+-]+>)*)+|~\/(?:[^\s'"`<>|)[\]]|\[[^\s'"`<>|]*\]|<[A-Za-z0-9._~+-]+>)*|\/(?!\/)(?:[^\s'"`<>|)[\]]|\[[^\s'"`<>|]*\]|<[A-Za-z0-9._~+-]+>)*/giu;
  let sanitized = '';
  let cursor = 0;
  for (const match of text.matchAll(pathTokenPattern)) {
    const candidate = match[0];
    const index = match.index;
    sanitized += text.slice(cursor, index);
    sanitized += shouldMaskPath(text, index, candidate) ? '[path]' : candidate;
    cursor = index + candidate.length;
  }
  return sanitized + text.slice(cursor);
}
